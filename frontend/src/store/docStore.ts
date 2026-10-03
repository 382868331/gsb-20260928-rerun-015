import { create } from 'zustand';
import { DocState, LanguageCode, TermRendering, TranslationStatus } from '../core/model';
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
} from '../core/docOps';
import {
  confirmAllForSegment,
  confirmLink,
  deferReview,
  requestRetranslation,
} from '../core/reviewWorkspace';
import { createTermDecision, decideTermOnLink, revokeTermDecision, reviseTermDecision } from '../core/terms';
import {
  ReviewJudgment,
  ReviewWorkspaceState,
  canFreeze,
  createBranch,
  emptyReviewWorkspace,
  freezeRelease,
  mergeBranches,
  recordJudgment,
  redecideMergedItem,
  resolveConflict,
  setBranchStatus,
  withdrawMergedItem,
} from '../core/reviewBranch';

const STORAGE_KEY = 'mlcp.doc.v1';
const REVIEW_STORAGE_KEY = 'mlcp.review.v1';
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

function loadReviewInitial(): ReviewWorkspaceState {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ReviewWorkspaceState;
  } catch {
    // 存储不可用时从空工作区开始。
  }
  return emptyReviewWorkspace();
}

function loadInitial(): DocState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DocState;
      return { ...parsed, termDecisions: parsed.termDecisions ?? [] };
    }
  } catch {
    // 存储不可用时回退到示例稿。
  }
  return deepClone(SAMPLE_DOC);
}

interface DocStore {
  doc: DocState;
  review: ReviewWorkspaceState;
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
  createUnit: (segmentId: string, language?: LanguageCode) => string | null;
  setTranslation: (unitId: string, text: string) => void;
  setStatus: (unitId: string, status: TranslationStatus) => void;
  confirmTranslation: (segmentId: string, unitId: string) => void;
  confirmSegment: (segmentId: string) => void;
  retranslate: (segmentId: string, unitId: string) => void;
  defer: (segmentId: string, unitId: string) => void;
  createTerm: (term: string, renderings: TermRendering[]) => string | null;
  reviseTerm: (decisionId: string, renderings: TermRendering[]) => void;
  revokeTerm: (decisionId: string) => void;
  decideTerm: (
    segmentId: string,
    unitId: string,
    decisionId: string,
    type: 'applied' | 'kept' | 'deferred',
    options?: { rationale?: string; revisedText?: string },
  ) => void;
  setTitle: (title: string) => void;
  createReviewBranch: (reviewer: string) => string | null;
  judge: (branchId: string, judgment: ReviewJudgment) => void;
  closeBranch: (branchId: string) => void;
  reopenBranch: (branchId: string) => void;
  mergeReviewBranches: (branchIdA: string, branchIdB: string) => string | null;
  resolveMergeConflict: (
    mergedId: string,
    segmentId: string,
    unitId: string,
    resolution: ReviewJudgment,
  ) => void;
  withdrawMerged: (mergedId: string, segmentId: string, unitId: string) => void;
  redecideMerged: (mergedId: string, resolution: ReviewJudgment) => void;
  freeze: (mergedId: string) => string | null;
}

export const useDocStore = create<DocStore>((set, get) => ({
  doc: typeof localStorage !== 'undefined' ? loadInitial() : deepClone(SAMPLE_DOC),
  review: typeof localStorage !== 'undefined' ? loadReviewInitial() : emptyReviewWorkspace(),
  past: [],
  future: [],
  dirty: false,
  savedAt: null,

  loadDoc: (doc) => set({ doc: deepClone(doc), past: [], future: [], dirty: true }),
  resetToSample: () => set({ doc: deepClone(SAMPLE_DOC), past: [], future: [], dirty: true }),

  save: () => {
    const { doc, review } = get();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(review));
    set({ dirty: false, savedAt: new Date().toLocaleTimeString() });
  },

  createReviewBranch: (reviewer) => {
    let branchId: string | null = null;
    set((s) => {
      const result = createBranch(s.review, s.doc, reviewer);
      branchId = result.branchId;
      return { review: result.ws, dirty: true };
    });
    return branchId;
  },

  judge: (branchId, judgment) =>
    set((s) => ({ review: recordJudgment(s.review, branchId, judgment), dirty: true })),

  closeBranch: (branchId) =>
    set((s) => ({ review: setBranchStatus(s.review, branchId, 'closed'), dirty: true })),

  reopenBranch: (branchId) =>
    set((s) => ({ review: setBranchStatus(s.review, branchId, 'open'), dirty: true })),

  mergeReviewBranches: (branchIdA, branchIdB) => {
    let mergedId: string | null = null;
    set((s) => {
      const result = mergeBranches(s.review, branchIdA, branchIdB);
      mergedId = result.mergedId;
      return { review: result.ws, dirty: true };
    });
    return mergedId;
  },

  resolveMergeConflict: (mergedId, segmentId, unitId, resolution) =>
    set((s) => ({
      review: resolveConflict(s.review, mergedId, segmentId, unitId, resolution),
      dirty: true,
    })),

  withdrawMerged: (mergedId, segmentId, unitId) =>
    set((s) => ({
      review: withdrawMergedItem(s.review, mergedId, segmentId, unitId),
      dirty: true,
    })),

  redecideMerged: (mergedId, resolution) =>
    set((s) => ({ review: redecideMergedItem(s.review, mergedId, resolution), dirty: true })),

  freeze: (mergedId) => {
    let freezeId: string | null = null;
    set((s) => {
      const merged = s.review.mergedVersions.find((m) => m.id === mergedId);
      if (!merged || !canFreeze(merged)) return {};
      const result = freezeRelease(s.review, s.doc, mergedId);
      freezeId = result.freezeId;
      return { review: result.ws, dirty: true };
    });
    return freezeId;
  },

  undo: () => {
    const { past, doc, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({
      doc: deepClone(previous),
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
      doc: deepClone(next),
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

  createUnit: (segmentId, language = 'en') => {
    let unitId: string | null = null;
    set((s) => {
      const snapshot = deepClone(s.doc);
      const result = createUnitForSegment(s.doc, segmentId, language);
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

  confirmTranslation: (segmentId, unitId) =>
    set((s) => ({
      doc: confirmLink(s.doc, segmentId, unitId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  confirmSegment: (segmentId) =>
    set((s) => ({
      doc: confirmAllForSegment(s.doc, segmentId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  retranslate: (segmentId, unitId) =>
    set((s) => ({
      doc: requestRetranslation(s.doc, segmentId, unitId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  defer: (segmentId, unitId) =>
    set((s) => ({
      doc: deferReview(s.doc, segmentId, unitId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  createTerm: (term, renderings) => {
    let decisionId: string | null = null;
    set((s) => {
      const snapshot = deepClone(s.doc);
      const result = createTermDecision(s.doc, { term, renderings });
      decisionId = result.decisionId;
      return { doc: result.state, past: [...s.past, snapshot].slice(-HISTORY_LIMIT), future: [], dirty: true };
    });
    return decisionId;
  },

  reviseTerm: (decisionId, renderings) =>
    set((s) => ({
      doc: reviseTermDecision(s.doc, decisionId, renderings),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  revokeTerm: (decisionId) =>
    set((s) => ({
      doc: revokeTermDecision(s.doc, decisionId),
      past: [...s.past, deepClone(s.doc)].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    })),

  decideTerm: (segmentId, unitId, decisionId, type, options) =>
    set((s) => ({
      doc: decideTermOnLink(s.doc, segmentId, unitId, decisionId, type, options),
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
