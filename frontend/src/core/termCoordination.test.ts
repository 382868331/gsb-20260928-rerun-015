import { describe, expect, it } from 'vitest';
import { createDocument, createUnitForSegment, editSegment, moveSegment, splitSegment, unitIdsForSegment, updateTranslation } from './docOps';
import { createTermDecision, decideTermOnLink, isLinkFullyConfirmed } from './terms';
import { confirmTermCoordination, createTermCoordination, findTermCoordinationCandidates, withdrawTermCoordination } from './termCoordination';
import { buildExport, exportBilingual } from './exportDoc';

function buildDoc() {
  let doc = createDocument('跨段术语协调稿', [
    { text: '新版本已发布。' },
    { text: '新版本说明如下。' },
    { text: '合同中的新版本另有定义。' },
  ]);
  const translate = (index: number, text: string) => {
    const result = createUnitForSegment(doc, doc.segments[index].id, 'en');
    doc = updateTranslation(result.state, result.unitId, text);
  };
  translate(0, 'The new version is live.');
  translate(1, 'The new version is described below.');
  translate(2, 'The new version has a separate contract meaning.');
  return doc;
}

const rendering = {
  language: 'en' as const,
  adopted: 'new release',
  scope: '普通公告语境',
  allowed: ['new edition'],
  exceptionContexts: ['contract'],
};

describe('跨段术语候选协调', () => {
  it('区分同一概念、同形异义语境和跨段移动，只定位不替换', () => {
    let doc = createTermDecision(buildDoc(), { term: '新版本', renderings: [rendering] }).state;
    doc = moveSegment(doc, doc.segments[2].id, 0).state;
    const candidates = findTermCoordinationCandidates(doc, doc.termDecisions[0].id, 'en');
    expect(candidates.map((item) => item.candidateKind)).toEqual([
      'different_context',
      'same_concept',
      'same_concept',
    ]);
    expect(candidates[0].blockedReasons).toContain('命中必须保留的例外语境');
    expect(candidates[0].eligible).toBe(false);
    expect(candidates.slice(1).every((item) => item.eligible)).toBe(true);
    expect(doc.units.every((unit) => unit.text.includes('new version'))).toBe(true);
  });

  it('允许译法不视为冲突，拆合来源明确标注并要求人工批准', () => {
    let doc = createTermDecision(buildDoc(), {
      term: '新版本',
      renderings: [{ ...rendering, allowed: ['new version'], exceptionContexts: [] }],
    }).state;
    const split = splitSegment(doc, doc.segments[1].id, ['新版本说明', '如下。']);
    doc = split.state;
    const [partA, partB] = split.meta.createdSegmentIds!;
    expect(findTermCoordinationCandidates(doc, doc.termDecisions[0].id, 'en').filter((item) => item.segmentId === partA)).toHaveLength(1);
    const candidates = findTermCoordinationCandidates(doc, doc.termDecisions[0].id, 'en');
    const ordinary = candidates.find((item) => item.segmentId === doc.segments[0].id)!;
    const inherited = candidates.find((item) => item.segmentId === partA)!;
    expect(ordinary.blockedReasons).toContain('审阅者已声明该译法允许使用');
    expect(inherited.candidateKind).toBe('split_merged_origin');
    expect(inherited.blockedReasons).toContain('原文或段落对应已变化，尚未确认');
    expect(partB).toBeTruthy();
  });

  it('确认时逐项应用；原文变化只阻止受影响项，其他明确决定独立发布', () => {
    let doc = createTermDecision(buildDoc(), { term: '新版本', renderings: [rendering] }).state;
    const segA = doc.segments[0].id;
    const segB = doc.segments[1].id;
    const unitA = unitIdsForSegment(doc, segA)[0];
    const unitB = unitIdsForSegment(doc, segB)[0];
    const created = createTermCoordination(doc, {
      decisionId: doc.termDecisions[0].id,
      language: 'en',
      targetRendering: 'new release',
      selectedKeys: [
        { segmentId: segA, unitId: unitA },
        { segmentId: segB, unitId: unitB },
      ],
      textOverrides: {
        [`${segA}::${unitA}`]: 'The new release is live.',
        [`${segB}::${unitB}`]: 'The new release is described below.',
      },
    });
    doc = created.state;
    doc = editSegment(doc, segA, '新版本刚刚发布。').state;
    doc = confirmTermCoordination(doc, created.coordinationId);

    expect(doc.units.find((unit) => unit.id === unitA)!.text).toBe('The new version is live.');
    expect(doc.units.find((unit) => unit.id === unitB)!.text).toBe('The new release is described below.');
    const linkA = doc.links.find((link) => link.segmentId === segA && link.unitId === unitA)!;
    const linkB = doc.links.find((link) => link.segmentId === segB && link.unitId === unitB)!;
    expect(isLinkFullyConfirmed(doc, linkA)).toBe(false);
    expect(isLinkFullyConfirmed(doc, linkB)).toBe(true);
    const payload = buildExport(doc);
    const exportedCoordination = payload.termCoordinations?.[0]!;
    expect(exportedCoordination.items.find((item) => item.segmentId === segA)?.eligible).toBe(false);
    expect(exportBilingual(doc)).toContain('跨段术语协调依据');
  });

  it('两名审阅者交错决定：撤回协调不覆盖后续独立例外裁决', () => {
    let doc = createTermDecision(buildDoc(), { term: '新版本', renderings: [rendering] }).state;
    const seg = doc.segments[1].id;
    const unit = unitIdsForSegment(doc, seg)[0];
    const created = createTermCoordination(doc, {
      decisionId: doc.termDecisions[0].id,
      language: 'en',
      targetRendering: 'new release',
      selectedKeys: [{ segmentId: seg, unitId: unit }],
      textOverrides: { [`${seg}::${unit}`]: 'The new release is described below.' },
    });
    doc = confirmTermCoordination(created.state, created.coordinationId);
    expect(isLinkFullyConfirmed(doc, doc.links.find((link) => link.segmentId === seg && link.unitId === unit)!)).toBe(true);

    doc = decideTermOnLink(doc, seg, unit, doc.termDecisions[0].id, 'kept', {
      rationale: '二审确认该段为标题固定措辞，应保留旧译。',
    });
    doc = withdrawTermCoordination(doc, created.coordinationId);
    const link = doc.links.find((item) => item.segmentId === seg && item.unitId === unit)!;
    expect(link.termDispositions?.at(-1)?.type).toBe('kept');
    expect(isLinkFullyConfirmed(doc, link)).toBe(true);
  });

  it('撤回没有后续独立裁决的协调项时，该项回到待核对', () => {
    let doc = createTermDecision(buildDoc(), { term: '新版本', renderings: [rendering] }).state;
    const seg = doc.segments[0].id;
    const unit = unitIdsForSegment(doc, seg)[0];
    const created = createTermCoordination(doc, {
      decisionId: doc.termDecisions[0].id,
      language: 'en',
      targetRendering: 'new release',
      selectedKeys: [{ segmentId: seg, unitId: unit }],
      textOverrides: { [`${seg}::${unit}`]: 'The new release is live.' },
    });
    doc = confirmTermCoordination(created.state, created.coordinationId);
    doc = withdrawTermCoordination(doc, created.coordinationId);
    const link = doc.links.find((item) => item.segmentId === seg && item.unitId === unit)!;
    expect(link.termDispositions?.at(-1)?.type).toBe('deferred');
    expect(isLinkFullyConfirmed(doc, link)).toBe(false);
  });
});
