import { create } from 'zustand';
import { DocState } from '../core/model';
import {
  BranchJudgmentType,
  MergedVersion,
  PublishFreeze,
  ReviewBranch,
  createBranch,
  decideOnBranch,
  editBranchText,
  freezePublish,
  mergeBranches,
  resolveMergeItem,
  withdrawMergeItem,
} from '../core/reviewBranch';

const STORAGE_KEY = 'mlcp.review.v1';

interface ReviewPersisted {
  branches: ReviewBranch[];
  merged: MergedVersion[];
  freezes: PublishFreeze[];
}

function loadInitial(): ReviewPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReviewPersisted>;
      return {
        branches: parsed.branches ?? [],
        merged: parsed.merged ?? [],
        freezes: parsed.freezes ?? [],
      };
    }
  } catch {
    // 存储不可用时从空开始。
  }
  return { branches: [], merged: [], freezes: [] };
}

function persist(state: ReviewPersisted): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        branches: state.branches,
        merged: state.merged,
        freezes: state.freezes,
      }),
    );
  } catch {
    // 存储失败不阻断编辑。
  }
}

interface ReviewStore extends ReviewPersisted {
  savedAt: string | null;
  openBranch: (doc: DocState, reviewer: string) => string;
  editJudgmentText: (branchId: string, key: string, text: string) => void;
  decide: (branchId: string, key: string, type: BranchJudgmentType, note?: string) => void;
  /** 保存当前分支状态（持久化，可关闭后重开继续）。 */
  save: () => void;
  merge: (leftBranchId: string, rightBranchId: string) => string | null;
  resolve: (mergedId: string, key: string, side: 'left' | 'right') => void;
  withdraw: (mergedId: string, key: string) => void;
  freeze: (doc: DocState, mergedId: string) => string | null;
  resetAll: () => void;
}

export const useReviewStore = create<ReviewStore>((set, get) => {
  const commit = (partial: Partial<ReviewPersisted>) => {
    set((state) => {
      const next = { ...state, ...partial };
      persist(next);
      return { ...partial, savedAt: new Date().toLocaleTimeString() };
    });
  };

  return {
    ...(typeof localStorage !== 'undefined'
      ? loadInitial()
      : { branches: [], merged: [], freezes: [] }),
    savedAt: null,

    openBranch: (doc, reviewer) => {
      const branch = createBranch(doc, reviewer);
      commit({ branches: [...get().branches, branch] });
      return branch.id;
    },

    editJudgmentText: (branchId, key, text) =>
      commit({
        branches: get().branches.map((b) =>
          b.id === branchId ? editBranchText(b, key, text) : b,
        ),
      }),

    decide: (branchId, key, type, note) =>
      commit({
        branches: get().branches.map((b) =>
          b.id === branchId ? decideOnBranch(b, key, type, note) : b,
        ),
      }),

    save: () => {
      const { branches, merged, freezes } = get();
      persist({ branches, merged, freezes });
      set({ savedAt: new Date().toLocaleTimeString() });
    },

    merge: (leftBranchId, rightBranchId) => {
      const { branches, merged } = get();
      const left = branches.find((b) => b.id === leftBranchId);
      const right = branches.find((b) => b.id === rightBranchId);
      if (!left || !right || left.id === right.id) return null;
      const version = mergeBranches(left, right);
      commit({ merged: [...merged, version] });
      return version.id;
    },

    resolve: (mergedId, key, side) =>
      commit({
        merged: get().merged.map((m) =>
          m.id === mergedId ? resolveMergeItem(m, key, side) : m,
        ),
      }),

    withdraw: (mergedId, key) =>
      commit({
        merged: get().merged.map((m) =>
          m.id === mergedId ? withdrawMergeItem(m, key) : m,
        ),
      }),

    freeze: (doc, mergedId) => {
      const merged = get().merged.find((m) => m.id === mergedId);
      if (!merged) return null;
      const frozen = freezePublish(doc, merged);
      commit({ freezes: [...get().freezes, frozen] });
      return frozen.id;
    },

    resetAll: () => commit({ branches: [], merged: [], freezes: [] }),
  };
});
