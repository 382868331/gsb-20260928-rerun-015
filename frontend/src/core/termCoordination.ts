import { DocState, LanguageCode, TermCoordination, TermCoordinationItem, TermDisposition } from './model';
import { nextId } from './identity';
import { sourceFingerprint } from './reviewWorkspace';
import { currentDisposition, decisionsForLink, isLinkTermSettled, reconcileUnitStatuses, segmentUsesTerm, termSnapshot, unitLanguage } from './terms';

function clone(state: DocState): DocState {
  return JSON.parse(JSON.stringify(state)) as DocState;
}

function ensureCoordinations(state: DocState): TermCoordination[] {
  if (!state.termCoordinations) state.termCoordinations = [];
  return state.termCoordinations;
}

function includesAny(text: string, values: Array<string | undefined>): boolean {
  return values.some((value) => Boolean(value && value.trim() && text.includes(value.trim())));
}

function replaceFirstFamily(text: string, target: string, alternatives: string[]): string {
  let next = text;
  const ordered = alternatives.map((v) => v.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const old of ordered) {
    if (next.includes(old)) return next.split(old).join(target);
  }
  return next;
}

export interface CoordinationCandidate extends TermCoordinationItem {
  segmentIndex: number;
  decisionId: string;
  decisionVersion: number;
  conflictingRendering?: string;
}

export function findTermCoordinationCandidates(state: DocState, decisionId: string, language: LanguageCode, targetRendering?: string): CoordinationCandidate[] {
  const decision = state.termDecisions.find((d) => d.id === decisionId && d.revokedAt === undefined);
  const rendering = decision?.renderings.find((r) => r.language === language);
  if (!decision || !rendering) return [];
  const target = (targetRendering ?? rendering.adopted).trim();
  const allowed = rendering.allowed ?? [];
  const candidates: CoordinationCandidate[] = [];

  for (const [segmentIndex, segment] of state.segments.entries()) {
    if (!segmentUsesTerm(segment.text, decision.term)) continue;
    for (const link of state.links.filter((l) => l.segmentId === segment.id)) {
      const unit = state.units.find((u) => u.id === link.unitId);
      if (!unit || unitLanguage(unit) !== language || unit.text.trim().length === 0) continue;
      if (!decisionsForLink(state, link).some((d) => d.id === decisionId)) continue;

      const disposition = currentDisposition(link, decisionId);
      const dispositionCurrent = disposition?.decisionVersion === decision.version;
      const blockedReasons: string[] = [];
      const exceptionHit = includesAny(segment.text, rendering.exceptionContexts ?? []) || includesAny(unit.text, rendering.exceptionContexts ?? []);
      const usesAllowed = includesAny(unit.text, allowed);
      const usesTarget = unit.text.includes(target);
      let candidateKind: CoordinationCandidate['candidateKind'] = 'same_concept';
      if (exceptionHit || (dispositionCurrent && disposition?.type === 'kept')) candidateKind = 'different_context';
      if ((link.originSegmentIds?.length ?? 0) > 0) candidateKind = 'split_merged_origin';

      if (usesTarget) blockedReasons.push('译文已包含目标译法');
      if (usesAllowed) blockedReasons.push('审阅者已声明该译法允许使用');
      if (exceptionHit) blockedReasons.push('命中必须保留的例外语境');
      if (dispositionCurrent && disposition?.type === 'kept') blockedReasons.push('该段已有带依据的例外裁决');
      if (dispositionCurrent && disposition?.type === 'deferred') blockedReasons.push('该段已被暂缓，尚未批准');
      if (dispositionCurrent && disposition?.type === 'applied' && !disposition.coordinationId) blockedReasons.push('该段已有独立应用裁决');
      if (dispositionCurrent && disposition?.coordinationId && disposition.type === 'applied') blockedReasons.push('该段已属于另一组协调');
      if (link.confirmedSource !== sourceFingerprint(segment.text)) blockedReasons.push('原文或段落对应已变化，尚未确认');

      const conflictingRendering = allowed.find((value) => unit.text.includes(value.trim()));
      const afterText = conflictingRendering ? replaceFirstFamily(unit.text, target, [conflictingRendering]) : unit.text;
      candidates.push({
        segmentIndex,
        segmentId: segment.id,
        unitId: unit.id,
        language,
        decisionId,
        decisionVersion: decision.version,
        candidateKind,
        conflictingRendering,
        beforeText: unit.text,
        afterText,
        sourceText: segment.text,
        originSegmentIds: [...(link.originSegmentIds ?? [])],
        eligible: blockedReasons.length === 0,
        blockedReasons,
      });
    }
  }

  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    const sameDecisionLinks = state.links
      .filter((l) => l.unitId === candidate.unitId)
      .filter((l) => decisionsForLink(state, l).some((d) => d.id === candidate.decisionId));
    const unapprovedSiblings = sameDecisionLinks.filter((l) => {
      if (l.segmentId === candidate.segmentId) return false;
      const sibling = candidates.find((c) => c.segmentId === l.segmentId && c.unitId === candidate.unitId);
      return !sibling?.eligible;
    });
    if (unapprovedSiblings.length > 0) {
      candidate.eligible = false;
      candidate.blockedReasons.push('同一译文单元还关联例外、未批准或来源待核段落');
    }
  }
  return candidates;
}

export interface CreateCoordinationInput {
  decisionId: string;
  language: LanguageCode;
  targetRendering: string;
  selectedKeys?: Array<{ segmentId: string; unitId: string }>;
  textOverrides?: Record<string, string>;
}

function candidateKey(segmentId: string, unitId: string): string {
  return `${segmentId}::${unitId}`;
}

export function previewTermCoordination(state: DocState, input: CreateCoordinationInput): { coordination: TermCoordination; candidates: CoordinationCandidate[] } {
  const candidates = findTermCoordinationCandidates(state, input.decisionId, input.language, input.targetRendering);
  const selected = new Set((input.selectedKeys ?? []).map((key) => candidateKey(key.segmentId, key.unitId)));
  const items: TermCoordinationItem[] = candidates.map((candidate) => {
    const key = candidateKey(candidate.segmentId, candidate.unitId);
    const override = input.textOverrides?.[key]?.trim();
    const afterText = override || candidate.afterText;
    const blockedReasons = [...candidate.blockedReasons];
    const revisionValid = afterText !== candidate.beforeText && afterText.includes(input.targetRendering.trim());
    if (!selected.has(key)) blockedReasons.push('用户未勾选该段');
    if (!revisionValid) {
      blockedReasons.push('预览文本必须包含目标译法且确有修改');
    }
    return {
      segmentId: candidate.segmentId,
      unitId: candidate.unitId,
      language: candidate.language,
      candidateKind: candidate.candidateKind,
      beforeText: candidate.beforeText,
      afterText,
      sourceText: candidate.sourceText,
      originSegmentIds: candidate.originSegmentIds,
      eligible: selected.has(key) && candidate.eligible && revisionValid,
      blockedReasons,
    };
  });
  const decision = state.termDecisions.find((d) => d.id === input.decisionId)!;
  return {
    candidates,
    coordination: {
      id: nextId('coordination'),
      decisionId: input.decisionId,
      decisionVersion: decision.version,
      language: input.language,
      term: decision.term,
      targetRendering: input.targetRendering.trim(),
      status: 'draft',
      items,
    },
  };
}

export function createTermCoordination(state: DocState, input: CreateCoordinationInput): { state: DocState; coordinationId: string } {
  const next = clone(state);
  const preview = previewTermCoordination(next, input);
  ensureCoordinations(next).push(preview.coordination);
  return { state: next, coordinationId: preview.coordination.id };
}

function appendDisposition(next: DocState, item: TermCoordinationItem, coordination: TermCoordination, now: string): void {
  const link = next.links.find((l) => l.segmentId === item.segmentId && l.unitId === item.unitId);
  if (!link) return;
  const disposition: TermDisposition = {
    decisionId: coordination.decisionId,
    decisionVersion: coordination.decisionVersion,
    type: 'applied',
    revisedText: item.afterText,
    coordinationId: coordination.id,
    decidedAt: now,
  };
  link.termDispositions = [...(link.termDispositions ?? []), disposition];
  if (isLinkTermSettled(next, link)) {
    const required = decisionsForLink(next, link).map((d) => termSnapshot(d));
    link.confirmedTerms = Array.from(new Set([...(link.confirmedTerms ?? []), ...required]));
  }
}

export function confirmTermCoordination(state: DocState, coordinationId: string, now: string = new Date().toISOString()): DocState {
  const next = clone(state);
  const coordination = ensureCoordinations(next).find((c) => c.id === coordinationId);
  const decision = next.termDecisions.find((d) => d.id === coordination?.decisionId);
  if (!coordination || coordination.status !== 'draft' || !decision || decision.revokedAt || decision.version !== coordination.decisionVersion) return next;

  const fresh = findTermCoordinationCandidates(next, coordination.decisionId, coordination.language, coordination.targetRendering);
  const freshByKey = new Map(fresh.map((c) => [candidateKey(c.segmentId, c.unitId), c]));
  for (const item of coordination.items) {
    const freshCandidate = freshByKey.get(candidateKey(item.segmentId, item.unitId));
    item.eligible = Boolean(freshCandidate?.eligible && item.afterText.includes(coordination.targetRendering) && item.afterText !== item.beforeText);
    item.blockedReasons = freshCandidate?.blockedReasons ?? ['候选已不存在'];
  }
  for (const item of coordination.items.filter((i) => i.eligible)) {
    const unit = next.units.find((u) => u.id === item.unitId);
    if (unit) unit.text = item.afterText;
    appendDisposition(next, item, coordination, now);
  }
  coordination.status = 'confirmed';
  coordination.confirmedAt = now;
  reconcileUnitStatuses(next);
  return next;
}

export function withdrawTermCoordination(state: DocState, coordinationId: string, reason = '审阅者撤回跨段协调', now: string = new Date().toISOString()): DocState {
  const next = clone(state);
  const coordination = ensureCoordinations(next).find((c) => c.id === coordinationId);
  if (!coordination || coordination.status === 'withdrawn') return next;
  coordination.status = 'withdrawn';
  coordination.withdrawnAt = now;
  coordination.withdrawReason = reason;

  for (const item of coordination.items) {
    const link = next.links.find((l) => l.segmentId === item.segmentId && l.unitId === item.unitId);
    if (!link) continue;
    const coordinatedIndex = (link.termDispositions ?? []).findIndex((d) => d.coordinationId === coordinationId && d.type === 'applied');
    if (coordinatedIndex < 0) continue;
    const laterIndependent = (link.termDispositions ?? []).slice(coordinatedIndex + 1).some((d) => d.coordinationId === undefined);
    if (laterIndependent) continue;
    link.termDispositions = [...(link.termDispositions ?? []), {
      decisionId: coordination.decisionId,
      decisionVersion: coordination.decisionVersion,
      type: 'deferred',
      coordinationId,
      rationale: reason,
      decidedAt: now,
    }];
    const decision = next.termDecisions.find((d) => d.id === coordination.decisionId);
    if (decision) link.confirmedTerms = (link.confirmedTerms ?? []).filter((snap) => snap !== termSnapshot(decision));
  }
  reconcileUnitStatuses(next);
  return next;
}
