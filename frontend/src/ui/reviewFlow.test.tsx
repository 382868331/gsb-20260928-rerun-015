import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from './App';
import { useDocStore } from '../store/docStore';
import { useReviewStore } from '../store/reviewStore';

function setupDocWithTranslations() {
  useDocStore.getState().resetToSample();
  const store = useDocStore.getState();
  for (const segment of [...store.doc.segments]) {
    const unitId = useDocStore.getState().createUnit(segment.id);
    if (unitId) useDocStore.getState().setTranslation(unitId, `EN:${segment.text}`);
  }
  useDocStore.getState().save();
}

function createBranchViaUi(reviewer: string) {
  fireEvent.change(screen.getByLabelText('审阅者姓名'), { target: { value: reviewer } });
  fireEvent.click(screen.getByText('从当前原文创建审阅分支'));
}

function decideAllInBranch(reviewer: string, label: string) {
  const card = screen.getByText(reviewer).closest('.branch-card') as HTMLElement;
  fireEvent.click(within(card).getByText('继续审阅'));
  for (const button of within(card).getAllByText(label)) {
    fireEvent.click(button);
  }
}

describe('页面级审阅流程：双分支 → 汇总 → 复核 → 冻结', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useReviewStore.getState().resetAll();
    setupDocWithTranslations();
  });

  it('从实际页面完成两份审阅、分歧选择、冻结，并重开核对', () => {
    render(<App />);

    // 两名审阅者从同一原文版本各自建分支。
    createBranchViaUi('Alice');
    createBranchViaUi('Bob');
    expect(useReviewStore.getState().branches).toHaveLength(2);

    // Alice 全部“采用现有译文”；Bob 前四项采用、最后一项修改后采用（制造分歧）。
    decideAllInBranch('Alice', '采用现有译文');
    const bobCard = screen.getByText('Bob').closest('.branch-card') as HTMLElement;
    fireEvent.click(within(bobCard).getByText('继续审阅'));
    const bobRows = bobCard.querySelectorAll('.judgment-row');
    expect(bobRows.length).toBeGreaterThan(0);
    bobRows.forEach((row, index) => {
      const textarea = row.querySelector('textarea')!;
      if (index === 0) {
        fireEvent.change(textarea, { target: { value: 'Bob revised translation' } });
        fireEvent.click(within(row as HTMLElement).getByText('修改后采用'));
      } else {
        fireEvent.click(within(row as HTMLElement).getByText('采用现有译文'));
      }
    });

    // 保存半完成状态并重开：来源独立、已决定项仍在。
    fireEvent.click(screen.getByText('保存全部审阅状态'));
    const persisted = JSON.parse(localStorage.getItem('mlcp.review.v1')!);
    expect(persisted.branches).toHaveLength(2);
    const [savedAlice, savedBob] = persisted.branches;
    expect(savedAlice.reviewer).toBe('Alice');
    expect(savedBob.reviewer).toBe('Bob');
    expect(savedAlice.judgments.every((j: any) => j.judgment === 'confirmed')).toBe(true);
    expect(savedBob.judgments.filter((j: any) => j.judgment === 'revised')).toHaveLength(1);
    expect(savedAlice.judgments[0].text).not.toBe('Bob revised translation');

    // 汇总：第一项为真正冲突，其余共同修改。
    fireEvent.change(screen.getByLabelText('左侧审阅分支'), {
      target: { value: savedAlice.id },
    });
    fireEvent.change(screen.getByLabelText('右侧审阅分支'), {
      target: { value: savedBob.id },
    });
    fireEvent.click(screen.getByText('汇总为独立合并版本'));
    const merged = useReviewStore.getState().merged[0];
    const conflicts = merged.items.filter((i) => i.category === 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(merged.items.filter((i) => i.category === 'common')).toHaveLength(
      merged.items.length - 1,
    );

    // 未裁决冲突不能发布。
    const freezeButton = screen.getByText('发布冻结') as HTMLButtonElement;
    expect(freezeButton.disabled).toBe(true);
    expect(screen.getByText(/项未决，不能发布/)).toBeTruthy();

    // 裁决分歧后发布冻结。
    fireEvent.click(screen.getByText('采用右侧'));
    expect((screen.getByText('发布冻结') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('发布冻结'));
    expect(screen.getByText('已冻结发布（1）')).toBeTruthy();
    const frozen = useReviewStore.getState().freezes[0];
    expect(frozen.decisions).toHaveLength(merged.items.length);
    expect(frozen.decisions[0].translation).toBe('Bob revised translation');
    expect(frozen.decisions[0].basis).toContain('Bob');

    // 冻结后继续审阅不改变已冻结内容。
    const aliceId = savedAlice.id;
    const firstKey = `${frozen.decisions[0].segmentId}::${frozen.decisions[0].unitId}`;
    act(() => {
      useReviewStore.getState().editJudgmentText(aliceId, firstKey, 'changed after freeze');
    });
    expect(useReviewStore.getState().freezes[0].decisions[0].translation).toBe(
      'Bob revised translation',
    );

    // 撤回某项合并决定 → 依赖项重新待审，原审阅分支不被覆盖。
    act(() => {
      useReviewStore.getState().withdraw(merged.id, firstKey);
    });
    expect(screen.getByText(/项未决，不能发布/)).toBeTruthy();
    const aliceBranch = useReviewStore.getState().branches.find((b) => b.id === aliceId)!;
    expect(aliceBranch.judgments.every((j) => j.judgment === 'confirmed')).toBe(true);
  });

  it('原文在审阅期间修订：页面逐项标注仍适用/必须复核', () => {
    render(<App />);
    createBranchViaUi('Alice');
    decideAllInBranch('Alice', '采用现有译文');

    // 修订第一段原文（其余不动）。
    const firstSegment = useDocStore.getState().doc.segments[0];
    act(() => {
      useDocStore.getState().editSegment(firstSegment.id, '产品更新公告（第二版）');
    });

    const aliceCard = screen.getByText('Alice').closest('.branch-card') as HTMLElement;
    expect(within(aliceCard).getByText(/1 项必须复核/)).toBeTruthy();
    expect(within(aliceCard).getByText(/4 项判断仍适用/)).toBeTruthy();
    expect(within(aliceCard).getAllByText('原文已修订，必须复核')).toHaveLength(1);
    expect(within(aliceCard).getAllByText('判断仍适用').length).toBeGreaterThan(0);
  });
});
