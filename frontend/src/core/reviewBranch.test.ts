import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  moveSegment,
  splitSegment,
  updateTranslation,
} from './docOps';
import { DocState } from './model';
import {
  branchApplicability,
  canPublish,
  createBranch,
  decideOnBranch,
  editBranchText,
  freezePublish,
  judgmentApplicability,
  judgmentKey,
  mergeBranches,
  publishBlockers,
  resolveMergeItem,
  withdrawMergeItem,
} from './reviewBranch';

function buildDoc(): DocState {
  let doc = createDocument('发布稿', [
    { text: '系统允许外部访问。' },
    { text: '保持简单。' },
    { text: '保持简单。' },
  ]);
  for (const segment of doc.segments) {
    const created = createUnitForSegment(doc, segment.id);
    doc = updateTranslation(created.state, created.unitId, `EN:${segment.text}`);
  }
  return doc;
}

const keyOf = (doc: DocState, index: number) =>
  judgmentKey(doc.segments[index].id, doc.links.find((l) => l.segmentId === doc.segments[index].id)!.unitId);

describe('独立审阅分支', () => {
  it('两名审阅者从同一原文版本独立工作，互不影响', () => {
    const doc = buildDoc();
    let alice = createBranch(doc, 'Alice', '2026-10-01T00:00:00Z');
    let bob = createBranch(doc, 'Bob', '2026-10-01T00:00:00Z');
    expect(alice.baselineSegments.map((s) => s.text)).toEqual(doc.segments.map((s) => s.text));

    const key = keyOf(doc, 0);
    alice = editBranchText(alice, key, 'External access is allowed.');
    alice = decideOnBranch(alice, key, 'revised', undefined, '2026-10-01T01:00:00Z');

    // Bob 的分支保持原基线与未决定状态。
    const bobJudgment = bob.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key)!;
    expect(bobJudgment.text).toBe('EN:系统允许外部访问。');
    expect(bobJudgment.judgment).toBeNull();
    bob = decideOnBranch(bob, key, 'confirmed', undefined, '2026-10-01T02:00:00Z');
    expect(alice.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === key)!.judgment).toBe('revised');
  });

  it('保存半完成状态并重开后：来源独立、已决定项仍在', () => {
    const doc = buildDoc();
    let alice = createBranch(doc, 'Alice');
    let bob = createBranch(doc, 'Bob');
    alice = decideOnBranch(alice, keyOf(doc, 0), 'confirmed');
    bob = decideOnBranch(bob, keyOf(doc, 1), 'deferred');

    // 模拟保存/重开：序列化往返。
    const reopenedAlice = JSON.parse(JSON.stringify(alice));
    const reopenedBob = JSON.parse(JSON.stringify(bob));
    expect(reopenedAlice.judgments.find((j: any) => judgmentKey(j.segmentId, j.unitId) === keyOf(doc, 0))!.judgment).toBe('confirmed');
    expect(reopenedBob.judgments.find((j: any) => judgmentKey(j.segmentId, j.unitId) === keyOf(doc, 1))!.judgment).toBe('deferred');
    // 两份来源独立：重开后改 Alice 不影响 Bob。
    const edited = editBranchText(reopenedAlice, keyOf(doc, 1), 'changed');
    expect(reopenedBob.judgments.find((j: any) => judgmentKey(j.segmentId, j.unitId) === keyOf(doc, 1))!.text).not.toBe('changed');
    expect(edited.id).not.toBe(reopenedBob.id);
  });
});

describe('汇总与发布冻结', () => {
  it('区分共同修改、单侧修改与真正冲突；未裁决冲突不能发布', () => {
    const doc = buildDoc();
    let alice = createBranch(doc, 'Alice');
    let bob = createBranch(doc, 'Bob');
    const [k0, k1, k2] = [keyOf(doc, 0), keyOf(doc, 1), keyOf(doc, 2)];

    // k0：双方同样改法 → 共同修改；k1：仅 Alice 决定；k2：双方不一致 → 冲突。
    alice = editBranchText(alice, k0, 'Access allowed.');
    alice = decideOnBranch(alice, k0, 'revised');
    bob = editBranchText(bob, k0, 'Access allowed.');
    bob = decideOnBranch(bob, k0, 'revised');
    alice = decideOnBranch(alice, k1, 'confirmed');
    alice = editBranchText(alice, k2, 'Keep it simple.');
    alice = decideOnBranch(alice, k2, 'revised');
    bob = editBranchText(bob, k2, 'Stay simple.');
    bob = decideOnBranch(bob, k2, 'revised');

    const merged = mergeBranches(alice, bob);
    const byKey = new Map(merged.items.map((i) => [i.key, i]));
    expect(byKey.get(k0)!.category).toBe('common');
    expect(byKey.get(k1)!.category).toBe('left-only');
    expect(byKey.get(k2)!.category).toBe('conflict');

    // 未裁决冲突阻止发布。
    expect(canPublish(merged)).toBe(false);
    expect(publishBlockers(merged).map((b) => b.key)).toEqual([k2]);
    expect(() => freezePublish(doc, merged)).toThrow();

    // 裁决后可以发布；冻结保留当时原文、译文与决定依据。
    const resolved = resolveMergeItem(merged, k2, 'right');
    expect(canPublish(resolved)).toBe(true);
    const frozen = freezePublish(doc, resolved, '2026-10-02T00:00:00Z');
    expect(frozen.decisions).toHaveLength(3);
    const conflictDecision = frozen.decisions.find(
      (d) => judgmentKey(d.segmentId, d.unitId) === k2,
    )!;
    expect(conflictDecision.translation).toBe('Stay simple.');
    expect(conflictDecision.basis).toContain('Bob');
    expect(conflictDecision.source).toBe('保持简单。');

    // 冻结后继续审阅不改变已冻结内容。
    const laterAlice = editBranchText(alice, k2, 'Totally different.');
    expect(laterAlice.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === k2)!.text).toBe('Totally different.');
    expect(frozen.decisions.find((d) => judgmentKey(d.segmentId, d.unitId) === k2)!.translation).toBe('Stay simple.');
  });

  it('单独撤回某项决定只使依赖项重新待审，不覆盖原审阅分支', () => {
    const doc = buildDoc();
    let alice = createBranch(doc, 'Alice');
    let bob = createBranch(doc, 'Bob');
    for (const key of [keyOf(doc, 0), keyOf(doc, 1), keyOf(doc, 2)]) {
      alice = decideOnBranch(alice, key, 'confirmed');
      bob = decideOnBranch(bob, key, 'confirmed');
    }
    const merged = mergeBranches(alice, bob);
    expect(canPublish(merged)).toBe(true);

    const withdrawn = withdrawMergeItem(merged, keyOf(doc, 1));
    expect(canPublish(withdrawn)).toBe(false);
    expect(publishBlockers(withdrawn)[0].reason).toContain('撤回');
    // 原审阅分支的决定保持不动。
    expect(alice.judgments.every((j) => j.judgment === 'confirmed')).toBe(true);
    expect(bob.judgments.every((j) => j.judgment === 'confirmed')).toBe(true);
    // 重新定夺后恢复可发布。
    const reResolved = resolveMergeItem(withdrawn, keyOf(doc, 1), 'left');
    expect(canPublish(reResolved)).toBe(true);
  });
});

describe('审阅期间原文修订的逐项适用性', () => {
  it('逐段区分仍适用与必须复核；移动位置不套用旧结论也不误判', () => {
    let doc = buildDoc();
    const alice = createBranch(doc, 'Alice');
    const decided = decideOnBranch(alice, keyOf(doc, 0), 'confirmed');

    // 段 0 内容修订、段 1 仅移动位置、段 2 不变。
    doc = editSegment(doc, doc.segments[0].id, '系统禁止外部访问。').state;
    doc = moveSegment(doc, doc.segments[1].id, 2).state;

    const judgments = decided.judgments;
    const j0 = judgments.find((j) => j.segmentId === alice.baselineSegments[0].id)!;
    const j1 = judgments.find((j) => j.segmentId === alice.baselineSegments[1].id)!;
    const j2 = judgments.find((j) => j.segmentId === alice.baselineSegments[2].id)!;
    expect(judgmentApplicability(j0, doc)).toBe('recheck');
    // 位置变了但身份与内容未变：仍适用，不因为位置变化而失效。
    expect(judgmentApplicability(j1, doc)).toBe('applicable');
    expect(judgmentApplicability(j2, doc)).toBe('applicable');

    const report = branchApplicability(decided, doc);
    expect(report.recheck.map((j) => j.segmentId)).toEqual([alice.baselineSegments[0].id]);
    expect(report.applicable).toHaveLength(2);
  });

  it('段落拆分后旧判断不可套用；同文不同上下文分别核对', () => {
    let doc = buildDoc();
    const alice = createBranch(doc, 'Alice');
    // 段 1 与段 2 文本相同（“保持简单。”），但身份不同：判断分别记录。
    const k1 = keyOf(doc, 1);
    const k2 = keyOf(doc, 2);
    expect(k1).not.toBe(k2);
    const decided1 = decideOnBranch(alice, k1, 'confirmed');
    expect(decided1.judgments.find((j) => judgmentKey(j.segmentId, j.unitId) === k2)!.judgment).toBeNull();

    // 拆分段 0：旧段落身份消失，其判断必须复核，不能按文本相似套用。
    const split = splitSegment(doc, doc.segments[0].id, ['系统允许', '外部访问。']);
    doc = split.state;
    const j0 = decided1.judgments.find((j) => j.segmentId === alice.baselineSegments[0].id)!;
    expect(judgmentApplicability(j0, doc)).toBe('segment-gone');
    // 新拆出的段落没有继承任何旧判断。
    for (const newId of split.meta.createdSegmentIds!) {
      expect(decided1.judgments.some((j) => j.segmentId === newId)).toBe(false);
    }
  });
});
