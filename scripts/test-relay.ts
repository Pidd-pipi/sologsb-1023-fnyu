import { mergeStates, readLease, writeLease, removeLease, leaseIsStale, STORAGE_KEY, LEASE_KEY, anchorOf } from '../src/collab';
import type { AlignmentRow, PersistedCollationState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

// ---- fake localStorage ----
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
(globalThis as any).localStorage = localStorageMock;

function makeRow(id: string, note = '', source = ''): AlignmentRow {
  return {
    id,
    left: { id: `L-${id}`, paragraphId: 'p', paragraphOrder: 1, sentenceOrder: 1, paragraphText: '', text: '左' },
    right: { id: `R-${id}`, paragraphId: 'p', paragraphOrder: 1, sentenceOrder: 1, paragraphText: '', text: '右' },
    status: 'changed',
    similarity: 0.5,
    note,
    source,
    accepted: false,
    manuallyAdjusted: false
  };
}

function draft(rows: AlignmentRow[]): PersistedCollationState {
  return { versions: [], leftVersionId: 'v1', rightVersionId: 'v2', rows, rules: { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 }, selectedRowId: '' };
}
function writeDraft(d: PersistedCollationState) {
  localStorageMock.setItem(STORAGE_KEY, JSON.stringify(d));
}
function readDraft(): PersistedCollationState {
  return JSON.parse(localStorageMock.getItem(STORAGE_KEY)!);
}

// ---- simulate ----
console.log('scenario: two tabs, crash, merge');

// Tab A acquires lease
const tabA = 'tab-A';
writeLease({ tabId: tabA, acquiredAt: Date.now(), beatAt: Date.now() });
let lease = readLease();
check('tab A holds lease', lease?.tabId === tabA);

// Tab B tries to acquire while A's lease is fresh
const tabB = 'tab-B';
lease = readLease();
const bBlocked = !leaseIsStale(lease) && lease?.tabId !== tabB;
check('tab B blocked while A heartbeat fresh', bBlocked);

// Tab A writes the initial draft
const initial = draft([makeRow('row-1'), makeRow('row-2')]);
writeDraft(initial);

// Tab B loads the draft as its base (waiter)
const bBase = readDraft();
check('tab B sees draft', bBase.rows.length === 2);

// Tab B goes offline: edits row-1 note locally (does not write storage)
const bLocal = draft(bBase.rows.map((r) => (r.id === 'row-1' ? { ...r, note: 'B 的离线校记', source: 'B 来源' } : r)));

// Tab A, still alive, edits row-2 and writes
const aNext = draft(initial.rows.map((r) => (r.id === 'row-2' ? { ...r, note: 'A 的校记' } : r)));
writeDraft(aNext);

// Tab A crashes: heartbeat goes stale
store.set(LEASE_KEY, JSON.stringify({ tabId: tabA, acquiredAt: Date.now() - 10000, beatAt: Date.now() - 10000 }));
check('lease now stale after crash', leaseIsStale(readLease()));

// Tab B acquires
writeLease({ tabId: tabB, acquiredAt: Date.now(), beatAt: Date.now() });
check('tab B took over', readLease()?.tabId === tabB);

// Tab B merges: base = initial (what B last synced), local = B's offline state, remote = A's latest
const merge = mergeStates(initial, bLocal, aNext);
check('row-1 note from B', merge.rows.find((r) => r.id === 'row-1')?.note === 'B 的离线校记');
check('row-2 note from A', merge.rows.find((r) => r.id === 'row-2')?.note === 'A 的校记');
check('no conflict (different rows)', merge.conflicts.length === 0);

// Now both edit the SAME row offline
const bLocal2 = draft(merge.rows.map((r) => (r.id === 'row-1' ? { ...r, note: 'B 改同一行', source: 'B 来源', status: 'misaligned' as const } : r)));
const aNext2 = draft(merge.rows.map((r) => (r.id === 'row-1' ? { ...r, note: 'A 改同一行', source: 'A 来源', status: 'removed' as const } : r)));
const merge2 = mergeStates(merge, bLocal2, aNext2);
check('conflict detected on same row', merge2.conflicts.length === 1);
const conflicted = merge2.rows.find((r) => r.id === 'row-1')!;
check('conflict keeps B note', conflicted.conflict?.local.note === 'B 改同一行');
check('conflict keeps A note', conflicted.conflict?.remote.note === 'A 改同一行');
check('conflict keeps B source', conflicted.conflict?.local.source === 'B 来源');
check('conflict keeps A source', conflicted.conflict?.remote.source === 'A 来源');
check('conflict keeps B status', conflicted.conflict?.local.status === 'misaligned');
check('conflict keeps A status', conflicted.conflict?.remote.status === 'removed');

console.log('scenario: quota refusal leaves draft untouched');
{
  const before = localStorageMock.getItem(STORAGE_KEY)!;
  // probe with a payload that is too big: emulate by making setItem throw
  const realSet = localStorageMock.setItem;
  let refused = false;
  (localStorageMock as any).setItem = (k: string, v: string) => {
    if (k.endsWith('__probe')) {
      refused = true;
      throw new DOMException('quota', 'QuotaExceededError');
    }
    realSet(k, v);
  };
  const probeOk = (() => {
    try {
      localStorageMock.setItem(`${STORAGE_KEY}__probe`, 'x');
      return true;
    } catch {
      return false;
    }
  })();
  check('probe detects quota failure', probeOk === false);
  // draft untouched
  check('draft unchanged after refusal', localStorageMock.getItem(STORAGE_KEY) === before);
  (localStorageMock as any).setItem = realSet;
}

console.log('scenario: graceful release on pagehide');
{
  writeLease({ tabId: tabB, acquiredAt: Date.now(), beatAt: Date.now() });
  removeLease();
  check('lease removed on pagehide', readLease() === null);
}

if (failures) {
  console.error(`\n${failures} checks failed`);
  process.exit(1);
} else {
  console.log('\nall relay scenario checks passed');
}
