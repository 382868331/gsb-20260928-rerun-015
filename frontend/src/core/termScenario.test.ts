import { describe, expect, it } from 'vitest';
import { createDocument, createUnitForSegment, editSegment, unitIdsForSegment, updateTranslation } from './docOps';
import { DocState } from './model';
import {
  createTermDecision,
  decideTermOnLink,
  findTermUsages,
  isLinkFullyConfirmed,
  isTermOnlyIssue,
  revokeTermDecision,
  reviseTermDecision,
} from './terms';
import { buildReviewWorkspace, confirmLink } from './reviewWorkspace';
import { buildExport, exportBilingual } from './exportDoc';

function buildDoc(): DocState {
  let doc = createDocument('术语核对稿', [
    { text: '新版本今天发布。' },
    { text: '新版本修复了若干缺陷。' },
    { text: '请注意兼容性。' },
  ]);
  const make = (index: number, language: 'en' | 'ja', text: string) => {
    const result = createUnitForSegment(doc, doc.segments[index].id, language);
    doc = updateTranslation(result.state, result.unitId, text);
  };
  make(0, 'en', 'The new version ships today.');
  make(0, 'ja', '新バージョンを本日公開します。');
  make(1, 'en', 'The new release fixes bugs.');
  make(2, 'en', 'Mind compatibility.');
  return doc;
}

const enRendering = { language: 'en' as const, adopted: 'new release', scope: '产品公告语境' };
const jaRendering = { language: 'ja' as const, adopted: '最新リリース', scope: '产品公告语境' };

describe('术语决定与逐段核对', () => {
  it('决定前先看到实际使用该术语的段落，决定不做无差别替换', () => {
    const doc0 = buildDoc();
    const usages = findTermUsages(doc0, '新版本');
    expect(usages.map((u) => u.segmentId).sort()).toEqual(
      [doc0.segments[0].id, doc0.segments[0].id, doc0.segments[1].id].sort(),
    );
    expect(findTermUsages(doc0, '兼容性')).toHaveLength(1);

    const { state } = createTermDecision(doc0, { term: '新版本', renderings: [enRendering, jaRendering] });
    // 译文文本未被自动改写。
    expect(state.units.find((u) => u.text.includes('new version'))?.text).toContain('new version');
    // 不含该术语的段落不受影响。
    const untouchedLink = state.links.find((l) => l.segmentId === doc0.segments[2].id)!;
    expect(isLinkFullyConfirmed(state, untouchedLink)).toBe(true);
    // 两个含术语段落的三个译文进入待核对，且属于仅术语变化。
    const termLinks = state.links.filter((l) => l.segmentId !== doc0.segments[2].id);
    expect(termLinks.every((l) => isTermOnlyIssue(state, l))).toBe(true);

    const workspace = buildReviewWorkspace(state);
    expect(workspace).toHaveLength(2);
    expect(workspace.every((e) => e.trigger === 'term')).toBe(true);
    expect(workspace[0].units[0].termIssues[0]).toMatchObject({ term: '新版本', adopted: 'new release' });
  });

  it('同一词不同语境逐段处理：一段按新术语、一段保留例外（需依据）、一段暂缓', () => {
    let doc = createTermDecision(buildDoc(), {
      term: '新版本',
      renderings: [enRendering, jaRendering],
    }).state;
    const segA = doc.segments[0].id;
    const segB = doc.segments[1].id;
    const [enA, jaA] = unitIdsForSegment(doc, segA);
    const enB = unitIdsForSegment(doc, segB)[0];
    const decisionId = doc.termDecisions[0].id;

    expect(() => decideTermOnLink(doc, segA, enA, decisionId, 'kept')).toThrow(/依据/);

    doc = decideTermOnLink(doc, segA, enA, decisionId, 'applied', { revisedText: 'The new release ships today.' });
    doc = decideTermOnLink(doc, segA, jaA, decisionId, 'kept', { rationale: '日文公告沿用旧称，市场部已确认' });
    doc = decideTermOnLink(doc, segB, enB, decisionId, 'deferred');

    const linkApplied = doc.links.find((l) => l.segmentId === segA && l.unitId === enA)!;
    const linkKept = doc.links.find((l) => l.segmentId === segA && l.unitId === jaA)!;
    const linkDeferred = doc.links.find((l) => l.segmentId === segB && l.unitId === enB)!;
    expect(isLinkFullyConfirmed(doc, linkApplied)).toBe(true);
    expect(isLinkFullyConfirmed(doc, linkKept)).toBe(true);
    expect(isLinkFullyConfirmed(doc, linkDeferred)).toBe(false);
    expect(doc.units.find((u) => u.id === enA)!.status).toBe('translated');
    expect(doc.units.find((u) => u.id === enB)!.status).toBe('review');

    const payload = buildExport(doc);
    const segAPayload = payload.segments.find((s) => s.segmentId === segA)!;
    expect(segAPayload.confirmedTranslations.map((t) => t.unitId)).toContain(enA);
    expect(segAPayload.exceptionTranslations.map((t) => t.unitId)).toEqual([jaA]);
    expect(segAPayload.exceptionTranslations[0].rationale).toContain('市场部');
    const segBPayload = payload.segments.find((s) => s.segmentId === segB)!;
    expect(segBPayload.pendingTranslations.map((t) => t.unitId)).toEqual([enB]);
    const text = exportBilingual(doc);
    expect(text).toContain('明确保留的术语例外');
    expect(text).toContain('市场部已确认');
    expect(text).toContain('待处理内容');
  });

  it('同一轮中原术语变化与原文改写并存，确认记录同时绑定原文与术语版本', () => {
    let doc = createTermDecision(buildDoc(), {
      term: '新版本',
      renderings: [enRendering],
    }).state;
    const seg = doc.segments[1].id;
    const unit = unitIdsForSegment(doc, seg)[0];
    doc = editSegment(doc, seg, '新版本修复了严重缺陷。').state;

    const workspace = buildReviewWorkspace(doc);
    const entry = workspace.find((e) => e.segmentId === seg)!;
    expect(entry.trigger).toBe('mixed');

    // 只处置术语、原文未确认：链路仍不完整。
    doc = decideTermOnLink(doc, seg, unit, doc.termDecisions[0].id, 'applied', {
      revisedText: 'The new release fixes critical bugs.',
    });
    const afterTerm = doc.links.find((l) => l.segmentId === seg && l.unitId === unit)!;
    expect(isLinkFullyConfirmed(doc, afterTerm)).toBe(false);

    doc = confirmLink(doc, seg, unit);
    const confirmedLink = doc.links.find((l) => l.segmentId === seg && l.unitId === unit)!;
    expect(confirmedLink.confirmedSource).toBe('新版本修复了严重缺陷。');
    expect(confirmedLink.confirmedTerms).toEqual([`${doc.termDecisions[0].id}@1`]);
    expect(isLinkFullyConfirmed(doc, confirmedLink)).toBe(true);
  });

  it('修订术语使旧处置失效；撤销决定不恢复另一轮审阅的确认', () => {
    let doc = createTermDecision(buildDoc(), {
      term: '新版本',
      renderings: [enRendering],
    }).state;
    const seg = doc.segments[0].id;
    const unit = unitIdsForSegment(doc, seg)[0];
    const decisionId = doc.termDecisions[0].id;
    doc = decideTermOnLink(doc, seg, unit, decisionId, 'applied', { revisedText: 'The new release ships today.' });
    const confirmedBefore = doc.links.find((l) => l.segmentId === seg && l.unitId === unit)!;
    expect(confirmedBefore.confirmedTerms).toContain(`${decisionId}@1`);

    doc = reviseTermDecision(doc, decisionId, [
      { language: 'en', adopted: 'latest release', scope: '正式公告' },
    ]);
    const revisedLink = doc.links.find((l) => l.segmentId === seg && l.unitId === unit)!;
    expect(revisedLink.confirmedTerms).toEqual([]);
    expect(isLinkFullyConfirmed(doc, revisedLink)).toBe(false);
    expect(revisedLink.termDispositions?.at(-1)?.decisionVersion).toBe(1);
    expect(buildReviewWorkspace(doc).flatMap((e) => e.units).some((v) => v.termIssues[0]?.version === 2)).toBe(true);

    doc = revokeTermDecision(doc, decisionId);
    const revokedLink = doc.links.find((l) => l.segmentId === seg && l.unitId === unit)!;
    expect(isLinkFullyConfirmed(doc, revokedLink)).toBe(false);
    // 历史处置与确认沿革仍保留，可追溯依据。
    expect(revokedLink.termDispositions?.length).toBe(1);
    expect(revokedLink.priorConfirmedTerms).toContain(`${decisionId}@1`);
    expect(doc.termDecisions[0].revokedAt).toBeTruthy();
  });

  it('保存重开后继续处理未完成项', () => {
    const doc0 = createTermDecision(buildDoc(), {
      term: '新版本',
      renderings: [enRendering, jaRendering],
    }).state;
    const reopened: DocState = JSON.parse(JSON.stringify(doc0));
    expect(buildReviewWorkspace(reopened)).toHaveLength(2);
    const seg = reopened.segments[1].id;
    const unit = unitIdsForSegment(reopened, seg)[0];
    const done = decideTermOnLink(reopened, seg, unit, reopened.termDecisions[0].id, 'kept', {
      rationale: '发行说明保留旧称，法务已批',
    });
    const payload = buildExport(done);
    expect(payload.segments.find((s) => s.segmentId === seg)!.exceptionTranslations).toHaveLength(1);
  });
});
