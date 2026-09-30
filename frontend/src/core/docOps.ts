import { DocState, OpMeta, Segment, SegmentKind, TranslationUnit, TranslationStatus, DEFAULT_LANGUAGE } from './model';
import { nextId } from './identity';
import { normalizeText } from './similarity';

function clone(state: DocState): DocState {
  return {
    title: state.title,
    segments: state.segments.map((s) => ({ ...s })),
    units: state.units.map((u) => ({ ...u })),
    links: state.links.map((l) => ({ ...l })),
  };
}

export function unitIdsForSegment(state: DocState, segmentId: string): string[] {
  return state.links.filter((l) => l.segmentId === segmentId).map((l) => l.unitId);
}

export function unitsForSegment(state: DocState, segmentId: string): TranslationUnit[] {
  return unitIdsForSegment(state, segmentId)
    .map((unitId) => state.units.find((u) => u.id === unitId))
    .filter((u): u is TranslationUnit => Boolean(u));
}

export function segmentIdsForUnit(state: DocState, unitId: string): string[] {
  return state.links.filter((l) => l.unitId === unitId).map((l) => l.segmentId);
}

export function createDocument(title: string, lines: Array<{ kind?: SegmentKind; text: string }>): DocState {
  return {
    title,
    segments: lines.map((line, index) => ({
      id: nextId('seg'),
      kind: line.kind ?? (index === 0 ? 'heading' : 'paragraph'),
      text: line.text,
    })),
    units: [],
    links: [],
  };
}

/**
 * 编辑源文段落：身份不变。
 * - 仅空白/排版变化：译文原样保留；
 * - 任何实际内容变化（哪怕只是“允许”→“禁止”一个词）：
 *   该段关联的所有语言译文一律进入待核对，不按改动字数/相似度判断含义。
 *   已确认译文携带的 provenance 同时失效，用户重新确认后才可采用。
 */
export function editSegment(
  state: DocState,
  segmentId: string,
  newText: string,
): { state: DocState; meta: OpMeta } {
  const next = clone(state);
  const segment = next.segments.find((s) => s.id === segmentId);
  if (!segment) return { state: next, meta: { type: 'edit' } };
  const oldText = segment.text;
  segment.text = newText;

  if (normalizeText(oldText) === normalizeText(newText)) {
    return { state: next, meta: { type: 'edit' } };
  }

  const affected = new Set(unitIdsForSegment(next, segmentId));
  for (const unit of next.units) {
    if (!affected.has(unit.id)) continue;
    if (unit.status === 'untranslated' || !unit.text.trim()) {
      // 还没有实际译文的单元不需要人工核对，只更新核对快照。
      unit.reviewContext = {
        ...unit.reviewContext,
        [segmentId]: { before: oldText, after: newText },
      };
      continue;
    }
    unit.status = 'review';
    unit.reason = '源文内容已修改，请逐语言核对译文';
    unit.reviewContext = {
      ...unit.reviewContext,
      [segmentId]: { before: oldText, after: newText },
    };
  }
  return { state: next, meta: { type: 'edit' } };
}

/** 移动段落：仅调整顺序，身份与关联、译文状态完全保留。 */
export function moveSegment(
  state: DocState,
  segmentId: string,
  toIndex: number,
): { state: DocState; meta: OpMeta } {
  const next = clone(state);
  const from = next.segments.findIndex((s) => s.id === segmentId);
  if (from < 0) return { state: next, meta: { type: 'move' } };
  const clamped = Math.max(0, Math.min(toIndex, next.segments.length - 1));
  const [moved] = next.segments.splice(from, 1);
  next.segments.splice(clamped, 0, moved);
  return { state: next, meta: { type: 'move' } };
}

function markUnitsReview(next: DocState, unitIds: Set<string>, reason: string): void {
  for (const unit of next.units) {
    if (!unitIds.has(unit.id) || unit.status === 'untranslated' || !unit.text.trim()) continue;
    unit.status = 'review';
    unit.reason = reason;
    // 注意：不清除 provenance——拆合保留确认来源（历史由谁对哪版原文确认），
    // 但其键已不覆盖新段，reconcile 会判定它不能确认当前版本。
  }
}

function carryReviewContext(
  unit: TranslationUnit,
  removedIds: string[],
  created: Array<{ id: string; text: string }>,
  before: Map<string, string>,
  reason: string,
): void {
  const context: Record<string, { before: string; after: string }> = {};
  for (const [key, value] of Object.entries(unit.reviewContext ?? {})) {
    if (!removedIds.includes(key)) context[key] = value;
  }
  for (const id of removedIds) {
    const oldText = before.get(id);
    if (oldText === undefined) continue;
    for (const segment of created) {
      context[segment.id] = { before: oldText, after: segment.text };
    }
  }
  unit.reviewContext = Object.keys(context).length > 0 ? context : undefined;
  if (unit.status !== 'untranslated' && unit.text.trim() && !unit.provenance) {
    unit.status = 'review';
    unit.reason = reason;
  }
}

/**
 * 拆分段落：原段被多个新段替换（新身份）。
 * 旧译文单元先与每个拆分段保持关联（多对一），置待核对，等待人工重新指定。
 */
export function splitSegment(
  state: DocState,
  segmentId: string,
  parts: string[],
): { state: DocState; meta: OpMeta } {
  const next = clone(state);
  const index = next.segments.findIndex((s) => s.id === segmentId);
  if (index < 0 || parts.length === 0) return { state: next, meta: { type: 'split' } };
  const original = next.segments[index];
  const inheritedUnits = unitIdsForSegment(next, segmentId);

  const newSegments: Segment[] = parts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({
      id: nextId('seg'),
      kind: original.kind === 'heading' ? 'paragraph' : original.kind,
      text,
    }));
  if (newSegments.length === 0) return { state: next, meta: { type: 'split' } };

  next.segments.splice(index, 1, ...newSegments);
  next.links = next.links.filter((l) => l.segmentId !== segmentId);
  for (const seg of newSegments) {
    for (const unitId of inheritedUnits) {
      next.links.push({ segmentId: seg.id, unitId });
    }
  }
  const before = new Map([[segmentId, original.text]]);
  const createdInfo = newSegments.map((s) => ({ id: s.id, text: s.text }));
  for (const unitId of inheritedUnits) {
    const unit = next.units.find((u) => u.id === unitId);
    if (!unit) continue;
    carryReviewContext(unit, [segmentId], createdInfo, before, '段落已拆分，请核对并重新指定译文对应');
  }
  markUnitsReview(next, new Set(inheritedUnits), '段落已拆分，请核对并重新指定译文对应');

  return {
    state: next,
    meta: {
      type: 'split',
      removedSegmentIds: [segmentId],
      createdSegmentIds: newSegments.map((s) => s.id),
    },
  };
}

/**
 * 合并段落：多个段（按当前顺序相邻）合并为一个新段。
 * 各段原译文单元全部与新段关联（一对多），置待核对，等待人工调整。
 */
export function mergeSegments(
  state: DocState,
  segmentIds: string[],
  separator = ' ',
): { state: DocState; meta: OpMeta } {
  const next = clone(state);
  const indices = segmentIds
    .map((id) => next.segments.findIndex((s) => s.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length < 2) return { state: next, meta: { type: 'merge' } };

  const mergedSegments = indices.map((i) => next.segments[i]);
  const inheritedUnits = new Set<string>();
  for (const seg of mergedSegments) {
    for (const unitId of unitIdsForSegment(next, seg.id)) inheritedUnits.add(unitId);
  }

  const merged: Segment = {
    id: nextId('seg'),
    kind: mergedSegments.every((s) => s.kind === 'heading') ? 'heading' : 'paragraph',
    text: mergedSegments.map((s) => s.text).join(separator),
  };
  const first = indices[0];
  next.segments = next.segments.filter((s) => !segmentIds.includes(s.id));
  next.segments.splice(first, 0, merged);

  const removed = new Set(segmentIds);
  next.links = next.links.filter((l) => !removed.has(l.segmentId));
  for (const unitId of inheritedUnits) {
    next.links.push({ segmentId: merged.id, unitId });
  }
  const before = new Map(mergedSegments.map((s) => [s.id, s.text]));
  const createdInfo = [{ id: merged.id, text: merged.text }];
  for (const unitId of inheritedUnits) {
    const unit = next.units.find((u) => u.id === unitId);
    if (!unit) continue;
    carryReviewContext(unit, segmentIds, createdInfo, before, '段落已合并，请核对译文对应');
  }
  markUnitsReview(next, inheritedUnits, '段落已合并，请核对译文对应');

  return {
    state: next,
    meta: {
      type: 'merge',
      removedSegmentIds: segmentIds,
      createdSegmentIds: [merged.id],
    },
  };
}

/** 人工建立对应关系（一对多/多对一都由 link 表表达）。 */
export function linkSegmentUnit(
  state: DocState,
  segmentId: string,
  unitId: string,
): DocState {
  const next = clone(state);
  const exists = next.links.some(
    (l) => l.segmentId === segmentId && l.unitId === unitId,
  );
  if (!exists) next.links.push({ segmentId, unitId });
  return reconcileConfirmedUnits(next);
}

/** 人工解除对应。失去所有段落关联的译文单元保留为“未关联”，不丢失。 */
export function unlinkSegmentUnit(
  state: DocState,
  segmentId: string,
  unitId: string,
): DocState {
  const next = clone(state);
  next.links = next.links.filter(
    (l) => !(l.segmentId === segmentId && l.unitId === unitId),
  );
  return next;
}

/** 为段落新建空译文单元并建立关联。 */
export function createUnitForSegment(
  state: DocState,
  segmentId: string,
  lang: string = DEFAULT_LANGUAGE,
): { state: DocState; unitId: string } {
  const next = clone(state);
  const unitId = nextId('unit');
  next.units.push({ id: unitId, text: '', status: 'untranslated', lang });
  next.links.push({ segmentId, unitId });
  return { state: next, unitId };
}

export function updateTranslation(state: DocState, unitId: string, text: string): DocState {
  const next = clone(state);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) return next;
  unit.text = text;
  if (text.trim().length === 0) {
    unit.status = 'untranslated';
    unit.reason = undefined;
    unit.provenance = undefined;
    return next;
  }
  // 录入或修改译文本身不等于确认；源文改动后，新译文也要显式确认后才采用。
  if (unit.status === 'untranslated' || unit.status === 'retranslate') {
    unit.status = 'review';
    unit.reason = unit.reason ?? '译文已更新，请核对后采用';
  }
  return next;
}

export function setTranslationStatus(
  state: DocState,
  unitId: string,
  status: TranslationStatus,
): DocState {
  const next = clone(state);
  const unit = next.units.find((u) => u.id === unitId);
  if (unit) {
    unit.status = status;
    if (status === 'translated') unit.reason = undefined;
  }
  return next;
}

/** 当前关联段落的规范化原文，作为确认来源内容。 */
export function currentSourceFingerprint(
  state: DocState,
  unitId: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const segmentId of segmentIdsForUnit(state, unitId)) {
    const segment = state.segments.find((s) => s.id === segmentId);
    if (segment) result[segmentId] = normalizeText(segment.text);
  }
  return result;
}

function fingerprintsMatch(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length === 0 || aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * 用户在核对工作区确认采用译文（分别按语言确认）。
 * provenance 记录确认时的全部关联原文；之后原文再变会立刻失效。
 */
export function confirmUnit(state: DocState, unitId: string): DocState {
  const next = clone(state);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit || !unit.text.trim()) return next;
  unit.status = 'translated';
  unit.reason = undefined;
  unit.provenance = currentSourceFingerprint(next, unitId);
  unit.reviewContext = undefined;
  return next;
}

export type ReviewDecision = 'confirm' | 'retranslate' | 'defer';

/** 核对决策：确认采用 / 重译（旧译文保留参考但不采用）/ 暂缓。 */
export function decideReview(
  state: DocState,
  unitId: string,
  decision: ReviewDecision,
): DocState {
  if (decision === 'confirm') return confirmUnit(state, unitId);
  const next = clone(state);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) return next;
  if (decision === 'retranslate') {
    unit.status = 'retranslate';
    unit.reason = '已要求重译，旧译文保留仅供参考';
    unit.provenance = undefined;
  } else {
    unit.status = 'deferred';
    unit.reason = '暂缓处理，导出时计入待处理内容';
    unit.provenance = undefined;
  }
  return next;
}

/**
 * 依据确认来源（provenance）校验所有“已确认”译文：
 * 只要关联原文与确认时不一致（含另一版本的确认、手工改挂、撤销后内容不匹配），
 * 一律退回待核对。未关联译文保留原状态。
 */
export function reconcileConfirmedUnits(state: DocState): DocState {
  let changed = false;
  const units = state.units.map((unit) => ({ ...unit }));
  for (const unit of units) {
    if (unit.status !== 'translated') continue;
    const segmentIds = state.links
      .filter((l) => l.unitId === unit.id)
      .map((l) => l.segmentId);
    if (segmentIds.length === 0) continue;
    const fingerprint: Record<string, string> = {};
    for (const segmentId of segmentIds) {
      const segment = state.segments.find((s) => s.id === segmentId);
      if (segment) fingerprint[segmentId] = normalizeText(segment.text);
    }
    if (!fingerprintsMatch(fingerprint, unit.provenance)) {
      unit.status = 'review';
      unit.reason = '确认来源与当前原文不一致，请重新核对';
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, units, links: state.links.map((l) => ({ ...l })) };
}
