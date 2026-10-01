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
  /** 人工可读语言名；译文单元本身就是一种语言的译文载体。 */
  languageLabel?: string;
  /** 最近一次导致待核对的原因，便于界面提示。 */
  reason?: string;
}

export interface TermTranslationChoice {
  /** 该语言对应的译文单元 id。 */
  unitId: string;
  /** 可选：旧译法，用于逐段替换；不同语境找不到旧译法时不会强行替换。 */
  previous?: string;
  /** 本轮采用的新译法。 */
  adopted: string;
}

export type TermDecisionStatus = 'active' | 'revoked';

/** 某个源文术语在一轮审阅中的各语言采用译法与适用段落范围。 */
export interface TermDecision {
  id: string;
  term: string;
  revision: number;
  scopeSegmentIds: string[];
  translations: TermTranslationChoice[];
  status: TermDecisionStatus;
  createdAt: string;
  revokedAt?: string;
}

export type TermResolutionKind = 'applied' | 'exception';

/** 逐段、逐语言的术语处理决定；例外必须写明人工依据。 */
export interface TermResolution {
  termId: string;
  revision: number;
  decision: TermResolutionKind;
  term: string;
  adopted: string;
  rationale?: string;
  sourceFingerprint: string;
  decidedAt: string;
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
  /** key 为 termId；只记录该链路已处理的术语版本。 */
  termResolutions?: Record<string, TermResolution>;
  /** key 为 termId；最终确认时所采用的术语修订版本。 */
  confirmedTermRevisions?: Record<string, number>;
  /** 本轮暂缓标记，不影响其它段落，也不是术语例外。 */
  deferred?: boolean;
}

export interface DocState {
  title: string;
  segments: Segment[];
  units: TranslationUnit[];
  links: SegmentUnitLink[];
  termDecisions: TermDecision[];
}

export interface OpMeta {
  type: string;
  /** 拆分/合并等操作中受影响的新旧段落 id，便于测试与撤销核对。 */
  removedSegmentIds?: string[];
  createdSegmentIds?: string[];
  createdUnitIds?: string[];
}
