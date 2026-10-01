import type {
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PendingVerdict,
  PersistedCollationState,
  RowEditableFields,
  TextUnit,
  VersionDocument,
  VerdictOption
} from '../types';

let verdictSequence = 0;

export function nextVerdictId(): string {
  verdictSequence = (verdictSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `verdict-${Date.now().toString(36)}-${verdictSequence}-${Math.random().toString(36).slice(2, 6)}`;
}

export function nowStamp(): string {
  return new Date().toISOString();
}

/** 参与“接受是否失效”判断的规则签名。 */
export function rulesSignature(rules: ComparisonRules): string {
  return `${rules.ignorePunctuation ? 1 : 0}:${rules.ignoreVariants ? 1 : 0}`;
}

export function pickEditable(row: AlignmentRow): RowEditableFields {
  return {
    status: row.status,
    note: row.note,
    source: row.source,
    accepted: row.accepted
  };
}

function sameEditable(a: RowEditableFields, b: RowEditableFields): boolean {
  return a.status === b.status && a.note === b.note && a.source === b.source && a.accepted === b.accepted;
}

export function rowPairKey(row: AlignmentRow): string {
  return `${row.left?.id ?? '∅'}::${row.right?.id ?? '∅'}`;
}

function rowLabel(row: AlignmentRow): string {
  const text = row.left?.text ?? row.right?.text ?? '';
  return Array.from(text).slice(0, 14).join('');
}

export function makeVerdictOption(
  tabId: string,
  tabLabel: string,
  fields: RowEditableFields,
  at = nowStamp()
): VerdictOption {
  return { tabId, tabLabel, at, fields: { ...fields } };
}

/** 兼容旧版本地草稿，补齐接力功能所需字段。 */
export function normalizeState(raw: PersistedCollationState): PersistedCollationState {
  const rules: ComparisonRules = raw.rules ?? { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
  const state: PersistedCollationState = {
    versions: raw.versions ?? [],
    leftVersionId: raw.leftVersionId ?? raw.versions?.[0]?.id ?? '',
    rightVersionId: raw.rightVersionId ?? raw.versions?.[1]?.id ?? raw.versions?.[0]?.id ?? '',
    rows: (raw.rows ?? []).map((row) => ({
      ...row,
      note: row.note ?? '',
      source: row.source ?? '',
      accepted: Boolean(row.accepted),
      manuallyAdjusted: Boolean(row.manuallyAdjusted),
      needsReview: Boolean(row.needsReview),
      acceptedRulesSig: row.acceptedRulesSig,
      pendingVerdictId: row.pendingVerdictId
    })),
    rules,
    selectedRowId: raw.selectedRowId ?? '',
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    updatedAt: raw.updatedAt ?? nowStamp(),
    pendingVerdicts: Array.isArray(raw.pendingVerdicts) ? raw.pendingVerdicts : []
  };
  // 清掉已经裁决（不在待裁决列表中）的占位标记。
  const live = new Set(state.pendingVerdicts.map((item) => item.id));
  state.rows.forEach((row) => {
    if (row.pendingVerdictId && !live.has(row.pendingVerdictId)) delete row.pendingVerdictId;
  });
  return state;
}

/**
 * 规则变化后让已接受记录失效：
 * - 原已接受的记录 accepted 复位为 false；
 * - 人工挪动过的行保留挪动与说明，只标记待复核；
 * - 不在这里自动改配对。
 */
export function invalidateAcceptedRows(rows: AlignmentRow[], rules: ComparisonRules): AlignmentRow[] {
  const signature = rulesSignature(rules);
  return rows.map((row) => {
    if (row.accepted && (row.acceptedRulesSig ?? signature) !== signature) {
      const next = { ...row, accepted: false, acceptedRulesSig: undefined as string | undefined };
      if (row.manuallyAdjusted) next.needsReview = true;
      return next;
    }
    return row;
  });
}

export interface MergeInput {
  base: PersistedCollationState;
  mine: PersistedCollationState;
  theirs: PersistedCollationState;
  myTabId: string;
  myTabLabel: string;
  theirTabId: string;
  theirTabLabel: string;
}

export interface MergeResult {
  state: PersistedCollationState;
  conflictCount: number;
  mergedChangeCount: number;
}

type RowSide = { row: AlignmentRow; index: number };

class RowIndex {
  byId = new Map<string, RowSide>();
  byPair = new Map<string, RowSide[]>();

  constructor(rows: AlignmentRow[]) {
    rows.forEach((row, index) => {
      this.byId.set(row.id, { row, index });
      const key = rowPairKey(row);
      const list = this.byPair.get(key);
      if (list) list.push({ row, index });
      else this.byPair.set(key, [{ row, index }]);
    });
  }

  lookup(row: AlignmentRow): RowSide | undefined {
    const direct = this.byId.get(row.id);
    if (direct) return direct;
    const candidates = this.byPair.get(rowPairKey(row));
    return candidates && candidates.length === 1 ? candidates[0] : undefined;
  }
}

interface RowGroup {
  rows: AlignmentRow[];
  memberIds: Set<string>;
  /** 底稿行号，用于底稿顺序兜底。 */
  baseOrder: number;
}

function stripVerdictMarker(row: AlignmentRow): AlignmentRow {
  if (!row.pendingVerdictId) return row;
  const next = { ...row };
  delete next.pendingVerdictId;
  return next;
}

/**
 * 三路合并离线改动：
 * - 只有一方改动 → 直接采用；
 * - 双方都改同一行 → 保留当前写入方版本，双方判断/说明/来源进待裁决；
 * - 双方都改比较规则 → 采用当前写入方版本，规则冲突进待裁决；
 * - 任一方删除的行，只有另一方也删掉才删除；
 * - 排序以线上规范版行序为骨架，底稿顺序兜底，新行追加。
 */
export function threeWayMerge(input: MergeInput): MergeResult {
  const { base, mine, theirs } = input;
  const baseIndex = new RowIndex(base.rows);
  const myIndex = new RowIndex(mine.rows);
  const theirIndex = new RowIndex(theirs.rows);

  const groups: RowGroup[] = [];
  const verdicts: PendingVerdict[] = base.pendingVerdicts.map((item) => ({ ...item }));
  let mergedChangeCount = 0;

  const baseOption = (row: AlignmentRow): VerdictOption =>
    makeVerdictOption('base', '分叉时底稿', pickEditable(row), base.updatedAt);

  /**
   * 登记一个结果组。conflict 三元组给齐时表示双方改动且内容不同，需生成待裁决。
   */
  const register = (
    winner: AlignmentRow,
    memberIds: string[],
    baseOrder: number,
    conflict?: { baseRow?: AlignmentRow; myRow: AlignmentRow; theirRow: AlignmentRow }
  ) => {
    let row = stripVerdictMarker(winner);
    if (conflict) {
      const { baseRow, myRow, theirRow } = conflict;
      const verdict: PendingVerdict = {
        id: nextVerdictId(),
        kind: 'row',
        rowId: row.id,
        rowLabel: rowLabel(myRow),
        base: baseRow ? baseOption(baseRow) : undefined,
        mine: makeVerdictOption(input.myTabId, input.myTabLabel, pickEditable(myRow)),
        theirs: makeVerdictOption(input.theirTabId, input.theirTabLabel, pickEditable(theirRow)),
        createdAt: nowStamp()
      };
      verdicts.push(verdict);
      row = { ...row, needsReview: true, pendingVerdictId: verdict.id };
    }
    groups.push({ rows: [row], memberIds: new Set(memberIds), baseOrder });
    mergedChangeCount += 1;
  };

  // 1) 底稿行：按底稿顺序分组。
  base.rows.forEach((baseRow, baseOrder) => {
    const mySide = myIndex.lookup(baseRow);
    const theirSide = theirIndex.lookup(baseRow);
    const memberIds = [baseRow.id];

    if (mySide && theirSide) {
      memberIds.push(mySide.row.id, theirSide.row.id);
      const myChanged = !sameEditable(pickEditable(mySide.row), pickEditable(baseRow));
      const theirChanged = !sameEditable(pickEditable(theirSide.row), pickEditable(baseRow));
      if (myChanged && theirChanged && !sameEditable(pickEditable(mySide.row), pickEditable(theirSide.row))) {
        register(mySide.row, memberIds, baseOrder, { baseRow, myRow: mySide.row, theirRow: theirSide.row });
      } else if (myChanged) {
        register(mySide.row, memberIds, baseOrder);
      } else if (theirChanged) {
        register(theirSide.row, memberIds, baseOrder);
      } else {
        // 双方都没改校勘字段：优先拿线上行（可能带规则重算后的相似度）。
        register(theirSide.row, memberIds, baseOrder);
      }
    } else if (mySide) {
      // 对方删、我方留 → 保留，离线删除不覆盖他方改动。
      memberIds.push(mySide.row.id);
      register(mySide.row, memberIds, baseOrder);
    } else if (theirSide) {
      memberIds.push(theirSide.row.id);
      register(theirSide.row, memberIds, baseOrder);
    }
    // 双方都删除 → 不建组。
  });

  // 2) 新增行（底稿查不到），按配对键匹配合并。
  const isNewRow = (row: AlignmentRow) => !baseIndex.byId.has(row.id) && !baseIndex.byPair.has(rowPairKey(row));
  const myNew = mine.rows.filter(isNewRow);
  const theirNew = theirs.rows.filter(isNewRow);
  const theirMatched = new Set<string>();

  myNew.forEach((myRow) => {
    const pair = rowPairKey(myRow);
    const match = theirNew.find((candidate) => !theirMatched.has(candidate.id) && rowPairKey(candidate) === pair);
    if (match) {
      theirMatched.add(match.id);
      const conflict = sameEditable(pickEditable(myRow), pickEditable(match))
        ? undefined
        : { myRow, theirRow: match };
      register(myRow, [myRow.id, match.id], Number.MAX_SAFE_INTEGER, conflict);
    } else {
      register(myRow, [myRow.id], Number.MAX_SAFE_INTEGER);
    }
  });
  theirNew.forEach((theirRow) => {
    if (!theirMatched.has(theirRow.id)) {
      register(theirRow, [theirRow.id], Number.MAX_SAFE_INTEGER);
    }
  });

  // 3) 排序：线上行序为骨架，底稿顺序兜底，剩余追加。
  const findGroup = (rowId: string): RowGroup | undefined =>
    groups.find((group) => group.memberIds.has(rowId));

  const ordered: AlignmentRow[] = [];
  const placed = new Set<RowGroup>();
  theirs.rows.forEach((theirRow) => {
    const group = findGroup(theirRow.id);
    if (group && !placed.has(group)) {
      ordered.push(group.rows[0]);
      placed.add(group);
    }
  });
  groups
    .filter((group) => !placed.has(group) && group.baseOrder !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.baseOrder - b.baseOrder)
    .forEach((group) => {
      ordered.push(group.rows[0]);
      placed.add(group);
    });
  groups
    .filter((group) => !placed.has(group))
    .forEach((group) => {
      ordered.push(group.rows[0]);
      placed.add(group);
    });

  // 4) 比较规则。
  let rules = theirs.rules;
  const baseRulesText = JSON.stringify(base.rules);
  const myRulesChanged = JSON.stringify(mine.rules) !== baseRulesText;
  const theirRulesChanged = JSON.stringify(theirs.rules) !== baseRulesText;
  if (myRulesChanged && theirRulesChanged && JSON.stringify(mine.rules) !== JSON.stringify(theirs.rules)) {
    rules = mine.rules;
    verdicts.push({
      id: nextVerdictId(),
      kind: 'rules',
      mine: makeVerdictOption(input.myTabId, input.myTabLabel, {
        status: 'same',
        note: rulesText(mine.rules),
        source: '',
        accepted: false
      }),
      theirs: makeVerdictOption(input.theirTabId, input.theirTabLabel, {
        status: 'same',
        note: rulesText(theirs.rules),
        source: '',
        accepted: false
      }),
      createdAt: nowStamp()
    });
  } else if (myRulesChanged) {
    rules = mine.rules;
  } else if (theirRulesChanged) {
    rules = theirs.rules;
  }

  // 5) 版本与当前选择：双方新增的版本都保留。
  const versions = mergeVersions(base.versions, mine.versions, theirs.versions);
  const leftVersionId = pickSelection(mine.leftVersionId, theirs.leftVersionId, base.leftVersionId, versions);
  const rightVersionId = pickSelection(mine.rightVersionId, theirs.rightVersionId, base.rightVersionId, versions);

  // 6) 最终规则下，失效的已接受记录复位，人工挪动标待复核。
  const signature = rulesSignature(rules);
  ordered.forEach((row) => {
    if (row.accepted && (row.acceptedRulesSig ?? signature) !== signature) {
      row.accepted = false;
      delete row.acceptedRulesSig;
      if (row.manuallyAdjusted) row.needsReview = true;
    }
  });

  const state: PersistedCollationState = {
    versions,
    leftVersionId,
    rightVersionId,
    rows: ordered,
    rules,
    selectedRowId: mine.selectedRowId || theirs.selectedRowId || base.selectedRowId,
    revision: theirs.revision + 1,
    updatedAt: nowStamp(),
    pendingVerdicts: verdicts
  };

  return {
    state,
    conflictCount: verdicts.length - base.pendingVerdicts.length,
    mergedChangeCount
  };
}

function mergeVersions(
  base: VersionDocument[],
  mine: VersionDocument[],
  theirs: VersionDocument[]
): VersionDocument[] {
  // 双方新增的版本都保留；同一 id 以线上版本为基础（正文按设计不会在离线中被改写）。
  const map = new Map<string, VersionDocument>();
  const visit = (list: VersionDocument[]) => {
    list.forEach((version) => {
      if (!map.has(version.id)) map.set(version.id, version);
    });
  };
  visit(theirs);
  visit(mine);
  visit(base);
  const ids: string[] = [];
  const pushIds = (list: VersionDocument[]) => list.forEach((item) => !ids.includes(item.id) && ids.push(item.id));
  pushIds(theirs);
  pushIds(mine);
  pushIds(base);
  return ids.map((id) => map.get(id)!).filter(Boolean);
}

function pickSelection(
  mine: string,
  theirs: string,
  baseValue: string,
  versions: VersionDocument[]
): string {
  const exists = (id: string) => versions.some((item) => item.id === id);
  if (mine !== baseValue && exists(mine)) return mine;
  if (theirs !== baseValue && exists(theirs)) return theirs;
  if (exists(theirs)) return theirs;
  if (exists(mine)) return mine;
  return versions[0]?.id ?? '';
}

function rulesText(rules: ComparisonRules): string {
  return `${rules.ignorePunctuation ? '忽略标点' : '保留标点'}；${rules.ignoreVariants ? '忽略异体字' : '不忽略异体字'}`;
}

/** 裁决一条同行冲突：采用指定一方的判断/说明/来源，行转待复核。 */
export function resolveRowVerdict(
  state: PersistedCollationState,
  verdictId: string,
  side: 'mine' | 'theirs'
): PersistedCollationState {
  const verdict = state.pendingVerdicts.find((item) => item.id === verdictId && item.kind === 'row');
  if (!verdict) return state;
  const next = normalizeState(structuredClone(state));
  const choice = verdict[side].fields;
  const row = next.rows.find((item) => item.id === verdict.rowId);
  if (row) {
    row.status = choice.status;
    row.note = choice.note;
    row.source = choice.source;
    row.accepted = false;
    row.needsReview = true;
    delete row.pendingVerdictId;
  }
  next.pendingVerdicts = next.pendingVerdicts.filter((item) => item.id !== verdictId);
  next.rows.forEach((item) => {
    if (item.pendingVerdictId === verdictId) delete item.pendingVerdictId;
  });
  next.updatedAt = nowStamp();
  return next;
}

/** 裁决规则冲突：采用指定一方的规则；调用方随后做一次重算。 */
export function resolveRulesVerdict(
  state: PersistedCollationState,
  verdictId: string,
  side: 'mine' | 'theirs'
): PersistedCollationState {
  const verdict = state.pendingVerdicts.find((item) => item.id === verdictId && item.kind === 'rules');
  if (!verdict) return state;
  const next = normalizeState(structuredClone(state));
  next.rules = parseRulesText(verdict[side].fields.note, next.rules);
  next.pendingVerdicts = next.pendingVerdicts.filter((item) => item.id !== verdictId);
  const signature = rulesSignature(next.rules);
  next.rows = invalidateAcceptedRows(next.rows, next.rules);
  void signature;
  next.updatedAt = nowStamp();
  return next;
}

function parseRulesText(text: string, fallback: ComparisonRules): ComparisonRules {
  return {
    ...fallback,
    ignorePunctuation: text.includes('忽略标点') && !text.includes('保留标点'),
    ignoreVariants: text.includes('忽略异体字') && !text.includes('不忽略异体字')
  };
}
