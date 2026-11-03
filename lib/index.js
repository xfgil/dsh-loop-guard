/**
 * dsh-loop-guard / index.js
 *
 * 给 agent 的干活循环加两道刹。
 *
 * ## 为什么单独一个插件，不塞进 dsh-onebot-companion
 *
 * 2026-10-27 用户当场指出来的：companion 是**给 QQ 通道**看的插件，它的每个
 * 挂载点都挂在 `dsh-onebot-qq` 的类上（`InboundPipeline#processInbound`、
 * `sendToChat`、`sendMsg`）。而「转 20 分钟不出声」这件事发生在 **GUI 会话**
 * 里，用的是宿主自己的 agent 循环。拿 QQ 的工具去修 GUI 的病，不成立。
 *
 * 所以这个插件只用宿主**通用**的两个钩子：
 *
 *   - `ctx.on('agent/pre-step')`  —— 每步之前，用来播报进展；
 *   - `ctx.tools.guard()`        —— 每次工具调用之前，用来记账与叫停。
 *
 * 两者都与 QQ、与人格、与任何具体渠道无关。它对所有会话一视同仁，谁卡住
 * 都管 —— 包括 subagent、包括网页、包括以后任何新渠道。
 *
 * ## 它治的是什么（有实测依据，不是臆想）
 *
 * 证据来自 2026-10-26 的会话 `session-a2c5aa3f`：
 *
 * | turn | 用时 | 工具调用 | 发生了什么 |
 * |---|---|---|---|
 * | 21 | **847 秒** | 59 次 | 用 SSH 传 289MB 安装包，全程几乎没跟用户说话 |
 * | 33 | 362 秒 | 16 次 | `write 脚本 → 跑 → write 同一个脚本 → 跑`，撞了十几遍 |
 *
 * 前者是「闷头干」，后者是「原地打转」。两个都不是上下文太长的问题 ——
 * 这也是用户的判断：装压缩插件治不了这个。
 *
 * @module dsh-loop-guard
 */

import { DEFAULTS, createLedger, narrateLine, stopMessage } from './detect.js';

export { DEFAULTS, createLedger, fingerprintOf, isReadOnly, targetOf, stableStringify, stopMessage, narrateLine } from './detect.js';

export const name = 'loop-guard';

/**
 * 不需要任何服务注入：`ctx.tools` 由宿主提供，缺了就在 `apply` 里退化。
 */
export const inject = [];

/** 注入消息的 source.kind，同时用来去重。 */
const INJECT_KIND = 'loop-guard';

/**
 * 宿主的 `@deepseek-ai/dsh-*` 在 profile 层的第三方插件里**不保证可解析**
 * （本机 `node_modules\@deepseek-ai` 只有 cosmokit 与 schemastery）。所以受控
 * 动态加载 + 本地兜底，跟 `dsh-session-clock` 同一套写法。
 */
let createUserMessage;
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  createUserMessage = undefined;
}

/** 兜底：形状与宿主一致，不依赖任何包。 */
function fallbackUserMessage(text) {
  return {
    id: `loop-guard-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: INJECT_KIND, form: 'snapshot', sections: [{ name: INJECT_KIND, text }] },
  };
}

function buildMessage(text) {
  if (typeof createUserMessage === 'function') {
    try {
      return createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: INJECT_KIND, form: 'snapshot', sections: [{ name: INJECT_KIND, text }] },
      });
    } catch {
      /* 掉到本地兜底 */
    }
  }
  return fallbackUserMessage(text);
}

/** 从 host 的 agent 对象上尽力取出会话 id（各家实现字段不一）。 */
function sessionIdOf(agent) {
  if (agent === null || agent === undefined) return null;
  const direct = agent.sessionId ?? agent.session_id;
  if (typeof direct === 'string' && direct !== '') return direct;
  const nested = agent.session?.id ?? agent.id;
  return typeof nested === 'string' && nested !== '' ? nested : null;
}

/**
 * 判断一次工具调用的结果算不算失败。
 *
 * 宿主给的结果形状不统一（`{ok}` / `{error}` / 报错文本），所以判宽一点：
 * 明确报错才算失败，说不清的一律当成功 —— 误判成失败会让「连续失败」这条
 * 判据乱跳。
 */
function isFailure(result) {
  if (result === null || result === undefined) return false;
  if (typeof result === 'object') {
    if (result.ok === false) return true;
    if (result.error !== undefined && result.error !== null) return true;
    if (result.success === false) return true;
    if (result.isError === true) return true;
  }
  return false;
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const log = (level, message) => {
    try {
      const fn = ctx.logger?.[level] ?? ctx.logger?.info;
      if (typeof fn === 'function') fn.call(ctx.logger, `[loop-guard] ${message}`);
    } catch {
      /* 日志失败不该连累任何东西 */
    }
  };

  if (cfg.enabled === false) {
    log('info', '已停用');
    return;
  }

  const ledger = createLedger(cfg);

  /** 每轮一份的时钟（播报用）。 */
  const clocks = new Map();

  const stats = {
    turns: 0,
    calls: 0,
    trips: 0,
    narrated: 0,
    lastTrip: null,
    lastNarrated: null,
    lastError: null,
  };

  // ── 每轮开始：清账 + 起表 ─────────────────────────────────────────────
  //
  // `agent/pre-step` 在**每一步**都会被调到，所以「这一轮开始」要自己判：
  // step === 1 就是新一轮。turn 号也参与判断，防止同一轮分了多个 step 时
  // 被重复重置（reset 太勤会让阈值永远攒不满）。
  try {
    ctx.on(
      'agent/pre-step',
      async (payload, next) => {
        try {
          const turn = payload?.turn;
          const step = payload?.step;
          const sid = sessionIdOf(payload?.agent) ?? 'unknown';
          const key = `${sid}#${turn}`;
          let clock = clocks.get(key);
          if (clock === undefined) {
            clock = { startedAt: Date.now(), lastNarratedAt: null, alreadySpoke: false, step: 0 };
            clocks.set(key, clock);
            ledger.reset();
            stats.turns += 1;
          }
          if (Number.isFinite(step) && step > clock.step) clock.step = step;
          // 会话一多，这个表会慢慢涨；只留最近 64 轮足够判当下。
          if (clocks.size > 64) {
            const oldest = [...clocks.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
            for (const [stale] of oldest.slice(0, 16)) clocks.delete(stale);
          }

          // 「她已经说过话了」：本轮里出现过 assistant 的正文就置位。
          // 只认正文、不认 reasoning —— 想了一堆没说出来，用户还是什么都看不到。
          if (Array.isArray(payload?.messages)) {
            for (let i = payload.messages.length - 1; i >= 0; i -= 1) {
              const m = payload.messages[i];
              if (m === null || typeof m !== 'object') continue;
              if (m.role !== 'assistant') continue;
              const parts = Array.isArray(m.content) ? m.content : [];
              const spoke = parts.some((p) => p?.type === 'text' && String(p.text ?? '').trim() !== '');
              if (spoke) {
                clock.alreadySpoke = true;
                break;
              }
            }
          }
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
        }
        return next();
      },
      { global: true },
    );
  } catch (error) {
    stats.lastError = String(error?.message ?? error);
    log('warn', `agent/pre-step 注册失败：${stats.lastError}`);
  }

  // ── 工具守卫：记账 + 叫停 ─────────────────────────────────────────────
  //
  // 用 `ctx.tools.guard()` 而不是 `tools/pre-execute`：宿主文档写明「一个必须
  // 无视顺序成立的拒绝，用 guard」。这里正是这种 —— 不管别的插件怎么插，
  // 撞够次数就该停。返回字符串 = 拒绝，并把这句话当作工具结果喂回模型。
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      const service = toolsCtx.tools ?? ctx.tools;
      if (typeof service?.guard !== 'function') {
        log('warn', 'tools 服务没有 guard()，叫停功能未生效');
        return;
      }
      toolsCtx.effect(
        () =>
          service.guard((execution) => {
            try {
              if (cfg.enabled === false) return undefined;
              const toolName = String(execution?.name ?? '');
              stats.calls += 1;

              const verdict = ledger.noteCall(toolName, execution?.arguments);
              if (verdict === null) return undefined;

              stats.trips += 1;
              stats.lastTrip = {
                at: Date.now(),
                kind: verdict.kind,
                detail: verdict.detail,
                tool: verdict.tool,
                session: sessionIdOf(execution?.agent),
              };
              log('info', `叫停：${verdict.detail}（${toolName}）`);
              return stopMessage(verdict);
            } catch (error) {
              // 守自己出错就放行 —— 宁可让它多转两圈，也不能把工具整个卡死。
              stats.lastError = String(error?.message ?? error);
              log('warn', `守卫异常，本次放行：${stats.lastError}`);
              return undefined;
            }
          }),
        `${name}: loop-guard`,
      );
    });
  } catch (error) {
    stats.lastError = String(error?.message ?? error);
    log('warn', `tools 守卫注册失败：${stats.lastError}`);
  }

  // ── 长任务播报 ────────────────────────────────────────────────────────
  //
  // 也用 `agent/pre-step`（同一个处理器里做不了注入，所以另挂一个）：
  // 在决策里追加一条 user 消息，代价最小且不会改动 system prompt（前缀缓存
  // 不会失效）。
  try {
    ctx.effect(() => {
      const off = ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          const decision = await next();
          try {
            if (cfg.enabled === false) return decision;
            if (decision?.kind === 'reject') return decision;
            const key = `${sessionIdOf(payload?.agent) ?? 'unknown'}#${payload?.turn}`;
            const clock = clocks.get(key);
            if (clock === undefined) return decision;
            const line = narrateLine(clock, Date.now(), cfg);
            if (line === null) return decision;
            clock.lastNarratedAt = Date.now();
            stats.narrated += 1;
            stats.lastNarrated = { at: Date.now(), turn: payload?.turn, step: payload?.step };
            return { ...decision, messages: [...(decision?.messages ?? []), buildMessage(line)] };
          } catch (error) {
            stats.lastError = String(error?.message ?? error);
            return decision;
          }
        },
        { global: true },
      );
      return () => {
        try {
          off?.();
        } catch {
          /* 卸载失败不重要 */
        }
      };
    }, `${name}: narrate`);
  } catch (error) {
    stats.lastError = String(error?.message ?? error);
    log('warn', `播报注册失败：${stats.lastError}`);
  }

  // ── 只读自检口 ────────────────────────────────────────────────────────
  //
  // 不提供「停用/重启」之类的一键开关：这个插件的作用是让 agent 别把人晾着，
  // 不是给人一个遥控器。看得到状态就够。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer;
      if (typeof server?.register !== 'function') {
        log('warn', 'webServer 没有 register()，观测面未开启');
        return;
      }
      // 宿主的接口是 `register({ kind, path, handler })`，**不是** express 那套
      // `.get()/.route()`。2026-10-27 第一版照 express 写，结果路由从未注册，
      // 探活一直 404 —— 而且不报错，因为 guard 那边全是 try/catch 放行。
      // 对照实现在 dsh-session-clock 的 `ctx.inject(['webServer'])` 段。
      webCtx.effect(
        () =>
          server.register({
            kind: 'prefix',
            path: `/${name}`,
            handler: async (request, response) => {
              try {
                const body = JSON.stringify(
                  { ok: true, at: new Date().toISOString(), stats, ledger: ledger.get(), limits: cfg },
                  null,
                  2,
                );
                response.writeHead?.(200, { 'content-type': 'application/json; charset=utf-8' });
                response.end?.(body);
              } catch (error) {
                stats.lastError = String(error?.message ?? error);
                try {
                  response.writeHead?.(500, { 'content-type': 'application/json; charset=utf-8' });
                  response.end?.(JSON.stringify({ ok: false, error: stats.lastError }));
                } catch {
                  /* 写不出去就算了 */
                }
              }
            },
          }),
        `${name}: http`,
      );
    });
  } catch (error) {
    stats.lastError = String(error?.message ?? error);
    log('warn', `观测面注册失败：${stats.lastError}`);
  }
}
