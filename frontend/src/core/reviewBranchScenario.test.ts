import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  editSegment,
  linkSegmentUnit,
  mergeSegments,
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
  reconcileMergedVersion,
  recordJudgment,
  resolveConflict,
  withdrawMergedItem,
  dependentItems,
  redecideMergedItem,
} from './reviewBranch';
import { buildExport, exportBilingual } from './exportDoc';

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
    ws2 = resolveConflict(ws2, doc, mv.id, conflict.segmentId, conflict.unitId, conflict.b!);
    const mv2 = ws2.mergedVersions.find((m) => m.id === mv.id)!;
    expect(canFreeze(mv2)).toBe(true);
    const frozen = freezeRelease(ws2, doc, mv.id, '2026-10-04T01:00:00Z');
    expect(frozen.freezeId).not.toBeNull();
    ws2 = frozen.ws;
    const freeze = ws2.freezes[0];
    // 冻结保留当时原文、译文与决定依据
    const frozenSegmentTexts = new Set(freeze.segments.map((s) => s.text));
    for (const text2 of [doc.segments[0].text, doc.segments[1].text, doc.segments[3].text]) {
      expect(frozenSegmentTexts.has(text2)).toBe(true);
    }
    expect(freeze.title).toBe('发布流程样稿');
    const d1 = freeze.decisions.find((d) => d.segmentId === doc.segments[1].id)!;
    expect(d1.text).toBe('Today we released a new version.');
    expect(d1.rationale).toBe('语序调整');
    expect(d1.sourceText).toBe('我们今天发布了新版本。');

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

    // 撤回 seg0 的共同决定 → 仅依赖项重新待审并阻断冻结；来源分支原判断不变
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

    // 重新决定后恢复可冻结，新决定重新冻结当时原文与依据
    ws = redecideMergedItem(ws, doc, mv.id, {
      segmentId: doc.segments[0].id,
      unitId: unitOf(doc, 0),
      action: 'accept',
      rationale: '撤回后复核接受',
      decidedAt: '2026-10-04T02:00:00Z',
    });
    expect(canFreeze(ws.mergedVersions[0])).toBe(true);
    expect(ws.mergedVersions[0].items[0].frozen.rationale).toBe('撤回后复核接受');
  });

  it('合并版本固定创建时原文/译文/依据，标题与正文修订单独提示复核', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept', undefined, '标题译法采用公告');
    ws = judge(ws, b.branchId, doc.segments[0].id, unitOf(doc, 0), 'edit', 'Product Release Notice', '乙认为应译作发布通知');
    ws = judge(ws, a.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept', undefined, '正文准确');
    ws = judge(ws, b.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept', undefined, '正文准确');

    const merged = mergeBranches(ws, doc, a.branchId, b.branchId);
    ws = merged.ws;
    let mv = ws.mergedVersions[0];
    const headingItem = mv.items.find((i) => i.segmentId === doc.segments[0].id)!;
    // 冲突裁定采用乙，冻结乙的译文与依据
    ws = resolveConflict(ws, doc, mv.id, headingItem.segmentId, headingItem.unitId, headingItem.b!);
    mv = ws.mergedVersions[0];
    const resolvedHeading = mv.items.find((i) => i.segmentId === doc.segments[0].id)!;
    expect(resolvedHeading.frozen.sourceText).toBe('产品更新公告');
    expect(resolvedHeading.frozen.resolvedText).toBe('Product Release Notice');
    expect(resolvedHeading.frozen.rationale).toBe('乙认为应译作发布通知');
    expect(mv.titleSnapshot).toBe('发布流程样稿');

    // 主文档标题改成“修订后标题”、标题段正文改写：冻结依据不变，变化单独标出需复核
    let changed = { ...doc, title: '修订后标题' };
    changed = editSegment(changed, doc.segments[0].id, '修订后标题正文').state;
    let drift = reconcileMergedVersion(changed, mv);
    expect(drift.titleChanged).toBe(true);
    expect(drift.titleSnapshot).toBe('发布流程样稿');
    expect(drift.currentTitle).toBe('修订后标题');
    const headingDrift = drift.entries.find((e) => e.segmentId === doc.segments[0].id)!;
    expect(headingDrift.status).toBe('recheck');
    expect(headingDrift.frozenSourceText).toBe('产品更新公告');
    expect(headingDrift.currentSourceText).toBe('修订后标题正文');
    expect(drift.recheckItems.map((i) => i.segmentId)).toContain(doc.segments[0].id);
    // 合并条目本身仍展示冻结原文，旧决定不会看起来像审过新原文
    expect(ws.mergedVersions[0].items.find((i) => i.segmentId === doc.segments[0].id)!.frozen.sourceText).toBe(
      '产品更新公告',
    );

    // 仅移动段落：身份不变，不产生复核项
    const moved = moveSegment(changed, doc.segments[1].id, 4).state;
    drift = reconcileMergedVersion(moved, mv);
    expect(drift.entries.find((e) => e.segmentId === doc.segments[1].id)!.status).toBe('applies');
    expect(drift.recheckItems.some((i) => i.segmentId === doc.segments[1].id)).toBe(false);

    // 译文事后被改动也要复核，但冻结译文保留
    const retranslated = updateTranslation(moved, unitOf(moved, moved.segments.findIndex((s) => s.id === doc.segments[1].id)), 'We have shipped a new version today.');
    drift = reconcileMergedVersion(retranslated, mv);
    const bodyDrift = drift.entries.find((e) => e.segmentId === doc.segments[1].id)!;
    expect(bodyDrift.unitChanged).toBe(true);
    expect(bodyDrift.frozenUnitText).toBe('We released a new version today.');
  });

  it('拆分/合并段落保留来源对应，旧合并条目标记 removed 并可追溯谱系', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept');
    ws = judge(ws, b.branchId, doc.segments[1].id, unitOf(doc, 1), 'accept');
    ws = mergeBranches(ws, doc, a.branchId, b.branchId).ws;
    const mv = ws.mergedVersions[0];

    const split = splitSegment(doc, doc.segments[1].id, ['我们今天发布了', '新版本。']).state;
    const newIds = split.segments
      .filter((s) => s.text === '我们今天发布了' || s.text === '新版本。')
      .map((s) => s.id);
    // 新链路携带来源谱系
    expect(split.links.filter((l) => newIds.includes(l.segmentId)).every((l) => l.originSegmentIds?.includes(doc.segments[1].id))).toBe(true);

    const drift = reconcileMergedVersion(split, mv);
    const entry = drift.entries.find((e) => e.segmentId === doc.segments[1].id)!;
    expect(entry.status).toBe('removed');
    expect(entry.viaOrigins).toContain(doc.segments[1].id);
    expect(drift.recheckItems.map((i) => i.segmentId)).toContain(doc.segments[1].id);

    // 再把两个新段合并：谱系仍追溯到原段
    const mergedDoc = mergeSegments(split, newIds, '').state;
    const drift2 = reconcileMergedVersion(mergedDoc, mv);
    expect(drift2.entries.find((e) => e.segmentId === doc.segments[1].id)!.viaOrigins).toContain(
      doc.segments[1].id,
    );
  });

  it('多段共用译文单元时撤回一项，只重开依赖连通分量', () => {
    let doc = buildDoc();
    // seg1 与 seg3 原文相同，让两者共用同一个译文单元（同文不同语境也不串身份）
    const sharedUnit = unitOf(doc, 1);
    doc = linkSegmentUnit(doc, doc.segments[3].id, sharedUnit);

    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[1].id, sharedUnit, 'accept');
    ws = judge(ws, b.branchId, doc.segments[1].id, sharedUnit, 'accept');
    ws = judge(ws, a.branchId, doc.segments[3].id, sharedUnit, 'reject', undefined, '语境不同');
    ws = judge(ws, b.branchId, doc.segments[3].id, sharedUnit, 'reject', undefined, '语境不同');
    ws = judge(ws, a.branchId, doc.segments[2].id, unitOf(doc, 2), 'accept');
    ws = judge(ws, b.branchId, doc.segments[2].id, unitOf(doc, 2), 'accept');
    ws = mergeBranches(ws, doc, a.branchId, b.branchId).ws;
    const mv = ws.mergedVersions[0];

    const deps = dependentItems(mv.items, doc.segments[1].id, sharedUnit).map((i) => i.segmentId);
    expect(deps).toContain(doc.segments[1].id);
    expect(deps).toContain(doc.segments[3].id);
    expect(deps).not.toContain(doc.segments[2].id);

    ws = withdrawMergedItem(ws, mv.id, doc.segments[1].id, sharedUnit);
    const after = ws.mergedVersions[0];
    expect(after.items.find((i) => i.segmentId === doc.segments[1].id)!.pending).toBe(true);
    expect(after.items.find((i) => i.segmentId === doc.segments[3].id)!.pending).toBe(true);
    expect(after.items.find((i) => i.segmentId === doc.segments[2].id)!.pending).toBe(false);
    expect(after.items.find((i) => i.segmentId === doc.segments[2].id)!.resolved).toBe(true);
  });

  it('保存重开与导出仍区分原合并依据、当前修订与冻结内容', () => {
    const doc = buildDoc();
    let ws = emptyReviewWorkspace();
    const a = createBranch(ws, doc, '甲');
    ws = a.ws;
    const b = createBranch(ws, doc, '乙');
    ws = b.ws;
    ws = judge(ws, a.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept', undefined, '旧标题依据');
    ws = judge(ws, b.branchId, doc.segments[0].id, unitOf(doc, 0), 'accept', undefined, '旧标题依据');
    ws = mergeBranches(ws, doc, a.branchId, b.branchId).ws;
    const mv = ws.mergedVersions[0];
    ws = freezeRelease(ws, doc, mv.id, '2026-10-04T03:00:00Z').ws;

    // 冻结后修订原文与标题
    let changed = editSegment(doc, doc.segments[0].id, '修订后标题').state;
    changed = { ...changed, title: '修订后标题' };

    // 保存 → 重开（序列化往返）：冻结与合并依据完整保留
    const reopenedWs = JSON.parse(JSON.stringify(ws)) as typeof ws;
    expect(reopenedWs.freezes[0].title).toBe('发布流程样稿');
    expect(reopenedWs.freezes[0].decisions[0].sourceText).toBe('产品更新公告');
    expect(reopenedWs.mergedVersions[0].items[0].frozen.sourceText).toBe('产品更新公告');

    const payload = buildExport(changed, reopenedWs);
    const exportedMerged = payload.mergedVersions![0];
    expect(exportedMerged.titleSnapshot).toBe('发布流程样稿');
    expect(exportedMerged.currentTitle).toBe('修订后标题');
    const exportedItem = exportedMerged.items[0];
    expect(exportedItem.frozenSourceText).toBe('产品更新公告');
    expect(exportedItem.currentSourceText).toBe('修订后标题');
    expect(exportedItem.needsRecheck).toBe(true);
    const exportedFreeze = payload.freezes![0];
    expect(exportedFreeze.title).toBe('发布流程样稿');
    expect(exportedFreeze.decisions[0].sourceText).toBe('产品更新公告');

    const bilingual = exportBilingual(changed, reopenedWs);
    expect(bilingual).toContain('裁决标题：发布流程样稿');
    expect(bilingual).toContain('冻结原文：产品更新公告');
    expect(bilingual).toContain('当前原文（修订）：修订后标题');
  });
});
