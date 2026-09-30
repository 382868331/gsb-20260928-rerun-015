export type SegmentKind = 'heading' | 'paragraph';

export type LinkStatus = 'ok' | 'needs_review';

export interface SourceSegment {
  id: string;
  kind: SegmentKind;
  text: string;
  /** 上次确认时的正文；用于判断本次编辑是否构成实质改写 */
  lastApprovedText: string;
}

export interface TargetSegment {
  id: string;
  text: string;
}

export interface SegmentLink {
  id: string;
  sourceId: string;
  targetId: string;
  status: LinkStatus;
}

export interface DocState {
  version: number;
  sourceLanguage: string;
  targetLanguage: string;
  /** 正文顺序即文档顺序 */
  sources: SourceSegment[];
  /** 译文顺序仅影响展示 */
  targets: TargetSegment[];
  links: SegmentLink[];
  seq: number;
}

export interface ExportedDoc {
  format: 'mlcp-export';
  exportedAt: string;
  doc: DocState;
}
