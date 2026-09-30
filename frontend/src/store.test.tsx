import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './store';
import { linksOfSource } from './model/doc';

const KEY = 'mlcp.doc.v1';

beforeEach(() => {
  localStorage.clear();
  useEditorStore.setState({ doc: useEditorStore.getState().doc, past: [], future: [], dirty: false });
});

describe('撤销/重做', () => {
  it('撤销拆分恢复原内容和关联，撤销合并恢复被删段落', () => {
    const initial = useEditorStore.getState().doc;
    const sourceId = initial.sources[1].id;
    const originalText = initial.sources[1].text;
    const originalLinkIds = linksOfSource(initial, sourceId).map((l) => l.id);
    const sourceCount = initial.sources.length;

    useEditorStore.getState().split(sourceId, '拆出前半', '拆出后半');
    expect(useEditorStore.getState().doc.sources).toHaveLength(sourceCount + 1);
    useEditorStore.getState().undo();

    const undone = useEditorStore.getState().doc;
    expect(undone.sources).toHaveLength(sourceCount);
    expect(undone.sources.find((s) => s.id === sourceId)?.text).toBe(originalText);
    expect(linksOfSource(undone, sourceId).map((l) => l.id)).toEqual(originalLinkIds);

    const ids = [undone.sources[0].id, undone.sources[1].id];
    useEditorStore.getState().merge(ids);
    const merged = useEditorStore.getState().doc;
    expect(merged.sources).toHaveLength(sourceCount - 1);
    useEditorStore.getState().undo();

    const restored = useEditorStore.getState().doc;
    expect(restored.sources).toHaveLength(sourceCount);
    for (const id of ids) {
      expect(restored.sources.some((s) => s.id === id)).toBe(true);
    }
    // 关联恢复到合并前的原始来源。
    for (const id of ids) {
      expect(linksOfSource(restored, id).length).toBeGreaterThan(0);
    }
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().doc.sources).toHaveLength(sourceCount - 1);
  });
});

describe('保存重开', () => {
  it('保存到 localStorage 后新初始化的状态与保存内容一致', async () => {
    const store = useEditorStore.getState();
    const sourceId = store.doc.sources[0].id;
    store.move(sourceId, store.doc.sources.length - 1);
    store.editSource(store.doc.sources[0].id, '改过的实质内容');
    store.save();
    expect(localStorage.getItem(KEY)).not.toBeNull();

    const raw = JSON.parse(localStorage.getItem(KEY)!);
    const { loadSavedDoc } = await import('./persistence');
    const reopened = loadSavedDoc();
    expect(reopened.sources.map((s) => s.id)).toEqual(
      raw.doc.sources.map((s: { id: string }) => s.id),
    );
    expect(reopened.links).toEqual(raw.doc.links);
  });
});
