export type SegmentKind = 'heading' | 'paragraph';

/** 源文段落。id 是段落身份，移动位置不改变身份。 */
export interface Segment {
  id: string;
  kind: SegmentKind;
  text: string;
}

export type TranslationStatus = 'untranslated' | 'translated' | 'review';

/** 译文单元：一个单元可与一个、多个源文段落对应（合并/多对一）。 */
export interface TranslationUnit {
  id: string;
  text: string;
  status: TranslationStatus;
  /** 最近一次导致待核对的原因，便于界面提示。 */
  reason?: string;
}

/** 源文段落 <-> 译文单元 多对多关联（join 表）。 */
export interface SegmentUnitLink {
  segmentId: string;
  unitId: string;
}

export interface DocState {
  title: string;
  segments: Segment[];
  units: TranslationUnit[];
  links: SegmentUnitLink[];
}

export interface OpMeta {
  type: string;
  /** 拆分/合并等操作中受影响的新旧段落 id，便于测试与撤销核对。 */
  removedSegmentIds?: string[];
  createdSegmentIds?: string[];
  createdUnitIds?: string[];
}

/** 实质改写判定阈值：相似度低于该值的编辑视为实质改写。 */
export const REWRITE_SIMILARITY_THRESHOLD = 0.85;
