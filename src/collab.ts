import type {
  AlignmentRow,
  ComparisonRules,
  PersistedCollationState,
  RowConflict,
  RowJudgment,
  VersionDocument,
  WriteLease
} from './types';

export const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
export const LEASE_KEY = `${STORAGE_KEY}/lease`;
const TAB_ID_KEY = 'sologsb-1023/tab-id';

/** 写入者心跳间隔：持有租约时每 1 秒报一次心跳 */
export const HEARTBEAT_INTERVAL = 1000;
/** 租约有效期：心跳超过 3 秒未到即视为页签崩溃，其他页签可接管 */
export const LEASE_TTL = 3000;
/** 声明租约后等待复核的时间，避免两个页签同时接管 */
const CLAIM_CONFIRM_DELAY = 90;

export function newTabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const created = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(TAB_ID_KEY, created);
    return created;
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function readLease(): WriteLease | null {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    return raw ? (JSON.parse(raw) as WriteLease) : null;
  } catch {
    return null;
  }
}

export function writeLease(lease: WriteLease): void {
  localStorage.setItem(LEASE_KEY, JSON.stringify(lease));
}

export function removeLease(): void {
  try {
    localStorage.removeItem(LEASE_KEY);
  } catch {
    /* 页面关闭前的尽力释放 */
  }
}

export function leaseIsStale(lease: WriteLease | null, now = Date.now()): boolean {
  return !lease || now - lease.beatAt > LEASE_TTL;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 行锚点：一对底本句与参校本句的组合，跨重新对齐也能重新挂接校记 */
export function anchorOf(row: AlignmentRow): string {
  return `${row.left?.id ?? '∅'}:${row.right?.id ?? '∅'}`;
}

export function judgmentOf(row: AlignmentRow): RowJudgment {
  return {
    status: row.status,
    note: row.note,
    source: row.source,
    accepted: row.accepted,
    manuallyAdjusted: row.manuallyAdjusted
  };
}

export function judgmentEqual(a: RowJudgment, b: RowJudgment): boolean {
  return (
    a.status === b.status &&
    a.note === b.note &&
    a.source === b.source &&
    a.accepted === b.accepted &&
    a.manuallyAdjusted === b.manuallyAdjusted
  );
}

export function rulesEqual(a: ComparisonRules, b: ComparisonRules): boolean {
  return (
    a.ignorePunctuation === b.ignorePunctuation &&
    a.ignoreVariants === b.ignoreVariants &&
    a.candidateWindow === b.candidateWindow
  );
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  a.forEach((id) => {
    if (b.has(id)) count += 1;
  });
  return count;
}

export interface MergeResult {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  rows: AlignmentRow[];
  conflicts: AlignmentRow[];
  /** 因对不上新对齐行而未能挂接的离线校记条数 */
  droppedCount: number;
}

function conflictFor(local: RowJudgment, remote: RowJudgment): RowConflict {
  return { local, remote, detectedAt: new Date().toISOString() };
}

/**
 * 三方合并：base 为双方上次共同见到的草稿，local 为本页签离线状态，remote 为已写入的最新草稿。
 * 同一对齐行双方都改过且不一致时，保留双方判断、说明与来源，列待裁决。
 */
export function mergeStates(
  base: PersistedCollationState,
  local: PersistedCollationState,
  remote: PersistedCollationState
): MergeResult {
  const versionMap = new Map<string, VersionDocument>();
  [...base.versions, ...local.versions, ...remote.versions].forEach((version) => {
    if (!versionMap.has(version.id)) versionMap.set(version.id, version);
  });
  const versions = [...versionMap.values()];

  const leftVersionId =
    local.leftVersionId !== base.leftVersionId && remote.leftVersionId === base.leftVersionId
      ? local.leftVersionId
      : remote.leftVersionId;
  const rightVersionId =
    local.rightVersionId !== base.rightVersionId && remote.rightVersionId === base.rightVersionId
      ? local.rightVersionId
      : remote.rightVersionId;

  const remoteRulesChanged = !rulesEqual(remote.rules, base.rules);
  // 规则以已写入草稿为准；仅本页签离线改过规则时才采用本页签规则
  const rules: ComparisonRules = remoteRulesChanged ? { ...remote.rules } : { ...local.rules };

  const baseIds = new Set(base.rows.map((row) => row.id));
  const localIds = new Set(local.rows.map((row) => row.id));
  const remoteIds = new Set(remote.rows.map((row) => row.id));
  const replaced = (ids: Set<string>) =>
    baseIds.size > 0 && intersectSize(ids, baseIds) / baseIds.size < 0.5;
  const localReplaced = replaced(localIds);
  const remoteReplaced = replaced(remoteIds);

  const conflicts: AlignmentRow[] = [];
  let rows: AlignmentRow[];
  let droppedCount = 0;

  if (remoteReplaced || localReplaced) {
    // 某一方整体重新对齐：以新结构为骨架，把另一方的离线校记按句对锚点重新挂接
    const structureSide = remoteReplaced ? 'remote' : 'local';
    const structureRows = structureSide === 'remote' ? remote.rows : local.rows;
    const otherRows = structureSide === 'remote' ? local.rows : remote.rows;
    const otherByAnchor = new Map(otherRows.map((row) => [anchorOf(row), row]));
    const structureAnchors = new Set(structureRows.map((row) => anchorOf(row)));

    rows = structureRows.map((structureRow) => {
      const otherRow = otherByAnchor.get(anchorOf(structureRow));
      if (!otherRow) return structureRow;
      const otherJudgment = judgmentOf(otherRow);
      const hasUserContent =
        otherJudgment.note.trim() !== '' || otherJudgment.source.trim() !== '' || otherJudgment.accepted;
      if (!hasUserContent) return structureRow;
      const structureJudgment = judgmentOf(structureRow);
      const structureHasContent =
        structureJudgment.note.trim() !== '' ||
        structureJudgment.source.trim() !== '' ||
        structureJudgment.accepted;
      if (structureHasContent) {
        const merged = {
          ...structureRow,
          conflict: conflictFor(
            structureSide === 'remote' ? otherJudgment : structureJudgment,
            structureSide === 'remote' ? structureJudgment : otherJudgment
          )
        };
        conflicts.push(merged);
        return merged;
      }
      return {
        ...structureRow,
        note: otherJudgment.note || structureRow.note,
        source: otherJudgment.source || structureRow.source,
        accepted: structureRow.accepted || otherJudgment.accepted
      };
    });

    otherRows.forEach((row) => {
      if (!structureAnchors.has(anchorOf(row))) {
        const judgment = judgmentOf(row);
        if (judgment.note.trim() !== '' || judgment.source.trim() !== '' || judgment.accepted) {
          droppedCount += 1;
        }
      }
    });
  } else {
    rows = mergeById(base, local, remote, conflicts);
  }

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rules,
    rows,
    conflicts: rows.filter((row) => row.conflict),
    droppedCount
  };
}

function mergeById(
  base: PersistedCollationState,
  local: PersistedCollationState,
  remote: PersistedCollationState,
  conflicts: AlignmentRow[]
): AlignmentRow[] {
  const baseById = new Map(base.rows.map((row) => [row.id, row]));
  const localById = new Map(local.rows.map((row) => [row.id, row]));
  const remoteById = new Map(remote.rows.map((row) => [row.id, row]));
  const ids = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);

  const mergedById = new Map<string, AlignmentRow>();
  ids.forEach((id) => {
    const b = baseById.get(id);
    const l = localById.get(id);
    const r = remoteById.get(id);
    let result: AlignmentRow;
    if (l && r) {
      const baseJudgment = b ? judgmentOf(b) : null;
      const localJudgment = judgmentOf(l);
      const remoteJudgment = judgmentOf(r);
      const localChanged = !baseJudgment || !judgmentEqual(localJudgment, baseJudgment);
      const remoteChanged = !baseJudgment || !judgmentEqual(remoteJudgment, baseJudgment);
      if (localChanged && remoteChanged && !judgmentEqual(localJudgment, remoteJudgment)) {
        result = { ...l, conflict: conflictFor(localJudgment, remoteJudgment) };
        conflicts.push(result);
      } else if (localChanged) {
        result = l;
      } else if (remoteChanged) {
        result = r;
      } else {
        result = b ?? l;
      }
    } else if (l) {
      result = l;
    } else {
      result = r!;
    }
    mergedById.set(id, result);
  });

  const commonIdOrder = (rows: AlignmentRow[], common: Set<string>) =>
    rows.map((row) => row.id).filter((id) => common.has(id));
  const commonOf = (a: Set<string>, b: Set<string>) => new Set([...a].filter((id) => b.has(id)));
  const localCommon = commonOf(new Set(baseById.keys()), new Set(localById.keys()));
  const remoteCommon = commonOf(new Set(baseById.keys()), new Set(remoteById.keys()));
  const localMoved =
    localCommon.size > 0 &&
    JSON.stringify(commonIdOrder(base.rows, localCommon)) !== JSON.stringify(commonIdOrder(local.rows, localCommon));
  const remoteMoved =
    remoteCommon.size > 0 &&
    JSON.stringify(commonIdOrder(base.rows, remoteCommon)) !== JSON.stringify(commonIdOrder(remote.rows, remoteCommon));

  let orderedIds: string[];
  if (localMoved && !remoteMoved) {
    orderedIds = local.rows.map((row) => row.id);
  } else {
    orderedIds = remote.rows.map((row) => row.id);
  }

  if (localMoved && remoteMoved) {
    // 双方都挪动过：保留最新写入方的次序，位置与本页签不一致的行标待复核
    const localOrder = new Map(local.rows.map((row, index) => [row.id, index]));
    orderedIds.forEach((id) => {
      const row = mergedById.get(id);
      if (row && !row.conflict && localOrder.has(id)) {
        const remoteIndex = remote.rows.findIndex((item) => item.id === id);
        const localIndex = localOrder.get(id)!;
        if (remoteIndex !== localIndex) row.pendingReview = true;
      }
    });
  }

  const orderedSet = new Set(orderedIds);
  local.rows.forEach((row) => {
    if (!orderedSet.has(row.id)) {
      const localIndex = local.rows.findIndex((item) => item.id === row.id);
      let insertAt = orderedIds.length;
      for (let cursor = localIndex - 1; cursor >= 0; cursor -= 1) {
        const predecessor = local.rows[cursor].id;
        const position = orderedIds.indexOf(predecessor);
        if (position >= 0) {
          insertAt = position + 1;
          break;
        }
      }
      orderedIds.splice(insertAt, 0, row.id);
    }
  });

  return orderedIds.map((id) => mergedById.get(id)).filter((row): row is AlignmentRow => Boolean(row));
}
