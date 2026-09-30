export type SegmentKind = 'heading' | 'paragraph';

/** 源文段落。id 是段落身份，移动位置不改变身份。 */
export interface Segment {
  id: string;
  kind: SegmentKind;
  text: string;
}

export type TranslationStatus =
  | 'untranslated'
  | 'translated'
  | 'review'
  | 'retranslate'
  | 'deferred';

/** 内置语言码。可按需要扩展，界面只依赖 code/label 两个字段。 */
export interface Language {
  code: string;
  label: string;
}

export const LANGUAGES: Language[] = [
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西语' },
];

export const DEFAULT_LANGUAGE = 'en';

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** 译文单元：一个单元可与一个、多个源文段落对应（合并/多对一）。 */
export interface TranslationUnit {
  id: string;
  text: string;
  /** 目标语言，例如 en/ja；一次原文改动会波及多个语言的单元。 */
  lang: string;
  status: TranslationStatus;
  /** 最近一次导致待核对的原因，便于界面提示。 */
  reason?: string;
  /**
   * 确认来源（confirmation provenance）。
   * 译文被确认采用时，记录它所确认的“段落 id -> 规范化原文内容”。
   * 只有当前关联段落的原文与来源一致时，translated 状态才成立；
   * 拆合/移动保留该来源，撤销原文改动时也不会错认另一版本的确认。
   */
  provenance?: Record<string, string>;
  /** 触发本次核对的前后原文快照（按段落 id），供核对工作区展示。 */
  reviewContext?: Record<string, { before: string; after: string }>;
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
