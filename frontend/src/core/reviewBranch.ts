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
  /** 合并创建时快照的原文（取自分支基线），之后主文档修订不改变它。 */
  sourceText: string;
  /** 合并创建时快照的译文。 */
  unitText: string;
  a?: ReviewJudgment;
  b?: ReviewJudgment;
  /** 汇总后采用的最终判断；共同/单侧条目自动确定，冲突需人工选择。 */
  resolution?: ReviewJudgment;
  resolved: boolean;
  /** 撤回后回到待审，阻断冻结，直到重新决定。 */
  pending: boolean;
}

/** 合并结果：独立保存的版本，不回写任何来源分支。 */
export interface MergedVersion {
  id: string;
  branchIds: [string, string];
  createdAt: string;
  items: MergeItem[];
}

/** 发布冻结：冻结当时的原文、译文与决定依据，之后不可变。 */
export interface ReleaseFreeze {
  id: string;
  mergedVersionId: string;
  frozenAt: string;
  title: string;
  segments: Segment[];
  decisions: Array<{
    segmentId: string;
    unitId: string;
    action: ReviewAction;
    text: string;
    rationale?: string;
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

/**
 * 汇总两个分支：区分共同修改、仅一侧修改与真正冲突。
 * 冲突默认未决定，未决定前不能进入发布包。
 */
export function mergeBranches(
  ws: ReviewWorkspaceState,
  doc: DocState,
  branchIdA: string,
  branchIdB: string,
  now = new Date().toISOString(),
): { ws: ReviewWorkspaceState; mergedId: string | null } {
  const a = ws.branches.find((b) => b.id === branchIdA);
  const b = ws.branches.find((b) => b.id === branchIdB);
  if (!a || !b || a.id === b.id) return { ws, mergedId: null };
  const items: MergeItem[] = [];
  const seen = new Set<string>();
  const snapshotOf = (judgment: ReviewJudgment) => {
    const sourceText =
      a.baseline[judgment.segmentId] ??
      b.baseline[judgment.segmentId] ??
      doc.segments.find((s) => s.id === judgment.segmentId)?.text ??
      '';
    const unitText = doc.units.find((u) => u.id === judgment.unitId)?.text ?? '';
    return { sourceText, unitText };
  };
  const push = (judgment: ReviewJudgment, side: 'a' | 'b') => {
    const key = judgmentKey(judgment.segmentId, judgment.unitId);
    const other = (side === 'a' ? b : a).judgments.find(
      (j) => judgmentKey(j.segmentId, j.unitId) === key,
    );
    if (seen.has(key)) return;
    seen.add(key);
    const snapshot = snapshotOf(judgment);
    if (!other) {
      const item: MergeItem = {
        segmentId: judgment.segmentId,
        unitId: judgment.unitId,
        kind: side === 'a' ? 'onlyA' : 'onlyB',
        ...snapshot,
        resolution: clone(judgment),
        resolved: true,
        pending: false,
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
        ...snapshot,
        a: clone(judgment),
        b: clone(other),
        resolution: clone(judgment),
        resolved: true,
        pending: false,
      });
    } else {
      items.push({
        segmentId: judgment.segmentId,
        unitId: judgment.unitId,
        kind: 'conflict',
        ...snapshot,
        a: clone(side === 'a' ? judgment : other),
        b: clone(side === 'a' ? other : judgment),
        resolved: false,
        pending: false,
      });
    }
  };
  for (const j of a.judgments) push(j, 'a');
  for (const j of b.judgments) push(j, 'b');
  const merged: MergedVersion = {
    id: nextId('unit'),
    branchIds: [a.id, b.id],
    createdAt: now,
    items,
  };
  const next = clone(ws);
  next.mergedVersions.push(merged);
  return { ws: next, mergedId: merged.id };
}

/** 人工裁定冲突：选择一侧或给出新的最终判断。 */
export function resolveConflict(
  ws: ReviewWorkspaceState,
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
  return next;
}

/**
 * 撤回合并版本中的某项决定：该项及其同段依赖项重新待审，
 * 不修改任何来源分支的原始判断。
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
  const target = merged.items.find(
    (i) => i.segmentId === segmentId && i.unitId === unitId,
  );
  if (!target) return next;
  for (const item of merged.items) {
    if (item.segmentId === segmentId) {
      item.pending = true;
      item.resolved = false;
    }
  }
  return next;
}

/**
 * 合并条目与当前原文的逐段核对：按段落 id（而非位置）比较
 * 合并创建时的快照与当前原文；拆分/合并后原段 id 消失视为 removed。
 */
export function reconcileMergedItem(doc: DocState, item: MergeItem): ReconcileEntry {
  const current = doc.segments.find((s) => s.id === item.segmentId);
  if (!current) {
    return { segmentId: item.segmentId, status: 'removed', baselineText: item.sourceText };
  }
  if (current.text === item.sourceText) {
    return {
      segmentId: item.segmentId,
      status: 'applies',
      baselineText: item.sourceText,
      currentText: current.text,
    };
  }
  return {
    segmentId: item.segmentId,
    status: 'recheck',
    baselineText: item.sourceText,
    currentText: current.text,
  };
}

/** 整个合并版本的核对结果：哪些条目的决定依据已与当前原文不一致。 */
export function reconcileMerged(doc: DocState, merged: MergedVersion): ReconcileEntry[] {
  return merged.items.map((item) => reconcileMergedItem(doc, item));
}

/** 重新决定合并版本中处于待审的条目。 */
export function redecideMergedItem(
  ws: ReviewWorkspaceState,
  mergedId: string,
  resolution: ReviewJudgment,
): ReviewWorkspaceState {
  return resolveConflict(ws, mergedId, resolution.segmentId, resolution.unitId, resolution);
}

/** 未决定的冲突或待审项存在时不能冻结。 */
export function canFreeze(merged: MergedVersion): boolean {
  return merged.items.every((i) => i.resolved && !i.pending && i.resolution);
}

/**
 * 发布冻结：快照当时的原文、最终译文与每项决定依据。
 * 冻结内容深拷贝独立保存，之后的审阅与合并不会改变它。
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
  const freeze: ReleaseFreeze = {
    id: nextId('unit'),
    mergedVersionId: merged.id,
    frozenAt: now,
    title: doc.title,
    segments: clone(doc.segments),
    decisions: merged.items.map((item) => {
      const unit = doc.units.find((u) => u.id === item.unitId);
      const resolution = item.resolution!;
      return {
        segmentId: item.segmentId,
        unitId: item.unitId,
        action: resolution.action,
        text:
          resolution.action === 'edit'
            ? resolution.revisedText ?? ''
            : unit?.text ?? '',
        rationale: resolution.rationale,
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
