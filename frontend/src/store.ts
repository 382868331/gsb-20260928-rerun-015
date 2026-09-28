import { create } from "zustand";
import { api } from "./api";
import { buildPairs } from "./lib/pairs";
import type { DocState, UpdateReport } from "./types";

interface EditorStore {
  docName: string | null;
  state: DocState | null;
  report: UpdateReport | null;
  error: string | null;
  selected: { source: Set<string>; target: Set<string> };
  loading: boolean;
  load: (name: string) => Promise<void>;
  apply: (next: DocState) => void;
  setError: (msg: string | null) => void;
  toggleSelect: (side: "source" | "target", id: string) => void;
  clearSelection: () => void;
  run: (fn: () => Promise<DocState>) => Promise<void>;
}

export const useStore = create<EditorStore>((set, get) => ({
  docName: null,
  state: null,
  report: null,
  error: null,
  selected: { source: new Set(), target: new Set() },
  loading: false,

  async load(name) {
    set({ loading: true, error: null });
    try {
      const state = await api.get(name);
      set({ docName: name, state, report: null, selected: { source: new Set(), target: new Set() } });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  apply(next) {
    set({
      state: next,
      report: next.report ?? null,
      selected: { source: new Set(), target: new Set() },
    });
  },

  setError(error) {
    set({ error });
  },

  toggleSelect(side, id) {
    const sel = get().selected;
    const next = new Set(sel[side]);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: { ...sel, [side]: next } });
  },

  clearSelection() {
    set({ selected: { source: new Set(), target: new Set() } });
  },

  async run(fn) {
    set({ loading: true, error: null });
    try {
      get().apply(await fn());
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },
}));

/** 页面直接用与后端一致的算法生成行；即使后端再返回 pairs，也以前端算法为准做一致性校验。 */
export function usePairs() {
  const state = useStore((s) => s.state);
  if (!state) return [];
  return buildPairs(state.document);
}
