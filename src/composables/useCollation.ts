import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import {
  HEARTBEAT_INTERVAL,
  LEASE_KEY,
  LEASE_TTL,
  STORAGE_KEY,
  anchorOf,
  leaseIsStale,
  mergeStates,
  newTabId,
  readLease,
  removeLease,
  rulesEqual,
  wait,
  writeLease
} from '../collab';
import type {
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  RowConflict,
  TextUnit,
  VersionDocument,
  WriteLease
} from '../types';

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
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

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
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted && !row.conflict).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);

  // ---- 离线校勘接力：写入租约 / 心跳 / 合并状态 ----
  const tabId = newTabId();
  /** holder = 本页签持有写入权；waiter = 其他页签在写，本页签离线改动稍后合并 */
  const relayState = ref<'holder' | 'waiter'>('waiter');
  const leaseHolderId = ref('');
  /** 本页签有尚未合并的离线改动 */
  const dirty = ref(false);
  /** 本页签相对上次同步草稿的离线改动行数 */
  const pendingChanges = ref(0);
  const conflictCount = computed(() => rows.value.filter((row) => row.conflict).length);
  const pendingReviewCount = computed(() => rows.value.filter((row) => row.pendingReview).length);

  /** 上次共同见到的草稿（JSON 字符串），用于三方合并 */
  let baseRaw = '';
  let heartbeatTimer: number | undefined;
  let merging = false;

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(data);
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
  }

  /** 容量探针：先写一条等大的探针数据，成功才允许正式写入；失败则原稿不动 */
  function probeQuota(raw: string): boolean {
    try {
      const probeKey = `${STORAGE_KEY}__probe`;
      localStorage.setItem(probeKey, raw);
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  function writeDraft(raw: string): boolean {
    if (!probeQuota(raw)) {
      message.value = '本地存储容量不足，已拒绝写入，原稿未改动';
      return false;
    }
    try {
      localStorage.setItem(STORAGE_KEY, raw);
      return true;
    } catch {
      message.value = '本地存储写入失败，原稿未改动';
      return false;
    }
  }

  function refreshPendingCount() {
    if (!baseRaw) {
      pendingChanges.value = dirty.value ? rows.value.length : 0;
      return;
    }
    try {
      const baseRows = (JSON.parse(baseRaw) as PersistedCollationState).rows;
      const baseByAnchor = new Map(baseRows.map((row) => [anchorOf(row), row]));
      let count = 0;
      rows.value.forEach((row) => {
        const baseRow = baseByAnchor.get(anchorOf(row));
        if (!baseRow) {
          count += 1;
          return;
        }
        const changed =
          row.status !== baseRow.status ||
          row.note !== baseRow.note ||
          row.source !== baseRow.source ||
          row.accepted !== baseRow.accepted ||
          row.manuallyAdjusted !== baseRow.manuallyAdjusted ||
          row.pendingReview !== baseRow.pendingReview ||
          Boolean(row.conflict) !== Boolean(baseRow.conflict);
        if (changed) count += 1;
      });
      pendingChanges.value = count;
    } catch {
      pendingChanges.value = 0;
    }
  }

  /** 只有持有写入权的页签才落盘；等待页签的改动先记在本地，合并时再写入 */
  function persist() {
    if (relayState.value !== 'holder') {
      dirty.value = true;
      refreshPendingCount();
      return;
    }
    const raw = snapshot();
    if (writeDraft(raw)) {
      baseRaw = raw;
      dirty.value = false;
      refreshPendingCount();
    }
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
    persist();
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
    persist();
  }

  /** 比较规则变更后：已接受校勘记录失效重算；人工挪动保留配对但标待复核 */
  function applyRulesInvalidation(target: AlignmentRow[], nextRules: ComparisonRules) {
    target.forEach((row) => {
      if (row.conflict) return;
      if (row.left && row.right) {
        const score = Number(
          similarity(normalized(row.left.text, nextRules), normalized(row.right.text, nextRules)).toFixed(3)
        );
        row.similarity = score;
        row.status = statusFor(row.left, row.right, score);
      }
      row.accepted = false;
      if (row.manuallyAdjusted) row.pendingReview = true;
    });
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
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
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异，已接受记录失效', () => {
      applyRulesInvalidation(rows.value, rules.value);
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true, pendingReview: false });
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
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
        row.pendingReview = false;
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
      row.pendingReview = false;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    const conflictIds = new Set(rows.value.filter((row) => row.conflict).map((row) => row.id));
    const blocked = ids.filter((id) => conflictIds.has(id));
    const allowed = ids.filter((id) => !conflictIds.has(id));
    if (blocked.length) {
      message.value = `${blocked.length} 条行合并冲突尚未裁决，不能接受；已跳过冲突行`;
    }
    if (!allowed.length) return;
    commit(`已接受 ${allowed.length} 条校对建议`, () => {
      const selected = new Set(allowed);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) {
          row.accepted = true;
          row.pendingReview = false;
        }
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    if (conflictCount.value) {
      message.value = `存在 ${conflictCount.value} 条待裁决行冲突，处理前不能接受；请先在“待裁决冲突”中裁决`;
      return;
    }
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
        row.pendingReview = false;
      });
      selectedRowIds.value = [];
    });
  }

  function resolveConflict(id: string, side: 'local' | 'remote') {
    const row = rows.value.find((item) => item.id === id);
    if (!row || !row.conflict) return;
    const judgment = side === 'local' ? row.conflict.local : row.conflict.remote;
    commit(side === 'local' ? '已采用本方判断，冲突已裁决' : '已采用对方判断，冲突已裁决', () => {
      row.status = judgment.status;
      row.note = judgment.note;
      row.source = judgment.source;
      row.accepted = false;
      row.manuallyAdjusted = true;
      row.pendingReview = false;
      row.conflict = null;
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
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
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

  function exportMarkdown() {
    if (conflictCount.value) {
      message.value = '存在待裁决的行合并冲突，裁决前不能导出校勘记';
      return '';
    }
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
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    if (conflictCount.value) {
      message.value = '存在待裁决的行合并冲突，裁决前不能导出校勘数据';
      return '';
    }
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  // ---- 写入租约与离线合并 ----

  async function tryAcquireLease(): Promise<boolean> {
    const lease = readLease();
    if (!leaseIsStale(lease) && lease?.tabId !== tabId) return false;
    const now = Date.now();
    const next: WriteLease = { tabId, acquiredAt: lease?.acquiredAt ?? now, beatAt: now };
    writeLease(next);
    await wait(90);
    const current = readLease();
    return current?.tabId === tabId;
  }

  function startHeartbeat() {
    if (heartbeatTimer !== undefined) return;
    heartbeatTimer = window.setInterval(() => {
      if (relayState.value === 'holder') {
        const lease = readLease();
        if (lease && lease.tabId !== tabId) {
          lostLease();
          return;
        }
        writeLease({ tabId, acquiredAt: lease?.acquiredAt ?? Date.now(), beatAt: Date.now() });
      } else {
        const lease = readLease();
        leaseHolderId.value = lease?.tabId ?? '';
        if (leaseIsStale(lease)) {
          void tryAcquireLease().then((acquired) => {
            if (acquired) void onBecameHolder();
          });
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  function lostLease() {
    relayState.value = 'waiter';
    leaseHolderId.value = readLease()?.tabId ?? '';
    message.value = '写入权已被其他页签接管；本页签改动保留在本地，下次获得写入权时合并';
    refreshPendingCount();
  }

  async function mergeWithRemote(remoteRaw: string) {
    if (merging) return;
    merging = true;
    try {
      const baseState = JSON.parse(baseRaw) as PersistedCollationState;
      const remoteState = JSON.parse(remoteRaw) as PersistedCollationState;
      const localState = JSON.parse(snapshot()) as PersistedCollationState;
      const result = mergeStates(baseState, localState, remoteState);

      const rulesChanged = !rulesEqual(result.rules, baseState.rules);
      if (rulesChanged) applyRulesInvalidation(result.rows, result.rules);

      const mergedState: PersistedCollationState = {
        versions: result.versions,
        leftVersionId: result.leftVersionId,
        rightVersionId: result.rightVersionId,
        rows: result.rows,
        rules: result.rules,
        selectedRowId:
          result.rows.find((row) => row.conflict)?.id ??
          result.rows.find((row) => row.status !== 'same')?.id ??
          result.rows[0]?.id ??
          ''
      };
      const mergedRaw = JSON.stringify(mergedState);

      if (!probeQuota(mergedRaw)) {
        message.value = '合并后数据超出本地存储容量，已拒绝合并，原稿未改动';
        removeLease();
        relayState.value = 'waiter';
        leaseHolderId.value = '';
        return;
      }

      versions.value = result.versions;
      leftVersionId.value = result.leftVersionId;
      rightVersionId.value = result.rightVersionId;
      rules.value = result.rules;
      rows.value = result.rows;
      selectedRowId.value = mergedState.selectedRowId;
      selectedRowIds.value = [];
      baseRaw = mergedRaw;
      try {
        localStorage.setItem(STORAGE_KEY, mergedRaw);
      } catch {
        message.value = '本地存储写入失败，原稿未改动';
        removeLease();
        relayState.value = 'waiter';
        return;
      }
      dirty.value = false;
      refreshPendingCount();

      const parts: string[] = [];
      parts.push('离线改动已合并，草稿已接回');
      if (result.conflicts.length) {
        parts.push(`${result.conflicts.length} 条行冲突待裁决，处理前不能接受或导出`);
      }
      if (result.droppedCount) {
        parts.push(`${result.droppedCount} 条对不上新对齐行的离线校记未挂接`);
      }
      if (rulesChanged) {
        parts.push('比较规则已变更，已接受记录失效重算，人工挪动行标待复核');
      }
      message.value = parts.join('；');
    } catch {
      message.value = '离线合并失败，已保留本页签改动，原稿未改动';
    } finally {
      merging = false;
    }
  }

  async function onBecameHolder() {
    relayState.value = 'holder';
    leaseHolderId.value = tabId;
    const remoteRaw = localStorage.getItem(STORAGE_KEY);

    if (!remoteRaw) {
      if (!baseRaw) {
        message.value = '已载入示例版本，正在自动对齐…';
        await runAlignment(false);
        baseRaw = snapshot();
      } else {
        baseRaw = snapshot();
      }
      dirty.value = false;
      refreshPendingCount();
      return;
    }

    if (!baseRaw) {
      try {
        restore(remoteRaw);
        baseRaw = remoteRaw;
        message.value = '已接回离线草稿，可继续写入';
      } catch {
        message.value = '本地草稿读取失败，已载入示例数据';
        await runAlignment(false);
        baseRaw = snapshot();
      }
      dirty.value = false;
      refreshPendingCount();
      return;
    }

    if (!dirty.value) {
      try {
        restore(remoteRaw);
        baseRaw = remoteRaw;
        message.value = '已同步其他页签的最新草稿';
      } catch {
        /* 保留本页签状态 */
      }
      refreshPendingCount();
      return;
    }

    await mergeWithRemote(remoteRaw);
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== LEASE_KEY && event.key !== STORAGE_KEY) return;
    if (relayState.value !== 'waiter') return;
    const lease = readLease();
    leaseHolderId.value = lease?.tabId ?? '';
    if (leaseIsStale(lease)) {
      void tryAcquireLease().then((acquired) => {
        if (acquired) void onBecameHolder();
      });
    }
  }

  function onPageHide() {
    if (relayState.value === 'holder') removeLease();
  }

  onMounted(async () => {
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', onPageHide);
    const remoteRaw = localStorage.getItem(STORAGE_KEY);
    const acquired = await tryAcquireLease();
    if (acquired) {
      relayState.value = 'holder';
      leaseHolderId.value = tabId;
      if (remoteRaw) {
        try {
          restore(remoteRaw);
          baseRaw = remoteRaw;
          message.value = '已恢复浏览器中的校勘草稿';
        } catch {
          message.value = '本地草稿读取失败，已载入示例数据';
          await runAlignment(false);
          baseRaw = snapshot();
        }
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        await runAlignment(false);
        baseRaw = snapshot();
      }
    } else {
      relayState.value = 'waiter';
      leaseHolderId.value = readLease()?.tabId ?? '';
      if (remoteRaw) {
        try {
          restore(remoteRaw);
          baseRaw = remoteRaw;
          message.value = '其他页签正在写入；本页签可离线改动，下次获得写入权时合并';
        } catch {
          message.value = '本地草稿读取失败';
        }
      } else {
        message.value = '正在等待其他页签完成首次写入…';
      }
    }
    dirty.value = false;
    startHeartbeat();
    refreshPendingCount();
  });

  onUnmounted(() => {
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', onPageHide);
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
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
    relayState,
    leaseHolderId,
    dirty,
    pendingChanges,
    conflictCount,
    pendingReviewCount,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    resolveConflict,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
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
