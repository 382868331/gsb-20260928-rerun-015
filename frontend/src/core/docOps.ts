import { DocState, LanguageCode, OpMeta, Segment, SegmentKind, TranslationStatus } from './model';
import { nextId } from './identity';
import { normalizeText } from './similarity';
import { sourceFingerprint } from './reviewWorkspace';
import { reconcileUnitStatuses, refreshLinkState } from './terms';

function clone(state: DocState): DocState {
  return {
    title: state.title,
    segments: state.segments.map((s) => ({ ...s })),
    units: state.units.map((u) => ({ ...u })),
    links: state.links.map((l) => ({ ...l })),
    termDecisions: (state.termDecisions ?? []).map((d) => ({ ...d })),
  };
}

export function unitIdsForSegment(state: DocState, segmentId: string): string[] {
  return state.links.filter((l) => l.segmentId === segmentId).map((l) => l.unitId);
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
    termDecisions: [],
  };
}

/**
 * 编辑源文段落：身份不变。
 * - 仅空白/排版变化：译文原样保留；
 * - 实质改写：只把该段关联的译文单元置为待核对，不影响其他段落。
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

  if (normalizeText(oldText) !== normalizeText(newText)) {
    const affected = new Set(unitIdsForSegment(next, segmentId));
    for (const unit of next.units) {
      if (affected.has(unit.id) && unit.status !== 'untranslated') {
        unit.status = 'review';
        unit.reason = '原文内容已变更，请核对译文';
      }
    }
    for (const link of next.links) {
      if (link.segmentId === segmentId && affected.has(link.unitId)) {
        link.sourceBefore = oldText;
        if (link.confirmedSource !== undefined) {
          link.priorConfirmedSource = link.confirmedSource;
        }
        if ((link.confirmedTerms?.length ?? 0) > 0) {
          link.priorConfirmedTerms = [
            ...(link.priorConfirmedTerms ?? []),
            ...(link.confirmedTerms ?? []),
          ];
          link.confirmedTerms = [];
        }
        link.confirmedSource = undefined;
        refreshLinkState(next, link, newText);
      }
    }
    reconcileUnitStatuses(next);
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
    if (unitIds.has(unit.id) && unit.status !== 'untranslated') {
      unit.status = 'review';
      unit.reason = reason;
    }
  }
}

/** 拆合产生新段落：继承旧关联，但旧确认指纹降格为“确认沿革”，需重新核对。 */
function inheritLinks(
  next: DocState,
  newSegmentIds: string[],
  inheritedUnitIds: string[],
  sourceBefore: string,
): void {
  for (const segmentId of newSegmentIds) {
    for (const unitId of inheritedUnitIds) {
      const prior = next.links.find(
        (l) => l.segmentId === segmentId && l.unitId === unitId,
      );
      next.links.push({
        segmentId,
        unitId,
        sourceBefore,
        priorConfirmedSource: prior?.confirmedSource ?? prior?.priorConfirmedSource,
        priorConfirmedTerms: prior?.confirmedTerms ?? prior?.priorConfirmedTerms,
      });
    }
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
  inheritLinks(
    next,
    newSegments.map((s) => s.id),
    inheritedUnits,
    original.text,
  );
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
  const inheritedLinks = next.links.filter((l) => removed.has(l.segmentId));
  next.links = next.links.filter((l) => !removed.has(l.segmentId));
  const sourceBefore = mergedSegments.map((s) => s.text).join(separator);
  for (const unitId of inheritedUnits) {
    const oldLink = inheritedLinks.find((l) => l.unitId === unitId);
    next.links.push({
      segmentId: merged.id,
      unitId,
      sourceBefore,
      priorConfirmedSource: oldLink?.confirmedSource ?? oldLink?.priorConfirmedSource,
      priorConfirmedTerms: oldLink?.confirmedTerms ?? oldLink?.priorConfirmedTerms,
    });
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
  if (!exists) {
    next.links.push({ segmentId, unitId });
    const unit = next.units.find((u) => u.id === unitId);
    const segment = next.segments.find((s) => s.id === segmentId);
    if (unit && segment && unit.text.trim().length > 0) {
      unit.status = 'review';
      unit.reason = '译文新挂到该段，需按当前原文确认';
    }
  }
  return next;
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
  language: LanguageCode = 'en',
): { state: DocState; unitId: string } {
  const next = clone(state);
  const unitId = nextId('unit');
  next.units.push({ id: unitId, language, text: '', status: 'untranslated' });
  next.links.push({ segmentId, unitId });
  return { state: next, unitId };
}

export function updateTranslation(state: DocState, unitId: string, text: string): DocState {
  const next = clone(state);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) return next;
  unit.text = text;
  if (text.trim().length > 0 && unit.status === 'untranslated') {
    unit.status = 'translated';
    for (const segmentId of segmentIdsForUnit(next, unitId)) {
      const segment = next.segments.find((s) => s.id === segmentId);
      const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
      if (segment && link && link.confirmedSource === undefined) {
        link.confirmedSource = sourceFingerprint(segment.text);
        link.sourceBefore = undefined;
      }
    }
  }
  if (text.trim().length === 0) {
    unit.status = 'untranslated';
    unit.reason = undefined;
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
    if (status === 'translated') {
      unit.reason = undefined;
      for (const segmentId of segmentIdsForUnit(next, unitId)) {
        const segment = next.segments.find((s) => s.id === segmentId);
        const link = next.links.find((l) => l.segmentId === segmentId && l.unitId === unitId);
        if (segment && link) {
          link.confirmedSource = sourceFingerprint(segment.text);
          link.sourceBefore = undefined;
        }
      }
    }
  }
  return next;
}
