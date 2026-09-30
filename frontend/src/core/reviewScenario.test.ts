import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  mergeSegments,
  moveSegment,
  splitSegment,
  unitIdsForSegment,
  updateTranslation,
} from './docOps';
import { DocState } from './model';
import {
  buildReviewWorkspace,
  confirmAllForSegment,
  confirmLink,
  deferReview,
  isLinkConfirmed,
  requestRetranslation,
} from './reviewWorkspace';
import { buildExport, exportBilingual } from './exportDoc';

function buildMultilingualDoc(): DocState {
  let doc = createDocument('核对稿', [{ text: '本系统允许外部访问。' }]);
  const segmentId = doc.segments[0].id;
  const en = createUnitForSegment(doc, segmentId);
  doc = updateTranslation(en.state, en.unitId, 'External access is allowed.');
  const ja = createUnitForSegment(doc, segmentId);
  doc = updateTranslation(ja.state, ja.unitId, '外部アクセスを許可します。');
  return doc;
}

describe('原文变更即待核对（不依赖相似度/改动字数）', () => {
  it('“允许”改为“禁止”：全部语言旧译文立即待核对，确认后才可重新采用', () => {
    const doc0 = buildMultilingualDoc();
    const segmentId = doc0.segments[0].id;
    const [enUnit, jaUnit] = unitIdsForSegment(doc0, segmentId);

    const edited = editSegment(doc0, segmentId, '本系统禁止外部访问。').state;
    for (const id of [enUnit, jaUnit]) {
      const link = edited.links.find((l) => l.segmentId === segmentId && l.unitId === id)!;
      expect(isLinkConfirmed(edited, link)).toBe(false);
      expect(edited.units.find((u) => u.id === id)!.status).toBe('review');
    }
    const workspace = buildReviewWorkspace(edited);
    expect(workspace).toHaveLength(1);
    expect(workspace[0].sourceBefore).toBe('本系统允许外部访问。');
    expect(workspace[0].sourceAfter).toBe('本系统禁止外部访问。');
    expect(workspace[0].units).toHaveLength(2);

    // 逐语言分别确认：只确认英文时日文仍待处理。
    const onlyEn = confirmLink(edited, segmentId, enUnit);
    expect(onlyEn.units.find((u) => u.id === enUnit)!.status).toBe('translated');
    expect(onlyEn.units.find((u) => u.id === jaUnit)!.status).toBe('review');
    const enLink = onlyEn.links.find((l) => l.segmentId === segmentId && l.unitId === enUnit)!;
    expect(enLink.confirmedSource).toBe('本系统禁止外部访问。');

    const allConfirmed = confirmAllForSegment(onlyEn, segmentId);
    expect(buildReviewWorkspace(allConfirmed)).toHaveLength(0);

    // 再改回“允许”：之前针对“禁止”的确认不可被错认。
    const reverted = editSegment(allConfirmed, segmentId, '本系统允许外部访问。').state;
    const linkAgain = reverted.links.find((l) => l.segmentId === segmentId && l.unitId === enUnit)!;
    expect(isLinkConfirmed(reverted, linkAgain)).toBe(false);
    expect(reverted.units.find((u) => u.id === enUnit)!.status).toBe('review');
  });

  it('重译与暂缓都不计入已确认导出', () => {
    let doc = buildMultilingualDoc();
    const segmentId = doc.segments[0].id;
    const [enUnit, jaUnit] = unitIdsForSegment(doc, segmentId);
    doc = editSegment(doc, segmentId, '本系统禁止外部访问。').state;
    doc = confirmLink(doc, segmentId, enUnit);
    doc = requestRetranslation(doc, segmentId, jaUnit);

    let payload = buildExport(doc);
    expect(payload.segments[0].confirmedTranslations.map((t) => t.unitId)).toEqual([enUnit]);
    expect(payload.segments[0].pendingTranslations.map((t) => t.unitId)).toEqual([jaUnit]);
    const text = exportBilingual(doc);
    expect(text).toContain('待处理内容');
    expect(text).toContain('不得作为正式译文交付');
    expect(text).toContain('[待处理·review] 外部アクセスを許可します。');
    expect(text).toContain('External access is allowed.');

    doc = deferReview(doc, segmentId, enUnit);
    payload = buildExport(doc);
    expect(payload.segments[0].confirmedTranslations).toHaveLength(0);
    expect(payload.summary.confirmedSegmentCount).toBe(0);
    expect(payload.summary.pendingSegmentCount).toBe(1);
  });
});

describe('拆合与移动保留对应关系与确认来源沿革', () => {
  it('拆分后逐段确认，确认来源随段绑定', () => {
    let doc = buildMultilingualDoc();
    const segmentId = doc.segments[0].id;
    const [enUnit] = unitIdsForSegment(doc, segmentId);
    const split = splitSegment(doc, segmentId, ['本系统禁止', '外部访问。']);
    doc = split.state;
    const [partAId, partBId] = split.meta.createdSegmentIds!;

    const aLink = doc.links.find((l) => l.segmentId === partAId && l.unitId === enUnit)!;
    expect(aLink.sourceBefore).toBe('本系统允许外部访问。');
    expect(aLink.confirmedSource).toBeUndefined();

    doc = confirmLink(doc, partAId, enUnit);
    expect(
      doc.links.find((l) => l.segmentId === partAId && l.unitId === enUnit)!.confirmedSource,
    ).toBe('本系统禁止');
    // 同一段译文在另一拆分段上仍未确认。
    expect(
      isLinkConfirmed(
        doc,
        doc.links.find((l) => l.segmentId === partBId && l.unitId === enUnit)!,
      ),
    ).toBe(false);

    // 移动拆分段不改变确认来源。
    doc = moveSegment(doc, partAId, 1).state;
    expect(
      doc.links.find((l) => l.segmentId === partAId && l.unitId === enUnit)!.confirmedSource,
    ).toBe('本系统禁止');
  });

  it('合并保留旧确认沿革，需对合并文本重新确认', () => {
    let doc = createDocument('核对稿', [
      { text: '允许访问。' },
      { text: '保持稳定。' },
    ]);
    const ids = doc.segments.map((s) => s.id);
    const u1 = createUnitForSegment(doc, ids[0]);
    doc = updateTranslation(u1.state, u1.unitId, 'Allowed.');
    const u2 = createUnitForSegment(doc, ids[1]);
    doc = updateTranslation(u2.state, u2.unitId, 'Stable.');

    const merge = mergeSegments(doc, ids, '');
    doc = merge.state;
    const mergedId = merge.meta.createdSegmentIds![0];
    const link = doc.links.find((l) => l.segmentId === mergedId && l.unitId === u1.unitId)!;
    expect(link.confirmedSource).toBeUndefined();
    expect(link.sourceBefore).toBe('允许访问。保持稳定。');
    expect(isLinkConfirmed(doc, link)).toBe(false);

    doc = confirmLink(doc, mergedId, u1.unitId);
    doc = confirmLink(doc, mergedId, u2.unitId);
    expect(buildReviewWorkspace(doc)).toHaveLength(0);
  });
});
