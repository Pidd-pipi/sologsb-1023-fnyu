export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

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

/** 人工可修改、需要参与合并的行字段。 */
export interface RowEditableFields {
  status: DifferenceStatus;
  note: string;
  source: string;
  accepted: boolean;
}

export interface AlignmentRow extends RowEditableFields {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  similarity: number;
  manuallyAdjusted: boolean;
  /** 规则变更后，原先的已接受判断需要重新核对。 */
  needsReview?: boolean;
  /** 接受时生效的规则签名；与当前规则不一致即视为失效。 */
  acceptedRulesSig?: string;
  /** 被待裁决冲突占用时为对应 verdictId，处理前不可接受、不可导出。 */
  pendingVerdictId?: string;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

/** 待裁决记录：双方都改过同一行时，各自的判断/说明/来源都保留。 */
export interface VerdictOption {
  tabId: string;
  tabLabel: string;
  at: string;
  fields: RowEditableFields;
}

export interface PendingVerdict {
  id: string;
  kind: 'row' | 'rules';
  rowId?: string;
  rowLabel?: string;
  base?: VerdictOption;
  mine: VerdictOption;
  theirs: VerdictOption;
  createdAt: string;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  /** 草稿修订号，每次规范写入递增。 */
  revision: number;
  updatedAt: string;
  /** 尚未人工裁决的冲突。 */
  pendingVerdicts: PendingVerdict[];
}
