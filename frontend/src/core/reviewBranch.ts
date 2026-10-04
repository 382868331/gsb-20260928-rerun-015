import { DocState } from './model';
import { nextId } from './identity';
import { normalizeText } from './similarity';

/** 审阅分支上逐项判断的类型：采用现有译文 / 修改后采用 / 暂缓。 */
export type BranchJudgmentType = 'confirmed' | 'revised' | 'deferred';

/** 审阅分支中针对某一“段落×译文单元”的独立判断。 */
export interface BranchJudgment {
  segmentId: string;
  unitId: string;
  language: string;
  /** 分支创建时的原文基线（判断依据，之后原文修订用于对照）。 */
  baselineSource: string;
  /** 分支创建时的译文基线。 */
  baselineTranslation: string;
  /** 审阅者当前译文（可继续编辑）。 */
  text: string;
  /** null 表示尚未决定；未决定项不能进入发布包。 */
  judgment: BranchJudgmentType | null;
  note?: string;
  decidedAt?: string;
}

/** 独立审阅分支：两名审阅者从同一原文版本各自工作，互不可见。 */
export interface ReviewBranch {
  id: string;
  reviewer: string;
  createdAt: string;
  savedAt?: string;
  /** 创建时的原文基线快照（按段落 id 绑定，移动位置不影响）。 */
  baselineSegments: Array<{ id: string; text: string }>;
  judgments: BranchJudgment[];
}

export function judgmentKey(segmentId: string, unitId: string): string {
  return `${segmentId}::${unitId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 从当前文档创建独立审阅分支：冻结原文基线与译文基线，判断全部从零开始。 */
export function createBranch(doc: DocState, reviewer: string, now: string = nowIso()): ReviewBranch {
  const judgments: BranchJudgment[] = [];
  for (const link of doc.links) {
    const segment = doc.segments.find((s) => s.id === link.segmentId);
    const unit = doc.units.find((u) => u.id === link.unitId);
    if (!segment || !unit) continue;
    judgments.push({
      segmentId: segment.id,
      unitId: unit.id,
      language: unit.language ?? 'en',
      baselineSource: segment.text,
      baselineTranslation: unit.text,
      text: unit.text,
      judgment: null,
    });
  }
  return {
    id: nextId('unit'),
    reviewer: reviewer.trim() || '未命名审阅者',
    createdAt: now,
    baselineSegments: doc.segments.map((s) => ({ id: s.id, text: s.text })),
    judgments,
  };
}

function cloneBranch(branch: ReviewBranch): ReviewBranch {
  return JSON.parse(JSON.stringify(branch)) as ReviewBranch;
}

/** 继续编辑分支内某项译文（仅影响本分支）。 */
export function editBranchText(branch: ReviewBranch, key: string, text: string): ReviewBranch {
  const next = cloneBranch(branch);
  const judgment = next.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key);
  if (judgment) judgment.text = text;
  return next;
}

/** 记录逐项判断；保存时间戳，可保存后重开继续。 */
export function decideOnBranch(
  branch: ReviewBranch,
  key: string,
  type: BranchJudgmentType,
  note?: string,
  now: string = nowIso(),
): ReviewBranch {
  const next = cloneBranch(branch);
  const judgment = next.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key);
  if (!judgment) return next;
  judgment.judgment = type;
  judgment.note = note?.trim() || undefined;
  judgment.decidedAt = now;
  next.savedAt = now;
  return next;
}

/** 原文在审阅期间发生修订后，逐项判断的适用性。 */
export type JudgmentApplicability =
  | 'applicable' // 原文未变（按段落身份比对，移动位置不影响），旧判断仍适用
  | 'recheck' // 同一段落内容已修订，必须复核
  | 'segment-gone'; // 段落被拆分/合并取代，旧判断不可套用，必须复核

/**
 * 逐项判断与当前原文对照：严格按段落 id（身份）比对，
 * 不以段落位置或文本相似度套用旧结论；同文不同上下文（不同 id）分别核对。
 */
export function judgmentApplicability(
  judgment: BranchJudgment,
  doc: DocState,
): JudgmentApplicability {
  const segment = doc.segments.find((s) => s.id === judgment.segmentId);
  if (!segment) return 'segment-gone';
  return normalizeText(segment.text) === normalizeText(judgment.baselineSource)
    ? 'applicable'
    : 'recheck';
}

export interface ApplicabilityReport {
  applicable: BranchJudgment[];
  recheck: BranchJudgment[];
  gone: BranchJudgment[];
}

export function branchApplicability(branch: ReviewBranch, doc: DocState): ApplicabilityReport {
  const report: ApplicabilityReport = { applicable: [], recheck: [], gone: [] };
  for (const judgment of branch.judgments) {
    const status = judgmentApplicability(judgment, doc);
    if (status === 'applicable') report.applicable.push(judgment);
    else if (status === 'recheck') report.recheck.push(judgment);
    else report.gone.push(judgment);
  }
  return report;
}

export type MergeCategory =
  | 'common' // 双方判断一致（同类型且译文相同）
  | 'left-only' // 仅左侧已决定
  | 'right-only' // 仅右侧已决定
  | 'conflict' // 双方都已决定但不一致：真正冲突
  | 'both-pending'; // 双方都未决定

export interface MergeItem {
  key: string;
  segmentId: string;
  unitId: string;
  language: string;
  baselineSource: string;
  category: MergeCategory;
  left?: BranchJudgment;
  right?: BranchJudgment;
  /** 冲突裁决：采用哪一侧；未裁决的冲突不能进入发布包。 */
  resolution?: 'left' | 'right';
  /** 该决定被单独撤回：依赖它的发布资格重新待审，原审阅分支不受影响。 */
  withdrawn?: boolean;
}

/** 合并结果作为独立版本保存，不覆盖任何一方审阅分支。 */
export interface MergedVersion {
  id: string;
  createdAt: string;
  leftBranchId: string;
  rightBranchId: string;
  reviewers: [string, string];
  items: MergeItem[];
}

function categorize(left?: BranchJudgment, right?: BranchJudgment): MergeCategory {
  const leftDecided = left?.judgment != null;
  const rightDecided = right?.judgment != null;
  if (leftDecided && rightDecided) {
    const sameJudgment = left!.judgment === right!.judgment;
    const sameText = normalizeText(left!.text) === normalizeText(right!.text);
    return sameJudgment && sameText ? 'common' : 'conflict';
  }
  if (leftDecided) return 'left-only';
  if (rightDecided) return 'right-only';
  return 'both-pending';
}

/** 汇总两份审阅分支：区分共同修改、只由一侧修改与真正冲突。 */
export function mergeBranches(
  left: ReviewBranch,
  right: ReviewBranch,
  now: string = nowIso(),
): MergedVersion {
  const keys = new Set<string>();
  for (const j of [...left.judgments, ...right.judgments]) {
    keys.add(judgmentKey(j.segmentId, j.unitId));
  }
  const items: MergeItem[] = [];
  for (const key of keys) {
    const leftJudgment = left.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key);
    const rightJudgment = right.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key);
    const sample = leftJudgment ?? rightJudgment!;
    items.push({
      key,
      segmentId: sample.segmentId,
      unitId: sample.unitId,
      language: sample.language,
      baselineSource: sample.baselineSource,
      category: categorize(leftJudgment, rightJudgment),
      left: leftJudgment,
      right: rightJudgment,
    });
  }
  return {
    id: nextId('unit'),
    createdAt: now,
    leftBranchId: left.id,
    rightBranchId: right.id,
    reviewers: [left.reviewer, right.reviewer],
    items,
  };
}

function cloneMerged(merged: MergedVersion): MergedVersion {
  return JSON.parse(JSON.stringify(merged)) as MergedVersion;
}

/** 裁决冲突（或对撤回项重新定夺）：选择采用哪一侧。 */
export function resolveMergeItem(
  merged: MergedVersion,
  key: string,
  side: 'left' | 'right',
): MergedVersion {
  const next = cloneMerged(merged);
  const item = next.items.find((i) => i.key === key);
  if (!item) return next;
  item.resolution = side;
  item.withdrawn = undefined;
  return next;
}

/** 单独撤回某项合并决定：仅使其依赖项（发布资格）重新待审，不改写原审阅分支。 */
export function withdrawMergeItem(merged: MergedVersion, key: string): MergedVersion {
  const next = cloneMerged(merged);
  const item = next.items.find((i) => i.key === key);
  if (!item) return next;
  item.withdrawn = true;
  item.resolution = undefined;
  return next;
}

/** 该项当前生效的译文与判断（裁决后按所侧，共同/单侧按已决定侧）。 */
export function effectiveJudgment(item: MergeItem): BranchJudgment | undefined {
  if (item.withdrawn) return undefined;
  if (item.category === 'conflict') {
    if (!item.resolution) return undefined;
    return item.resolution === 'left' ? item.left : item.right;
  }
  if (item.category === 'common' || item.category === 'left-only') return item.left;
  if (item.category === 'right-only') return item.right;
  return undefined;
}

/** 阻止发布的原因列表（逐项）；为空才可发布冻结。 */
export function publishBlockers(merged: MergedVersion): Array<{ key: string; reason: string }> {
  const blockers: Array<{ key: string; reason: string }> = [];
  for (const item of merged.items) {
    if (item.withdrawn) {
      blockers.push({ key: item.key, reason: '该决定已撤回，等待重新定夺' });
    } else if (item.category === 'conflict' && !item.resolution) {
      blockers.push({ key: item.key, reason: '冲突尚未裁决，不能进入发布包' });
    } else if (item.category === 'both-pending') {
      blockers.push({ key: item.key, reason: '两侧均未决定' });
    }
  }
  return blockers;
}

export function canPublish(merged: MergedVersion): boolean {
  return publishBlockers(merged).length === 0;
}

/** 发布冻结中逐项保留的决定依据。 */
export interface FrozenDecision {
  segmentId: string;
  unitId: string;
  language: string;
  /** 冻结当时的原文。 */
  source: string;
  /** 冻结当时的译文。 */
  translation: string;
  judgment: BranchJudgmentType;
  /** 决定依据：共同决定 / 仅某侧 / 冲突裁决采用某侧。 */
  basis: string;
}

/** 发布冻结：保留当时的原文、译文与决定依据；之后的审阅改动不影响已冻结内容。 */
export interface PublishFreeze {
  id: string;
  frozenAt: string;
  mergedVersionId: string;
  reviewers: [string, string];
  decisions: FrozenDecision[];
}

export function freezePublish(
  doc: DocState,
  merged: MergedVersion,
  now: string = nowIso(),
): PublishFreeze {
  if (!canPublish(merged)) {
    throw new Error('存在未决定或未裁决的条目，不能发布冻结');
  }
  const decisions: FrozenDecision[] = [];
  for (const item of merged.items) {
    const effective = effectiveJudgment(item);
    if (!effective || effective.judgment == null) continue;
    const segment = doc.segments.find((s) => s.id === item.segmentId);
    const basis =
      item.category === 'common'
        ? `共同决定（${merged.reviewers[0]} / ${merged.reviewers[1]}）`
        : item.category === 'conflict'
          ? `冲突裁决：采用 ${item.resolution === 'left' ? merged.reviewers[0] : merged.reviewers[1]}`
          : `仅 ${item.category === 'left-only' ? merged.reviewers[0] : merged.reviewers[1]} 决定`;
    decisions.push({
      segmentId: item.segmentId,
      unitId: item.unitId,
      language: item.language,
      source: segment?.text ?? item.baselineSource,
      translation: effective.text,
      judgment: effective.judgment,
      basis,
    });
  }
  return {
    id: nextId('unit'),
    frozenAt: now,
    mergedVersionId: merged.id,
    reviewers: [...merged.reviewers],
    decisions,
  };
}
