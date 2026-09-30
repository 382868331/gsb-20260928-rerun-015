import type {
  DocState,
  ExportedDoc,
  LinkStatus,
  SegmentKind,
  SourceSegment,
  TargetSegment,
} from '../types';
import { isSubstantiveChange } from './text';

let runtimeCounter = 0;

export function nextId(prefix: string, seq: number): { id: string; seq: number } {
  runtimeCounter += 1;
  return { id: `${prefix}_${seq}_${runtimeCounter.toString(36)}`, seq: seq + 1 };
}

function bump(state: DocState): DocState {
  return { ...state, version: state.version + 1 };
}

function makeId(state: DocState, prefix: string): { state: DocState; id: string } {
  const { id, seq } = nextId(prefix, state.seq);
  return { state: { ...state, seq }, id };
}

export interface DocInput {
  sourceLanguage?: string;
  targetLanguage?: string;
  blocks?: Array<{ kind?: SegmentKind; text: string; translation?: string }>;
}

// 从结构化内容创建文档（首块通常是中文标题）。
export function createDoc(input: DocInput = {}): DocState {
  let state: DocState = {
    version: 1,
    sourceLanguage: input.sourceLanguage ?? 'zh-CN',
    targetLanguage: input.targetLanguage ?? 'en-US',
    sources: [],
    targets: [],
    links: [],
    seq: 1,
  };

  for (const block of input.blocks ?? []) {
    const added = addSource(state, block.kind ?? 'paragraph', block.text);
    state = added.state;
    if (block.translation) {
      const target = addTarget(state, block.translation);
      state = target.state;
      const link = addLink(state, added.id, target.id, 'ok');
      state = link.state;
    }
  }

  return state;
}

export function addSource(
  state: DocState,
  kind: SegmentKind,
  text: string,
  index?: number,
): { state: DocState; id: string } {
  const made = makeId(state, 's');
  state = made.state;
  const segment: SourceSegment = { id: made.id, kind, text, lastApprovedText: text };
  const sources = [...state.sources];
  const at = index === undefined ? sources.length : index;
  sources.splice(at, 0, segment);
  return { state: bump({ ...state, sources }), id: made.id };
}

export function addTarget(state: DocState, text: string): { state: DocState; id: string } {
  const made = makeId(state, 't');
  state = made.state;
  const segment: TargetSegment = { id: made.id, text };
  return { state: bump({ ...state, targets: [...state.targets, segment] }), id: made.id };
}

export function addLink(
  state: DocState,
  sourceId: string,
  targetId: string,
  status: LinkStatus = 'needs_review',
): { state: DocState; id: string } {
  const existing = state.links.find(
    (link) => link.sourceId === sourceId && link.targetId === targetId,
  );
  if (existing) {
    return { state, id: existing.id };
  }
  const made = makeId(state, 'l');
  const link = { id: made.id, sourceId, targetId, status };
  return { state: bump({ ...made.state, links: [...state.links, link] }), id: made.id };
}

export function removeLink(state: DocState, linkId: string): DocState {
  return bump({ ...state, links: state.links.filter((link) => link.id !== linkId) });
}

export function unlinkTargetFromSource(state: DocState, sourceId: string, targetId: string): DocState {
  return bump({
    ...state,
    links: state.links.filter(
      (link) => !(link.sourceId === sourceId && link.targetId === targetId),
    ),
  });
}

// 移动正文段落位置：身份与关联全部保留。
export function moveSource(state: DocState, sourceId: string, toIndex: number): DocState {
  const from = state.sources.findIndex((s) => s.id === sourceId);
  if (from < 0) return state;
  const sources = [...state.sources];
  const [moved] = sources.splice(from, 1);
  const target = Math.max(0, Math.min(toIndex, sources.length));
  sources.splice(target, 0, moved);
  return bump({ ...state, sources });
}

// 编辑正文：仅空白变化不动关联；实质改写只把该段关联标待核对。
export function editSourceText(state: DocState, sourceId: string, text: string): DocState {
  const index = state.sources.findIndex((s) => s.id === sourceId);
  if (index < 0) return state;
  const current = state.sources[index];
  if (current.text === text) return state;

  const sources = state.sources.slice();
  sources[index] = { ...current, text };

  let links = state.links;
  if (isSubstantiveChange(current.lastApprovedText, text)) {
    links = links.map((link) =>
      link.sourceId === sourceId && link.status === 'ok'
        ? { ...link, status: 'needs_review' as LinkStatus }
        : link,
    );
  }
  return bump({ ...state, sources, links });
}

// 人工确认某条关联：待核对转正常，并更新正文基线。
export function approveLink(state: DocState, linkId: string): DocState {
  const link = state.links.find((l) => l.id === linkId);
  if (!link) return state;
  const links = state.links.map((l) =>
    l.id === linkId ? { ...l, status: 'ok' as LinkStatus } : l,
  );
  const sources = state.sources.map((s) =>
    s.id === link.sourceId ? { ...s, lastApprovedText: s.text } : s,
  );
  return bump({ ...state, links, sources });
}

// 确认一个正文段下的全部关联（一对多时一次性核对）。
export function approveSource(state: DocState, sourceId: string): DocState {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return state;
  const sources = state.sources.map((s) =>
    s.id === sourceId ? { ...s, lastApprovedText: s.text } : s,
  );
  const links = state.links.map((l) =>
    l.sourceId === sourceId ? { ...l, status: 'ok' as LinkStatus } : l,
  );
  return bump({ ...state, sources, links });
}

export function editTargetText(state: DocState, targetId: string, text: string): DocState {
  const targets = state.targets.map((t) => (t.id === targetId ? { ...t, text } : t));
  return bump({ ...state, targets });
}

// 拆分：原段保留前段（身份/关联不变），后段为全新身份且不继承译文。
export function splitSource(
  state: DocState,
  sourceId: string,
  leftText: string,
  rightText: string,
): { state: DocState; newId: string } {
  const index = state.sources.findIndex((s) => s.id === sourceId);
  if (index < 0) throw new Error(`source not found: ${sourceId}`);
  const original = state.sources[index];

  const sources = state.sources.slice();
  sources[index] = { ...original, text: leftText };
  // 前段文字若相对已确认基线发生实质变化，保留的旧译文同样需要核对。
  const links = isSubstantiveChange(original.lastApprovedText, leftText)
    ? state.links.map((link) =>
        link.sourceId === sourceId && link.status === 'ok'
          ? { ...link, status: 'needs_review' as LinkStatus }
          : link,
      )
    : state.links;
  const next: DocState = { ...state, sources, links };

  const added = addSource(next, original.kind, rightText, index + 1);
  return { state: added.state, newId: added.id };
}

// 合并：新段拼接原文，被并段关联迁移到新段并标待核对，允许一对多。
export function mergeSources(
  state: DocState,
  sourceIds: string[],
  separator = '\n',
): { state: DocState; newId: string } {
  const idSet = new Set(sourceIds);
  const ordered = state.sources.filter((s) => idSet.has(s.id));
  if (ordered.length < 2) throw new Error('merge requires at least two segments');

  const kind = ordered[0].kind;
  const text = ordered.map((s) => s.text).join(separator);
  const insertAt = state.sources.findIndex((s) => s.id === ordered[0].id);

  const sources = state.sources.filter((s) => !idSet.has(s.id));
  let next: DocState = { ...state, sources };
  const added = addSource(next, kind, text, insertAt);
  next = added.state;

  let links = next.links.map((link) =>
    idSet.has(link.sourceId)
      ? { ...link, sourceId: added.id, status: 'needs_review' as LinkStatus }
      : link,
  );
  links = dedupeLinks(links);
  next = bump({ ...next, links });
  return { state: next, newId: added.id };
}

function dedupeLinks(links: DocState['links']): DocState['links'] {
  const seen = new Map<string, DocState['links'][number]>();
  for (const link of links) {
    const key = `${link.sourceId}\u0000${link.targetId}`;
    const prev = seen.get(key);
    if (!prev || rank(link.status) > rank(prev.status)) {
      seen.set(key, link);
    }
  }
  return [...seen.values()];
}

function rank(status: LinkStatus): number {
  return status === 'needs_review' ? 1 : 0;
}

// 导出：完整身份与关联随文档一起导出。
export function exportDoc(state: DocState, now: () => Date = () => new Date()): ExportedDoc {
  return {
    format: 'mlcp-export',
    exportedAt: now().toISOString(),
    doc: structuredClone(state),
  };
}

export function importDoc(payload: ExportedDoc): DocState {
  if (payload.format !== 'mlcp-export' || !payload.doc) {
    throw new Error('invalid export payload');
  }
  return structuredClone(payload.doc);
}

export function linksOfSource(state: DocState, sourceId: string): DocState['links'] {
  return state.links.filter((link) => link.sourceId === sourceId);
}

export function linksOfTarget(state: DocState, targetId: string): DocState['links'] {
  return state.links.filter((link) => link.targetId === targetId);
}

export function getSource(state: DocState, id: string): SourceSegment | undefined {
  return state.sources.find((s) => s.id === id);
}

export function getTarget(state: DocState, id: string): TargetSegment | undefined {
  return state.targets.find((t) => t.id === id);
}
