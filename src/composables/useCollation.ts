import { computed, onMounted, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PendingVerdict,
  PersistedCollationState,
  TextUnit,
  VersionDocument
} from '../types';
import {
  invalidateAcceptedRows,
  normalizeState,
  nowStamp,
  resolveRowVerdict,
  resolveRulesVerdict,
  rulesSignature,
  threeWayMerge
} from '../collaboration/merge';
import {
  estimateFreeCapacity,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  isLockStale,
  listStashKeys,
  readLock,
  readMainState,
  readStash,
  removeStash,
  safeSetItem,
  STORAGE_KEYS,
  writeLock,
  writeStash,
  clearLock,
  type LockRecord,
  type StashRecord
} from '../collaboration/lock';

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function unitSimilarity(rules: ComparisonRules) {
  return (left: TextUnit, right: TextUnit) =>
    similarity(normalized(left.text, rules), normalized(right.text, rules));
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  const sig = rulesSignature(rules);

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          acceptedRulesSig: score > 0.995 ? sig : undefined,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  const accepted = score > 0.995;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted,
    acceptedRulesSig: accepted ? rulesSignature(rules) : undefined,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

type WorkMode = 'writer' | 'viewer' | 'offline';

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const revision = ref(0);
  const pendingVerdicts = ref<PendingVerdict[]>([]);

  // —— 多页签接力状态 ——
  const tabId = getOrCreateTabId();
  const TAB_LABEL_KEY = 'sologsb-1023/collaboration/tab-label';
  const tabLabel = ref(sessionGet(TAB_LABEL_KEY) ?? makeTabLabel());
  const mode = ref<WorkMode>('viewer');
  const lockHolder = ref<{ tabId: string; label: string; heartbeatAt: number } | null>(null);
  const clock = ref(Date.now());
  const storageWarning = ref('');
  const stashInfo = ref<{ updatedAt: string; baseRevision: number } | null>(null);
  const orphanStashes = ref<StashRecord[]>([]);
  let offlineBase: PersistedCollationState | null = null;
  let stashCreatedAt = '';
  let heartbeatTimer = 0;
  let viewerTimer = 0;

  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);
  const verdictCount = computed(() => pendingVerdicts.value.length);
  const reviewCount = computed(() => rows.value.filter((row) => row.needsReview && !row.pendingVerdictId).length);
  const lockStale = computed(() =>
    lockHolder.value ? clock.value - lockHolder.value.heartbeatAt > HEARTBEAT_TIMEOUT : true
  );

  sessionSet(TAB_LABEL_KEY, tabLabel.value);

  // —— 状态装载 / 快照 ——

  function buildState(): PersistedCollationState {
    return {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      revision: revision.value,
      updatedAt: nowStamp(),
      pendingVerdicts: pendingVerdicts.value
    };
  }

  function snapshot(): string {
    return JSON.stringify(buildState());
  }

  function loadState(state: PersistedCollationState) {
    const normalized = normalizeState(state);
    versions.value = normalized.versions;
    leftVersionId.value = normalized.leftVersionId;
    rightVersionId.value = normalized.rightVersionId;
    rows.value = normalized.rows;
    rules.value = normalized.rules;
    revision.value = normalized.revision;
    pendingVerdicts.value = normalized.pendingVerdicts;
    if (!normalized.rows.some((row) => row.id === selectedRowId.value)) {
      selectedRowId.value = normalized.selectedRowId;
    }
  }

  function refreshLockHolder() {
    const lock = readLock();
    lockHolder.value = lock
      ? { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt }
      : null;
  }

  // —— 本地持久化（写入方写主文档+锁草稿；离页签写 stash）——

  function persist() {
    if (mode.value === 'writer') {
      const state = buildState();
      const serialized = JSON.stringify(state);
      const mainResult = safeSetItem(STORAGE_KEYS.main, serialized);
      const current = readLock();
      const lockRecord: LockRecord = {
        holderTabId: tabId,
        holderLabel: tabLabel.value,
        acquiredAt: current?.acquiredAt ?? nowStamp(),
        heartbeatAt: Date.now(),
        draft: state,
        baseRevision: current?.baseRevision ?? revision.value
      };
      const lockResult = writeLock(lockRecord);
      handleStorageResult(mainResult === 'quota' || lockResult === 'quota');
    } else if (mode.value === 'offline' && offlineBase) {
      const record: StashRecord = {
        tabId,
        tabLabel: tabLabel.value,
        createdAt: stashCreatedAt || nowStamp(),
        updatedAt: nowStamp(),
        base: offlineBase,
        draft: buildState()
      };
      const result = writeStash(record);
      handleStorageResult(result === 'quota');
    }
  }

  function handleStorageResult(quota: boolean) {
    storageWarning.value = quota
      ? '本地存储容量不足，最新改动可能未能写入；清理站点数据或导出后再合并。'
      : '';
  }

  // —— 撤销 / 重做 ——

  function commit(label: string, mutate: () => void) {
    beginWritingIfNeeded();
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    revision.value += 1;
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = normalizeState(JSON.parse(raw) as PersistedCollationState);
    loadState(parsed);
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    beginWritingIfNeeded();
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    beginWritingIfNeeded();
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  // —— 写锁 / 离线分叉 ——

  function acquireWriter(state: PersistedCollationState | null, writeMain: boolean) {
    const now = Date.now();
    if (state) loadState(state);
    const snapshotState = buildState();
    if (writeMain) {
      // 只在主稿为空或接管到更新的崩溃草稿时才覆盖主稿，避免用旧草稿回退主稿。
      const main = readMainState();
      if (!main || main.versions.length === 0 || snapshotState.revision > main.revision) {
        safeSetItem(STORAGE_KEYS.main, JSON.stringify(snapshotState));
      }
    }
    const record: LockRecord = {
      holderTabId: tabId,
      holderLabel: tabLabel.value,
      acquiredAt: nowStamp(),
      heartbeatAt: now,
      draft: snapshotState,
      baseRevision: snapshotState.revision
    };
    handleStorageResult(writeLock(record) === 'quota');
    mode.value = 'writer';
    lockHolder.value = null;
    offlineBase = null;
    stashInfo.value = null;
    stashCreatedAt = '';
  }

  /**
   * 非写入页签发起改动时调用：
   * - 无锁 → 直接成为写入页签；
   * - 锁过期（崩溃）→ 接回锁内草稿继续写；
   * - 对方在线 → 自动分叉为离线编辑，之后走合并。
   */
  function beginWritingIfNeeded(): 'writer' | 'offline' {
    if (mode.value !== 'viewer') return mode.value as 'writer' | 'offline';
    const lock = readLock();
    if (!lock) {
      acquireWriter(readMainState(), false);
      message.value = '本页签取得写入权';
      return 'writer';
    }
    if (isLockStale(lock)) {
      const main = readMainState();
      const recovered = lock.draft ?? main;
      acquireWriter(recovered, true);
      message.value = lock.draft
        ? `检测到写入页签「${lock.holderLabel}」心跳停止，已接回其草稿并接管写入`
        : '原写入页签心跳停止，已接管写入';
      return 'writer';
    }
    // 对方仍在线：分叉离线编辑。
    const main = readMainState();
    if (main) loadState(main);
    offlineBase = clone(main ?? buildState());
    mode.value = 'offline';
    lockHolder.value = { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt };
    stashCreatedAt = nowStamp();
    stashInfo.value = { updatedAt: stashCreatedAt, baseRevision: offlineBase.revision };
    persist();
    message.value = `「${lock.holderLabel}」正在写入，本页签已转为离线编辑，改动稍后合并`;
    return 'offline';
  }

  function releaseWriting() {
    if (mode.value !== 'writer') return;
    persist();
    clearLock(tabId);
    mode.value = 'viewer';
    refreshLockHolder();
    history.value = [];
    future.value = [];
    message.value = '已停止心跳并让出写入权，其他页签可以接手写';
  }

  function discardOfflineChanges() {
    if (mode.value !== 'offline') return;
    removeStash(tabId);
    offlineBase = null;
    stashInfo.value = null;
    stashCreatedAt = '';
    history.value = [];
    future.value = [];
    const main = readMainState();
    if (main) loadState(main);
    mode.value = 'viewer';
    refreshLockHolder();
    message.value = '已放弃本页签的离线改动，回到只读的最新主稿';
  }

  // —— 离线合并 ——

  interface MergePlan {
    base: PersistedCollationState;
    mine: PersistedCollationState;
    theirs: PersistedCollationState;
    theirTabId: string;
    theirTabLabel: string;
    stashToRemove: string | null;
  }

  function buildMergePlan(stash?: StashRecord): MergePlan | null {
    const lock = readLock();
    if (lock && !isLockStale(lock) && lock.holderTabId !== tabId) {
      Message.warning(`写入页签「${lock.holderLabel}」仍在工作，请等待其让出写入权后再合并`);
      return null;
    }
    let base: PersistedCollationState;
    let mine: PersistedCollationState;
    let theirTabId: string;
    let theirTabLabel: string;
    let stashToRemove: string | null = null;

    if (stash) {
      base = stash.base;
      mine = stash.draft;
      theirTabId = stash.tabId;
      theirTabLabel = stash.tabLabel;
      stashToRemove = `${STORAGE_KEYS.stashPrefix}${stash.tabId}`;
    } else {
      if (mode.value !== 'offline' || !offlineBase) {
        Message.info('当前没有待合并的离线改动');
        return null;
      }
      base = offlineBase;
      mine = buildState();
      theirTabId = lock?.holderTabId ?? 'unknown';
      theirTabLabel = lock?.holderLabel ?? '原写入页签';
    }

    // 对方崩溃时优先接回锁内未入主稿的草稿；否则以线上主稿为准。
    const main = readMainState();
    let theirs = main;
    if (lock && isLockStale(lock) && lock.draft) {
      if (!main || (lock.draft.updatedAt >= main.updatedAt && lock.draft.revision >= main.revision)) {
        theirs = lock.draft;
      }
    }
    if (!theirs) {
      Message.error('找不到线上主稿，无法合并');
      return null;
    }
    return { base, mine: clone(mine), theirs: clone(theirs), theirTabId, theirTabLabel, stashToRemove };
  }

  function performMerge(plan: MergePlan, mineLabel: string, mineTabId: string) {
    const { state, conflictCount, mergedChangeCount } = threeWayMerge({
      base: plan.base,
      mine: plan.mine,
      theirs: plan.theirs,
      myTabId: mineTabId,
      myTabLabel: mineLabel,
      theirTabId: plan.theirTabId,
      theirTabLabel: plan.theirTabLabel
    });

    // 容量预检：主稿 + 锁草稿会同时存在，预留两倍体积。
    const serialized = JSON.stringify(state);
    if (!estimateFreeCapacity(serialized.length * 2)) {
      storageWarning.value = '本地容量不足，已拒绝合并，线上原稿与离线原稿均未改动。请导出或清理空间后重试。';
      Message.error('本地容量不足，已拒绝合并，原稿不动');
      return;
    }

    // 分阶段提交：先主稿，再以新主稿为草稿持锁。
    const mainResult = safeSetItem(STORAGE_KEYS.main, serialized);
    if (mainResult === 'quota') {
      storageWarning.value = '本地容量不足，已拒绝合并，原稿不动。';
      Message.error('本地容量不足，已拒绝合并，原稿不动');
      return;
    }
    const record: LockRecord = {
      holderTabId: tabId,
      holderLabel: tabLabel.value,
      acquiredAt: nowStamp(),
      heartbeatAt: Date.now(),
      draft: state,
      baseRevision: state.revision
    };
    const lockResult = writeLock(record);
    if (lockResult === 'quota') {
      // 锁草稿写不下：回滚主稿，保证“原稿不动”。
      safeSetItem(STORAGE_KEYS.main, JSON.stringify(plan.theirs));
      storageWarning.value = '本地容量不足，已拒绝合并，原稿不动。';
      Message.error('本地容量不足，已拒绝合并，原稿不动');
      return;
    }

    if (plan.stashToRemove) {
      try {
        localStorage.removeItem(plan.stashToRemove);
      } catch {
        /* ignore */
      }
      orphanStashes.value = orphanStashes.value.filter((item) => item.tabId !== plan.theirTabId);
    } else {
      removeStash(tabId);
    }

    loadState(state);
    mode.value = 'writer';
    offlineBase = null;
    stashInfo.value = null;
    history.value = [];
    future.value = [];
    storageWarning.value = '';
    if (conflictCount > 0) {
      Message.warning(`合并完成：并入 ${mergedChangeCount} 处改动，${conflictCount} 条双方改动列为待裁决，处理前不能接受或导出`);
      message.value = `离线改动已合并，${conflictCount} 条待裁决；裁决前不能接受或导出`;
    } else {
      Message.success(`合并完成：并入 ${mergedChangeCount} 处改动，无冲突`);
      message.value = '离线改动已合并，未发现冲突';
    }
  }

  function mergeOffline() {
    const plan = buildMergePlan();
    if (plan) performMerge(plan, tabLabel.value, tabId);
  }

  function mergeOrphanStash(stash: StashRecord) {
    const plan = buildMergePlan(stash);
    if (plan) performMerge(plan, stash.tabLabel, stash.tabId);
  }

  // —— 对齐 / 规则重算 ——

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    beginWritingIfNeeded();
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
        revision.value += 1;
      }
      rows.value = result;
      pendingVerdicts.value = [];
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  /** 按当前规则重算：已接受记录失效，人工挪动/判断保留并标待复核。 */
  function applyRulesToRows() {
    const score = unitSimilarity(rules.value);
    rows.value = invalidateAcceptedRows(rows.value, rules.value).map((row) => {
      if (!row.left || !row.right) return row;
      const next: AlignmentRow = { ...row, similarity: Number(score(row.left, row.right).toFixed(3)) };
      if (row.manuallyAdjusted) {
        // 人工挪动/判断保留，只标待复核。
        next.needsReview = true;
      } else {
        next.status = statusFor(row.left, row.right, next.similarity);
      }
      return next;
    });
    selectedRowIds.value = [];
  }

  function recalculate() {
    beginWritingIfNeeded();
    commit('已按比较规则重算差异，原已接受记录失效待复核', applyRulesToRows);
  }

  function toggleRule(field: 'ignorePunctuation' | 'ignoreVariants', value: boolean | string | number) {
    beginWritingIfNeeded();
    commit('已修改比较规则：已接受记录失效重算，人工挪动保留并标待复核', () => {
      rules.value[field] = Boolean(value);
      applyRulesToRows();
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (!row) return;
      Object.assign(row, patch, { manuallyAdjusted: true });
      if (row.accepted) {
        row.acceptedRulesSig = rulesSignature(rules.value);
        row.needsReview = false;
      }
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      const score = unitSimilarity(rules.value);
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(score(row.left, row.right).toFixed(3));
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
        row.accepted = false;
        delete row.acceptedRulesSig;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function guardVerdicts(): boolean {
    if (pendingVerdicts.value.length > 0) {
      Message.warning(`还有 ${pendingVerdicts.value.length} 条待裁决冲突，处理前不能接受或导出`);
      return false;
    }
    return true;
  }

  function acceptRows(ids: string[]) {
    if (!ids.length || !guardVerdicts()) return;
    beginWritingIfNeeded();
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      const sig = rulesSignature(rules.value);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) {
          row.accepted = true;
          row.acceptedRulesSig = sig;
          row.needsReview = false;
        }
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    if (!guardVerdicts()) return;
    beginWritingIfNeeded();
    commit('已批量接受全部差异建议', () => {
      const sig = rulesSignature(rules.value);
      rows.value.forEach((row) => {
        row.accepted = true;
        row.acceptedRulesSig = sig;
        row.needsReview = false;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        if (mode.value !== 'viewer') persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    beginWritingIfNeeded();
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  // —— 待裁决 ——

  function resolveVerdict(verdictId: string, side: 'mine' | 'theirs') {
    if (mode.value !== 'writer') {
      Message.warning('请先取得写入权后再裁决冲突');
      return;
    }
    const verdict = pendingVerdicts.value.find((item) => item.id === verdictId);
    if (!verdict) return;
    history.value.push(snapshot());
    future.value = [];
    let next = buildState();
    next = verdict.kind === 'row' ? resolveRowVerdict(next, verdictId, side) : resolveRulesVerdict(next, verdictId, side);
    loadState(next);
    if (verdict.kind === 'rules') {
      const score = unitSimilarity(rules.value);
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right || row.manuallyAdjusted) return row;
        const similarityScore = Number(score(row.left, row.right).toFixed(3));
        return { ...row, similarity: similarityScore, status: statusFor(row.left, row.right, similarityScore) };
      });
    }
    revision.value += 1;
    message.value = '已按所选一方完成裁决，该行标记为待复核';
    persist();
  }

  function locateVerdictRow(rowId?: string) {
    if (!rowId) return;
    if (rows.value.some((row) => row.id === rowId)) selectedRowId.value = rowId;
  }

  // —— 导出（裁决前禁止）——

  function exportMarkdown(): string {
    if (!guardVerdicts()) return '';
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      const stateLabel = row.pendingVerdictId
        ? '待裁决'
        : row.needsReview
          ? '规则变更待复核'
          : row.accepted
            ? '已接受'
            : '待处理';
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${stateLabel} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson(): string {
    if (!guardVerdicts()) return '';
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        pendingVerdicts: pendingVerdicts.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  // —— 心跳与页签协同 ——

  function writerHeartbeat() {
    clock.value = Date.now();
    const lock = readLock();
    if (!lock) {
      // 锁被清掉（如站点数据被清理）：立即重建。
      persist();
      return;
    }
    if (lock.holderTabId !== tabId) {
      if (!isLockStale(lock)) {
        // 锁被在线的其他页签取得：本页签降级为只读，避免双写。
        demoteToViewer('写入权已被其他页签接管，本页签已切换为只读');
        return;
      }
      persist();
      return;
    }
    const record: LockRecord = { ...lock, heartbeatAt: Date.now(), draft: buildState() };
    const result = writeLock(record);
    handleStorageResult(result === 'quota');
  }

  function viewerTick() {
    clock.value = Date.now();
    const lock = readLock();
    if (mode.value === 'writer') return;
    lockHolder.value = lock
      ? { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt }
      : null;
  }

  function demoteToViewer(text: string) {
    mode.value = 'viewer';
    const main = readMainState();
    if (main) loadState(main);
    refreshLockHolder();
    history.value = [];
    future.value = [];
    message.value = text;
  }

  function onStorage(event: StorageEvent) {
    if (!event.key) return;
    if (event.key === STORAGE_KEYS.lock) {
      const lock = readLock();
      if (mode.value === 'writer') {
        if (lock && lock.holderTabId !== tabId && !isLockStale(lock)) {
          demoteToViewer('写入权已被其他页签接管，本页签已切换为只读');
        }
        return;
      }
      lockHolder.value = lock
        ? { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt }
        : null;
      return;
    }
    if (event.key === STORAGE_KEYS.main) {
      if (mode.value === 'viewer') {
        const main = readMainState();
        if (main) {
          loadState(main);
          message.value = `已同步写入页签的最新主稿（修订 ${main.revision}）`;
        }
      } else if (mode.value === 'writer') {
        const lock = readLock();
        if (lock && lock.holderTabId !== tabId && !isLockStale(lock)) {
          demoteToViewer('检测到其他页签写入主稿，本页签已切换为只读');
        }
      }
      // 离线模式不自动刷新，保持分叉底稿直到合并。
    }
  }

  function flushAndReleaseOnUnload() {
    if (mode.value === 'writer') {
      try {
        localStorage.setItem(STORAGE_KEYS.main, snapshot());
      } catch {
        /* ignore */
      }
      clearLock(tabId);
    }
  }

  onMounted(() => {
    const main = readMainState();
    const lock = readLock();
    const ownStash = readStash(tabId);

    if (ownStash) {
      loadState(ownStash.draft);
      offlineBase = ownStash.base;
      stashCreatedAt = ownStash.createdAt;
      stashInfo.value = { updatedAt: ownStash.updatedAt, baseRevision: ownStash.base.revision };
      mode.value = 'offline';
      lockHolder.value = lock
        ? { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt }
        : null;
      message.value = '已恢复本页签崩溃前的离线草稿，可继续编辑后合并';
    } else if (lock && (lock.holderTabId === tabId || isLockStale(lock))) {
      const recovered = lock.draft ?? main;
      if (recovered && (recovered.versions.length > 0 || main)) {
        acquireWriter(recovered, true);
        message.value = lock.draft
          ? `检测到写入页签心跳停止，已接回草稿并接管写入`
          : '已接管无人持有的写入权';
      } else {
        bootstrapSampleAsWriter();
      }
    } else if (!lock) {
      if (main) {
        acquireWriter(main, false);
        message.value = '已恢复浏览器中的校勘草稿，本页签持有写入权';
      } else {
        bootstrapSampleAsWriter();
      }
    } else {
      if (main) {
        loadState(main);
        message.value = `「${lock.holderLabel}」正在写入，本页签为只读；编辑时将自动转入离线模式`;
      } else {
        bootstrapSampleAsViewer(lock);
      }
      lockHolder.value = { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt };
    }

    // 其他崩溃页签留下的离线草稿：取得写入权后可代为合并。
    if (mode.value === 'writer') {
      const stashes: StashRecord[] = [];
      listStashKeys().forEach((key) => {
        const stash = readStash(key.slice(STORAGE_KEYS.stashPrefix.length));
        if (stash && stash.tabId !== tabId) stashes.push(stash);
      });
      orphanStashes.value = stashes;
    }

    heartbeatTimer = window.setInterval(() => {
      if (mode.value === 'writer') writerHeartbeat();
      else viewerTick();
    }, HEARTBEAT_INTERVAL);
    viewerTimer = window.setInterval(() => {
      clock.value = Date.now();
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        clock.value = Date.now();
        if (mode.value === 'writer') writerHeartbeat();
        else viewerTick();
      }
    });
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', flushAndReleaseOnUnload);
    window.addEventListener('beforeunload', flushAndReleaseOnUnload);
  });

  function bootstrapSampleAsWriter() {
    versions.value = clone(sampleVersions);
    leftVersionId.value = versions.value[0].id;
    rightVersionId.value = versions.value[1].id;
    rules.value = defaultRules();
    acquireWriter(buildState(), false);
    message.value = '已载入示例版本，正在自动对齐…';
    void runAlignment(false);
  }

  function bootstrapSampleAsViewer(lock: LockRecord) {
    versions.value = clone(sampleVersions);
    leftVersionId.value = versions.value[0].id;
    rightVersionId.value = versions.value[1].id;
    rules.value = defaultRules();
    mode.value = 'viewer';
    lockHolder.value = { tabId: lock.holderTabId, label: lock.holderLabel, heartbeatAt: lock.heartbeatAt };
    message.value = `「${lock.holderLabel}」正在写入，本页签为只读`;
  }

  watch(
    [leftVersionId, rightVersionId],
    () => {
      if (mode.value !== 'viewer' && !processing.value) persist();
    }
  );

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    runAlignment,
    recalculate,
    toggleRule,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit,
    // 接力相关
    tabId,
    tabLabel,
    mode,
    lockHolder,
    lockStale,
    clock,
    storageWarning,
    stashInfo,
    orphanStashes,
    verdictCount,
    reviewCount,
    pendingVerdicts,
    beginWriting: beginWritingIfNeeded,
    releaseWriting,
    mergeOffline,
    mergeOrphanStash,
    discardOfflineChanges,
    resolveVerdict,
    locateVerdictRow
  };
}

function getOrCreateTabId(): string {
  const key = `${STORAGE_KEYS.tabPrefix}id`;
  let id = sessionGet(key);
  if (!id) {
    id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    sessionSet(key, id);
  }
  return id;
}

function sessionGet(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function sessionSet(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function makeTabLabel(): string {
  return `页签 ${Math.random().toString(36).slice(2, 6)}`;
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
