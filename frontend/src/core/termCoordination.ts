import {
  CoordinationTarget,
  DocState,
  LanguageCode,
  TermCoordination,
  TermDecision,
  TermDisposition,
} from './model';
import { nextId } from './identity';
import { sourceFingerprint } from './reviewWorkspace';
import {
  activeTermDecisions,
  currentDisposition,
  decideTermOnLink,
  isLinkFullyConfirmed,
  isLinkTermSettled,
  reconcileUnitStatuses,
  refreshLinkState,
  segmentUsesTerm,
  unitLanguage,
} from './terms';

function clone(state: DocState): DocState {
  return JSON.parse(JSON.stringify(state)) as DocState;
}

function targetKey(segmentId: string, unitId: string): string {
  return segmentId + '::' + unitId;
}

function ensureCoordinations(state: DocState): TermCoordination[] {
  if (!state.coordinations) state.coordinations = [];
  return state.coordinations;
}

function findDecision(state: DocState, decisionId: string): TermDecision | undefined {
  return activeTermDecisions(state).find((d) => d.id === decisionId);
}

/**
 * 在多份译文修订中寻找某术语决定在某语言下的冲突出现位置，并分类：
 * - same-concept：真正同一概念，可纳入协调替换；
 * - different-context：同文不同语境，已有审阅者声明的保留例外（附依据），永不纳入；
 * - split-origin：段落拆合后来源可溯的同一概念，可纳入但展示谱系来源。
 * 译文不含冲突译法 from 的位置不是冲突，不列为目标。
 */
export function scanCoordinationCandidates(
  state: DocState,
  decisionId: string,
  language: LanguageCode,
  from: string,
): CoordinationTarget[] {
  const decision = findDecision(state, decisionId);
  const key = from.trim();
  if (!decision || key.length === 0) return [];
  const rendering = decision.renderings.find((r) => r.language === language);
  if (!rendering || rendering.adopted.trim().length === 0) return [];
  const targets: CoordinationTarget[] = [];
  for (const segment of state.segments) {
    if (!segmentUsesTerm(segment.text, decision.term)) continue;
    for (const link of state.links.filter((l) => l.segmentId === segment.id)) {
      const unit = state.units.find((u) => u.id === link.unitId);
      if (!unit || unit.text.trim().length === 0) continue;
      if (unitLanguage(unit) !== language) continue;
      if (!unit.text.includes(key)) continue;
      const disposition = currentDisposition(link, decision.id);
      const keptException =
        disposition?.type === 'kept' && disposition.decisionVersion === decision.version;
      const splitOrigin = (link.originSegmentIds?.length ?? 0) > 0;
      const kind = keptException ? 'different-context' : splitOrigin ? 'split-origin' : 'same-concept';
      targets.push({
        segmentId: segment.id,
        unitId: unit.id,
        language,
        kind,
        eligible: !keptException,
        blockReason: keptException
          ? `已声明例外语境${disposition?.rationale ? `：${disposition.rationale}` : ''}`
          : undefined,
        currentText: unit.text,
        proposedText: unit.text.split(key).join(rendering.adopted),
        originSegmentIds: splitOrigin ? [...link.originSegmentIds!] : undefined,
        sourceFingerprintAtPlan: sourceFingerprint(segment.text),
        decisionVersionAtPlan: decision.version,
      });
    }
  }
  return targets;
}

/** 形成一组协调替换（草案）：只记录目标与预览文本，不改任何译文。 */
export function planCoordination(
  state: DocState,
  decisionId: string,
  language: LanguageCode,
  from: string,
  now: string = new Date().toISOString(),
): { state: DocState; coordinationId: string | null } {
  const decision = findDecision(state, decisionId);
  if (!decision) return { state, coordinationId: null };
  const rendering = decision.renderings.find((r) => r.language === language);
  if (!rendering || from.trim().length === 0) return { state, coordinationId: null };
  const targets = scanCoordinationCandidates(state, decisionId, language, from);
  if (targets.length === 0) return { state, coordinationId: null };
  const next = clone(state);
  ensureCoordinations(next);
  const coordination: TermCoordination = {
    id: nextId('coord'),
    decisionId,
    term: decision.term,
    language,
    from: from.trim(),
    to: rendering.adopted,
    createdAt: now,
    targets,
    status: 'draft',
  };
  next.coordinations!.push(coordination);
  return { state: next, coordinationId: coordination.id };
}

export interface CoordinationPreviewItem {
  target: CoordinationTarget;
  action: 'apply' | 'skip';
  skipReason?: string;
  /** 该目标上既有的逐段处置（预览对既有裁决的影响）。 */
  existingDisposition?: TermDisposition;
  /** 该链路当前是否已完全确认（应用协调将改写其确认依据）。 */
  linkCurrentlyConfirmed: boolean;
}

export interface CoordinationPreview {
  coordinationId: string;
  items: CoordinationPreviewItem[];
  applicableCount: number;
  skippedCount: number;
}

/** 确认前逐项复核目标是否仍可应用：决定被修订、出现例外、原文变化、译文已变都会阻止对应项。 */
function evaluateTarget(
  state: DocState,
  plan: TermCoordination,
  target: CoordinationTarget,
): { ok: boolean; reason?: string } {
  if (!target.eligible) return { ok: false, reason: target.blockReason ?? '不可纳入协调' };
  const decision = findDecision(state, plan.decisionId);
  if (!decision) return { ok: false, reason: '术语决定已撤销' };
  if (decision.version !== target.decisionVersionAtPlan) {
    return { ok: false, reason: '术语决定已修订，本方案基于旧版本' };
  }
  const segment = state.segments.find((s) => s.id === target.segmentId);
  const unit = state.units.find((u) => u.id === target.unitId);
  const link = state.links.find(
    (l) => l.segmentId === target.segmentId && l.unitId === target.unitId,
  );
  if (!segment || !unit || !link) return { ok: false, reason: '段落或译文已不存在' };
  if (sourceFingerprint(segment.text) !== target.sourceFingerprintAtPlan) {
    return { ok: false, reason: '原文已变化，仅阻止该部分' };
  }
  const disposition = currentDisposition(link, decision.id);
  if (disposition?.type === 'kept' && disposition.decisionVersion === decision.version) {
    return { ok: false, reason: '已声明例外语境，协调不得覆盖' };
  }
  if (!unit.text.includes(plan.from)) {
    return { ok: false, reason: '译文已不含待替换译法' };
  }
  return { ok: true };
}

/** 预览一组协调替换对各段既有裁决的影响：哪些会应用、哪些被跳过及原因。 */
export function previewCoordination(state: DocState, coordinationId: string): CoordinationPreview | null {
  const plan = state.coordinations?.find((c) => c.id === coordinationId);
  if (!plan) return null;
  const items: CoordinationPreviewItem[] = plan.targets.map((target) => {
    const verdict = evaluateTarget(state, plan, target);
    const link = state.links.find(
      (l) => l.segmentId === target.segmentId && l.unitId === target.unitId,
    );
    return {
      target,
      action: verdict.ok ? 'apply' : 'skip',
      skipReason: verdict.reason,
      existingDisposition: link ? currentDisposition(link, plan.decisionId) : undefined,
      linkCurrentlyConfirmed: link ? isLinkFullyConfirmed(state, link) : false,
    };
  });
  return {
    coordinationId,
    items,
    applicableCount: items.filter((i) => i.action === 'apply').length,
    skippedCount: items.filter((i) => i.action === 'skip').length,
  };
}

/**
 * 确认一组协调替换：逐项复核后只应用仍有效的目标。
 * 原文变化等只阻止受影响部分，其余目标独立应用并随处置确认；
 * 例外语境与未批准段落（原文已变）绝不被全局替换覆盖。
 */
export function applyCoordination(
  state: DocState,
  coordinationId: string,
  now: string = new Date().toISOString(),
): { state: DocState; appliedKeys: string[]; skipped: Array<{ key: string; reason: string }> } {
  const plan = state.coordinations?.find((c) => c.id === coordinationId);
  if (!plan || plan.status !== 'draft') return { state, appliedKeys: [], skipped: [] };
  let next = clone(state);
  const appliedKeys: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const target of plan.targets) {
    const key = targetKey(target.segmentId, target.unitId);
    const verdict = evaluateTarget(next, plan, target);
    if (!verdict.ok) {
      skipped.push({ key, reason: verdict.reason ?? '' });
      continue;
    }
    const unit = next.units.find((u) => u.id === target.unitId)!;
    const revisedText = unit.text.split(plan.from).join(plan.to);
    next = decideTermOnLink(next, target.segmentId, target.unitId, plan.decisionId, 'applied', {
      revisedText,
      rationale: `跨段协调替换：${plan.from} → ${plan.to}`,
    }, now);
    const link = next.links.find(
      (l) => l.segmentId === target.segmentId && l.unitId === target.unitId,
    )!;
    const dispositions = link.termDispositions ?? [];
    dispositions[dispositions.length - 1].coordinationId = plan.id;
    appliedKeys.push(key);
  }
  const stored = next.coordinations!.find((c) => c.id === coordinationId)!;
  stored.status = 'applied';
  stored.appliedAt = now;
  stored.appliedKeys = appliedKeys;
  return { state: next, appliedKeys, skipped };
}

/**
 * 撤回一项协调：只收回由本次协调产生的处置（仍为该决定最新处置时），
 * 译文未被后续改动则同时还原；后续针对同一链路的独立裁决一律保留。
 */
export function withdrawCoordination(
  state: DocState,
  coordinationId: string,
  now: string = new Date().toISOString(),
): DocState {
  const plan = state.coordinations?.find((c) => c.id === coordinationId);
  if (!plan || plan.status !== 'applied') return state;
  const next = clone(state);
  const stored = next.coordinations!.find((c) => c.id === coordinationId)!;
  stored.status = 'withdrawn';
  stored.withdrawnAt = now;
  for (const key of stored.appliedKeys ?? []) {
    const [segmentId, unitId] = key.split('::');
    const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
    if (!link) continue;
    const dispositions = link.termDispositions ?? [];
    const lastForDecision = dispositions.map((d, i) => ({ d, i })).filter(
      ({ d }) => d.decisionId === plan.decisionId,
    );
    const last = lastForDecision[lastForDecision.length - 1];
    // 该决定上已有后续独立裁决：协调处置被覆盖，撤回不影响现状。
    if (!last || last.d.coordinationId !== plan.id) continue;
    link.termDispositions = dispositions.filter((_, index) => index !== last.i);
    const target = stored.targets.find(
      (t) => t.segmentId === segmentId && t.unitId === unitId,
    );
    const unit = next.units.find((u) => u.id === unitId);
    if (unit && target?.proposedText !== undefined && unit.text === target.proposedText) {
      unit.text = target.currentText;
    }
    const segment = next.segments.find((s) => s.id === segmentId);
    if (segment) {
      if (!isLinkTermSettled(next, link)) {
        if (unit && unit.text.trim().length > 0) {
          unit.status = 'review';
          unit.reason = `术语“${plan.term}”的协调替换已撤回，请重新核对`;
        }
      }
      refreshLinkState(next, link, segment.text);
    }
  }
  reconcileUnitStatuses(next);
  return next;
}

/** 某术语决定相关的全部协调（含已撤回，供追溯）。 */
export function coordinationsForDecision(state: DocState, decisionId: string): TermCoordination[] {
  return (state.coordinations ?? []).filter((c) => c.decisionId === decisionId);
}
