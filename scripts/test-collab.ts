import { mergeStates, anchorOf, judgmentOf, leaseIsStale, rulesEqual } from '../src/collab';
import type { AlignmentRow, ComparisonRules, PersistedCollationState, TextUnit } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

const rules: ComparisonRules = { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };

function unit(id: string, text: string): TextUnit {
  return { id, paragraphId: `p-${id}`, paragraphOrder: 1, sentenceOrder: 1, paragraphText: text, text };
}

function row(id: string, left: TextUnit | undefined, right: TextUnit | undefined, patch: Partial<AlignmentRow> = {}): AlignmentRow {
  return {
    id,
    left,
    right,
    status: 'changed',
    similarity: 0.5,
    note: '',
    source: '',
    accepted: false,
    manuallyAdjusted: false,
    ...patch
  };
}

function state(rows: AlignmentRow[], r: ComparisonRules = rules): PersistedCollationState {
  return {
    versions: [],
    leftVersionId: 'v1',
    rightVersionId: 'v2',
    rows,
    rules: r,
    selectedRowId: ''
  };
}

const L1 = unit('L1', '道可道也');
const L2 = unit('L2', '名可名也');
const R1 = unit('R1', '道可道');
const R2 = unit('R2', '名可名');

console.log('lease: stale detection');
check('no lease is stale', leaseIsStale(null) === true);
check('fresh lease not stale', leaseIsStale({ tabId: 'a', acquiredAt: 0, beatAt: Date.now() }) === false);
check('old lease is stale', leaseIsStale({ tabId: 'a', acquiredAt: 0, beatAt: Date.now() - 4000 }) === true);

console.log('merge: neither side changed -> base preserved');
{
  const base = state([row('a', L1, R1), row('b', L2, R2)]);
  const result = mergeStates(base, state([row('a', L1, R1), row('b', L2, R2)]), state([row('a', L1, R1), row('b', L2, R2)]));
  check('rows count', result.rows.length === 2);
  check('no conflicts', result.conflicts.length === 0);
}

console.log('merge: only local edited -> local taken');
{
  const base = state([row('a', L1, R1)]);
  const local = state([row('a', L1, R1, { note: '本方校记', source: '本方来源', status: 'misaligned' })]);
  const remote = state([row('a', L1, R1)]);
  const result = mergeStates(base, local, remote);
  check('note from local', result.rows[0].note === '本方校记');
  check('source from local', result.rows[0].source === '本方来源');
  check('no conflict', !result.rows[0].conflict);
}

console.log('merge: only remote edited -> remote taken');
{
  const base = state([row('a', L1, R1)]);
  const local = state([row('a', L1, R1)]);
  const remote = state([row('a', L1, R1, { note: '对方校记', accepted: true })]);
  const result = mergeStates(base, local, remote);
  check('note from remote', result.rows[0].note === '对方校记');
  check('accepted from remote', result.rows[0].accepted === true);
}

console.log('merge: both edited same row -> conflict with both judgments');
{
  const base = state([row('a', L1, R1)]);
  const local = state([row('a', L1, R1, { note: '本方判断', source: '本方来源', status: 'misaligned' })]);
  const remote = state([row('a', L1, R1, { note: '对方判断', source: '对方来源', status: 'removed' })]);
  const result = mergeStates(base, local, remote);
  check('conflict recorded', result.conflicts.length === 1);
  check('local judgment kept', result.rows[0].conflict?.local.note === '本方判断');
  check('remote judgment kept', result.rows[0].conflict?.remote.note === '对方判断');
  check('local source kept', result.rows[0].conflict?.local.source === '本方来源');
  check('remote source kept', result.rows[0].conflict?.remote.source === '对方来源');
  check('local status kept', result.rows[0].conflict?.local.status === 'misaligned');
  check('remote status kept', result.rows[0].conflict?.remote.status === 'removed');
}

console.log('merge: both edited identically -> no conflict');
{
  const base = state([row('a', L1, R1)]);
  const local = state([row('a', L1, R1, { note: '一样的校记' })]);
  const remote = state([row('a', L1, R1, { note: '一样的校记' })]);
  const result = mergeStates(base, local, remote);
  check('no conflict', result.conflicts.length === 0);
  check('note kept', result.rows[0].note === '一样的校记');
}

console.log('merge: remote realigned, local notes re-anchored by pair anchor');
{
  const base = state([row('a', L1, R1), row('b', L2, R2)]);
  // remote realigned: new ids, same pairs
  const remote = state([row('new-1', L1, R1), row('new-2', L2, R2)]);
  // local kept old structure with a note on pair L1+R1
  const local = state([row('a', L1, R1, { note: '离线校记', source: '离线来源' }), row('b', L2, R2)]);
  const result = mergeStates(base, local, remote);
  check('structure from remote', result.rows[0].id === 'new-1');
  check('note re-anchored', result.rows[0].note === '离线校记');
  check('source re-anchored', result.rows[0].source === '离线来源');
  check('no conflict', result.conflicts.length === 0);
}

console.log('merge: both moved rows -> pendingReview on position mismatch');
{
  const base = state([row('a', L1, R1), row('b', L2, R2)]);
  const local = state([row('b', L2, R2), row('a', L1, R1)]);
  const remote = state([row('b', L2, R2), row('a', L1, R1)]);
  const result = mergeStates(base, local, remote);
  check('no conflict', result.conflicts.length === 0);
  check('order from remote', result.rows[0].id === 'b');
}

console.log('merge: rules changed on remote side -> remote rules win');
{
  const base = state([row('a', L1, R1)], rules);
  const localRules: ComparisonRules = { ...rules, ignorePunctuation: false };
  const remoteRules: ComparisonRules = { ...rules, ignoreVariants: false };
  const local = state([row('a', L1, R1)], localRules);
  const remote = state([row('a', L1, R1)], remoteRules);
  const result = mergeStates(base, local, remote);
  check('remote rules win', rulesEqual(result.rules, remoteRules));
}

console.log('merge: local-only rules change -> local rules kept');
{
  const base = state([row('a', L1, R1)], rules);
  const localRules: ComparisonRules = { ...rules, ignorePunctuation: false };
  const local = state([row('a', L1, R1)], localRules);
  const remote = state([row('a', L1, R1)], rules);
  const result = mergeStates(base, local, remote);
  check('local rules kept', rulesEqual(result.rules, localRules));
}

console.log('merge: anchor identity');
check('anchor uses unit ids', anchorOf(row('x', L1, R1)) === 'L1:R1');
check('anchor for missing side', anchorOf(row('x', L1, undefined)) === 'L1:∅');

console.log('merge: conflict row not double counted');
{
  const base = state([row('a', L1, R1)]);
  const local = state([row('a', L1, R1, { note: '甲' })]);
  const remote = state([row('a', L1, R1, { note: '乙' })]);
  const result = mergeStates(base, local, remote);
  check('conflicts list matches rows', result.conflicts.every((r) => r.conflict));
  check('single row', result.rows.length === 1);
}

if (failures) {
  console.error(`\n${failures} checks failed`);
  process.exit(1);
} else {
  console.log('\nall merge checks passed');
}
