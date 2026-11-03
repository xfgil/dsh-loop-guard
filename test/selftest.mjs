#!/usr/bin/env node
/**
 * dsh-loop-guard / selftest.mjs
 *
 * 只测纯函数（detect.js）与一两个接线面。理由同其他插件：**不依赖真实宿主**
 * 才能随时跑。真挂没挂上要靠实测，测试只负责把判据钉死。
 *
 * 跑：node test/selftest.mjs
 */

import {
  DEFAULTS,
  createLedger,
  fingerprintOf,
  isReadOnly,
  narrateLine,
  stableStringify,
  stopMessage,
  targetOf,
} from '../lib/detect.js';

let pass = 0;
let fail = 0;

function ok(value, label) {
  if (value) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${label}\n    期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`);
  }
}

// ── stableStringify：键序不影响结果 ──────────────────────────────────────
{
  eq(
    stableStringify({ b: 1, a: 2 }),
    stableStringify({ a: 2, b: 1 }),
    'stableStringify：键序不同但内容相同，结果一致',
  );
  eq(stableStringify([1, { z: 1, y: 2 }]), '[1,{"y":2,"z":1}]', 'stableStringify：数组与嵌套对象');
}

// ── parseArgs：字符串与对象都要能吃 ──────────────────────────────────────
{
  eq(fingerprintOf('a', '{"x":1}'), fingerprintOf('a', { x: 1 }), 'fingerprintOf：字符串参数与对象参数同指纹');
  ok(fingerprintOf('a', { x: 1 }) !== fingerprintOf('b', { x: 1 }), 'fingerprintOf：换工具就换指纹');
  ok(fingerprintOf('a', 'not json') !== fingerprintOf('a', 'not json 2'), 'fingerprintOf：非 JSON 字符串按命令处理');
}

// ── targetOf：这才是抓改写循环的关键 ────────────────────────────────────
{
  eq(targetOf('write', { file_path: 'D:/a/b.py' }), 'file:D:/a/b.py', 'targetOf：认 file_path');
  eq(targetOf('write', { filePath: 'D:/a/b.py' }), 'file:D:/a/b.py', 'targetOf：也认 filePath');
  eq(
    targetOf('write', { file_path: 'D:/a/b.py', content: '完全不同的内容 v2' }),
    'file:D:/a/b.py',
    'targetOf：内容变了但目标没变 —— 正是 turn 33 的形状',
  );
  ok(
    targetOf('pwsh', { command: 'python a.py --timeout 5' })
      === targetOf('pwsh', { command: 'python   a.py   --timeout 9' }),
    'targetOf：同一条命令改个参数数字，仍算同一个目标（判宽一点）',
  );
  eq(targetOf('ping', {}), 'tool:ping', 'targetOf：没有路径也没有命令就退回工具名');
}

// ── createLedger：三个判据 ──────────────────────────────────────────────
{
  // 1) 同一个目标反复动（turn 33 的形态：每次内容都不一样）
  //
  // 注意断言**第一次**叫停的时机，不是「循环结束时还有没有返回值」——
  // 叫停之后按设计会闭嘴（`muteAfterTrip`），最后一次必然是 null。
  const l = createLedger({ maxSameTarget: 3, maxSameCall: 99, maxFailures: 99, maxCallsPerTurn: 999 });
  const v1 = [];
  for (let i = 0; i < 5; i += 1) {
    v1.push(l.noteCall('write', { file_path: 'D:/x.py', content: `第 ${i} 版` }));
  }
  ok(v1[3] !== null && v1[3].kind === 'same-target', 'ledger：内容每次不同，仍按「同一个目标」叫停');
  eq(v1[4], null, 'ledger：叫停之后同一轮闭嘴（不是每步都喊）');

  // 2) 一模一样的调用
  const l2 = createLedger({ maxSameCall: 2, maxSameTarget: 999, maxFailures: 99, maxCallsPerTurn: 999 });
  const v2 = [];
  for (let i = 0; i < 4; i += 1) v2.push(l2.noteCall('read', { file_path: 'D:/same.txt' }));
  ok(v2[2] !== null, 'ledger：完全相同的调用会被叫停');

  // 3) 连续失败
  const l3 = createLedger({ maxSameCall: 999, maxSameTarget: 999, maxFailures: 3, maxCallsPerTurn: 999 });
  l3.noteResult(false);
  l3.noteResult(false);
  ok(l3.noteCall('a', { file_path: 'D:/f1' }) === null, 'ledger：失败两次还不叫停');
  l3.noteResult(false);
  const v3 = l3.noteCall('b', { file_path: 'D:/f2' });
  ok(v3 !== null && v3.kind === 'failures', 'ledger：连续失败够数就叫停（换个工具也拦）');

  // 4) 成功了就清零 —— 偶尔失败不该攒成老账
  const l4 = createLedger({ maxSameCall: 999, maxSameTarget: 999, maxFailures: 3, maxCallsPerTurn: 999 });
  l4.noteResult(false);
  l4.noteResult(false);
  l4.noteResult(true);
  l4.noteResult(false);
  eq(l4.get().consecutiveFailures, 1, 'ledger：一次成功就把连续失败清零');

  // 5) 单轮总量硬顶（turn 21 是 59 次）
  const l5 = createLedger({ maxSameCall: 999, maxSameTarget: 999, maxFailures: 999, maxCallsPerTurn: 3 });
  const v5 = [];
  for (let i = 0; i < 6; i += 1) v5.push(l5.noteCall(`t${i}`, { file_path: `D:/f${i}` }));
  ok(v5[3] !== null && v5[3].kind === 'budget', 'ledger：单轮工具调用超量也叫停');

  // 6) 叫停之后不再重复吼
  const l6 = createLedger({ maxSameTarget: 2, muteAfterTrip: true });
  for (let i = 0; i < 3; i += 1) l6.noteCall('write', { file_path: 'D:/x' });
  eq(l6.noteCall('write', { file_path: 'D:/x' }), null, 'ledger：叫停后同一轮不再重复叫停');

  // 7) reset 之后重新记账
  const l7 = createLedger({ maxSameTarget: 2 });
  l7.noteCall('write', { file_path: 'D:/x' });
  l7.reset();
  eq(l7.noteCall('write', { file_path: 'D:/x' }), null, 'ledger：换了轮次账本清空（不记仇）');

  // 8) 关掉就什么都不做
  const l8 = createLedger({ enabled: false, maxSameTarget: 1 });
  eq(l8.noteCall('write', { file_path: 'D:/x' }), null, 'ledger：enabled=false 时不叫停');
}

// ── stopMessage：必须给出一条别的出路 ───────────────────────────────────
{
  const text = stopMessage({ kind: 'same-target', detail: 'file:D:/x.py 被动了 12 次', tool: 'write' });
  ok(text.includes('12'), 'stopMessage：把实际次数说出来');
  ok(text.includes('不要再试'), 'stopMessage：明确禁止再试变体');
  ok(text.includes('办不成就说办不成'), 'stopMessage：给出「放弃」这条出路');
}

// ── narrateLine：长任务播报 ─────────────────────────────────────────────
{
  const T = Date.parse('2026-10-27T16:00:00+08:00');
  const cfg = { narrateAfterMs: 180_000, narrateEveryMs: 240_000 };

  // 还没到点
  eq(narrateLine({ startedAt: T, lastNarratedAt: null, alreadySpoke: false }, T + 60_000, cfg), null,
    'narrate：跑了 1 分钟不催');

  // 到点了
  const line = narrateLine({ startedAt: T, lastNarratedAt: null, alreadySpoke: false }, T + 200_000, cfg);
  ok(typeof line === 'string' && line.includes('3 分钟'), 'narrate：跑够 3 分钟就提醒一句');
  ok(line.includes('还没跟用户说过一句'), 'narrate：说的是「没出声」，不是「太慢」');

  // 已经说话就不催 —— 她自己在同步，插件不该多嘴
  eq(narrateLine({ startedAt: T, lastNarratedAt: null, alreadySpoke: true }, T + 400_000, cfg), null,
    'narrate：已经说过话就不再催');

  // 播报过要隔一阵
  eq(narrateLine({ startedAt: T, lastNarratedAt: T + 200_000, alreadySpoke: false }, T + 300_000, cfg), null,
    'narrate：距上次播报不足间隔就不再出声');
  ok(
    typeof narrateLine({ startedAt: T, lastNarratedAt: T + 200_000, alreadySpoke: false }, T + 500_000, cfg) === 'string',
    'narrate：隔够了就再提醒一次',
  );

  // 关掉就不播
  eq(narrateLine({ startedAt: T, lastNarratedAt: null, alreadySpoke: false }, T + 999_000, { ...cfg, narrateAfterMs: 0 }), null,
    'narrate：after=0 表示不播报');

  // 时间戳坏了不能炸
  eq(narrateLine({ startedAt: undefined, lastNarratedAt: null, alreadySpoke: false }, T, cfg), null,
    'narrate：没有起始时间时安静返回 null');
}

// ── 只读工具不计入 target（2026-10-27 误报的回归） ───────────────────────
{
  ok(isReadOnly('read') === true, 'isReadOnly：read 是只读');
  ok(isReadOnly('ops_inspect_local_file') === true, 'isReadOnly：ops_inspect_local_file 是只读');
  ok(isReadOnly('web_fetch') === true, 'isReadOnly：web_fetch 是只读');
  ok(isReadOnly('write') === false, 'isReadOnly：write 不是只读');
  ok(isReadOnly('ops_bash') === false, 'isReadOnly：ops_bash 有副作用（可能是 rm）');

  // 关键回归：同一个文件读 10 次不该被叫停。这是 2026-10-27 真实踩到的那次误报
  // —— 我在排查问题时读同一个文件读了 7 次（每次看不同段落），被自己的插件拦了。
  const l = createLedger({ maxSameTarget: 3, maxSameCall: 99, maxFailures: 99, maxCallsPerTurn: 999 });
  const verdicts = [];
  for (let i = 0; i < 10; i += 1) {
    verdicts.push(l.noteCall('read', { file_path: 'D:/x.js', offset: i * 20 }));
  }
  eq(verdicts.filter((v) => v !== null).length, 0, 'ledger：同一个文件反复读（不同 offset）不该被叫停');

  // 但改成写，就该拦 —— 别把这条例外开得太大。
  const l2 = createLedger({ maxSameTarget: 3, maxSameCall: 99, maxFailures: 99, maxCallsPerTurn: 999 });
  const w = [];
  for (let i = 0; i < 6; i += 1) w.push(l2.noteCall('write', { file_path: 'D:/x.js', content: `v${i}` }));
  ok(w[3] !== null && w[3].kind === 'same-target', 'ledger：同一个文件反复写仍然要叫停');
}

// ── 复现 turn 33 的真实序列 ─────────────────────────────────────────────
{
  // 原始序列（简化）：write 同一个文件、跑同一条命令，反复十几遍，每次都失败。
  const l = createLedger({ ...DEFAULTS });
  const hits = [];
  for (let i = 0; i < 14; i += 1) {
    const w = l.noteCall('write', { file_path: 'D:/Documents/deepseek-harness/default-workspace/_ssh_upload.py', content: `v${i}` });
    if (w !== null) hits.push({ step: i * 2, kind: w.kind });
    const p = l.noteCall('pwsh', { command: `python _ssh_upload.py --try ${i}` });
    if (p !== null) hits.push({ step: i * 2 + 1, kind: p.kind });
    l.noteResult(false);
  }
  ok(hits.length > 0, 'turn33 复现：这种循环一定会被叫停');
  ok(hits[0].step <= 12, `turn33 复现：在第 ${hits[0].step} 次调用内就叫停（不是跑到第 59 次才喊）`);
}

console.log(`\npass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
