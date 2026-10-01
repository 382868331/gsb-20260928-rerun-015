import { nextId } from './identity';
import {
  DocState,
  TermDecision,
  TermResolution,
  TermTranslationChoice,
  TranslationUnit,
} from './model';
import { normalizeText } from './similarity';

export interface TermDecisionInput {
  term: string;
  scopeSegmentIds: string[];
  translations: TermTranslationChoice[];
}

export interface ApplicableTerm {
  decision: TermDecision;
  choice: TermTranslationChoice;
  resolution?: TermResolution;
  state: 'missing' | 'outdated' | 'applied' | 'exception';
  finalConfirmed: boolean;
  oldTermFound: boolean;
}

function clone(state: DocState): DocState {
  return {
    ...state,
    termDecisions: (state.termDecisions ?? []).map((term) => ({
      ...term,
      scopeSegmentIds: [...term.scopeSegmentIds],
      translations: term.translations.map((choice) => ({ ...choice })),
    })),
    units: state.units.map((unit) => ({ ...unit })),
    links: state.links.map((link) => ({
      ...link,
      termResolutions: link.termResolutions
        ? Object.fromEntries(Object.entries(link.termResolutions).map(([id, resolution]) => [id, { ...resolution }]))
        : undefined,
      confirmedTermRevisions: link.confirmedTermRevisions ? { ...link.confirmedTermRevisions } : undefined,
    })),
  };
}

function nowText(): string {
  return new Date().toISOString();
}

function setUnitReview(next: DocState, unitId: string, reason: string): void {
  const unit = next.units.find((item) => item.id === unitId);
  if (unit && unit.status !== 'untranslated') {
    unit.status = 'review';
    unit.reason = reason;
  }
}

/** 创建术语决定并让范围内实际出现源术语、且已有译文的链路进入术语核对。 */
export function createTermDecision(state: DocState, input: TermDecisionInput): { state: DocState; termId: string } {
  const term = input.term.trim();
  if (!term) return { state, termId: '' };
  const next = clone(state);
  const scope = new Set(input.scopeSegmentIds);
  const termId = nextId('term');
  const decision: TermDecision = {
    id: termId,
    term,
    revision: 1,
    scopeSegmentIds: next.segments.filter((segment) => scope.has(segment.id) && segment.text.includes(term)).map((segment) => segment.id),
    translations: input.translations
      .filter((choice) => next.units.some((unit) => unit.id === choice.unitId))
      .map((choice) => ({
        unitId: choice.unitId,
        adopted: choice.adopted.trim(),
        previous: choice.previous?.trim() || undefined,
      }))
      .filter((choice) => choice.adopted.length > 0),
    status: 'active',
    createdAt: nowText(),
  };
  if (decision.translations.length === 0) return { state, termId: '' };
  next.termDecisions.push(decision);

  for (const link of next.links) {
    if (!scope.has(link.segmentId)) continue;
    const segment = next.segments.find((item) => item.id === link.segmentId);
    const choice = decision.translations.find((item) => item.unitId === link.unitId);
    const unit = next.units.find((item) => item.id === link.unitId);
    if (!segment || !choice || !unit || unit.text.trim().length === 0) continue;
    link.deferred = false;
    setUnitReview(next, unit.id, `术语“${term}”译法需逐段核对`);
  }
  return { state: next, termId };
}

/** 撤销术语决定：旧轮确认不会恢复；使用或保留过该术语的链路需重新人工处理。 */
export function revokeTermDecision(state: DocState, termId: string): DocState {
  const next = clone(state);
  const decision = next.termDecisions.find((term) => term.id === termId);
  if (!decision || decision.status !== 'active') return next;
  decision.status = 'revoked';
  decision.revokedAt = nowText();
  for (const link of next.links) {
    if (link.termResolutions?.[termId]) {
      link.deferred = false;
      setUnitReview(next, link.unitId, `术语“${decision.term}”决定已撤销，需重新核对`);
    }
  }
  return next;
}

export function applicableTermsForLink(state: DocState, segmentId: string, unitId: string): ApplicableTerm[] {
  const segment = state.segments.find((item) => item.id === segmentId);
  const unit = state.units.find((item) => item.id === unitId);
  if (!segment || !unit) return [];
  const result: ApplicableTerm[] = [];
  for (const decision of state.termDecisions ?? []) {
    const choice = decision.translations.find((item) => item.unitId === unitId);
    if (!choice || !decision.scopeSegmentIds.includes(segmentId) || !segment.text.includes(decision.term)) continue;
    const link = state.links.find(
      (link) => link.segmentId === segmentId && link.unitId === unitId,
    );
    const resolution = link?.termResolutions?.[decision.id];
    const current = resolution?.revision === decision.revision && resolution.sourceFingerprint === normalizeText(segment.text);
    const finalConfirmed = Boolean(current && link?.confirmedTermRevisions?.[decision.id] === decision.revision);
    if (decision.status === 'active') {
      result.push({
        decision,
        choice,
        resolution: current ? resolution : undefined,
        state: !resolution || !current ? 'missing' : resolution.decision === 'applied' ? 'applied' : 'exception',
        finalConfirmed,
        oldTermFound: Boolean(choice.previous && unit.text.includes(choice.previous)),
      });
    } else if (resolution) {
      result.push({
        decision,
        choice,
        resolution,
        state: 'outdated',
        finalConfirmed: false,
        oldTermFound: Boolean(choice.previous && unit.text.includes(choice.previous)),
      });
    }
  }
  return result;
}

function putResolution(
  next: DocState,
  segmentId: string,
  unitId: string,
  term: TermDecision,
  choice: TermTranslationChoice,
  decision: 'applied' | 'exception',
  rationale?: string,
): void {
  const segment = next.segments.find((item) => item.id === segmentId);
  const link = next.links.find((item) => item.segmentId === segmentId && item.unitId === unitId);
  if (!segment || !link) return;
  link.termResolutions ??= {};
  link.confirmedTermRevisions ??= {};
  delete link.confirmedTermRevisions[term.id];
  link.termResolutions[term.id] = {
    termId: term.id,
    revision: term.revision,
    decision,
    term: term.term,
    adopted: choice.adopted,
    rationale: rationale?.trim() || undefined,
    sourceFingerprint: normalizeText(segment.text),
    decidedAt: nowText(),
  };
  link.deferred = false;
}

function replaceTerm(unit: TranslationUnit, previous: string, adopted: string): string {
  return previous && unit.text.includes(previous) ? unit.text.split(previous).join(adopted) : unit.text;
}

function canApplyChoice(unit: TranslationUnit, previous: string | undefined, adopted: string): boolean {
  return Boolean(previous && unit.text.includes(previous)) || unit.text.includes(adopted);
}

/**
 * 按新术语修改当前语境。若该译文还挂在其它未处理段落，先为当前段复制一个语境专属译文，
 * 避免同一译文文本被无差别替换到不同语境。
 */
export function applyTermDecision(
  state: DocState,
  segmentId: string,
  unitId: string,
  termId: string,
): { state: DocState; unitId: string } {
  const term = state.termDecisions.find((item) => item.id === termId && item.status === 'active');
  const choice = term?.translations.find((item) => item.unitId === unitId);
  if (!term || !choice) return { state, unitId };
  const sourceUnit = state.units.find((unit) => unit.id === unitId);
  if (!sourceUnit || !canApplyChoice(sourceUnit, choice.previous, choice.adopted)) return { state, unitId };
  let next = clone(state);
  let targetUnitId = unitId;
  const otherLinks = next.links.filter((link) => link.unitId === unitId && link.segmentId !== segmentId);
  if (otherLinks.length > 0) {
    targetUnitId = nextId('unit');
    next.units.push({ ...sourceUnit, id: targetUnitId, status: 'review', reason: undefined });
    const currentIndex = next.links.findIndex((link) => link.segmentId === segmentId && link.unitId === unitId);
    if (currentIndex >= 0) {
      const currentLink = next.links[currentIndex];
      next.links[currentIndex] = { ...currentLink, unitId: targetUnitId };
    }
    const forkedChoice = { ...choice, unitId: targetUnitId };
    const forkedUnit = next.units.find((unit) => unit.id === targetUnitId)!;
    forkedUnit.text = replaceTerm(forkedUnit, choice.previous ?? '', choice.adopted);
    putResolution(next, segmentId, targetUnitId, term, forkedChoice, 'applied');
    forkedUnit.status = 'review';
    forkedUnit.reason = `已按术语“${term.term}”修改，请确认当前语境`;
    return { state: next, unitId: targetUnitId };
  }

  const unit = next.units.find((item) => item.id === unitId);
  if (unit) {
    unit.text = replaceTerm(unit, choice.previous ?? '', choice.adopted);
    unit.status = 'review';
    unit.reason = `已按术语“${term.term}”修改，请确认当前语境`;
  }
  putResolution(next, segmentId, unitId, term, choice, 'applied');
  return { state: next, unitId };
}

/** 人工保留原译法；必须填写依据，导出时单列为语境例外。 */
export function keepTermException(
  state: DocState,
  segmentId: string,
  unitId: string,
  termId: string,
  rationale: string,
): DocState {
  const term = state.termDecisions.find((item) => item.id === termId && item.status === 'active');
  const choice = term?.translations.find((item) => item.unitId === unitId);
  if (!term || !choice || !rationale.trim()) return state;
  const next = clone(state);
  putResolution(next, segmentId, unitId, term, choice, 'exception', rationale);
  const unit = next.units.find((item) => item.id === unitId);
  if (unit) {
    unit.status = 'review';
    unit.reason = `术语“${term.term}”已作为语境例外保留，待最终确认`;
  }
  return next;
}

export function deferTermResolution(
  state: DocState,
  segmentId: string,
  unitId: string,
  termId: string,
): DocState {
  const next = clone(state);
  const link = next.links.find((item) => item.segmentId === segmentId && item.unitId === unitId);
  const term = next.termDecisions.find((item) => item.id === termId);
  if (!link || !term) return next;
  link.deferred = true;
  setUnitReview(next, unitId, `术语“${term.term}”已暂缓，稍后逐语境核对`);
  return next;
}

/** 人工看过撤销后的语境，清掉旧术语决议；随后可对当前原文做一次新的确认。 */
export function acknowledgeRevokedTerm(
  state: DocState,
  segmentId: string,
  unitId: string,
  termId: string,
): DocState {
  const next = clone(state);
  const decision = next.termDecisions.find((term) => term.id === termId);
  const link = next.links.find((item) => item.segmentId === segmentId && item.unitId === unitId);
  if (decision?.status === 'revoked' && link?.termResolutions) {
    delete link.termResolutions[termId];
  }
  return next;
}

export function hasStaleTermResolution(state: DocState, segmentId: string, unitId: string): boolean {
  return applicableTermsForLink(state, segmentId, unitId).some((term) => term.state !== 'applied' && term.state !== 'exception');
}

export function unitLanguageLabel(unit: TranslationUnit | undefined): string {
  return unit?.languageLabel?.trim() || unit?.id.slice(0, 8) || '译文';
}
