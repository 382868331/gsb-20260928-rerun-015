import { describe, expect, it } from 'vitest';
import {
  confirmUnit,
  createUnitForSegment,
  createDocument,
  decideReview,
  editSegment,
  mergeSegments,
  moveSegment,
  reconcileConfirmedUnits,
  splitSegment,
  linkSegmentUnit,
  unlinkSegmentUnit,
  unitIdsForSegment,
  updateTranslation,
} from './docOps';
import { DocState } from './model';
import { buildReviewWorkspace } from './reviewWorkspace';
import { buildExport, exportBilingual } from './exportDoc';

function multilingualDoc(): DocState {
  let doc = createDocument('多语言核对稿', [
    { kind: 'heading', text: '隐私政策' },
    { text: '本功能允许收集位置信息。' },
  ]);
  const add = (index: number, lang: string, text: string) => {
    const result = createUnitForSegment(doc, doc.segments[index].id, lang);
    doc = updateTranslation(result.state, result.unitId, text);
    doc = confirmUnit(doc, result.unitId);
  };
  add(1, 'en', 'This feature allows collecting location data.');
  add(1, 'ja', '本機能は位置情報の収集を許可します。');
  add(1, 'fr', 'Cette fonctionnalité permet de collecter la localisation.');
  return doc;
}

describe('一字之差的原文修改', () => {
  it('“允许”改“禁止”使所有语言旧译文进入待核对，不再用相似度放行', () => {
    const doc = multilingualDoc();
    const target = doc.segments[1].id;
    const edited = editSegment(doc, target, '本功能禁止收集位置信息。').state;

    const units = unitIdsForSegment(edited, target).map(
      (id) => edited.units.find((u) => u.id === id)!,
    );
    expect(units).toHaveLength(3);
    expect(units.every((u) => u.status === 'review')).toBe(true);
    // 旧确认来源保留为历史，但已不能证明新版本。
    expect(units.every((u) => u.provenance !== undefined)).toBe(true);
    expect(units[0].reviewContext?.[target]?.before).toContain('允许');
    expect(edited.segments.find((s) => s.id === target)?.text).toContain('禁止');
  });

  it('仅空白变化不触发核对', () => {
    const doc = multilingualDoc();
    const target = doc.segments[1].id;
    const edited = editSegment(doc, target, ' 本功能允许收集位置信息。\n').state;
    expect(
      unitIdsForSegment(edited, target).every(
        (id) => edited.units.find((u) => u.id === id)!.status === 'translated',
      ),
    ).toBe(true);
  });

  it('必须逐语言确认后才重新采用，未确认的不进导出成品', () => {
    let doc = multilingualDoc();
    const target = doc.segments[1].id;
    doc = editSegment(doc, target, '本功能禁止收集位置信息。').state;
    const [enId, jaId, frId] = unitIdsForSegment(doc, target);

    doc = updateTranslation(doc, enId, 'This feature prohibits collecting location data.');
    doc = confirmUnit(doc, enId);
    doc = decideReview(doc, jaId, 'defer');
    doc = decideReview(doc, frId, 'retranslate');

    const payload = buildExport(doc);
    const seg = payload.segments.find((s) => s.segmentId === target)!;
    expect(seg.confirmedTranslations.map((t) => t.lang)).toEqual(['en']);
    expect(seg.pendingTranslations.map((t) => t.status).sort()).toEqual(['deferred', 'retranslate']);
    expect(payload.summary.confirmedCount).toBeGreaterThanOrEqual(1);
    expect(payload.summary.pendingCount).toBe(2);

    const text = exportBilingual(doc);
    expect(text).toContain('[已确认·en] This feature prohibits collecting location data.');
    expect(text).toContain('待处理内容');
    expect(text).toContain('[暂缓·ja]');
    expect(text).toContain('[需重译·fr]');
  });
});

describe('核对工作区', () => {
  it('一次改动影响多语言时逐段展示前后内容与各语言条目', () => {
    let doc = multilingualDoc();
    const target = doc.segments[1].id;
    doc = editSegment(doc, target, '本功能禁止收集位置信息。').state;

    const workspace = buildReviewWorkspace(doc);
    expect(workspace).toHaveLength(1);
    const entry = workspace[0];
    expect(entry.beforeText).toBe('本功能允许收集位置信息。');
    expect(entry.afterText).toBe('本功能禁止收集位置信息。');
    expect(entry.items.map((i) => i.lang).sort()).toEqual(['en', 'fr', 'ja']);
    expect(entry.items.every((i) => i.status === 'review')).toBe(true);
  });

  it('分别确认/重译/暂缓后工作区条目相应减少', () => {
    let doc = multilingualDoc();
    const target = doc.segments[1].id;
    doc = editSegment(doc, target, '本功能禁止收集位置信息。').state;
    const [enId, jaId, frId] = unitIdsForSegment(doc, target);

    doc = confirmUnit(doc, enId);
    doc = decideReview(doc, jaId, 'defer');
    const workspace = buildReviewWorkspace(doc);
    expect(workspace[0].items.map((i) => i.unitId).sort()).toEqual([frId, jaId].sort());
  });
});

describe('拆合、移动与确认来源', () => {
  it('移动保留确认来源，译文继续有效', () => {
    const doc = multilingualDoc();
    const moved = moveSegment(doc, doc.segments[0].id, 1).state;
    const checked = reconcileConfirmedUnits(moved);
    expect(checked.units.every((u) => u.status === 'translated')).toBe(true);
  });

  it('拆分后旧译文全部待核对；逐段确认后才采用，且确认绑定新段原文', () => {
    let doc = multilingualDoc();
    const target = doc.segments[1].id;
    const split = splitSegment(doc, target, ['本功能禁止收集位置信息。', '并提供关闭开关。']);
    doc = split.state;
    const [partA, partB] = split.meta.createdSegmentIds!;
    const inherited = unitIdsForSegment(doc, partA);
    expect(inherited.length).toBeGreaterThan(0);
    expect(
      inherited.every((id) => doc.units.find((u) => u.id === id)!.status === 'review'),
    ).toBe(true);

    const enUnit = doc.units.find((u) => u.lang === 'en')!.id;
    doc = unlinkSegmentUnit(doc, partB, enUnit);
    doc = confirmUnit(doc, enUnit);
    expect(doc.units.find((u) => u.id === enUnit)!.provenance).toEqual({
      [partA]: '本功能禁止收集位置信息。',
    });
    // 已确认单元再改原文立即失效。
    doc = editSegment(doc, partA, '本功能禁止收集精确位置信息。').state;
    expect(doc.units.find((u) => u.id === enUnit)!.status).toBe('review');
  });

  it('合并形成多对一，旧译文待核对，确认来源覆盖合并后整段', () => {
    let doc = multilingualDoc();
    const ids = doc.segments.map((s) => s.id);
    doc = mergeSegments(doc, ids, '').state;
    const mergedId = doc.segments[0].id;
    const units = unitIdsForSegment(doc, mergedId);
    expect(units.every((id) => doc.units.find((u) => u.id === id)!.status === 'review')).toBe(true);

    const enId = doc.units.find((u) => u.lang === 'en')!.id;
    doc = confirmUnit(doc, enId);
    expect(doc.units.find((u) => u.id === enId)!.provenance?.[mergedId]).toBe(
      '隐私政策本功能允许收集位置信息。',
    );
  });

  it('把已确认译文改挂到不同原文上会被 reconcile 退回待核对', () => {
    const doc = multilingualDoc();
    const enId = doc.units.find((u) => u.lang === 'en')!.id;
    const headingId = doc.segments[0].id;
    const linked = linkSegmentUnit(doc, headingId, enId);
    const checked = reconcileConfirmedUnits(linked);
    expect(checked.units.find((u) => u.id === enId)!.status).toBe('review');
  });
});

describe('撤销原文改动不误恢复另一版本确认', () => {
  it('A 版确认 -> 改成 B 版 -> 撤销回 A 版可恢复；B 版确认不会污染 A 版', () => {
    let doc = multilingualDoc();
    const target = doc.segments[1].id;
    const enId = doc.units.find((u) => u.lang === 'en')!.id;
    const aText = '本功能允许收集位置信息。';
    const bText = '本功能禁止收集位置信息。';

    // 在 B 版上重新确认。
    let edited = editSegment(doc, target, bText).state;
    edited = updateTranslation(edited, enId, 'This feature prohibits collecting location data.');
    const confirmedOnB = confirmUnit(edited, enId);
    expect(confirmedOnB.units.find((u) => u.id === enId)!.provenance).toEqual({
      [target]: '本功能禁止收集位置信息。',
    });

    // 模拟撤销回到 A 版历史快照：B 版确认来源不匹配 A 版原文，必须退回核对。
    const restored = reconcileConfirmedUnits({
      ...confirmedOnB,
      segments: confirmedOnB.segments.map((s) =>
        s.id === target ? { ...s, text: aText } : s,
      ),
    });
    expect(restored.units.find((u) => u.id === enId)!.status).toBe('review');
    // 历史来源仍保留，可追溯它确认的是 B 版。
    expect(restored.units.find((u) => u.id === enId)!.provenance?.[target]).toBe(bText.replace(/\s+/g, ''));
  });
});
