import { create } from 'zustand';
import type { DocState, ExportedDoc } from './types';
import {
  addLink,
  addSource,
  addTarget,
  approveLink,
  approveSource,
  createDoc,
  editSourceText,
  editTargetText,
  exportDoc,
  importDoc,
  mergeSources,
  moveSource,
  removeLink,
  splitSource,
} from './model/doc';
import { createSampleDoc } from './model/sample';
import { STORAGE_KEY, loadSavedDoc } from './persistence';
const HISTORY_LIMIT = 100;

function snapshotEqual(a: DocState, b: DocState): boolean {
  return a === b;
}

interface EditorStore {
  doc: DocState;
  past: DocState[];
  future: DocState[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;

  commit: (next: DocState, markDirty?: boolean) => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  reset: () => void;
  loadImport: (payload: ExportedDoc) => void;
  exportJson: () => ExportedDoc;

  editSource: (id: string, text: string) => void;
  editTarget: (id: string, text: string) => void;
  move: (id: string, toIndex: number) => void;
  split: (id: string, left: string, right: string) => void;
  merge: (ids: string[]) => void;
  addParagraph: () => void;
  addTranslation: (text?: string) => string;
  link: (sourceId: string, targetId: string) => void;
  unlink: (linkId: string) => void;
  confirmLink: (linkId: string) => void;
  confirmSource: (sourceId: string) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => {
  const apply = (producer: (doc: DocState) => DocState) => {
    const { doc, past } = get();
    const next = producer(doc);
    if (snapshotEqual(next, doc)) return;
    set({
      doc: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), doc],
      future: [],
      dirty: true,
      canUndo: true,
      canRedo: false,
    });
  };

  return {
    doc: loadSavedDoc(),
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
    dirty: false,

    commit: (next, markDirty = true) => {
      const { doc, past } = get();
      if (next === doc) return;
      set({
        doc: next,
        past: [...past.slice(-(HISTORY_LIMIT - 1)), doc],
        future: [],
        dirty: markDirty,
        canUndo: true,
        canRedo: false,
      });
    },

    undo: () => {
      const { doc, past, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [doc, ...future].slice(0, HISTORY_LIMIT),
        dirty: true,
        canUndo: past.length - 1 >= 0,
        canRedo: true,
      });
    },

    redo: () => {
      const { doc, past, future } = get();
      const nextDoc = future[0];
      if (!nextDoc) return;
      set({
        doc: nextDoc,
        future: future.slice(1),
        past: [...past, doc].slice(-HISTORY_LIMIT),
        dirty: true,
        canUndo: true,
        canRedo: future.length - 1 > 0,
      });
    },

    save: () => {
      const payload = exportDoc(get().doc);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      set({ dirty: false });
    },

    reset: () => {
      const fresh = createDoc({});
      set({ doc: fresh, past: [], future: [], dirty: true, canUndo: false, canRedo: false });
    },

    loadImport: (payload) => {
      const doc = importDoc(payload);
      set({ doc, past: [], future: [], dirty: false, canUndo: false, canRedo: false });
      get().save();
    },

    exportJson: () => exportDoc(get().doc),

    editSource: (id, text) => apply((doc) => editSourceText(doc, id, text)),
    editTarget: (id, text) => apply((doc) => editTargetText(doc, id, text)),
    move: (id, toIndex) => apply((doc) => moveSource(doc, id, toIndex)),
    split: (id, left, right) => apply((doc) => splitSource(doc, id, left, right).state),
    merge: (ids) => apply((doc) => mergeSources(doc, ids).state),
    addParagraph: () =>
      apply((doc) => addSource(doc, 'paragraph', '').state),
    addTranslation: (text = '') => {
      const current = get().doc;
      const result = addTarget(current, text);
      get().commit(result.state);
      return result.id;
    },
    link: (sourceId, targetId) => apply((doc) => addLink(doc, sourceId, targetId).state),
    unlink: (linkId) => apply((doc) => removeLink(doc, linkId)),
    confirmLink: (linkId) => apply((doc) => approveLink(doc, linkId)),
    confirmSource: (sourceId) => apply((doc) => approveSource(doc, sourceId)),
  };
});
