import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const tmpFile = resolve('node_modules/.tmp-merge-test.cjs');

// 把纯逻辑模块（merge.ts）打包成 CJS 临时文件，再用 node 跑断言。
const result = await build({
  entryPoints: ['src/collaboration/merge.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false
});

writeFileSync(tmpFile, result.outputFiles[0].text);

const {
  threeWayMerge,
  resolveRowVerdict,
  resolveRulesVerdict,
  normalizeState,
  invalidateAcceptedRows,
  rulesSignature
} = await import(pathToFileURL(tmpFile).href);

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

function unit(id, text = id) {
  return {
    id,
    paragraphId: `${id}-p`,
    paragraphOrder: 1,
    sentenceOrder: 1,
    paragraphText: text,
    text
  };
}

function row(id, patch = {}) {
  return {
    id,
    left: unit(`l-${id}`),
    right: unit(`r-${id}`),
    status: 'changed',
    similarity: 0.5,
    note: '',
    source: '',
    accepted: false,
    manuallyAdjusted: false,
    ...patch
  };
}

function state(rows, rules = { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 }, revision = 1) {
  return {
    versions: [],
    leftVersionId: '',
    rightVersionId: '',
    rows,
    rules,
    selectedRowId: '',
    revision,
    updatedAt: new Date().toISOString(),
    pendingVerdicts: []
  };
}

// —— 场景 1：双方改不同行 → 都并入，无冲突 ——
{
  console.log('场景1：不同行离线改动自动并入');
  const base = state([row('a'), row('b'), row('c')]);
  const mine = normalizeState(structuredClone(base));
  mine.rows[0].note = '我改了A';
  const theirs = normalizeState(structuredClone(base));
  theirs.rows[1].note = '对方改了B';
  theirs.revision = 2;

  const merged = threeWayMerge({
    base,
    mine,
    theirs,
    myTabId: 't1',
    myTabLabel: '页签一',
    theirTabId: 't2',
    theirTabLabel: '页签二'
  });
  assert(merged.conflictCount === 0, '无冲突');
  assert(merged.state.rows.find((r) => r.id === 'a').note === '我改了A', '我方对A的说明并入');
  assert(merged.state.rows.find((r) => r.id === 'b').note === '对方改了B', '对方对B的说明并入');
  assert(merged.state.revision === 3, '修订号在对方基础上 +1');
}

// —— 场景 2：双方改同一行 → 双方判断/说明/来源保留为待裁决 ——
{
  console.log('场景2：同一对齐行双方都改 → 待裁决，保留各自判断/说明/来源');
  const base = state([row('a')]);
  const mine = normalizeState(structuredClone(base));
  Object.assign(mine.rows[0], { status: 'changed', note: '我方判断：改动', source: '甲本' });
  const theirs = normalizeState(structuredClone(base));
  Object.assign(theirs.rows[0], { status: 'same', note: '对方判断：相同', source: '乙本', accepted: true });
  theirs.revision = 2;

  const merged = threeWayMerge({
    base,
    mine,
    theirs,
    myTabId: 't1',
    myTabLabel: '页签一',
    theirTabId: 't2',
    theirTabLabel: '页签二'
  });
  assert(merged.conflictCount === 1, '产生 1 条待裁决');
  assert(merged.state.pendingVerdicts.length === 1, '待裁决列表 1 条');
  const verdict = merged.state.pendingVerdicts[0];
  assert(verdict.kind === 'row', '类型为行冲突');
  assert(verdict.mine.fields.note === '我方判断：改动' && verdict.mine.fields.source === '甲本', '保留我方说明与来源');
  assert(verdict.theirs.fields.note === '对方判断：相同' && verdict.theirs.fields.source === '乙本', '保留对方说明与来源');
  assert(verdict.theirs.fields.status === 'same' && verdict.mine.fields.status === 'changed', '保留双方判断类别');
  assert(verdict.base !== undefined, '保留分叉时底稿');
  assert(merged.state.rows[0].pendingVerdictId === verdict.id, '结果行被标记待裁决');
  assert(merged.state.rows[0].needsReview === true, '结果行同时标待复核');

  // 裁决采用对方
  const resolved = resolveRowVerdict(merged.state, verdict.id, 'theirs');
  assert(resolved.pendingVerdicts.length === 0, '裁决后待裁决清空');
  assert(resolved.rows[0].note === '对方判断：相同', '采用对方说明');
  assert(resolved.rows[0].source === '乙本', '采用对方来源');
  assert(resolved.rows[0].status === 'same', '采用对方判断');
  assert(resolved.rows[0].accepted === false && resolved.rows[0].needsReview === true, '裁决后不自动接受，转待复核');
  assert(!resolved.rows[0].pendingVerdictId, '裁决标记清除');
}

// —— 场景 3：一方删行，另一方改该行 → 保留改动，不静默丢失 ——
{
  console.log('场景3：一方删行另一方改行');
  const base = state([row('a'), row('b')]);
  const mine = normalizeState(structuredClone(base));
  mine.rows[0].note = '我方保留并修改A';
  const theirs = normalizeState(structuredClone(base));
  theirs.rows = theirs.rows.filter((r) => r.id !== 'a');
  theirs.revision = 2;

  const merged = threeWayMerge({
    base,
    mine,
    theirs,
    myTabId: 't1',
    myTabLabel: '页签一',
    theirTabId: 't2',
    theirTabLabel: '页签二'
  });
  assert(merged.state.rows.some((r) => r.id === 'a'), '对方删除但我方修改的行被保留');
  assert(merged.state.rows.find((r) => r.id === 'a').note === '我方保留并修改A', '保留我方修改内容');
}

// —— 场景 4：双方都改规则 → 规则冲突进待裁决，采用我方版本 ——
{
  console.log('场景4：双方修改比较规则');
  const oldRules = { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
  const base = state([row('a', { accepted: true, acceptedRulesSig: rulesSignature(oldRules) })]);
  const mine = normalizeState(structuredClone(base));
  mine.rules = { ignorePunctuation: false, ignoreVariants: true, candidateWindow: 3 };
  const theirs = normalizeState(structuredClone(base));
  theirs.rules = { ignorePunctuation: true, ignoreVariants: false, candidateWindow: 3 };
  theirs.revision = 2;

  const merged = threeWayMerge({
    base,
    mine,
    theirs,
    myTabId: 't1',
    myTabLabel: '页签一',
    theirTabId: 't2',
    theirTabLabel: '页签二'
  });
  assert(merged.state.rules.ignorePunctuation === false, '采用我方规则');
  assert(merged.state.pendingVerdicts.some((v) => v.kind === 'rules'), '规则冲突进待裁决');
  const rulesVerdict = merged.state.pendingVerdicts.find((v) => v.kind === 'rules');
  assert(rulesVerdict.mine.fields.note.includes('保留标点'), '记录我方规则描述');
  assert(rulesVerdict.theirs.fields.note.includes('不忽略异体字'), '记录对方规则描述');
  // 已接受记录在新规则下失效
  assert(merged.state.rows[0].accepted === false, '原已接受记录失效');

  const resolved = resolveRulesVerdict(merged.state, rulesVerdict.id, 'theirs');
  assert(resolved.rules.ignoreVariants === false, '裁决后采用对方规则');
  assert(resolved.pendingVerdicts.length === 0, '规则裁决清空');
}

// —— 场景 5：规则签名变化 → 已接受失效，人工挪动保留并待复核 ——
{
  console.log('场景5：规则变化后已接受记录失效，人工挪动保留');
  const oldRules = { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
  const newRules = { ignorePunctuation: false, ignoreVariants: true, candidateWindow: 3 };
  const rowsData = [
    row('auto', { accepted: true, acceptedRulesSig: rulesSignature(oldRules) }),
    row('manual', {
      accepted: true,
      acceptedRulesSig: rulesSignature(oldRules),
      manuallyAdjusted: true,
      note: '人工挪过',
      status: 'misaligned'
    })
  ];
  const next = invalidateAcceptedRows(rowsData, newRules);
  assert(next[0].accepted === false, '自动接受行失效');
  assert(next[1].accepted === false, '人工行接受状态失效');
  assert(next[1].needsReview === true, '人工挪动行标待复核');
  assert(next[1].manuallyAdjusted === true && next[1].note === '人工挪过', '人工挪动与说明保留');
  assert(next[1].status === 'misaligned', '人工判断类别不被自动覆盖');
  assert(next[0].needsReview !== true, '非人工行不打待复核（会被自动重算状态）');
}

// —— 场景 6：双方各新增行 → 都并入；同一配对键新增且字段不同 → 冲突 ——
{
  console.log('场景6：新增行合并');
  const shared = unit('l-new');
  const base = state([]);
  const mine = normalizeState(state([
    row('mine-only'),
    row('both-new', { left: shared, right: unit('r-new'), note: '我新增的校记' })
  ]));
  const theirs = normalizeState(state([
    row('their-only'),
    row('both-new-x', { left: { ...shared }, right: { ...unit('r-new') }, note: '对方新增的校记' })
  ], undefined, 2));

  const merged = threeWayMerge({
    base,
    mine,
    theirs,
    myTabId: 't1',
    myTabLabel: '页签一',
    theirTabId: 't2',
    theirTabLabel: '页签二'
  });
  const ids = merged.state.rows.map((r) => r.id);
  assert(ids.includes('mine-only'), '我方独有新增行并入');
  assert(ids.includes('their-only'), '对方独有新增行并入');
  assert(merged.conflictCount === 1, '同配对键新增且校记不同 → 1 条冲突');
  assert(merged.state.pendingVerdicts[0].mine.fields.note === '我新增的校记', '冲突保留我方校记');
  assert(merged.state.pendingVerdicts[0].theirs.fields.note === '对方新增的校记', '冲突保留对方校记');
}

// —— 场景 7：旧版草稿迁移 ——
{
  console.log('场景7：旧版本地草稿迁移');
  const legacy = {
    versions: [{ id: 'v1' }],
    leftVersionId: 'v1',
    rightVersionId: 'v2',
    rows: [{ id: 'r1', status: 'same', similarity: 1 }],
    rules: undefined,
    selectedRowId: 'r1'
  };
  const normalized = normalizeState(legacy);
  assert(normalized.revision === 0, '补默认修订号');
  assert(Array.isArray(normalized.pendingVerdicts), '补待裁决数组');
  assert(normalized.rows[0].accepted === false, '补接受标记');
  assert(normalized.rules.ignorePunctuation === true, '补默认规则');
}

if (failures) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
} else {
  console.log('\n全部断言通过');
}
