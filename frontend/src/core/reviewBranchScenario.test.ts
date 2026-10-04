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
  reconcileMergedItem,
  recordJudgment,
  resolveConflict,
  withdrawMergedItem,
} from './reviewBranch';
import { buildReviewExport } from './exportDoc';

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
    const merged = mergeBranches(ws2, doc, branchA, branchB);
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
    const merged = mergeBranches(ws, doc, a.branchId, b.branchId);
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

  it('合并条目固定创建时原文/译文/依据，主文档修订单独标注需复核', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    // 两名审阅者对标题段作出不同译文判断
    ws = judge(ws, a.branchId, doc.segments[0].id, unitOf(doc, 0), 'edit', 'Product Update', '简洁');
    ws = judge(ws, b.branchId, doc.segments[0].id, unitOf(doc, 0), 'edit', 'Product News', '口语化');
    ws = judge(ws, b.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept', undefined, '准确');
    const merged = mergeBranches(ws, doc, a.branchId, b.branchId);
    ws = merged.ws;
    const mv = ws.mergedVersions[0];
    const conflict = mv.items.find((i) => i.kind === 'conflict')!;
    // 汇总采用甲的一侧
    ws = resolveConflict(ws, mv.id, conflict.segmentId, conflict.unitId, conflict.a!);

    // 主文档标题改为“修订后标题”
    const revised = { ...editSegment(doc, doc.segments[0].id, '修订后标题').state, title: '修订后标题' };
    const mvAfter = ws.mergedVersions[0];
    const item = mvAfter.items.find((i) => i.segmentId === doc.segments[0].id)!;
    // 合并条目仍展示创建时的原文与译文，决定依据不变
    expect(item.sourceText).toBe('产品更新公告');
    expect(item.unitText).toBe('Product Update Announcement');
    expect(item.resolution?.revisedText).toBe('Product Update');
    expect(item.resolution?.rationale).toBe('简洁');
    // 当前原文变化单独标注为需复核
    const entry = reconcileMergedItem(revised, item);
    expect(entry.status).toBe('recheck');
    expect(entry.currentText).toBe('修订后标题');
    // 未改动的段落仍适用
    const other = mvAfter.items.find((i) => i.segmentId === doc.segments[1].id)!;
    expect(reconcileMergedItem(revised, other).status).toBe('applies');

    // 保存重开后快照仍在
    const reopened = JSON.parse(JSON.stringify(ws)) as ReviewWorkspaceState;
    expect(reopened.mergedVersions[0].items.find((i) => i.segmentId === doc.segments[0].id)!.sourceText).toBe(
      '产品更新公告',
    );

    // 导出后仍能区分原合并依据、当前修订
    const payload = buildReviewExport(revised, reopened);
    const exported = payload.mergedVersions[0].items.find((i) => i.segmentId === doc.segments[0].id)!;
    expect(exported.sourceAtMerge).toBe('产品更新公告');
    expect(exported.currentSource).toBe('修订后标题');
    expect(exported.reconcileStatus).toBe('recheck');
    expect(payload.currentTitle).toBe('修订后标题');
  });

  it('撤回一项决定只重开其同段依赖项，冻结内容保持独立', () => {
    let doc = buildDoc();
    // 同段第二个译文单元：依赖同一原文语境
    const extra = createUnitForSegment(doc, doc.segments[0].id, 'en');
    doc = updateTranslation(extra.state, extra.unitId, 'Alt title.');
    const extraUnitId = extra.unitId;

    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept');
    ws = judge(ws, a.branchId, doc.segments[0].id, extraUnitId, 'reject', undefined, '备用译法不用');
    ws = judge(ws, b.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept');
    ws = judge(ws, b.branchId, doc.segments[0].id, extraUnitId, 'reject', undefined, '备用译法不用');
    ws = judge(ws, b.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept');
    const merged = mergeBranches(ws, doc, a.branchId, b.branchId);
    ws = merged.ws;
    const mv = ws.mergedVersions[0];
    expect(canFreeze(mv)).toBe(true);

    // 撤回 seg0 的一个决定 → 同段依赖项一并重开，其他段不受影响
    ws = withdrawMergedItem(ws, mv.id, doc.segments[0].id, unitOf(doc, 0));
    const mvAfter = ws.mergedVersions[0];
    const seg0Items = mvAfter.items.filter((i) => i.segmentId === doc.segments[0].id);
    expect(seg0Items).toHaveLength(2);
    expect(seg0Items.every((i) => i.pending && !i.resolved)).toBe(true);
    const seg1 = mvAfter.items.find((i) => i.segmentId === doc.segments[1].id)!;
    expect(seg1.resolved).toBe(true);
    expect(seg1.pending).toBe(false);
    expect(canFreeze(mvAfter)).toBe(false);

    // 冻结后导出：冻结内容与当前修订、合并依据各自独立
    const frozen = freezeRelease(ws, doc, mv.id);
    expect(frozen.freezeId).toBeNull(); // 待审项阻断冻结
    // 重新决定后冻结成功
    let ws2 = ws;
    for (const item of seg0Items) {
      ws2 = resolveConflict(ws2, mv.id, item.segmentId, item.unitId, item.resolution!);
    }
    const done = freezeRelease(ws2, doc, mv.id, '2026-10-04T02:00:00Z');
    expect(done.freezeId).not.toBeNull();
    ws2 = done.ws;
    const revised = { ...doc, title: '修订后标题' };
    const payload = buildReviewExport(revised, ws2);
    expect(payload.freezes).toHaveLength(1);
    expect(payload.freezes[0].title).toBe('发布流程样稿');
    expect(payload.currentTitle).toBe('修订后标题');
    expect(payload.mergedVersions[0].items[0].sourceAtMerge).toBe('产品更新公告');
  });
});
