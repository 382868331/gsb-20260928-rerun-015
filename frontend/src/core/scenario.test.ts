import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  mergeSegments,
  moveSegment,
  splitSegment,
  unlinkSegmentUnit,
  updateTranslation,
  confirmUnit,
  setTranslationStatus,
  unitIdsForSegment,
} from './docOps';
import { DocState } from './model';
import { checkIntegrity } from './integrity';

/** 含重复句子与中文标题的文稿。 */
function buildScenarioDoc(): DocState {
  let doc = createDocument('重复句核对稿', [
    { kind: 'heading', text: '产品更新公告' },
    { text: '我们今天发布了新版本。' },
    { text: '新版本提升了稳定性。' },
    { text: '我们今天发布了新版本。' },
    { text: '感谢大家的支持与反馈。' },
  ]);
  const translate = (index: number, text: string) => {
    const segmentId = doc.segments[index].id;
    const result = createUnitForSegment(doc, segmentId);
    doc = confirmUnit(updateTranslation(result.state, result.unitId, text), result.unitId);
  };
  translate(0, 'Product Update Announcement');
  translate(1, 'We released a new version today.');
  translate(2, 'The new version improves stability.');
  translate(3, 'Different translation for the repeated line.');
  translate(4, 'Thanks for your support and feedback.');
  return doc;
}

describe('段落身份与译文对应', () => {
  it('移动位置保留身份、关联与译文状态', () => {
    const doc = buildScenarioDoc();
    const moved = doc.segments[1];
    const movedUnits = unitIdsForSegment(doc, moved.id);

    const { state } = moveSegment(doc, moved.id, 3);

    expect(state.segments.map((s) => s.text)).toEqual([
      '产品更新公告',
      '新版本提升了稳定性。',
      '我们今天发布了新版本。',
      '我们今天发布了新版本。',
      '感谢大家的支持与反馈。',
    ]);
    const movedAgain = state.segments.find((s) => s.id === moved.id)!;
    expect(movedAgain).toBeDefined();
    expect(unitIdsForSegment(state, moved.id)).toEqual(movedUnits);
    expect(state.units.every((u) => u.status === 'translated')).toBe(true);
    expect(checkIntegrity(state).ok).toBe(true);
  });

  it('实质改写只标记受影响段落的译文，无差别失效不发生', () => {
    const doc = buildScenarioDoc();
    const targetId = doc.segments[1].id;
    const otherIds = doc.segments.filter((_, i) => i !== 1).map((s) => s.id);

    const whitespaceOnly = editSegment(doc, targetId, ' 我们今天发布了新版本。\n ').state;
    expect(whitespaceOnly.units.every((u) => u.status === 'translated')).toBe(true);

    const rewritten = editSegment(doc, targetId, '我们昨天回滚了旧版本。').state;
    const affectedUnits = new Set(unitIdsForSegment(rewritten, targetId));
    for (const unit of rewritten.units) {
      if (affectedUnits.has(unit.id)) expect(unit.status).toBe('review');
      else expect(unit.status).toBe('translated');
    }
    const reviewCount = rewritten.units.filter((u) => u.status === 'review').length;
    expect(reviewCount).toBe(1);
    expect(otherIds.every((id) => unitIdsForSegment(rewritten, id).length === 1)).toBe(true);
  });

  it('重复句子按身份区分，译文不会按文本错配', () => {
    const doc = buildScenarioDoc();
    const first = doc.segments[1];
    const second = doc.segments[3];
    expect(first.text).toBe(second.text);
    expect(first.id).not.toBe(second.id);
    const u1 = unitIdsForSegment(doc, first.id);
    const u2 = unitIdsForSegment(doc, second.id);
    expect(u1).not.toEqual(u2);
    const t1 = doc.units.find((u) => u.id === u1[0])!.text;
    const t2 = doc.units.find((u) => u.id === u2[0])!.text;
    expect(t1).not.toBe(t2);

    const edited = editSegment(doc, first.id, '我们今天取消了新版本。').state;
    expect(edited.units.find((u) => u.id === u2[0])!.status).toBe('translated');
  });

  it('拆分后新段携带旧译文并待核对，可人工改为一对一', () => {
    let doc = buildScenarioDoc();
    const original = doc.segments[2];
    const oldUnitId = unitIdsForSegment(doc, original.id)[0];

    const split = splitSegment(doc, original.id, ['新版本提升了', '稳定性。']);
    doc = split.state;
    const createdIds = split.meta.createdSegmentIds!;
    const partA = doc.segments.find((s) => s.id === createdIds[0])!;
    const partB = doc.segments.find((s) => s.id === createdIds[1])!;
    expect(doc.segments.some((s) => s.id === original.id)).toBe(false);
    expect(partA.text).toBe('新版本提升了');
    expect(unitIdsForSegment(doc, partA.id)).toEqual([oldUnitId]);
    expect(unitIdsForSegment(doc, partB.id)).toEqual([oldUnitId]);
    expect(doc.units.find((u) => u.id === oldUnitId)!.status).toBe('review');

    doc = unlinkSegmentUnit(doc, partA.id, oldUnitId);
    const created = createUnitForSegment(doc, partA.id);
    doc = confirmUnit(updateTranslation(created.state, created.unitId, 'The new version improves'), created.unitId);
    expect(unitIdsForSegment(doc, partA.id)).toEqual([created.unitId]);
    expect(unitIdsForSegment(doc, partB.id)).toEqual([oldUnitId]);
    expect(checkIntegrity(doc).ok).toBe(true);

    const base2 = buildScenarioDoc();
    const split2 = splitSegment(base2, base2.segments[4].id, [
      '我们今天发布了新版本。',
      '感谢大家的支持与反馈。',
    ]);
    const repeatSplit = split2.state;
    const newId = split2.meta.createdSegmentIds!.find(
      (id) => repeatSplit.segments.find((s) => s.id === id)!.text === '我们今天发布了新版本。',
    )!;
    const linkedTexts = unitIdsForSegment(repeatSplit, newId).map(
      (uid) => repeatSplit.units.find((u) => u.id === uid)!.text,
    );
    expect(linkedTexts).not.toContain('We released a new version today.');
  });

  it('合并形成一对多并待核对，解除的旧译文保留不丢', () => {
    let doc = buildScenarioDoc();
    const ids = [doc.segments[1].id, doc.segments[2].id];
    const oldUnits = ids.flatMap((id) => unitIdsForSegment(doc, id));

    const result = mergeSegments(doc, ids, '');
    doc = result.state;
    const mergedId = result.meta.createdSegmentIds![0];
    expect(unitIdsForSegment(doc, mergedId).sort()).toEqual([...oldUnits].sort());
    expect(
      doc.units.filter((u) => oldUnits.includes(u.id)).every((u) => u.status === 'review'),
    ).toBe(true);
    expect(doc.segments).toHaveLength(4);

    doc = unlinkSegmentUnit(doc, mergedId, oldUnits[1]);
    expect(unitIdsForSegment(doc, mergedId)).toEqual([oldUnits[0]]);
    expect(doc.units.some((u) => u.id === oldUnits[1])).toBe(true);
    expect(checkIntegrity(doc).ok).toBe(true);
  });

  it('核对确认后译文恢复已译状态', () => {
    let doc = buildScenarioDoc();
    const target = doc.segments[1].id;
    doc = editSegment(doc, target, '我们昨天取消了新版本。').state;
    const unitId = unitIdsForSegment(doc, target)[0];
    doc = setTranslationStatus(doc, unitId, 'translated');
    expect(doc.units.find((u) => u.id === unitId)!.status).toBe('translated');
    expect(doc.units.find((u) => u.id === unitId)!.reason).toBeUndefined();
  });
});
