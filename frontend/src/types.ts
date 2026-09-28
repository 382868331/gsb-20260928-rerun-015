export type Side = "source" | "target";
export type GroupState = "active" | "conflict" | "retired";
export type SegStatus =
  | "normal"
  | "moved"
  | "changed"
  | "new"
  | "missing"
  | "review";

export interface Segment {
  id: string;
  side: Side;
  text: string;
  status: SegStatus;
  origin: string[];
  retired: boolean;
}

export interface LinkGroup {
  id: string;
  source_ids: string[];
  target_ids: string[];
  origin: "auto" | "manual";
  state: GroupState;
}

export interface Revision {
  id: string;
  note: string;
  snapshot: unknown;
}

export interface DocData {
  name: string;
  source_lang: string;
  target_lang: string;
  order: Record<Side, string[]>;
  segments: Record<string, Segment>;
  groups: LinkGroup[];
  revisions: Revision[];
}

export interface Pair {
  source_ids: string[];
  target_ids: string[];
  state: GroupState | "none";
  group_id: string | null;
}

export interface DocState {
  document: DocData;
  pairs: Pair[];
  revisions: { id: string; note: string }[];
  report?: UpdateReport;
  group_id?: string;
}

export interface UpdateReport {
  moved: string[];
  changed: { old: string; new: string; targets: string[] }[];
  new: string[];
  missing: string[];
  affected_targets: string[];
}

export interface ExportRow {
  row: number;
  state: string;
  group_id: string | null;
  source_ids: string[];
  target_ids: string[];
  source: string[];
  target: string[];
}

export interface ExportData {
  name: string;
  source_lang: string;
  target_lang: string;
  pairs: ExportRow[];
}
