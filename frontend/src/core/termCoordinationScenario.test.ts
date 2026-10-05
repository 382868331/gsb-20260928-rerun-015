import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  moveSegment,
  splitSegment,
  unitIdsForSegment,
  updateTranslation,
} from './docOps';
import { DocState } from './model';
import {
  createTermDecision,
  decideTermOnLink,
  isLinkFullyConfirmed,
  isTermOnlyIssue,
} from './terms';
import {
  applyCoordination,
  previewCoordination,
  planCoordination,
  scanCoordinationCandidates,
  withdrawCoordination,
} from './termCoordination';
import { buildExport } from './exportDoc';

const enRendering = { language: 'en' as const, adopted: 'new release', scope: '产品公告语境；发行说明除外' };

/** 两名审阅者交错决定场景：同一术语出现在多段译文修订中。 */
function buildDoc(): DocState {
  let doc = createDocument('协调核对稿', [
    { text: '新版本今天发布。' },
    { text: '新版本今天发布。' },
    { text: '新版本修复了若干缺陷。' },
  ]);
  const make = (index: number, text: string) => {
    const result = createUnitForSegment(doc, doc.segments[index].id, 'en');
    doc = updateTranslation(result.state, result.unitId, text);
  };
  make(0, 'The new version ships today.');
  make(1, 'The new version ships today.');
  make(2, 'The new version fixes bugs.');
  return doc;
}

function decidedDoc(): DocState {
  return createTermDecision(buildDoc(), { term: '新版本', renderings: [enRendering] }).state;
}

describe('跨段术语一致性协调', () => {
  it('区分真正同一概念与同文不同语境：例外语境永不纳入协调替换', () => {
    let doc = decidedDoc();
    const decisionId = doc.termDecisions[0].id;
    const [segA, segB] = [doc.segments[0].id, doc.segments[1].id];
    const unitA = unitIdsForSegment(doc, segA)[0];
    // 审阅者甲：同文不同语境，第一段声明必须保留的例外。
    doc = decideTermOnLink(doc, segA, unitA, decisionId, 'kept', {
      rationale: '发行说明沿用旧称，法务已批',
    });

    const targets = scanCoordinationCandidates(doc, decisionId, 'en', 'new version');
    expect(targets).toHaveLength(3);
    const bySegment = new Map(targets.map((t) => [t.segmentId, t]));
    expect(bySegment.get(segA)?.kind).toBe('different-context');
    expect(bySegment.get(segA)?.eligible).toBe(false);
    expect(bySegment.get(segA)?.blockReason).toContain('法务已批');
    expect(bySegment.get(segB)?.kind).toBe('same-concept');

    const planned = planCoordination(doc, decisionId, 'en', 'new version');
    const applied = applyCoordination(planned.state, planned.coordinationId!);
    expect(applied.appliedKeys).toHaveLength(2);
    expect(applied.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('例外语境'),
    ]);
    // 例外段译文原样保留，其余段替换为采用译法。
    doc = applied.state;
    expect(doc.units.find((u) => u.id === unitA)!.text).toBe('The new version ships today.');
    const unitB = unitIdsForSegment(doc, segB)[0];
    expect(doc.units.find((u) => u.id === unitB)!.text).toBe('The new release ships today.');
    // 例外仍是例外，协调应用段已确认。
    const payload = buildExport(doc);
    expect(payload.segments.find((s) => s.segmentId === segA)!.exceptionTranslations).toHaveLength(1);
    expect(payload.segments.find((s) => s.segmentId === segB)!.confirmedTranslations.map((t) => t.unitId)).toContain(unitB);
  });

  it('跨段移动不改变身份；拆合后来源可溯并归类为 split-origin', () => {
    let doc = decidedDoc();
    const decisionId = doc.termDecisions[0].id;
    const segC = doc.segments[2].id;
    // 跨段移动：目标身份不变，协调仍按 id 对应。
    doc = moveSegment(doc, segC, 0).state;
    // 拆分段落：新段继承关联并记录来源谱系。
    const split = splitSegment(doc, segC, ['新版本修复了若干缺陷。', '详见发行说明。']);
    doc = split.state;
    const newSeg = split.meta.createdSegmentIds![0];

    const targets = scanCoordinationCandidates(doc, decisionId, 'en', 'new version');
    const inherited = targets.filter((t) => t.segmentId === newSeg);
    expect(inherited.length).toBeGreaterThan(0);
    expect(inherited[0].kind).toBe('split-origin');
    expect(inherited[0].originSegmentIds).toContain(segC);
    // 拆分后来源段仍可用于协调替换。
    const planned = planCoordination(doc, decisionId, 'en', 'new version');
    const applied = applyCoordination(planned.state, planned.coordinationId!);
    expect(applied.appliedKeys.some((k) => k.startsWith(newSeg))).toBe(true);
  });

  it('确认时原文变化只阻止受影响部分，其余明确决定独立发布', () => {
    let doc = decidedDoc();
    const decisionId = doc.termDecisions[0].id;
    const [segA, segB, segC] = doc.segments.map((s) => s.id);
    const planned = planCoordination(doc, decisionId, 'en', 'new version');
    doc = planned.state;
    // 形成方案后，仅第一段原文被改写。
    doc = editSegment(doc, segA, '新版本明天发布。').state;

    const preview = previewCoordination(doc, planned.coordinationId!)!;
    expect(preview.applicableCount).toBe(2);
    const itemA = preview.items.find((i) => i.target.segmentId === segA)!;
    expect(itemA.action).toBe('skip');
    expect(itemA.skipReason).toContain('原文已变化');

    const applied = applyCoordination(doc, planned.coordinationId!);
    doc = applied.state;
    expect(applied.appliedKeys).toHaveLength(2);
    expect(applied.skipped[0].reason).toContain('原文已变化');
    // 受影响部分保持待核对，其余两段独立确认、可发布。
    const unitA = unitIdsForSegment(doc, segA)[0];
    expect(doc.units.find((u) => u.id === unitA)!.text).toBe('The new version ships today.');
    for (const seg of [segB, segC]) {
      const link = doc.links.find((l) => l.segmentId === seg)!;
      expect(isLinkFullyConfirmed(doc, link)).toBe(true);
    }
    const payload = buildExport(doc);
    expect(payload.segments.find((s) => s.segmentId === segB)!.confirmedTranslations).toHaveLength(1);
    expect(payload.segments.find((s) => s.segmentId === segA)!.pendingTranslations.map((t) => t.unitId)).toContain(unitA);
  });

  it('撤回一项协调保留后续独立裁决，未再处置的部分回到待核对', () => {
    let doc = decidedDoc();
    const decisionId = doc.termDecisions[0].id;
    const [segA, segB, segC] = doc.segments.map((s) => s.id);
    // 审阅者甲：形成并确认协调替换（三段全部应用）。
    const planned = planCoordination(doc, decisionId, 'en', 'new version');
    const applied = applyCoordination(planned.state, planned.coordinationId!);
    doc = applied.state;
    expect(applied.appliedKeys).toHaveLength(3);
    const unitC = unitIdsForSegment(doc, segC)[0];
    // 审阅者乙：随后对第三段作出独立裁决（自己的改译），与协调无关。
    doc = decideTermOnLink(doc, segC, unitC, decisionId, 'applied', {
      revisedText: 'The new release fixes many bugs.',
      rationale: '审阅者乙独立改译',
    });

    doc = withdrawCoordination(doc, planned.coordinationId!);
    // 协调产生的两段处置被收回：译文还原、回到仅术语变化的待核对。
    for (const seg of [segA, segB]) {
      const unit = unitIdsForSegment(doc, seg)[0];
      expect(doc.units.find((u) => u.id === unit)!.text).toContain('new version');
      const link = doc.links.find((l) => l.segmentId === seg)!;
      expect(isLinkFullyConfirmed(doc, link)).toBe(false);
      expect(isTermOnlyIssue(doc, link)).toBe(true);
    }
    // 审阅者乙的后续独立裁决原样保留，不受撤回影响。
    const linkC = doc.links.find((l) => l.segmentId === segC)!;
    expect(isLinkFullyConfirmed(doc, linkC)).toBe(true);
    expect(doc.units.find((u) => u.id === unitC)!.text).toBe('The new release fixes many bugs.');
    expect(linkC.termDispositions?.at(-1)?.rationale).toBe('审阅者乙独立改译');
    // 协调记录保留为已撤回，可追溯到依据。
    const stored = doc.coordinations!.find((c) => c.id === planned.coordinationId)!;
    expect(stored.status).toBe('withdrawn');
    expect(stored.appliedKeys).toHaveLength(3);
  });

  it('译文在确认前被后续修改时按当前文本替换，例外段不被覆盖', () => {
    let doc = decidedDoc();
    const decisionId = doc.termDecisions[0].id;
    const segA = doc.segments[0].id;
    const unitA = unitIdsForSegment(doc, segA)[0];
    const planned = planCoordination(doc, decisionId, 'en', 'new version');
    doc = planned.state;
    // 方案形成后译文被人工微调（仍含冲突译法）：按当前文本替换。
    doc = updateTranslation(doc, unitA, 'The new version ships today, finally.');
    const applied = applyCoordination(doc, planned.coordinationId!);
    doc = applied.state;
    expect(doc.units.find((u) => u.id === unitA)!.text).toBe('The new release ships today, finally.');
  });
});
