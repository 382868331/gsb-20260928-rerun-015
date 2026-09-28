import type { DocState } from "./types";

const BASE = "/api";

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  list: () => call<{ documents: string[] }>("/documents"),
  get: (name: string) => call<DocState>(`/documents/${encodeURIComponent(name)}`),
  split: (name: string, segId: string, parts: string[], side: "source" | "target") =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/split`, { seg_id: segId, parts, side }),
  merge: (name: string, segIds: string[], side: "source" | "target") =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/merge`, { seg_ids: segIds, side }),
  correspond: (name: string, sourceIds: string[], targetIds: string[]) =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/correspond`, {
      source_ids: sourceIds,
      target_ids: targetIds,
    }),
  resolve: (name: string, groupId: string, action: "keep" | "detach") =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/resolve`, { group_id: groupId, action }),
  updateSource: (name: string, paragraphs: string[]) =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/update-source`, { paragraphs }),
  edit: (name: string, segId: string, text: string) =>
    call<DocState>(`/documents/${encodeURIComponent(name)}/edit`, { seg_id: segId, text }),
  undo: (name: string) => call<DocState>(`/documents/${encodeURIComponent(name)}/undo`),
  save: (name: string, path: string) =>
    call<{ saved: string }>(`/documents/${encodeURIComponent(name)}/save`, { path }),
  exportJsonUrl: (name: string) => `${BASE}/documents/${encodeURIComponent(name)}/export/json`,
  exportTxtUrl: (name: string) => `${BASE}/documents/${encodeURIComponent(name)}/export/txt`,
};
