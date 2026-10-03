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
  ReviewJudgment,
  ReviewWorkspaceState,
  canFreeze,
  createBranch,
  emptyReviewWorkspace,
  freezeRelease,
  mergeBranches,
  reconcileBranch,
  recordJudgment,
  resolveConflict,
  withdrawMergedItem,
} from './reviewBranch';

function buildDoc(): DocState {
  let doc = createDocument('发布流程样稿', [
    { kind: 'heading', text: '产品更新公告' },
    { text: '我们今天发布了新版本。' },
    { text: '新版本提升了稳定性。' },
    { text: '我们今天发布了新版本。' },
    { text: '感谢大家的支持与反馈。' },
  ]);
  const texts = [
    'Product Update Announcement',
    'We released a new version today.',
    'The new version improves stability.',
    'We released a new version today.',
    'Thanks for your support.',
  ];
  doc.segments.forEach((segment, index) => {
    const result = createUnitForSegment(doc, segment.id, 'en');
    doc = updateTranslation(result.state, result.unitId, texts[index]);
  });
  return doc;
}

function judge(
  ws: ReviewWorkspaceState,
  branchId: string,
  segmentId: string,
  unitId: string,
  action: ReviewJudgment['action'],
  revisedText?: string,
  rationale?: string,
): ReviewWorkspaceState {
  return recordJudgment(ws, branchId, {
    segmentId,
    unitId,
    action,
    revisedText,
    rationale,
    decidedAt: '2026-10-04T00:00:00Z',
  });
}

const unitOf = (doc: DocState, index: number) =>
  doc.links.find((l) => l.segmentId === doc.segments[index].id)!.unitId;

describe('独立审阅分支 → 汇总 → 冻结 全流程', () => {
  it('两名审阅者独立工作、保存重开、汇总分类、冲突阻断冻结', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    const branchA = a.branchId;
    const branchB = b.branchId;

    // 同一原文基线
    expect(ws.branches[0].baseline).toEqual(ws.branches[1].baseline);

    // 甲：接受 seg0，修改 seg1
    ws = judge(ws, branchA, doc.segments[0].id, unitOf(doc, 0), 'accept', undefined, '译文准确');
    ws = judge(ws, branchA, doc.segments[1].id, unitOf(doc, 1), 'edit', 'We shipped a new version today.', '更地道');
    // 乙：接受 seg0（与甲一致），修改 seg1（与甲不同 → 冲突），修改 seg3（仅乙）
    ws = judge(ws, branchB, doc.segments[0].id, unitOf(doc, 0), 'accept', undefined, '译文准确');
    ws = judge(ws, branchB, doc.segments[1].id, unitOf(doc, 1), 'edit', 'Today we released a new version.', '语序调整');
    ws = judge(ws, branchB, doc.segments[3].id, unitOf(doc, 3), 'edit', 'We launched a new version today.', '重复句不同上下文');

    // 保存半完成状态再重开：序列化/反序列化后判断仍在、分支独立
    const reopened = JSON.parse(JSON.stringify(ws)) as ReviewWorkspaceState;
    expect(reopened.branches[0].judgments).toHaveLength(2);
    expect(reopened.branches[1].judgments).toHaveLength(3);
    // 继续编辑甲的分支不影响乙
    let ws2 = judge(reopened, branchA, doc.segments[2].id, unitOf(doc, 2), 'accept');
    expect(ws2.branches[0].judgments).toHaveLength(3);
    expect(ws2.branches[1].judgments).toHaveLength(3);

    // 汇总
    const merged = mergeBranches(ws2, branchA, branchB);
    ws2 = merged.ws;
    const mv = ws2.mergedVersions.find((m) => m.id === merged.mergedId)!;
    const byKind = (kind: string) => mv.items.filter((i) => i.kind === kind);
    expect(byKind('common')).toHaveLength(1); // seg0 共同接受
    expect(byKind('onlyA')).toHaveLength(1); // seg2 仅甲
    expect(byKind('onlyB')).toHaveLength(1); // seg3 仅乙
    expect(byKind('conflict')).toHaveLength(1); // seg1 冲突

    // 未决定的冲突不能进入发布包
    expect(canFreeze(mv)).toBe(false);
    const blocked = freezeRelease(ws2, doc, mv.id);
    expect(blocked.freezeId).toBeNull();
    expect(blocked.error).toContain('未决定');

    // 裁定冲突（采用乙），随后冻结成功
    const conflict = byKind('conflict')[0];
    ws2 = resolveConflict(ws2, mv.id, conflict.segmentId, conflict.unitId, conflict.b!);
    const mv2 = ws2.mergedVersions.find((m) => m.id === mv.id)!;
    expect(canFreeze(mv2)).toBe(true);
    const frozen = freezeRelease(ws2, doc, mv.id, '2026-10-04T01:00:00Z');
    expect(frozen.freezeId).not.toBeNull();
    ws2 = frozen.ws;
    const freeze = ws2.freezes[0];
    // 冻结保留当时原文、译文与决定依据
    expect(freeze.segments.map((s) => s.text)).toEqual(doc.segments.map((s) => s.text));
    const d1 = freeze.decisions.find((d) => d.segmentId === doc.segments[1].id)!;
    expect(d1.text).toBe('Today we released a new version.');
    expect(d1.rationale).toBe('语序调整');

    // 冻结后继续审阅/修改不改变已冻结内容
    let ws3 = judge(ws2, branchA, doc.segments[4].id, unitOf(doc, 4), 'reject', undefined, '需重译');
    const docAfter = editSegment(doc, doc.segments[1].id, '我们今天发布了全新版本。').state;
    const freezeAgain = ws3.freezes[0];
    expect(freezeAgain.segments[1].text).toBe('我们今天发布了新版本。');
    expect(freezeAgain.decisions.find((d) => d.segmentId === doc.segments[1].id)!.text).toBe(
      'Today we released a new version.',
    );
    expect(docAfter.segments[1].text).toBe('我们今天发布了全新版本。');
  });

  it('原文在审阅期间修订：逐段区分仍适用/必须复核，与位置无关', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const branch = ws.branches[0];

    // 移动段落：身份不变，结论仍适用
    const moved = moveSegment(doc, doc.segments[1].id, 3).state;
    let entries = reconcileBranch(moved, branch);
    expect(entries.every((e) => e.status === 'applies')).toBe(true);

    // 实质改写 seg1：该段必须复核，其余仍适用
    const edited = editSegment(moved, moved.segments[3].id, '我们昨天回滚了旧版本。').state;
    entries = reconcileBranch(edited, branch);
    const recheck = entries.filter((e) => e.status === 'recheck');
    expect(recheck).toHaveLength(1);
    expect(recheck[0].baselineText).toBe('我们今天发布了新版本。');
    expect(recheck[0].currentText).toBe('我们昨天回滚了旧版本。');
    expect(entries.filter((e) => e.status === 'applies')).toHaveLength(4);

    // 拆分：原段 id 消失（removed），新段 id 为新增，不套用旧结论
    const split = splitSegment(edited, edited.segments[4].id, ['感谢大家的支持。', '感谢大家的反馈。']).state;
    entries = reconcileBranch(split, branch);
    expect(entries.filter((e) => e.status === 'removed')).toHaveLength(1);
    expect(entries.filter((e) => e.status === 'new')).toHaveLength(2);

    // 同文不同上下文：两段相同原文的判断互不串用
    let ws2 = emptyReviewWorkspace();
    const c = createBranch(ws2, doc, '甲');
    ws2 = c.ws;
    ws2 = judge(ws2, c.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept');
    const branchAfter = ws2.branches[0];
    expect(branchAfter.judgments).toHaveLength(1);
    expect(branchAfter.judgments[0].segmentId).toBe(doc.segments[1].id);
    expect(
      branchAfter.judgments.some((j) => j.segmentId === doc.segments[3].id),
    ).toBe(false);
  });

  it('撤回合并项只使依赖项重新待审，不覆盖原审阅', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept');
    ws = judge(ws, b.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept');
    ws = judge(ws, b.branchId, doc.segments[1].id, unitOf(doc, 1), 'edit', 'Improved.');
    const merged = mergeBranches(ws, a.branchId, b.branchId);
    ws = merged.ws;
    const mv = ws.mergedVersions[0];
    expect(canFreeze(mv)).toBe(true);

    // 撤回 seg0 的共同决定 → 该项重新待审并阻断冻结；来源分支原判断不变
    ws = withdrawMergedItem(ws, mv.id, doc.segments[0].id, unitOf(doc, 0));
    const mvAfter = ws.mergedVersions[0];
    const target = mvAfter.items.find((i) => i.segmentId === doc.segments[0].id)!;
    expect(target.pending).toBe(true);
    expect(target.resolved).toBe(false);
    expect(canFreeze(mvAfter)).toBe(false);
    const other = mvAfter.items.find((i) => i.segmentId === doc.segments[1].id)!;
    expect(other.resolved).toBe(true);
    expect(ws.branches[0].judgments).toHaveLength(1);
    expect(ws.branches[1].judgments).toHaveLength(2);
  });
});
