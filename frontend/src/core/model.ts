export type SegmentKind = 'heading' | 'paragraph';

/** 平台内建的目标语言；译文单元按语言归属，术语决定也按语言给出采用译法。 */
export type LanguageCode = 'en' | 'ja' | 'fr' | 'de';

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  en: 'English',
  ja: '日本語',
  fr: 'Français',
  de: 'Deutsch',
};

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
  /** 该译文单元所属目标语言。历史数据缺省时视为英文。 */
  language?: LanguageCode;
  text: string;
  status: TranslationStatus;
  /** 最近一次导致待核对的原因，便于界面提示。 */
  reason?: string;
}

/** 某个术语在某种语言下的采用译法与适用范围。 */
export interface TermRendering {
  language: LanguageCode;
  adopted: string;
  /** 适用范围说明，例如仅限产品界面、合同语境除外。 */
  scope: string;
}

/** 术语决定（含修订沿革）。撤销决定是把 revokedAt 置位，而不是删除记录。 */
export interface TermDecision {
  id: string;
  /** 源文术语，如“新版本”。 */
  term: string;
  /** 当前各语言采用译法。 */
  renderings: TermRendering[];
  /** 决定作出时的版本号，每修订一次加一；确认记录绑定该版本。 */
  version: number;
  createdAt: string;
  revokedAt?: string;
}

/** 逐段逐语言对术语变化的人工处置类型。 */
export type TermDispositionType = 'applied' | 'kept' | 'deferred';

export interface TermDisposition {
  /** 处置针对的术语决定 id。 */
  decisionId: string;
  /** 处置时所针对的决定版本（修订后旧处置不再算数）。 */
  decisionVersion: number;
  type: TermDispositionType;
  /** 保留原译文（例外）时必须填写依据；其他处置可选备注。 */
  rationale?: string;
  /** 按新术语修改时，人工产出的新译文文本，便于审计对照。 */
  revisedText?: string;
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
  /** 确认该译文时所采用的术语决定版本快照：decisionId@version。 */
  confirmedTerms?: string[];
  /** 上一版确认时的术语快照（确认沿革）。 */
  priorConfirmedTerms?: string[];
  /** 本条链路上译文对各术语的人工处置（按 decisionId 保留历史）。 */
  termDispositions?: TermDisposition[];
}

export interface DocState {
  title: string;
  segments: Segment[];
  units: TranslationUnit[];
  links: SegmentUnitLink[];
  termDecisions: TermDecision[];
}

// ---------------------------------------------------------------------------
// 审阅分支与合并会话
// ---------------------------------------------------------------------------

/** 审阅来源身份：原文编辑、术语决定、局部译文可来自不同编辑者的不同审阅。 */
export interface ReviewBranch {
  id: string;
  name: string;
  author: string;
  /** 分支所基于的明确文档版本（基线 DocState 的深拷贝）。 */
  base: DocState;
  /** 分支当前文档状态（深拷贝），拒绝合入时基线与主线均不受它影响。 */
  head: DocState;
  createdAt: string;
}

export type ChangeKind = 'source' | 'translation' | 'term';

export interface ChangeEvidence {
  /** 基线值（原文文本 / 译文文本 / 术语采用译法快照）。 */
  base?: string;
  /** 该审阅提出的值。 */
  proposed: string;
  /** 编辑者填写的依据，冲突时两边依据都必须保留可查。 */
  rationale?: string;
}

export type ProposalResolution = 'unresolved' | 'a' | 'b' | 'manual' | 'skipped';

/** 同一段落+语言上两个审阅都改了译文时的冲突处置。 */
export interface TranslationResolution {
  kind: 'translation';
  segmentId: string;
  language: LanguageCode;
  a: ChangeEvidence;
  b: ChangeEvidence;
  resolution: ProposalResolution;
  /** 人工解决时给出的译文文本。 */
  manualText?: string;
  /** 人工保留的例外说明（即使后续失效也保留可查）。 */
  manualRationale?: string;
  /** 处置时所绑定的原文指纹；原文再变则该选择失效、重新打开冲突。 */
  resolvedSource?: string;
  /** 处置时所绑定的术语快照集合；术语再变则该选择失效。 */
  resolvedTerms?: string[];
  decidedAt?: string;
}

export interface SourceResolution {
  kind: 'source';
  segmentId: string;
  a: ChangeEvidence;
  b: ChangeEvidence;
  resolution: ProposalResolution;
  manualText?: string;
  manualRationale?: string;
  /** 处置时该段所关联的术语快照；术语变化只重开术语项，不重开原文决定。 */
  decidedAt?: string;
}

export interface TermResolution {
  kind: 'term';
  /** 术语决定 id（按术语一一对应，修订即新版本）。 */
  decisionId: string;
  term: string;
  language: LanguageCode;
  a: ChangeEvidence;
  b: ChangeEvidence;
  resolution: ProposalResolution;
  manualText?: string;
  manualRationale?: string;
  /** 处置绑定的决定版本；决定再变则重新打开。 */
  resolvedVersion?: number;
  decidedAt?: string;
}

export type MergeResolution = SourceResolution | TranslationResolution | TermResolution;

/** 单个非冲突变化项，可按语言、按段落选择性合入。 */
export interface MergeChange {
  kind: ChangeKind;
  branchId: string;
  segmentId?: string;
  unitId?: string;
  language?: LanguageCode;
  decisionId?: string;
  /** 变化前的值。 */
  before?: string;
  /** 审阅提出的值。 */
  after: string;
  rationale?: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export type MergeSessionStatus = 'open' | 'merged' | 'rejected';

export interface MergeSession {
  id: string;
  /** 会话开始时主线的不可变快照；拒绝合入时主线回到此状态（本就未变）。 */
  targetSnapshot: DocState;
  branchA: ReviewBranch;
  branchB: ReviewBranch;
  changes: MergeChange[];
  resolutions: MergeResolution[];
  status: MergeSessionStatus;
  createdAt: string;
  mergedAt?: string;
  rejectedAt?: string;
}

// ---------------------------------------------------------------------------
// 冻结发布包
// ---------------------------------------------------------------------------

/** 发布包中每段译文的确定出处：对应确定的原文、术语与审阅决定。 */
export interface ReleaseTranslation {
  unitId: string;
  language: LanguageCode;
  text: string;
  /** 所确认的原文指纹。 */
  sourceFingerprint: string;
  /** 所采用的术语决定快照 decisionId@version。 */
  termSnapshots: string[];
  /** 该译文来自哪次合并会话（如有）及其合入决定。 */
  adoptedFrom?: { sessionId: string; branchId: string; kind: ChangeKind };
  /** 人工保留的术语例外说明（历史可查）。 */
  exceptionRationale?: string;
}

export interface ReleaseSegment {
  segmentId: string;
  kind: SegmentKind;
  source: string;
  translations: ReleaseTranslation[];
  /** 逐语言是否仍待处理；待处理语言不进入 translations，不能冒充已确认。 */
  pendingLanguages: LanguageCode[];
}

/** 冻结后不可变的发布包：快照内容不再随后续编辑改变。 */
export interface ReleasePackage {
  id: string;
  title: string;
  version: number;
  frozenAt: string;
  sourceDocTitle: string;
  segments: ReleaseSegment[];
  /** 冻结时的整篇文档快照，保证下载内容永远对应旧包。 */
  snapshot: DocState;
}

export interface OpMeta {
  type: string;
  /** 拆分/合并等操作中受影响的新旧段落 id，便于测试与撤销核对。 */
  removedSegmentIds?: string[];
  createdSegmentIds?: string[];
  createdUnitIds?: string[];
}
