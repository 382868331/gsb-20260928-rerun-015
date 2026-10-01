import { DocState, SegmentUnitLink, TranslationUnit } from './model';
import { normalizeText } from './similarity';
import { segmentIdsForUnit, unitIdsForSegment } from './docOps';
import {
  decisionsForLink,
  currentDisposition,
  isLinkFullyConfirmed,
  isTermOnlyIssue,
  reconcileUnitStatuses,
  termSnapshot,
} from './terms';

/** 源文指纹：任意内容变化（包括“允许”→“禁止”这类单字反义改动）都会改变。 */
export function sourceFingerprint(text: string): string {
  return normalizeText(text);
}

/** 某条段落↔译文关联是否已针对当前源文版本人工确认。 */
export function isLinkConfirmed(state: DocState, link: SegmentUnitLink): boolean {
  return isLinkFullyConfirmed(state, link);
}

/** 译文是否在所有关联段落上都已确认（多对一情形下每段需分别确认）。 */
export function isUnitConfirmed(state: DocState, unitId: string): boolean {
  const links = state.links.filter((l) => l.unitId === unitId);
  if (links.length === 0) return false;
  return links.every((l) => isLinkConfirmed(state, l));
}

export interface ReviewUnitView {
  unit: TranslationUnit;
  /** 该单元在本段上的关联是否已确认。 */
  confirmed: boolean;
  /** 上一版本的确认来源指纹（若有），用于展示确认沿革、防止错认版本。 */
  priorConfirmedSource?: string;
  deferred: boolean;
  /** 触发原因：原文改写/拆合，或仅术语决定变化。 */
  trigger: 'source' | 'term' | 'mixed';
  /** 该段译文当前需要处置的术语决定。 */
  termIssues: Array<{
    decisionId: string;
    term: string;
    version: number;
    adopted: string;
    scope: string;
    dispositionType?: string;
    rationale?: string;
  }>;
}

export interface ReviewEntry {
  segmentId: string;
  kind: 'heading' | 'paragraph';
  /** 触发本次核对的旧原文（拆合时为旧段拼接），首次出现的译文可为空。 */
  sourceBefore?: string;
  sourceAfter: string;
  units: ReviewUnitView[];
  trigger: 'source' | 'term' | 'mixed';
}

/**
 * 核对工作区：逐段列出原文前后版本与各语言现有译文。
 * 仅包含存在译文内容、且至少一条关联未确认的段落。
 */
export function buildReviewWorkspace(state: DocState): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  for (const segment of state.segments) {
    const unitIds = unitIdsForSegment(state, segment.id);
    const views: ReviewUnitView[] = [];
    for (const unitId of unitIds) {
      const unit = state.units.find((u) => u.id === unitId);
      if (!unit || unit.text.trim().length === 0) continue;
      const link = state.links.find(
        (l) => l.segmentId === segment.id && l.unitId === unitId,
      )!;
      const confirmed = isLinkConfirmed(state, link);
      if (!confirmed) {
        const termDecisions = decisionsForLink(state, link);
        const termIssues = termDecisions.map((decision) => {
          const rendering = decision.renderings.find(
            (r) => r.language === (unit.language ?? 'en'),
          )!;
          const disposition = currentDisposition(link, decision.id);
          return {
            decisionId: decision.id,
            term: decision.term,
            version: decision.version,
            adopted: rendering?.adopted ?? '',
            scope: rendering?.scope ?? '',
            dispositionType: disposition?.type,
            rationale: disposition?.rationale,
          };
        });
        const termOnly = isTermOnlyIssue(state, link);
        views.push({
          unit,
          confirmed,
          priorConfirmedSource: link.priorConfirmedSource,
          deferred: unit.reason?.startsWith('已暂缓') ?? false,
          trigger: termOnly ? 'term' : termIssues.length > 0 ? 'mixed' : 'source',
          termIssues,
        });
      }
    }
    if (views.length > 0) {
      const sourceBefore = state.links
        .filter((l) => l.segmentId === segment.id)
        .map((l) => l.sourceBefore)
        .find((text): text is string => Boolean(text));
      const trigger = views.every((v) => v.trigger === 'term')
        ? 'term'
        : views.some((v) => v.trigger !== 'source')
          ? 'mixed'
          : 'source';
      entries.push({
        segmentId: segment.id,
        kind: segment.kind,
        sourceBefore,
        sourceAfter: segment.text,
        units: views,
        trigger,
      });
    }
  }
  return entries;
}

/** 确认某条译文对某段当前原文有效（逐语言、逐段分别确认）。 */
export function confirmLink(
  state: DocState,
  segmentId: string,
  unitId: string,
): DocState {
  const next: DocState = JSON.parse(JSON.stringify(state)) as DocState;
  const segment = next.segments.find((s) => s.id === segmentId);
  const link = next.links.find(
    (l) => l.segmentId === segmentId && l.unitId === unitId,
  );
  if (!segment || !link) return next;
  const required = decisionsForLink(next, link);
  for (const decision of required) {
    const disposition = currentDisposition(link, decision.id);
    if (!disposition || disposition.decisionVersion !== decision.version || disposition.type === 'deferred') {
      return next;
    }
  }
  link.confirmedSource = sourceFingerprint(segment.text);
  link.confirmedTerms = Array.from(
    new Set([...(link.confirmedTerms ?? []), ...required.map(termSnapshot)]),
  );
  link.priorConfirmedSource = undefined;
  link.priorConfirmedTerms = undefined;
  link.sourceBefore = undefined;
  const unit = next.units.find((u) => u.id === unitId);
  if (unit && isUnitConfirmed(next, unitId)) {
    unit.status = 'translated';
    unit.reason = undefined;
  }
  reconcileUnitStatuses(next);
  return next;
}

/** 一次原文修改影响多种语言：整段现有译文逐语言分别确认。 */
export function confirmAllForSegment(state: DocState, segmentId: string): DocState {
  let next = state;
  for (const unitId of unitIdsForSegment(state, segmentId)) {
    next = confirmLink(next, segmentId, unitId);
  }
  return next;
}

/** 重译：保留旧译文文本供参考，但作废其确认，要求新译文完成后重新确认。 */
export function requestRetranslation(
  state: DocState,
  segmentId: string,
  unitId: string,
): DocState {
  const next: DocState = JSON.parse(JSON.stringify(state)) as DocState;
  const link = next.links.find(
    (l) => l.segmentId === segmentId && l.unitId === unitId,
  );
  const unit = next.units.find((u) => u.id === unitId);
  if (!link || !unit) return next;
  link.confirmedSource = undefined;
  link.confirmedTerms = [];
  unit.status = 'review';
  unit.reason = '原文已变更，旧译文作废，等待重译后确认';
  reconcileUnitStatuses(next);
  return next;
}

/** 暂缓：保留待核对状态，明确从本轮确认批次中排除。 */
export function deferReview(
  state: DocState,
  segmentId: string,
  unitId: string,
): DocState {
  const next: DocState = JSON.parse(JSON.stringify(state)) as DocState;
  const link = next.links.find(
    (l) => l.segmentId === segmentId && l.unitId === unitId,
  );
  const unit = next.units.find((u) => u.id === unitId);
  if (!link || !unit) return next;
  link.confirmedSource = undefined;
  link.confirmedTerms = [];
  unit.status = 'review';
  unit.reason = '已暂缓，稍后人工核对';
  reconcileUnitStatuses(next);
  return next;
}

/** 译文单元当前涉及的所有段落指纹，用于更新译文时同步确认来源。 */
export function stampUnitConfirmed(state: DocState, unitId: string): DocState {
  const next: DocState = JSON.parse(JSON.stringify(state)) as DocState;
  for (const segmentId of segmentIdsForUnit(next, unitId)) {
    const segment = next.segments.find((s) => s.id === segmentId);
    const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
    if (segment && link) link.confirmedSource = sourceFingerprint(segment.text);
    if (segment && link) {
      const required = decisionsForLink(next, link);
      link.confirmedTerms = Array.from(
        new Set([...(link.confirmedTerms ?? []), ...required.map(termSnapshot)]),
      );
    }
  }
  reconcileUnitStatuses(next);
  return next;
}
