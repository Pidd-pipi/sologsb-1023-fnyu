import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const tmpFile = resolve('node_modules/.tmp-lock-test.cjs');
const result = await build({
  entryPoints: ['src/collaboration/lock.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false
});
writeFileSync(tmpFile, result.outputFiles[0].text);
const mergeTmp = resolve('node_modules/.tmp-merge-test.cjs');
const mergeBundle = await build({
  entryPoints: ['src/collaboration/merge.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false
});
writeFileSync(mergeTmp, mergeBundle.outputFiles[0].text);
const lockMod = await import(pathToFileURL(tmpFile).href);
const { threeWayMerge, rulesSignature, invalidateAcceptedRows } = await import(
  pathToFileURL(mergeTmp).href
);
const lock = lockMod;

// —— 内存版 localStorage（可模拟配额） ——
class MemoryStorage {
  constructor(quotaBytes = Infinity) {
    this.store = new Map();
    this.quotaBytes = quotaBytes;
  }
  get length() {
    return this.store.size;
  }
  key(index) {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    const nextSize = this.usedBytes() - (this.store.get(key)?.length ?? 0) + value.length;
    if (nextSize > this.quotaBytes) {
      const err = new Error('QuotaExceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  usedBytes() {
    let total = 0;
    this.store.forEach((value) => (total += value.length));
    return total;
  }
  clear() {
    this.store.clear();
  }
}

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}

function makeState(revision, rowsPatch = {}) {
  return {
    versions: [{ id: 'v1', name: 'v', source: '', createdAt: '', text: 'x', units: [] }],
    leftVersionId: 'v1',
    rightVersionId: 'v1',
    rows: [
      {
        id: 'r1',
        left: undefined,
        right: undefined,
        status: 'changed',
        similarity: 0.4,
        note: '',
        source: '',
        accepted: false,
        manuallyAdjusted: false,
        ...rowsPatch
      }
    ],
    rules: { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 },
    selectedRowId: '',
    revision,
    updatedAt: new Date().toISOString(),
    pendingVerdicts: []
  };
}

// —— 场景 A：独占写入 + 心跳新鲜时第二页签不能抢锁 ——
{
  console.log('场景A：心跳锁独占与防抢');
  globalThis.localStorage = new MemoryStorage();
  const s1 = makeState(1);
  const rec1 = {
    holderTabId: 'tab1',
    holderLabel: '页签一',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
    draft: s1,
    baseRevision: 1
  };
  assert(lock.writeLock(rec1) === 'ok', '页签一取得写锁');
  const read = lock.readLock();
  assert(read.holderTabId === 'tab1', '锁记录可读');
  assert(!lock.isLockStale(read, Date.now()), '刚写入的心跳是新鲜的');
  assert(lock.isLockStale(read, Date.now() + lock.HEARTBEAT_TIMEOUT + 1), '超过 8 秒无心跳判定崩溃');

  // 页签二在锁新鲜时不应覆盖（由 composable 层在 isLockStale=false 时走分叉）。
  assert(!lock.isLockStale(lock.readLock()), '页签二观察到页签一仍在线 → 应分叉而非抢锁');
}

// —— 场景 B：崩溃后接回锁内草稿 ——
{
  console.log('场景B：页签崩溃后接回草稿');
  globalThis.localStorage = new MemoryStorage();
  const s1 = makeState(3);
  s1.rows[0].note = '页签一崩溃前最后写入的校记';
  lock.writeLock({
    holderTabId: 'tab1',
    holderLabel: '页签一',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: Date.now() - lock.HEARTBEAT_TIMEOUT - 5000,
    draft: s1,
    baseRevision: 3
  });
  // 主稿停留在更早版本。
  const mainOld = makeState(2);
  globalThis.localStorage.setItem(lock.STORAGE_KEYS.main, JSON.stringify(mainOld));

  const stale = lock.readLock();
  assert(lock.isLockStale(stale), '页签一心跳停止');
  assert(stale.draft.rows[0].note === '页签一崩溃前最后写入的校记', '锁内保留崩溃前草稿');

  // 页签二接管：优先使用崩溃草稿（updatedAt 更新）。
  const main = lock.readMainState();
  const recovered = stale.draft.updatedAt >= main.updatedAt ? stale.draft : main;
  assert(recovered.rows[0].note.includes('崩溃前'), '页签二接回的是更新的崩溃草稿');
}

// —— 场景 C：在线分叉 → 离线 stash → 锁释放后三路合并 ——
{
  console.log('场景C：双页签离线接力合并');
  globalThis.localStorage = new MemoryStorage();
  const base = makeState(1);
  globalThis.localStorage.setItem(lock.STORAGE_KEYS.main, JSON.stringify(base));
  lock.writeLock({
    holderTabId: 'tab1',
    holderLabel: '页签一',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
    draft: base,
    baseRevision: 1
  });

  // 页签二在线分叉：写 stash。
  const offlineDraft = JSON.parse(JSON.stringify(base));
  offlineDraft.rows[0].note = '页签二离线写的说明';
  offlineDraft.rows[0].source = '页签二来源';
  const stash = {
    tabId: 'tab2',
    tabLabel: '页签二',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    base,
    draft: offlineDraft
  };
  assert(lock.writeStash(stash) === 'ok', '离线草稿写入 stash');
  assert(lock.readStash('tab2').draft.rows[0].source === '页签二来源', 'stash 可回读');

  // 页签一同时又写了主稿（改另一行不现实，单行情景改 note 会冲突；这里改版本/修订推进）。
  const online = JSON.parse(JSON.stringify(base));
  online.revision = 2;
  online.updatedAt = new Date().toISOString();
  globalThis.localStorage.setItem(lock.STORAGE_KEYS.main, JSON.stringify(online));

  // 页签一正常退出，释放锁。
  lock.clearLock('tab1');
  assert(lock.readLock() === null, '页签一释放锁');

  // 页签二合并：base=stash.base, mine=stash.draft, theirs=main。
  const theirs = lock.readMainState();
  const savedStash = lock.readStash('tab2');
  const merged = threeWayMerge({
    base: savedStash.base,
    mine: savedStash.draft,
    theirs,
    myTabId: 'tab2',
    myTabLabel: '页签二',
    theirTabId: 'tab1',
    theirTabLabel: '页签一'
  });
  assert(merged.conflictCount === 0, '无同行冲突');
  assert(merged.state.rows[0].note === '页签二离线写的说明', '离线说明并入主稿');
  assert(merged.state.revision === 3, '合并后修订号推进到 3');

  // 容量预检通过后分阶段写入（先主稿后锁草稿）。
  const serialized = JSON.stringify(merged.state);
  assert(lock.estimateFreeCapacity(serialized.length * 2), '容量预检通过');
  assert(lock.safeSetItem(lock.STORAGE_KEYS.main, serialized) === 'ok', '主稿写入');
  const lockResult = lock.writeLock({
    holderTabId: 'tab2',
    holderLabel: '页签二',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
    draft: merged.state,
    baseRevision: merged.state.revision
  });
  assert(lockResult === 'ok', '页签二持锁');
  lock.removeStash('tab2');
  assert(lock.readStash('tab2') === null, '合并后 stash 清理');
  assert(lock.readMainState().rows[0].note === '页签二离线写的说明', '主稿即合并结果');
}

// —— 场景 D：容量不足 → 拒绝合并，原稿不动 ——
{
  console.log('场景D：本地容量不足拒绝合并，原稿不动');
  const small = new MemoryStorage(6000);
  globalThis.localStorage = small;
  const base = makeState(1);
  const baseSerialized = JSON.stringify(base);
  globalThis.localStorage.setItem(lock.STORAGE_KEYS.main, baseSerialized);

  // 先写入一些占空间内容，使两倍合并结果放不下。
  const mergedState = makeState(9);
  mergedState.rows[0].note = '离线改动';
  const serialized = JSON.stringify(mergedState);

  // 容量只够主稿 + 约一倍余量：两倍合并结果的预检探针必然失败。
  small.quotaBytes = baseSerialized.length + serialized.length + 50;
  // 预检应失败。
  assert(!lock.estimateFreeCapacity(serialized.length * 2), '容量预检失败 → 拒绝合并');

  // 模拟分阶段：主稿恰好写入成功但锁草稿失败时，要回滚主稿。
  // 把配额设为主稿放得下、主稿+锁放不下。
  const fitOne = new MemoryStorage(baseSerialized.length + serialized.length + 50);
  globalThis.localStorage = fitOne;
  fitOne.setItem(lock.STORAGE_KEYS.main, baseSerialized);
  const mainWrite = lock.safeSetItem(lock.STORAGE_KEYS.main, serialized);
  assert(mainWrite === 'ok', '主稿阶段写入成功');
  const lockWrite = lock.writeLock({
    holderTabId: 'tab2',
    holderLabel: '页签二',
    acquiredAt: new Date().toISOString(),
    heartbeatAt: Date.now(),
    draft: mergedState,
    baseRevision: 9
  });
  assert(lockWrite === 'quota', '锁草稿阶段容量不足');
  // 回滚主稿。
  lock.safeSetItem(lock.STORAGE_KEYS.main, baseSerialized);
  const restored = lock.readMainState();
  assert(restored.revision === 1 && restored.rows[0].note === '', '回滚后主稿保持原样');
}

// —— 场景 E：规则变更使已接受失效（协议层数据配合） ——
{
  console.log('场景E：规则一改，已接受记录失效');
  globalThis.localStorage = new MemoryStorage();
  const oldRules = { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
  const newRules = { ignorePunctuation: false, ignoreVariants: true, candidateWindow: 3 };
  const accepted = makeState(1, { accepted: true, acceptedRulesSig: rulesSignature(oldRules) });
  const next = invalidateAcceptedRows(accepted.rows, newRules);
  assert(next[0].accepted === false, '接受状态失效');
  assert(next[0].acceptedRulesSig === undefined, '旧规则签名被清除');

  // 失效后必须重新接受才能导出（由 guardVerdicts/接受按钮闸口保证，这里验证数据基础）。
  const stillUnaccepted = next.every((r) => !r.accepted);
  assert(stillUnaccepted, '重算完成前所有原已接受行处于未接受状态');
}

if (failures) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
} else {
  console.log('\n锁协议全部断言通过');
}
