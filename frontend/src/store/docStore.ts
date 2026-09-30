import { create } from 'zustand';
import { DocState, TranslationStatus } from '../core/model';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  linkSegmentUnit,
  mergeSegments,
  moveSegment,
  splitSegment,
  unlinkSegmentUnit,
  updateTranslation,
  setTranslationStatus,
  confirmUnit,
  decideReview,
  reconcileConfirmedUnits,
  ReviewDecision,
} from '../core/docOps';

const STORAGE_KEY = 'mlcp.doc.v1';
const HISTORY_LIMIT = 100;

export const SAMPLE_DOC: DocState = createDocument('多语言内容制作平台示例稿', [
  { kind: 'heading', text: '产品更新公告' },
  { text: '我们今天发布了新版本。' },
  { text: '新版本提升了稳定性。' },
  { text: '我们今天发布了新版本。' },
  { text: '感谢大家的支持与反馈。' },
]);

function deepClone(state: DocState): DocState {
  return JSON.parse(JSON.stringify(state)) as DocState;
}

function loadInitial(): DocState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as DocState;
  } catch {
    // 存储不可用时回退到示例稿。
  }
  return deepClone(SAMPLE_DOC);
}

interface DocStore {
  doc: DocState;
  past: DocState[];
  future: DocState[];
  dirty: boolean;
  savedAt: string | null;
  loadDoc: (doc: DocState) => void;
  resetToSample: () => void;
  save: () => void;
  undo: () => void;
  redo: () => void;
  editSegment: (id: string, text: string) => void;
  moveSegment: (id: string, toIndex: number) => void;
  splitSegment: (id: string, parts: string[]) => void;
  mergeSegments: (ids: string[]) => void;
  link: (segmentId: string, unitId: string) => void;
  unlink: (segmentId: string, unitId: string) => void;
  createUnit: (segmentId: string, lang?: string) => string | null;
  setTranslation: (unitId: string, text: string) => void;
  setStatus: (unitId: string, status: TranslationStatus) => void;
  confirmReview: (unitId: string) => void;
  decideReview: (unitId: string, decision: ReviewDecision) => void;
  setTitle: (title: string) => void;
}

export const useDocStore = create<DocStore>((set, get) => ({
  doc: typeof localStorage !== 'undefined' ? loadInitial() : deepClone(SAMPLE_DOC),
  past: [],
  future: [],
  dirty: false,
  savedAt: null,

  loadDoc: (doc) => set({ doc: deepClone(doc), past: [], future: [], dirty: true }),
  resetToSample: () => set({ doc: deepClone(SAMPLE_DOC), past: [], future: [], dirty: true }),

  save: () => {
    const { doc } = get();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    set({ dirty: false, savedAt: new Date().toLocaleTimeString() });
  },

  undo: () => {
    const { past, doc, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    // 撤销原文改动恢复到历史快照；历史确认来源仍在，
    // 但若历史确认对应的是另一版原文，不会被误恢复为有效（reconcile 兜底）。
    const restored = reconcileConfirmedUnits(deepClone(previous));
    set({
      doc: restored,
      past: past.slice(0, -1),
      future: [deepClone(doc), ...future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo: () => {
    const { past, doc, future } = get();
    if (future.length === 0) return;
    const [next, ...rest] = future;
    set({
      doc: reconcileConfirmedUnits(deepClone(next)),
      past: [...past, deepClone(doc)].slice(-HISTORY_LIMIT),
      future: rest,
      dirty: true,
    });
  },

  editSegment: (id, text) =>
    set((s) => {
      const result = editSegment(s.doc, id, text);
      if (result.state === s.doc) return {};
      return { doc: result.state, past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }),

  moveSegment: (id, toIndex) =>
    set((s) => {
      const snapshot = deepClone(s.doc);
      const { state } = moveSegment(s.doc, id, toIndex);
      return { doc: state, past: [...s.past, snapshot].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }),

  splitSegment: (id, parts) =>
    set((s) => {
      const snapshot = deepClone(s.doc);
      const { state } = splitSegment(s.doc, id, parts);
      return { doc: state, past: [...s.past, snapshot].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }),

  mergeSegments: (ids) =>
    set((s) => {
      const snapshot = deepClone(s.doc);
      const { state } = mergeSegments(s.doc, ids);
      return { doc: state, past: [...s.past, snapshot].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }),

  link: (segmentId, unitId) =>
    set((s) => {
      const snapshot = deepClone(s.doc);
      return {
        doc: linkSegmentUnit(s.doc, segmentId, unitId),
        past: [...s.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    }),

  unlink: (segmentId, unitId) =>
    set((s) => {
      const snapshot = deepClone(s.doc);
      return {
        doc: unlinkSegmentUnit(s.doc, segmentId, unitId),
        past: [...s.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    }),

  createUnit: (segmentId, lang) => {
    let unitId: string | null = null;
    set((s) => {
      const snapshot = deepClone(s.doc);
      const result = createUnitForSegment(s.doc, segmentId, lang);
      unitId = result.unitId;
      return {
        doc: result.state,
        past: [...s.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
      };
    });
    return unitId;
  },

  setTranslation: (unitId, text) =>
    set((s) => {
      const before = s.doc.units.find((u) => u.id === unitId);
      const next = updateTranslation(s.doc, unitId, text);
      if (before && before.text === text) return {};
      return { doc: next, past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT), future: [], dirty: true };
    }),

  setStatus: (unitId, status) =>
    set((s) => ({
      doc: setTranslationStatus(s.doc, unitId, status),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  confirmReview: (unitId) =>
    set((s) => ({
      doc: confirmUnit(s.doc, unitId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  decideReview: (unitId, decision) =>
    set((s) => ({
      doc: decideReview(s.doc, unitId, decision),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  setTitle: (title) =>
    set((s) => ({
      doc: { ...s.doc, title },
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),
}));
