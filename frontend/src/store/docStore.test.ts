import { beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_DOC, useDocStore } from './docStore';
import { unitIdsForSegment } from '../core/docOps';

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
    store.confirmReview(oldUnit);

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
    expect(reopened.links).toContainEqual({
      segmentId: SAMPLE_DOC.segments[0].id,
      unitId: unit,
    });
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

  it('A 版未确认、B 版确认后撤销回 A 版，不会把 B 版确认误恢复为有效', () => {
    const store = useDocStore.getState();
    const target = store.doc.segments[1].id;
    const unit = store.createUnit(target)!;
    store.setTranslation(unit, 'We allow it.');
    // 有意不确认 A 版：A 版译文从未被采用。

    store.editSegment(target, '我们今天禁止发布新版本。');
    expect(useDocStore.getState().doc.units.find((u) => u.id === unit)!.status).toBe('review');
    store.setTranslation(unit, 'We prohibit it.');
    store.confirmReview(unit);
    expect(useDocStore.getState().doc.units.find((u) => u.id === unit)!.status).toBe('translated');

    store.undo(); // 撤销确认（B 版）
    store.undo(); // 撤销译文修改（B 版）
    store.undo(); // 撤销原文编辑，回到 A 版
    const restored = useDocStore.getState().doc;
    expect(restored.segments.find((s) => s.id === target)?.text).toBe(SAMPLE_DOC.segments[1].text);
    // A 版从未确认，不能因历史里存在 B 版确认而显示为已采用。
    expect(restored.units.find((u) => u.id === unit)!.status).not.toBe('translated');
  });
});
