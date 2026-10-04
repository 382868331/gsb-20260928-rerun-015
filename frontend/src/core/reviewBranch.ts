import { DocState, Segment } from './model';
import { nextId } from './identity';

/** 单项审阅判断的处理方式。 */
export type ReviewAction = 'accept' | 'edit' | 'reject';

/** 审阅者对某条“段落 × 译文单元”的逐项判断。 */
export interface ReviewJudgment {
  segmentId: string;
  unitId: string;
  action: ReviewAction;
  /** action 为 edit 时的改动后译文。 */
  revisedText?: string;
  /** 决定依据，随判断与冻结快照保留。 */
  rationale?: string;
  decidedAt: string;
}

/**
 * 独立审阅分支：从同一原文基线出发，审阅者互不干扰。
 * baseline 按段落 id 快照原文，与段落位置无关。
 */
export interface ReviewBranch {
  id: string;
  reviewer: string;
  baseline: Record<string, string>;
  baselineTakenAt: string;
  judgments: ReviewJudgment[];
  status: 'open' | 'closed';
  createdAt: string;
}

export type MergeItemKind = 'common' | 'onlyA' | 'onlyB' | 'conflict';

export interface MergeItem {
  segmentId: string;
  unitId: string;
  kind: MergeItemKind;
  a?: ReviewJudgment;
  b?: ReviewJudgment;
  /** 汇总后采用的最终判断；共同/单侧条目自动确定，冲突需人工选择。 */
  resolution?: ReviewJudgment;
  resolved: boolean;
  /** 撤回后回到待审，阻断冻结，直到重新决定。 */
  pending: boolean;
  /**
   * 创建合并版本（或重新决定）时冻结的裁决现场：
   * 原文、译文、最终采用译文与依据都在此刻固定，
   * 之后主文档如何修改都不会让旧决定看起来像审过新原文。
   */
  frozen: FrozenBasis;
}

/** 合并条目冻结的裁决依据，随合并版本独立保存、不可变（重新决定会整体替换）。 */
export interface FrozenBasis {
  /** 决定所针对的原文文本。 */
  sourceText: string;
  /** 段落类型，冻结后重建快照时使用。 */
  sourceKind: Segment['kind'];
  /** 决定时译文单元中的译文。 */
  unitText: string;
  /** 裁决最终采用的译文：edit 取 revisedText，accept 取 unitText，reject 为空。 */
  resolvedText: string;
  /** 裁决依据（采用一侧时随该侧判断保留）。 */
  rationale?: string;
}

/** 合并结果：独立保存的版本，不回写任何来源分支。 */
export interface MergedVersion {
  id: string;
  branchIds: [string, string];
  createdAt: string;
  /** 创建合并版本时的主文档标题，与标题后续修改解耦。 */
  titleSnapshot: string;
  items: MergeItem[];
}

/** 发布冻结：冻结当时的原文、译文与决定依据，之后不可变。 */
export interface ReleaseFreeze {
  id: string;
  mergedVersionId: string;
  frozenAt: string;
  /** 合并版本创建时冻结的标题（裁决依据的一部分）。 */
  title: string;
  /** 冻结发布时主文档的当前标题：可能已修订，仅作对照展示。 */
  currentTitle: string;
  /** 按合并条目冻结原文重建的快照；不读取当前主文档，旧决定永不展示成新原文。 */
  segments: Segment[];
  decisions: Array<{
    segmentId: string;
    unitId: string;
    action: ReviewAction;
    /** 裁决冻结的原文、译文与依据。 */
    sourceText: string;
    text: string;
    /** 冻结发布时的当前原文/当前译文，供对照；与冻结裁决分列。 */
    currentSourceText?: string;
    currentUnitText?: string;
    rationale?: string;
    /** 冻结时该条目的原文相对当前文档的状态。 */
    driftStatus?: MergeDriftStatus;
  }>;
}

export interface ReviewWorkspaceState {
  branches: ReviewBranch[];
  mergedVersions: MergedVersion[];
  freezes: ReleaseFreeze[];
}

export function emptyReviewWorkspace(): ReviewWorkspaceState {
  return { branches: [], mergedVersions: [], freezes: [] };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function judgmentKey(segmentId: string, unitId: string): string {
  return segmentId + '::' + unitId;
}

/** 从当前原文建立独立审阅分支；基线按段落 id 记录，移动段落不影响。 */
export function createBranch(
  ws: ReviewWorkspaceState,
  doc: DocState,
  reviewer: string,
  now = new Date().toISOString(),
): { ws: ReviewWorkspaceState; branchId: string } {
  const next = clone(ws);
  const branch: ReviewBranch = {
    id: nextId('unit'),
    reviewer,
    baseline: Object.fromEntries(doc.segments.map((s) => [s.id, s.text])),
    baselineTakenAt: now,
    judgments: [],
    status: 'open',
    createdAt: now,
  };
  next.branches.push(branch);
  return { ws: next, branchId: branch.id };
}

/** 记录/覆盖某项判断：同一键再次判断视为继续编辑，保留最新决定。 */
export function recordJudgment(
  ws: ReviewWorkspaceState,
  branchId: string,
  judgment: ReviewJudgment,
): ReviewWorkspaceState {
  const next = clone(ws);
  const branch = next.branches.find((b) => b.id === branchId);
  if (!branch || branch.status !== 'open') return next;
  const key = judgmentKey(judgment.segmentId, judgment.unitId);
  branch.judgments = branch.judgments.filter(
    (j) => judgmentKey(j.segmentId, j.unitId) !== key,
  );
  branch.judgments.push(clone(judgment));
  return next;
}

export function setBranchStatus(
  ws: ReviewWorkspaceState,
  branchId: string,
  status: 'open' | 'closed',
): ReviewWorkspaceState {
  const next = clone(ws);
  const branch = next.branches.find((b) => b.id === branchId);
  if (branch) branch.status = status;
  return next;
}

function sameJudgment(a: ReviewJudgment, b: ReviewJudgment): boolean {
  return (
    a.action === b.action &&
    (a.revisedText ?? '') === (b.revisedText ?? '')
  );
}

/** 取一项判断最终采用的译文文本。 */
function resolvedTextOf(judgment: ReviewJudgment, unitText: string): string {
  if (judgment.action === 'edit') return judgment.revisedText ?? '';
  if (judgment.action === 'accept') return unitText;
  return '';
}

/** 在汇总/裁定时刻冻结该条目的原文、译文与裁决依据。 */
function freezeBasis(doc: DocState, segmentId: string, unitId: string, resolution: ReviewJudgment): FrozenBasis {
  const segment = doc.segments.find((s) => s.id === segmentId);
  const unit = doc.units.find((u) => u.id === unitId);
  const unitText = unit?.text ?? '';
  return {
    sourceText: segment?.text ?? '',
    sourceKind: segment?.kind ?? 'paragraph',
    unitText,
    resolvedText: resolvedTextOf(resolution, unitText),
    rationale: resolution.rationale,
  };
}

/**
 * 汇总两个分支：区分共同修改、仅一侧修改与真正冲突。
 * 冲突默认未决定，未决定前不能进入发布包。
 * 共同/单侧条目在创建时即冻结当时原文、译文与依据；
 * 冲突条目冻结两侧判断时的现场，待人工裁定后再固定最终依据。
 */
export function mergeBranches(
  ws: ReviewWorkspaceState,
  doc: DocState,
  branchIdA: string,
  branchIdB: string,
  now = new Date().toISOString(),
): { ws: ReviewWorkspaceState; mergedId: string | null } {
  const a = ws.branches.find((br) => br.id === branchIdA);
  const b = ws.branches.find((br) => br.id === branchIdB);
  if (!a || !b || a.id === b.id) return { ws, mergedId: null };
  const items: MergeItem[] = [];
  const seen = new Set<string>();
  const push = (judgment: ReviewJudgment, side: 'a' | 'b') => {
    const key = judgmentKey(judgment.segmentId, judgment.unitId);
    const other = (side === 'a' ? b! : a!).judgments.find(
      (j) => judgmentKey(j.segmentId, j.unitId) === key,
    );
    if (seen.has(key)) return;
    seen.add(key);
    if (!other) {
      const frozen = freezeBasis(doc, judgment.segmentId, judgment.unitId, judgment);
      const item: MergeItem = {
        segmentId: judgment.segmentId,
        unitId: judgment.unitId,
        kind: side === 'a' ? 'onlyA' : 'onlyB',
        resolution: clone(judgment),
        resolved: true,
        pending: false,
        frozen,
      };
      item[side] = clone(judgment);
      items.push(item);
      return;
    }
    if (sameJudgment(judgment, other)) {
      items.push({
        segmentId: judgment.segmentId,
        unitId: judgment.unitId,
        kind: 'common',
        a: clone(judgment),
        b: clone(other),
        resolution: clone(judgment),
        resolved: true,
        pending: false,
        frozen: freezeBasis(doc, judgment.segmentId, judgment.unitId, judgment),
      });
    } else {
      items.push({
        segmentId: judgment.segmentId,
        unitId: judgment.unitId,
        kind: 'conflict',
        a: clone(side === 'a' ? judgment : other),
        b: clone(side === 'a' ? other : judgment),
        resolved: false,
        pending: false,
        frozen: freezeBasis(doc, judgment.segmentId, judgment.unitId, side === 'a' ? judgment : other),
      });
    }
  };
  for (const j of a.judgments) push(j, 'a');
  for (const j of b.judgments) push(j, 'b');
  const merged: MergedVersion = {
    id: nextId('unit'),
    branchIds: [a.id, b.id],
    createdAt: now,
    titleSnapshot: doc.title,
    items,
  };
  const next = clone(ws);
  next.mergedVersions.push(merged);
  return { ws: next, mergedId: merged.id };
}

/** 人工裁定冲突：选择一侧或给出新的最终判断。 */
export function resolveConflict(
  ws: ReviewWorkspaceState,
  doc: DocState,
  mergedId: string,
  segmentId: string,
  unitId: string,
  resolution: ReviewJudgment,
): ReviewWorkspaceState {
  const next = clone(ws);
  const merged = next.mergedVersions.find((m) => m.id === mergedId);
  const item = merged?.items.find(
    (i) => i.segmentId === segmentId && i.unitId === unitId,
  );
  if (!item) return next;
  item.resolution = clone(resolution);
  item.resolved = true;
  item.pending = false;
  item.frozen = freezeBasis(doc, segmentId, unitId, resolution);
  return next;
}

/**
 * 计算合并条目之间的依赖连通分量。
 * 共享同一译文单元（多段共用一篇译文）或同一段落上的条目
 * 彼此依赖：撤回任一项会重开整个分量。
 */
export function dependentItems(items: MergeItem[], segmentId: string, unitId: string): MergeItem[] {
  const adjacency = items.map(() => new Set<number>());
  const bySegment = new Map<string, number[]>();
  const byUnit = new Map<string, number[]>();
  items.forEach((item, index) => {
    for (const map of [bySegment, byUnit]) {
      const key = map === bySegment ? item.segmentId : item.unitId;
      const list = map.get(key) ?? [];
      list.push(index);
      map.set(key, list);
    }
  });
  const connect = (indices: number[]) => {
    for (const i of indices) {
      for (const j of indices) adjacency[i].add(j);
    }
  };
  bySegment.forEach(connect);
  byUnit.forEach(connect);
  const start = items.findIndex((i) => i.segmentId === segmentId && i.unitId === unitId);
  if (start < 0) return [];
  const visited = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const neighbor of adjacency[current]) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return [...visited].map((index) => items[index]);
}

/**
 * 撤回合并版本中的某项决定：只重开其依赖连通分量（同段/同译文单元），
 * 其他条目不受影响；不修改任何来源分支的原始判断，
 * 冻结的原合并依据原样保留，pending 仅标记当前裁决状态。
 */
export function withdrawMergedItem(
  ws: ReviewWorkspaceState,
  mergedId: string,
  segmentId: string,
  unitId: string,
): ReviewWorkspaceState {
  const next = clone(ws);
  const merged = next.mergedVersions.find((m) => m.id === mergedId);
  if (!merged) return next;
  const dependent = new Set(
    dependentItems(merged.items, segmentId, unitId).map((i) => judgmentKey(i.segmentId, i.unitId)),
  );
  for (const item of merged.items) {
    if (dependent.has(judgmentKey(item.segmentId, item.unitId))) {
      item.pending = true;
      item.resolved = false;
    }
  }
  return next;
}

/** 重新决定合并版本中处于待审的条目。 */
export function redecideMergedItem(
  ws: ReviewWorkspaceState,
  doc: DocState,
  mergedId: string,
  resolution: ReviewJudgment,
): ReviewWorkspaceState {
  return resolveConflict(ws, doc, mergedId, resolution.segmentId, resolution.unitId, resolution);
}

/** 未决定的冲突或待审项存在时不能冻结。 */
export function canFreeze(merged: MergedVersion): boolean {
  return merged.items.every((i) => i.resolved && !i.pending && i.resolution);
}

export type MergeDriftStatus = 'applies' | 'recheck' | 'removed' | 'new';

export interface MergeItemDrift {
  segmentId: string;
  unitId: string;
  status: MergeDriftStatus;
  /** 合并时冻结的原文与译文。 */
  frozenSourceText: string;
  frozenUnitText: string;
  /** 当前主文档中的原文/译文；removed 或缺单元时缺省。 */
  currentSourceText?: string;
  currentUnitText?: string;
  /** 原文是否相对冻结依据发生变化（译文变化单独提示）。 */
  sourceChanged: boolean;
  unitChanged: boolean;
  /** 该条目是否经拆合谱系仍能对应到当前段落（用于展示来源而非自动沿用）。 */
  viaOrigins?: string[];
}

export interface MergeReconcileResult {
  titleChanged: boolean;
  titleSnapshot: string;
  currentTitle: string;
  entries: MergeItemDrift[];
  /** 需要复核的条目：原文/译文已变，或原段已被拆分合并删除（经谱系可查来源）。 */
  recheckItems: MergeItemDrift[];
}

/** 段落 id 是否（经 link 谱系）派生自某个合并条目冻结的来源段。 */
function derivedFrom(doc: DocState, candidateId: string, originId: string): string[] | undefined {
  if (candidateId === originId) return undefined;
  const trails: string[] = [];
  for (const link of doc.links) {
    if (link.segmentId === candidateId && link.originSegmentIds?.includes(originId)) {
      for (const origin of link.originSegmentIds!) {
        if (!trails.includes(origin)) trails.push(origin);
      }
    }
  }
  return trails.length > 0 ? trails : undefined;
}

/**
 * 把合并版本冻结的裁决依据与当前主文档对照：
 * - 移动段落不改变身份，仍然 applies；
 * - 原文/译文变化标记 recheck，分别展示冻结原文与当前原文；
 * - 原段被拆分/合并删除时标记 removed，并通过 link.originSegmentIds 保留来源对应；
 * - 当前文档中存在、但不属于本合并版本的段落在 UI 侧另列为 new（此处按条目对照，不产生条目）。
 * 标题变化单独报告，不与条目混淆。
 */
export function reconcileMergedVersion(doc: DocState, merged: MergedVersion): MergeReconcileResult {
  const entries: MergeItemDrift[] = [];
  for (const item of merged.items) {
    const segment = doc.segments.find((s) => s.id === item.segmentId);
    const unit = doc.units.find((u) => u.id === item.unitId);
    let status: MergeDriftStatus;
    let currentSourceText: string | undefined;
    let currentUnitText: string | undefined;
    let sourceChanged = false;
    let unitChanged = false;
    let viaOrigins: string[] | undefined;
    if (!segment) {
      status = 'removed';
      const descendant = doc.links.find(
        (l) => derivedFrom(doc, l.segmentId, item.segmentId) !== undefined,
      );
      if (descendant) viaOrigins = derivedFrom(doc, descendant.segmentId, item.segmentId);
    } else {
      currentSourceText = segment.text;
      currentUnitText = unit?.text;
      sourceChanged = segment.text !== item.frozen.sourceText;
      unitChanged = (unit?.text ?? '') !== item.frozen.unitText;
      status = sourceChanged || unitChanged || !unit ? 'recheck' : 'applies';
    }
    entries.push({
      segmentId: item.segmentId,
      unitId: item.unitId,
      status,
      frozenSourceText: item.frozen.sourceText,
      frozenUnitText: item.frozen.unitText,
      currentSourceText,
      currentUnitText,
      sourceChanged,
      unitChanged,
      viaOrigins,
    });
  }
  return {
    titleChanged: doc.title !== merged.titleSnapshot,
    titleSnapshot: merged.titleSnapshot,
    currentTitle: doc.title,
    entries,
    recheckItems: entries.filter((e) => e.status === 'recheck' || e.status === 'removed'),
  };
}

/**
 * 发布冻结：快照当时的原文、最终译文与每项决定依据。
 * 裁决依据一律取自合并条目的冻结快照，不读取当前主文档，
 * 因而主文档标题/正文事后修改不会让已冻结决定看起来针对新原文；
 * 当前修订另列在 current* 字段中，冻结内容深拷贝独立保存。
 */
export function freezeRelease(
  ws: ReviewWorkspaceState,
  doc: DocState,
  mergedId: string,
  now = new Date().toISOString(),
): { ws: ReviewWorkspaceState; freezeId: string | null; error?: string } {
  const merged = ws.mergedVersions.find((m) => m.id === mergedId);
  if (!merged) return { ws, freezeId: null, error: '合并版本不存在' };
  if (!canFreeze(merged)) {
    return { ws, freezeId: null, error: '存在未决定的冲突或待审项，不能进入发布包' };
  }
  const drift = reconcileMergedVersion(doc, merged);
  const driftByKey = new Map(
    drift.entries.map((entry) => [judgmentKey(entry.segmentId, entry.unitId), entry]),
  );
  const segmentById = new Map<string, Segment>();
  for (const item of merged.items) {
    if (!segmentById.has(item.segmentId)) {
      segmentById.set(item.segmentId, {
        id: item.segmentId,
        kind: item.frozen.sourceKind,
        text: item.frozen.sourceText,
      });
    }
  }
  const freeze: ReleaseFreeze = {
    id: nextId('unit'),
    mergedVersionId: merged.id,
    frozenAt: now,
    title: merged.titleSnapshot,
    currentTitle: doc.title,
    segments: merged.items
      .map((item) => segmentById.get(item.segmentId)!)
      .filter((segment, index, all) => all.findIndex((s) => s.id === segment.id) === index),
    decisions: merged.items.map((item) => {
      const resolution = item.resolution!;
      const entry = driftByKey.get(judgmentKey(item.segmentId, item.unitId));
      return {
        segmentId: item.segmentId,
        unitId: item.unitId,
        action: resolution.action,
        sourceText: item.frozen.sourceText,
        text: item.frozen.resolvedText,
        currentSourceText: entry?.currentSourceText,
        currentUnitText: entry?.currentUnitText,
        rationale: item.frozen.rationale,
        driftStatus: entry?.status,
      };
    }),
  };
  const next = clone(ws);
  next.freezes.push(freeze);
  return { ws: next, freezeId: freeze.id };
}

export type ReconcileStatus = 'applies' | 'recheck' | 'removed' | 'new';

export interface ReconcileEntry {
  segmentId: string;
  status: ReconcileStatus;
  baselineText?: string;
  currentText?: string;
}

/**
 * 原文在审阅期间修订后的逐段核对：
 * 按段落 id（而非位置）比较基线与当前原文，
 * 未变的判断仍适用，已变的必须复核；拆分/合并产生的新 id 视为新增。
 */
export function reconcileBranch(doc: DocState, branch: ReviewBranch): ReconcileEntry[] {
  const entries: ReconcileEntry[] = [];
  const currentIds = new Set(doc.segments.map((s) => s.id));
  for (const segment of doc.segments) {
    const baselineText = branch.baseline[segment.id];
    if (baselineText === undefined) {
      entries.push({ segmentId: segment.id, status: 'new', currentText: segment.text });
    } else if (baselineText === segment.text) {
      entries.push({
        segmentId: segment.id,
        status: 'applies',
        baselineText,
        currentText: segment.text,
      });
    } else {
      entries.push({
        segmentId: segment.id,
        status: 'recheck',
        baselineText,
        currentText: segment.text,
      });
    }
  }
  for (const [segmentId, baselineText] of Object.entries(branch.baseline)) {
    if (!currentIds.has(segmentId)) {
      entries.push({ segmentId, status: 'removed', baselineText });
    }
  }
  return entries;
}
