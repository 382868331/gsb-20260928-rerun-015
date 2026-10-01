import { DocState, SegmentUnitLink, TranslationUnit } from './model';
import { normalizeText } from './similarity';
import { segmentIdsForUnit, unitIdsForSegment } from './docOps';
import { applicableTermsForLink, ApplicableTerm } from './termOps';

/** 源文指纹：任意内容变化（包括“允许”→“禁止”这类单字反义改动）都会改变。 */
export function sourceFingerprint(text: string): string {
  return normalizeText(text);
}

function sourceConfirmed(state: DocState, link: SegmentUnitLink): boolean {
  const segment = state.segments.find((s) => s.id === link.segmentId);
  if (!segment) return false;
  if (link.confirmedSource === sourceFingerprint(segment.text)) return true;
  const unit = state.units.find((u) => u.id === link.unitId);
  return link.confirmedSource === undefined && unit?.status === 'translated';
}

function unresolvedTerms(state: DocState, link: SegmentUnitLink): ApplicableTerm[] {
  return applicableTermsForLink(state, link.segmentId, link.unitId)
    .filter((term) => term.state === 'missing' || term.state === 'outdated' || !term.finalConfirmed);
}
const noApplicableTerms: ApplicableTerm[] = [];

/** 某条段落↔译文关联是否已针对当前源文版本人工确认。 */
export function isLinkConfirmed(state: DocState, link: SegmentUnitLink): boolean {
  return sourceConfirmed(state, link) && unresolvedTerms(state, link).length === 0 && !link.deferred;
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
  reviewCause: 'source-change' | 'term-change' | 'both' | 'unresolved';
  termItems: ApplicableTerm[];
  exceptionRationales: string[];
}

export interface ReviewEntry {
  segmentId: string;
  kind: 'heading' | 'paragraph';
  /** 触发本次核对的旧原文（拆合时为旧段拼接），首次出现的译文可为空。 */
  sourceBefore?: string;
  sourceAfter: string;
  units: ReviewUnitView[];
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
        const termItems = applicableTermsForLink(state, segment.id, unitId) ?? noApplicableTerms;
        const sourceOk = sourceConfirmed(state, link);
        const staleTerms = termItems.filter((term) => term.state === 'missing' || term.state === 'outdated' || !term.finalConfirmed);
        const hasTermTrigger = staleTerms.length > 0 || link.deferred;
        const sourceChanged = Boolean(link.sourceBefore || link.confirmedSource !== undefined || link.priorConfirmedSource);
        const reviewCause: ReviewUnitView['reviewCause'] = hasTermTrigger
          ? (!sourceOk && sourceChanged ? 'both' : 'term-change')
          : sourceChanged
            ? 'source-change'
            : 'unresolved';
        views.push({
          unit,
          confirmed,
          priorConfirmedSource: link.priorConfirmedSource,
          deferred: Boolean(link.deferred),
          reviewCause,
          termItems,
          exceptionRationales: Object.values(link.termResolutions ?? {})
            .filter((resolution) => resolution.decision === 'exception' && resolution.rationale)
            .map((resolution) => `${resolution.term}：${resolution.rationale}`),
        });
      }
    }
    if (views.length > 0) {
      const sourceBefore = state.links
        .filter((l) => l.segmentId === segment.id)
        .map((l) => l.sourceBefore)
        .find((text): text is string => Boolean(text));
      entries.push({
        segmentId: segment.id,
        kind: segment.kind,
        sourceBefore,
        sourceAfter: segment.text,
        units: views,
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
  link.confirmedSource = sourceFingerprint(segment.text);
  link.priorConfirmedSource = undefined;
  link.sourceBefore = undefined;
  link.deferred = false;
  link.confirmedTermRevisions ??= {};
  for (const item of applicableTermsForLink(next, segmentId, unitId)) {
    if (item.decision.status === 'active' && item.resolution) {
      link.confirmedTermRevisions[item.decision.id] = item.decision.revision;
    }
  }
  const unit = next.units.find((u) => u.id === unitId);
  if (unit && isUnitConfirmed(next, unitId)) unit.status = 'translated';
  if (unit && unit.status === 'translated') unit.reason = undefined;
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
  link.deferred = false;
  link.termResolutions = undefined;
  unit.status = 'review';
  unit.reason = '原文已变更，旧译文作废，等待重译后确认';
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
  link.deferred = true;
  unit.status = 'review';
  unit.reason = '已暂缓，稍后人工核对';
  return next;
}

/** 译文单元当前涉及的所有段落指纹，用于更新译文时同步确认来源。 */
export function stampUnitConfirmed(state: DocState, unitId: string): DocState {
  const next: DocState = JSON.parse(JSON.stringify(state)) as DocState;
  for (const segmentId of segmentIdsForUnit(next, unitId)) {
    const segment = next.segments.find((s) => s.id === segmentId);
    const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
    if (segment && link) link.confirmedSource = sourceFingerprint(segment.text);
  }
  return next;
}
