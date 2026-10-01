export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

/** 某一方对同一对齐行的判断快照，用于离线合并冲突裁决 */
export interface RowJudgment {
  status: DifferenceStatus;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

/** 两个页签离线改过同一对齐行时，保留双方判断、说明与来源，列待裁决 */
export interface RowConflict {
  local: RowJudgment;
  remote: RowJudgment;
  detectedAt: string;
}

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
  /** 离线合并时双方改过同一行，保留各自判断，待裁决后才能接受或导出 */
  conflict?: RowConflict | null;
  /** 比较规则变更后，人工挪动的行保留配对但需重新复核 */
  pendingReview?: boolean;
}

export interface WriteLease {
  tabId: string;
  acquiredAt: number;
  beatAt: number;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
}
