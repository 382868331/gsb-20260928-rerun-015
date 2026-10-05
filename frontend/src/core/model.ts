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
  /** 由哪一次跨段协调产生的处置；缺省为逐段独立裁决。 */
  coordinationId?: string;
  decidedAt: string;
}

/** 跨段术语一致性协调中，一处冲突出现位置的分类。 */
export type CoordinationTargetKind =
  /** 真正同一概念：可直接纳入协调替换。 */
  | 'same-concept'
  /** 同文不同语境：审阅者已声明必须保留的例外语境，协调不得覆盖。 */
  | 'different-context'
  /** 段落拆合后的来源：同一概念，但链路经拆分/合并继承而来，需展示来源。 */
  | 'split-origin';

/** 协调方案中的一项目标位置（某段某语言译文中的一处冲突）。 */
export interface CoordinationTarget {
  segmentId: string;
  unitId: string;
  language: LanguageCode;
  kind: CoordinationTargetKind;
  /** 是否可纳入本次协调替换（例外语境永远为 false）。 */
  eligible: boolean;
  /** 不可纳入的原因（如已声明例外语境及其依据）。 */
  blockReason?: string;
  /** 形成方案时的译文文本。 */
  currentText: string;
  /** 协调替换后的译文文本。 */
  proposedText?: string;
  /** 拆合谱系来源段 id（split-origin 时给出）。 */
  originSegmentIds?: string[];
  /** 形成方案时的原文指纹：确认时原文若变，仅该目标被阻止。 */
  sourceFingerprintAtPlan: string;
  /** 形成方案时的术语决定版本：决定修订后本方案目标需重新核对。 */
  decisionVersionAtPlan: number;
}

/**
 * 跨段术语一致性协调：针对某术语决定在某语言下的一处冲突译法，
 * 把一组可协调位置统一替换为采用译法。例外语境与未批准段落不被覆盖；
 * 撤回协调只收回本次处置，后续独立裁决保留。
 */
export interface TermCoordination {
  id: string;
  decisionId: string;
  term: string;
  language: LanguageCode;
  /** 冲突译法（被替换的旧译法）。 */
  from: string;
  /** 采用译法（替换为目标）。 */
  to: string;
  createdAt: string;
  targets: CoordinationTarget[];
  status: 'draft' | 'applied' | 'withdrawn';
  appliedAt?: string;
  withdrawnAt?: string;
  /** 确认时实际应用的目标键（segmentId::unitId），用于撤回时精确定位。 */
  appliedKeys?: string[];
}

/** 源文段落 <-> 译文单元 多对多关联（join 表）。 */
export interface SegmentUnitLink {
  segmentId: string;
  unitId: string;
  /**
   * 拆合谱系：该链路直接由哪些旧段 id 的链路继承而来。
   * 拆分时每个新段指向原段；合并时新段指向全部被合并段。
   * 跨多次拆合累积全部祖先，用于把旧决定/旧原文对应到新身份。
   */
  originSegmentIds?: string[];
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
  coordinations?: TermCoordination[];
}

export interface OpMeta {
  type: string;
  /** 拆分/合并等操作中受影响的新旧段落 id，便于测试与撤销核对。 */
  removedSegmentIds?: string[];
  createdSegmentIds?: string[];
  createdUnitIds?: string[];
}
