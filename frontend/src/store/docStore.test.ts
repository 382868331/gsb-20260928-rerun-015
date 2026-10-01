import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_DOC, useDocStore } from './docStore';
import { unitIdsForSegment } from '../core/docOps';
import { isLinkFullyConfirmed } from '../core/terms';

describe('docStore 撤销与保存重开', () => {
  beforeEach(() => {
    localStorage.clear();
    useDocStore.getState().loadDoc(structuredClone(SAMPLE_DOC));
  });

  it('拆分后撤销恢复原段落内容与关联，再重做', () => {
    const store = useDocStore.getState();
    const before = structuredClone(store.doc);
    const target = before.segments[1];
    const oldUnit = store.createUnit(target.id)!;
    store.setTranslation(oldUnit, 'We released a new version today.');

    store.splitSegment(target.id, ['我们今天', '发布了新版本。']);
    const afterSplit = useDocStore.getState().doc;
    expect(afterSplit.segments.some((s) => s.id === target.id)).toBe(false);
    expect(afterSplit.segments).toHaveLength(before.segments.length + 1);
    expect(afterSplit.units.find((u) => u.id === oldUnit)!.status).toBe('review');

    store.undo();
    const restored = useDocStore.getState().doc;
    expect(restored.segments.find((s) => s.id === target.id)?.text).toBe(target.text);
    expect(unitIdsForSegment(restored, target.id)).toEqual([oldUnit]);
    expect(restored.units.find((u) => u.id === oldUnit)!.status).toBe('translated');
    expect(restored.segments).toHaveLength(before.segments.length);

    store.redo();
    expect(useDocStore.getState().doc.segments).toHaveLength(before.segments.length + 1);
  });

  it('保存后可从 localStorage 重开，移动不改变关联', () => {
    const store = useDocStore.getState();
    const unit = store.createUnit(store.doc.segments[0].id)!;
    store.setTranslation(unit, 'Product Update');
    store.moveSegment(store.doc.segments[0].id, 2);
    store.save();

    const raw = localStorage.getItem('mlcp.doc.v1');
    expect(raw).toBeTruthy();
    const reopened = JSON.parse(raw!);
    expect(reopened.segments[2].id).toBe(SAMPLE_DOC.segments[0].id);
    expect(
      reopened.links.find(
        (l: { segmentId: string; unitId: string }) =>
          l.segmentId === SAMPLE_DOC.segments[0].id && l.unitId === unit,
      ),
    ).toBeTruthy();
  });

  it('合并撤销同样恢复原文与关联', () => {
    const store = useDocStore.getState();
    const ids = store.doc.segments.slice(1, 3).map((s) => s.id);
    const u1 = store.createUnit(ids[0])!;
    const u2 = store.createUnit(ids[1])!;
    store.mergeSegments(ids);
    expect(useDocStore.getState().doc.segments).toHaveLength(SAMPLE_DOC.segments.length - 1);

    store.undo();
    const restored = useDocStore.getState().doc;
    expect(restored.segments).toHaveLength(SAMPLE_DOC.segments.length);
    expect(unitIdsForSegment(restored, ids[0])).toEqual([u1]);
    expect(unitIdsForSegment(restored, ids[1])).toEqual([u2]);
    expect(restored.units.every((u) => u.status === 'translated' || u.status === 'untranslated')).toBe(true);
  });

  it('术语决定保存重开后仍在，撤销不恢复上一轮确认', () => {
    const store = useDocStore.getState();
    const segmentId = store.doc.segments[1].id;
    const unitId = store.createUnit(segmentId, 'en')!;
    store.setTranslation(unitId, 'We released a new version today.');
    const beforeConfirmedLink = useDocStore
      .getState()
      .doc.links.find((l) => l.segmentId === segmentId && l.unitId === unitId)!;
    expect(isLinkFullyConfirmed(useDocStore.getState().doc, beforeConfirmedLink)).toBe(true);

    const decisionId = store.createTerm('新版本', [
      { language: 'en', adopted: 'new release', scope: '公告语境' },
    ])!;
    const pendingLink = useDocStore
      .getState()
      .doc.links.find((l) => l.segmentId === segmentId && l.unitId === unitId)!;
    expect(isLinkFullyConfirmed(useDocStore.getState().doc, pendingLink)).toBe(false);

    store.decideTerm(segmentId, unitId, decisionId, 'applied', {
      revisedText: 'We released a new release today.',
    });
    store.save();

    const raw = localStorage.getItem('mlcp.doc.v1')!;
    const reopened = JSON.parse(raw);
    expect(reopened.termDecisions).toHaveLength(1);
    expect(
      reopened.links.find((l: { segmentId: string; unitId: string }) => l.segmentId === segmentId && l.unitId === unitId)
        .confirmedTerms,
    ).toEqual([`${decisionId}@1`]);

    store.revokeTerm(decisionId);
    const afterRevoke = useDocStore.getState().doc;
    const revokedLink = afterRevoke.links.find((l) => l.segmentId === segmentId && l.unitId === unitId)!;
    expect(isLinkFullyConfirmed(afterRevoke, revokedLink)).toBe(false);

    store.undo();
    const undone = useDocStore.getState().doc;
    expect(undone.termDecisions[0].revokedAt).toBeUndefined();
    const restoredLink = undone.links.find((l) => l.segmentId === segmentId && l.unitId === unitId)!;
    expect(isLinkFullyConfirmed(undone, restoredLink)).toBe(true);
  });
});
