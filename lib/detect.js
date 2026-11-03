/**
 * dsh-loop-guard / detect.js
 *
 * 判断「这个 agent 是不是在同一个坑里反复摔」。
 *
 * ## 为什么不能用「完全相同的参数」当判据
 *
 * 最直觉的指纹是 `name + JSON.stringify(args)`，但实测抓不到真正的死循环。
 *
 * 证据来自 2026-10-26 的会话 `session-a2c5aa3f`（turn 33，362 秒 / 16 次调用）：
 *
 * ```
 * write _ssh_upload.py  →  pwsh 跑它  →  write _ssh_upload.py  →  pwsh 跑它  →  …
 * ```
 *
 * 那个脚本**每次都被改了一点点再写一遍**（改超时、改编码、换 base64 写法）。
 * 参数永远不同，指纹永远不同，可它做的事一模一样：往同一个文件里再灌一版，
 * 再跑一次，再失败。
 *
 * 所以真正的判据不是「参数相同」，而是**「同一个目标被反复动」**：
 * 同一个文件路径、同一条命令的开头。这才是「在原地打转」的形状。
 *
 * ## 三类判据，各管一种卡法
 *
 *   1. `target` 重复 —— 同一个目标被动了 N 次（上面那种改写循环）；
 *   2. `fingerprint` 完全重复 —— 一模一样地再来一次（工具自身在重试）；
 *   3. `failures` 持续 —— 连着 N 次调用都失败了（换了花样也还是不通）。
 *
 * 三条都是**每轮重置**。跨轮累计会变成一本老账：昨天改过十次文件，今天
 * 一提文件就挨骂。那不叫看住它，那叫记仇。
 *
 * @module dsh-loop-guard/detect
 */

/** 默认阈值。全部可以按需覆盖，但默认值是按实测那两次卡死调的。 */
export const DEFAULTS = {
  enabled: true,
  /** 同一个目标最多被动几次。turn 33 是同一个文件 12 次。 */
  maxSameTarget: 6,
  /** 完全相同的调用最多几次。 */
  maxSameCall: 3,
  /** 同一个轮次里，连续失败几次就认为「这条路不通」。 */
  maxFailures: 5,
  /** 单轮工具调用总数的硬顶。turn 21 是 59 次，正常任务很少过 25。 */
  maxCallsPerTurn: 40,
  /** 叫停之后，同一轮内不再重复叫停（否则每一步都吼一嗓子）。 */
  muteAfterTrip: true,
  /**
   * 长任务播报：一轮跑了多久之后，开始提醒它「先跟人说句话」。
   * 0 表示不播报。默认 180 秒 —— turn 21 那 847 秒里它一声没吭。
   */
  narrateAfterMs: 180_000,
  /** 播报之后至少隔多久才播下一次。 */
  narrateEveryMs: 240_000,
};

/** 参数里出现这些键时，用来判断「它在动什么」。 */
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'filename', 'file'];
/** 命令类工具的参数键。 */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'script_path', 'scriptPath'];

/** 把任意参数解析成对象。宿主有时给字符串，有时给对象。 */
export function parseArgs(args) {
  if (args !== null && typeof args === 'object') return args;
  if (typeof args === 'string' && args !== '') {
    try {
      const parsed = JSON.parse(args);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      /* 不是 JSON 就当纯文本命令处理 */
      return { command: args };
    }
  }
  return {};
}

/**
 * 稳定序列化：键序不影响结果，否则同一份参数会因为键序不同而算出两个指纹。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 一次工具调用的指纹（用于判「一模一样地又来一次」）。
 *
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
export function fingerprintOf(name, args) {
  return `${String(name ?? '')}\u0000${stableStringify(parseArgs(args))}`;
}

/**
 * 只读工具：它们**不改变任何东西**，所以不该计入「同一个目标被动了 N 次」。
 *
 * ## 这条是踩出来的（2026-10-27 当天）
 *
 * 第一版把 read 也算进 target 计数，结果我在排查一个问题时读同一个文件读了
 * 7 次（每次看不同段落），被自己的插件叫停：「file:index.js 被动了 7 次」。
 *
 * 那是**误报**，而且是最烦的那种 —— 调研阶段反复读同一个大文件完全正常，
 * 判宽了它只会烦人，判窄了才会漏。区分标准很简单：**有没有副作用**。
 *
 * 只读的仍然计入 `maxSameCall`（一模一样读十次确实可疑）和单轮总量。
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'grep',
  'glob',
  'list',
  'ls',
  'stat',
  'ops_read_file',
  'ops_grep',
  'ops_glob',
  'ops_inspect_local_file',
  'session_search',
  'session_clock',
  'cache_search',
  'web_fetch',
  'web_search',
  'mnemon_recall',
  'mnemon_status',
  'advisor_status',
]);

/** 这次调用有没有副作用。名字前缀兜底，认不出的一律当「有副作用」（保守）。 */
export function isReadOnly(name) {
  const n = String(name ?? '').toLowerCase();
  if (READ_ONLY_TOOLS.has(n)) return true;
  // 兜底：`*_read` / `read_*` / `*_status` / `get_*` / `list_*` 这类命名。
  return /(^|_)(read|status|inspect|list|glob|grep|search|find)(_|$)/.test(n)
    || /^get_/.test(n);
}

/**
 * 这次调用「动的是什么东西」。
 *
 * 优先看文件路径（改写循环的典型形态），其次看命令开头（反复跑同一条），
 * 都没有就退回工具名 —— 那样等于「同一个工具叫太多次」，也是一种卡法。
 *
 * 命令只取前 80 个字符并抹掉空白差异：同一条命令改个超时数字，仍然算同一个
 * 目标。宁可判宽一点 —— 判宽了它最多被提醒一句，判窄了它继续转 6 分钟。
 *
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
export function targetOf(name, args) {
  const parsed = parseArgs(args);
  for (const key of TARGET_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return `file:${value.trim()}`;
    }
  }
  for (const key of COMMAND_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') {
      // 把数字抹掉再比：`--timeout 5` 与 `--timeout 9` 是同一个动作在调参，
      // 不是两件事。真正换了命令的（改 python → 改 bandizip）首段就不同，
      // 仍然分得开。
      const normalized = value
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\d+/g, '#')
        .slice(0, 120);
      return `cmd:${normalized}`;
    }
  }
  return `tool:${String(name ?? '')}`;
}

/**
 * 一轮的账本。每轮一份，轮末丢弃。
 *
 * @param {object} [cfg]
 */
export function createLedger(cfg = DEFAULTS) {
  const limits = { ...DEFAULTS, ...(cfg ?? {}) };
  /** @type {{targets: Map<string, number>, calls: Map<string, number>, total: number, failures: number, consecutiveFailures: number, tripped: null|{kind:string, detail:string, at:number}}} */
  let state = blank();

  function blank() {
    return {
      targets: new Map(),
      calls: new Map(),
      total: 0,
      failures: 0,
      consecutiveFailures: 0,
      tripped: null,
    };
  }

  return {
    limits,
    /** 开新一轮（或换会话）。 */
    reset() {
      state = blank();
    },
    /** 这一轮的账（只读快照，给状态面板与测试看）。 */
    get() {
      return {
        total: state.total,
        failures: state.failures,
        consecutiveFailures: state.consecutiveFailures,
        tripped: state.tripped,
        targets: Object.fromEntries(state.targets),
        calls: state.calls.size,
      };
    },
    /** 记一次调用，返回「要不要叫停」。 */
    noteCall(name, args, now = Date.now()) {
      if (limits.enabled === false) return null;
      state.total += 1;
      const fp = fingerprintOf(name, args);
      const tg = targetOf(name, args);
      const callCount = (state.calls.get(fp) ?? 0) + 1;
      state.calls.set(fp, callCount);

      // 只读调用不计入「同一个目标被动了 N 次」（见 READ_ONLY_TOOLS 的注释：
      // 调研时反复读同一个文件完全正常，那是误报）。它仍然计入同调用与总量。
      let targetCount = 0;
      if (!isReadOnly(name)) {
        targetCount = (state.targets.get(tg) ?? 0) + 1;
        state.targets.set(tg, targetCount);
      }

      const verdict = this.judge(name, tg, callCount, targetCount, now);
      return verdict;
    },
    /** 记一次工具结果。`ok === false` 说明这次没成。 */
    noteResult(ok) {
      if (limits.enabled === false) return;
      if (ok === false) {
        state.failures += 1;
        state.consecutiveFailures += 1;
      } else {
        state.consecutiveFailures = 0;
      }
    },
    /**
     * 判据汇总。单独抽出来是为了能在**没真的执行工具**时也能测。
     */
    judge(name, target, callCount, targetCount, now = Date.now()) {
      if (state.tripped !== null && limits.muteAfterTrip !== false) return null;

      let kind = null;
      let detail = '';
      if (callCount > limits.maxSameCall) {
        kind = 'same-call';
        detail = `同一个调用做了 ${callCount} 次`;
      } else if (targetCount > limits.maxSameTarget) {
        kind = 'same-target';
        detail = `${target} 被动了 ${targetCount} 次`;
      } else if (state.consecutiveFailures >= limits.maxFailures) {
        kind = 'failures';
        detail = `连续失败 ${state.consecutiveFailures} 次`;
      } else if (state.total > limits.maxCallsPerTurn) {
        kind = 'budget';
        detail = `这一轮已经调了 ${state.total} 次工具`;
      }
      if (kind === null) return null;

      state.tripped = { kind, detail, at: now, tool: String(name ?? '') };
      return { kind, detail, tool: String(name ?? '') };
    },
  };
}

/**
 * 给模型看的一句话。刻意写得像**帮它收尾**，不像报警。
 *
 * 为什么要提「告诉他要动手了/办不成」：模型在卡住时的默认行为是继续试，
 * 它以为「再试一次就通了」。这里必须给它一条**别的出路**，否则它只会换个
 * 姿势继续撞。
 *
 * @param {{kind:string, detail:string, tool:string}} verdict
 * @returns {string}
 */
export function stopMessage(verdict) {
  const what = verdict?.detail ?? '同一个动作';
  return [
    `停一下：${what}，这条路已经走不通了。`,
    '不要再试同一件事的另一个版本。现在直接回复用户，说清楚三件事：',
    '已经试过什么、卡在哪、需要他决定什么。',
    '办不成就说办不成——这比再转十分钟有用。',
  ].join('');
}

/**
 * 长任务播报。跑太久还没开口时提醒它说一句。
 *
 * 判据是「这一轮开始到现在多久」，不是「上次播报多久之前」—— 后者在
 * 一步很长的工具调用里会漏掉（那一步本身就可能占满 800 秒）。
 *
 * @param {{startedAt:number, lastNarratedAt:number|null, alreadySpoke:boolean}} clock
 * @param {number} now
 * @param {object} [cfg]
 * @returns {string|null}
 */
export function narrateLine(clock, now = Date.now(), cfg = DEFAULTS) {
  const limits = { ...DEFAULTS, ...(cfg ?? {}) };
  if (limits.enabled === false) return null;
  const every = Number(limits.narrateEveryMs) > 0 ? Number(limits.narrateEveryMs) : DEFAULTS.narrateEveryMs;
  // `0` 是一个有意义的取值（= 不播报），不能当成「没配」而被默认值顶掉。
  const rawAfter = cfg?.narrateAfterMs;
  const after = typeof rawAfter === 'number' && Number.isFinite(rawAfter) ? rawAfter : DEFAULTS.narrateAfterMs;
  if (after <= 0) return null;
  if (!Number.isFinite(clock?.startedAt)) return null;

  const elapsed = now - clock.startedAt;
  if (elapsed < after) return null;
  // 已经说过话就不催 —— 她自己已经在同步进展，不需要插件多嘴。
  if (clock.alreadySpoke === true) return null;
  if (clock.lastNarratedAt !== null && Number.isFinite(clock.lastNarratedAt)) {
    if (now - clock.lastNarratedAt < every) return null;
  }
  const mins = Math.round(elapsed / 60_000);
  return [
    `这一轮已经跑了 ${mins} 分钟，你还没跟用户说过一句话。`,
    '先停下来跟他说一句现在的进展（一两句就够，不用总结），再继续。',
    '他要的不是等到的结果，是知道你还活着、在做什么。',
  ].join('');
}
