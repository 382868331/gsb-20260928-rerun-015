import {
  DocState,
  LanguageCode,
  SegmentUnitLink,
  TermDecision,
  TermDisposition,
  TermDispositionType,
  TermRendering,
  TranslationUnit,
} from './model';
import { nextId } from './identity';
import { sourceFingerprint } from './reviewWorkspace';

export function unitLanguage(unit: TranslationUnit): LanguageCode {
  return unit.language ?? 'en';
}

export function activeTermDecisions(state: DocState): TermDecision[] {
  return state.termDecisions.filter((d) => d.revokedAt === undefined);
}

export function termSnapshot(decision: TermDecision): string {
  return `${decision.id}@${decision.version}`;
}

/** 段落原文是否实际使用了某术语（按源文词形出现判断，逐段而不是全库替换）。 */
export function segmentUsesTerm(segmentText: string, term: string): boolean {
  const key = term.trim();
  if (key.length === 0) return false;
  return segmentText.includes(key);
}

/** 现有译文是否仍包含某语言旧译法（用于提示“这段译文实际用了它”）。 */
export function translationUsesRendering(text: string, adopted: string): boolean {
  const key = adopted.trim();
  return key.length > 0 && text.includes(key);
}

export interface TermUsage {
  segmentId: string;
  unitId: string;
  language: LanguageCode;
  /** 该语言决定中给出的采用译法（没有该语言决定时为 undefined）。 */
  rendering?: TermRendering;
  segmentText: string;
  translationText: string;
  /** 译文是否实际包含当前采用译法。 */
  usesAdopted: boolean;
}

/**
 * 术语决定前先看到哪些已有段落实际使用了它：
 * 源文出现该术语、且该段有非空译文的段落-语言组合。
 */
export function findTermUsages(state: DocState, term: string): TermUsage[] {
  const usages: TermUsage[] = [];
  const decision = activeTermDecisions(state).find((d) => d.term === term.trim());
  for (const segment of state.segments) {
    if (!segmentUsesTerm(segment.text, term)) continue;
    for (const link of state.links.filter((l) => l.segmentId === segment.id)) {
      const unit = state.units.find((u) => u.id === link.unitId);
      if (!unit || unit.text.trim().length === 0) continue;
      const language = unitLanguage(unit);
      const rendering = decision?.renderings.find((r) => r.language === language);
      usages.push({
        segmentId: segment.id,
        unitId: unit.id,
        language,
        rendering,
        segmentText: segment.text,
        translationText: unit.text,
        usesAdopted: rendering ? translationUsesRendering(unit.text, rendering.adopted) : false,
      });
    }
  }
  return usages;
}

function clone(state: DocState): DocState {
  return JSON.parse(JSON.stringify(state)) as DocState;
}

function ensureTermDecisions(state: DocState): TermDecision[] {
  if (!state.termDecisions) state.termDecisions = [];
  return state.termDecisions;
}

export interface CreateTermInput {
  term: string;
  renderings: TermRendering[];
}

/**
 * 作出术语决定：指定各语言采用译法与适用范围。
 * 不自动改任何译文，只让受影响段落进入“仅术语变化”的待核对。
 */
export function createTermDecision(
  state: DocState,
  input: CreateTermInput,
  now: string = new Date().toISOString(),
): { state: DocState; decisionId: string } {
  const next = clone(state);
  ensureTermDecisions(next);
  const term = input.term.trim();
  const existing = next.termDecisions.find((d) => d.term === term && d.revokedAt === undefined);
  if (existing) {
    existing.renderings = input.renderings.map((r) => ({ ...r }));
    existing.version += 1;
    invalidateTerm(next, existing);
    return { state: next, decisionId: existing.id };
  }
  const decision: TermDecision = {
    id: nextId('term'),
    term,
    renderings: input.renderings.map((r) => ({ ...r })),
    version: 1,
    createdAt: now,
  };
  next.termDecisions.push(decision);
  invalidateTerm(next, decision);
  return { state: next, decisionId: decision.id };
}

/** 修订术语决定：新版本使之前针对旧版本的逐段处置与确认失效，需重新核对。 */
export function reviseTermDecision(
  state: DocState,
  decisionId: string,
  renderings: TermRendering[],
): DocState {
  const next = clone(state);
  const decision = next.termDecisions.find((d) => d.id === decisionId);
  if (!decision || decision.revokedAt !== undefined) return next;
  decision.renderings = renderings.map((r) => ({ ...r }));
  decision.version += 1;
  invalidateTerm(next, decision);
  return next;
}

/**
 * 撤销术语决定：受影响译文回到术语待核对（要求重新决定），
 * 绝不恢复另一轮审阅中作出的确认；历史处置保留以便追溯。
 */
export function revokeTermDecision(state: DocState, decisionId: string, now: string = new Date().toISOString()): DocState {
  const next = clone(state);
  const decision = next.termDecisions.find((d) => d.id === decisionId);
  if (!decision || decision.revokedAt !== undefined) return next;
  decision.revokedAt = now;
  // 撤销不恢复任何旧确认：实际使用该术语的段落保持待核对，等待新的术语决定。
  for (const segment of next.segments) {
    if (!segmentUsesTerm(segment.text, decision.term)) continue;
    for (const link of next.links.filter((l) => l.segmentId === segment.id)) {
      const unit = next.units.find((u) => u.id === link.unitId);
      if (!unit || unit.text.trim().length === 0) continue;
      if (link.confirmedSource !== undefined) link.priorConfirmedSource = link.confirmedSource;
      link.confirmedSource = undefined;
      unit.status = 'review';
      unit.reason = `术语“${decision.term}”决定已撤销，等待新决定后重新核对`;
    }
  }
  return next;
}

/** 新决定/修订后：凡源文实际使用该术语的链路，其术语相关确认失效（逐段生效，不做无差别替换）。 */
function invalidateTerm(next: DocState, decision: TermDecision): void {
  for (const segment of next.segments) {
    if (!segmentUsesTerm(segment.text, decision.term)) continue;
    for (const link of next.links.filter((l) => l.segmentId === segment.id)) {
      if ((link.confirmedTerms?.length ?? 0) > 0) {
        link.priorConfirmedTerms = [
          ...(link.priorConfirmedTerms ?? []),
          ...(link.confirmedTerms ?? []),
        ];
      }
      link.confirmedTerms = [];
      const unit = next.units.find((u) => u.id === link.unitId);
      if (unit && unit.text.trim().length > 0) {
        unit.status = 'review';
        unit.reason = `术语“${decision.term}”决定已更新，请逐段核对译法`;
      }
    }
  }
}

/** 当前作用在某条链路上、且该段源文实际使用的有效术语决定。 */
export function decisionsForLink(state: DocState, link: SegmentUnitLink): TermDecision[] {
  const segment = state.segments.find((s) => s.id === link.segmentId);
  const unit = state.units.find((u) => u.id === link.unitId);
  if (!segment || !unit) return [];
  const language = unitLanguage(unit);
  return activeTermDecisions(state).filter(
    (d) =>
      segmentUsesTerm(segment.text, d.term) &&
      d.renderings.some((r) => r.language === language),
  );
}

export function currentDisposition(link: SegmentUnitLink, decisionId: string): TermDisposition | undefined {
  return link.termDispositions?.filter((d) => d.decisionId === decisionId).slice(-1)[0];
}

/** 某条链路的术语要求是否已满足当前决定版本（已按新术语改，或有依据地保留例外）。暂缓不算。 */
export function isLinkTermSettled(state: DocState, link: SegmentUnitLink): boolean {
  for (const decision of decisionsForLink(state, link)) {
    const disposition = currentDisposition(link, decision.id);
    if (!disposition || disposition.decisionVersion !== decision.version) return false;
    if (disposition.type === 'deferred') return false;
    if (disposition.type === 'kept' && !(disposition.rationale ?? '').trim()) return false;
  }
  return true;
}

/** 术语处置中是否存在针对当前版本、明确保留原译文的例外。 */
export function linkHasKeptException(state: DocState, link: SegmentUnitLink): boolean {
  return decisionsForLink(state, link).some((d) => {
    const disposition = currentDisposition(link, d.id);
    return disposition?.type === 'kept' && disposition.decisionVersion === d.version;
  });
}

export type LinkReviewCategory = 'confirmed' | 'exception' | 'pending';

/**
 * 链路核对三分类：
 * - confirmed：已按当前术语确认，可随正文交付；
 * - exception：明确保留的例外（必须带依据），单列导出；
 * - pending：仍待处理（原文变更、术语未处置、暂缓、重译）。
 */
export function linkReviewCategory(state: DocState, link: SegmentUnitLink): LinkReviewCategory {
  const segment = state.segments.find((s) => s.id === link.segmentId);
  if (!segment) return 'pending';
  const sourceCurrent = link.confirmedSource === sourceFingerprint(segment.text);
  const required = decisionsForLink(state, link);
  const currentDispositions = required.map((d) => currentDisposition(link, d.id));
  const termCurrent =
    currentDispositions.length === required.length &&
    currentDispositions.every(
      (disposition, index) =>
        disposition !== undefined && disposition.decisionVersion === required[index].version,
    ) &&
    required.every((d) => (link.confirmedTerms ?? []).includes(termSnapshot(d)));
  if (sourceCurrent && termCurrent) {
    if (currentDispositions.some((d) => d?.type === 'kept')) return 'exception';
    return 'confirmed';
  }
  return 'pending';
}

/** 该链路是否有任何术语待核对事项（含暂缓项，用于界面徽标）。 */
export function linkHasTermIssue(state: DocState, link: SegmentUnitLink): boolean {
  return decisionsForLink(state, link).length > 0 && !isLinkTermSettled(state, link);
}

function setDisposition(link: SegmentUnitLink, disposition: TermDisposition): void {
  link.termDispositions = [...(link.termDispositions ?? []), disposition];
}

function recordAndMaybeConfirm(next: DocState, segmentId: string, unitId: string, disposition: TermDisposition): void {
  const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
  const segment = next.segments.find((s) => s.id === segmentId);
  if (!link || !segment) return;
  const sourceWasCurrent = link.confirmedSource === sourceFingerprint(segment.text);
  setDisposition(link, disposition);
  refreshLinkState(next, link, segment.text);
  // 同一轮审阅中原文本就未变（仅术语变化）时：处置即确认，确认记录同时绑定当前原文与术语版本。
  if (
    disposition.type !== 'deferred' &&
    sourceWasCurrent &&
    link.confirmedSource === undefined &&
    isLinkTermSettled(next, link)
  ) {
    link.confirmedSource = sourceFingerprint(segment.text);
  }
  if (disposition.type !== 'deferred' && isLinkTermSettled(next, link)) {
    const required = decisionsForLink(next, link).map(termSnapshot);
    link.confirmedTerms = Array.from(new Set([...(link.confirmedTerms ?? []), ...required]));
  }
}

/** 按当前链路状态重算：确认必须同时对应当前原文与所采用术语决定；单元状态随所有链路汇总。 */
export function refreshLinkState(next: DocState, link: SegmentUnitLink, segmentText: string): void {
  const required = decisionsForLink(next, link).map(termSnapshot);
  const sourceOk = link.confirmedSource !== undefined && link.confirmedSource === sourceFingerprint(segmentText);
  const termsOk = required.every((snap) => (link.confirmedTerms ?? []).includes(snap));
  const settled = isLinkTermSettled(next, link);
  if (sourceOk && termsOk && settled) {
    link.confirmedTerms = Array.from(new Set([...(link.confirmedTerms ?? []), ...required]));
  } else {
    link.confirmedTerms = (link.confirmedTerms ?? []).filter((snap) => !required.includes(snap));
  }
}

/**
 * 逐段处置术语变化。
 * - applied：按新术语修改（调用方负责改译文文本，或给出 revisedText）；
 * - kept：人工保留原译文，必须填写依据，作为明确例外；
 * - deferred：暂缓，保持待核对。
 */
export function decideTermOnLink(
  state: DocState,
  segmentId: string,
  unitId: string,
  decisionId: string,
  type: TermDispositionType,
  options: { rationale?: string; revisedText?: string } = {},
  now: string = new Date().toISOString(),
): DocState {
  const next = clone(state);
  const decision = next.termDecisions.find((d) => d.id === decisionId);
  if (!decision || decision.revokedAt !== undefined) return next;
  if (type === 'kept' && !(options.rationale ?? '').trim()) {
    throw new Error('保留原译文作为例外时必须说明依据');
  }
  const unit = next.units.find((u) => u.id === unitId);
  let revisedText = options.revisedText;
  if (type === 'applied' && revisedText !== undefined && unit) {
    unit.text = revisedText;
  }
  if (type === 'applied' && unit) revisedText = unit.text;
  recordAndMaybeConfirm(next, segmentId, unitId, {
    decisionId,
    decisionVersion: decision.version,
    type,
    rationale: options.rationale?.trim() || undefined,
    revisedText,
    decidedAt: now,
  });
  reconcileUnitStatuses(next);
  return next;
}

/** 全文状态归一：任一关联链路未确认（原文或术语）则译文单元待核对。 */
export function reconcileUnitStatuses(state: DocState): void {
  for (const unit of state.units) {
    if (unit.text.trim().length === 0) {
      unit.status = 'untranslated';
      continue;
    }
    const links = state.links.filter((l) => l.unitId === unit.id);
    if (links.length === 0) continue;
    const allConfirmed = links.every((l) => isLinkFullyConfirmed(state, l));
    const deferred = links.some((l) => hasDeferredTerm(state, l));
    if (allConfirmed) {
      unit.status = 'translated';
      if (!deferred) unit.reason = undefined;
    } else {
      unit.status = 'review';
      if (!unit.reason) unit.reason = '存在待核对的原文或术语变化';
    }
  }
}

export function hasDeferredTerm(state: DocState, link: SegmentUnitLink): boolean {
  return decisionsForLink(state, link).some((d) => currentDisposition(link, d.id)?.type === 'deferred');
}

/** 链路完全确认：当前原文指纹一致，且所有当前术语决定都已按当前版本处置并经确认。 */
export function isLinkFullyConfirmed(state: DocState, link: SegmentUnitLink): boolean {
  const segment = state.segments.find((s) => s.id === link.segmentId);
  if (!segment) return false;
  if (link.confirmedSource !== sourceFingerprint(segment.text)) {
    const unit = state.units.find((u) => u.id === link.unitId);
    if (!(link.confirmedSource === undefined && unit?.status === 'translated')) return false;
  }
  if (!isLinkTermSettled(state, link)) return false;
  const required = decisionsForLink(state, link).map(termSnapshot);
  return required.every((snap) => (link.confirmedTerms ?? []).includes(snap));
}

/** 该链路未确认仅由术语变化引起（原文指纹仍是当前版本）。 */
export function isTermOnlyIssue(state: DocState, link: SegmentUnitLink): boolean {
  const segment = state.segments.find((s) => s.id === link.segmentId);
  if (!segment) return false;
  const sourceCurrent =
    link.confirmedSource === sourceFingerprint(segment.text) ||
    (link.confirmedSource === undefined && state.units.find((u) => u.id === link.unitId)?.status === 'translated');
  return sourceCurrent && linkHasTermIssue(state, link);
}
