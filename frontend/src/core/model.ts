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
  /**
   * 人工确认时所依据的源文指纹。
   * 仅当与当前关联源文指纹一致时该链路才算已确认；
   * 源文任意内容变化都会使其失效，撤销/重做也不会错认另一版本的确认。
   */
  confirmedSource?: string;
  /** 进入核对工作区时的旧原文，供“前后对照”展示。 */
  sourceBefore?: string;
  /** 上一次被确认过的源文指纹（已被新版本作废），保留确认沿革。 */
  priorConfirmedSource?: string;
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
