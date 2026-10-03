import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { unitIdsForSegment } from '../core/docOps';
import {
  MergeItem,
  ReviewBranch,
  ReviewJudgment,
  canFreeze,
  reconcileBranch,
} from '../core/reviewBranch';

const ACTION_LABELS = { accept: '接受', edit: '修改', reject: '驳回' } as const;
const KIND_LABELS = { common: '共同修改', onlyA: '仅甲', onlyB: '仅乙', conflict: '冲突' } as const;
const RECONCILE_LABELS = {
  applies: '仍适用',
  recheck: '必须复核',
  removed: '已拆并（原段不存在）',
  new: '新增段落',
} as const;

function JudgmentEditor({ branch }: { branch: ReviewBranch }) {
  const store = useDocStore();
  const { doc } = store;
  const reconcile = useMemo(() => reconcileBranch(doc, branch), [doc, branch]);
  const statusOf = (segmentId: string) =>
    reconcile.find((e) => e.segmentId === segmentId)?.status;
  const [drafts, setDrafts] = useState<Record<string, { action: ReviewJudgment['action']; revisedText: string; rationale: string }>>({});

  const judgmentFor = (segmentId: string, unitId: string) =>
    branch.judgments.find((j) => j.segmentId === segmentId && j.unitId === unitId);

  const commit = (segmentId: string, unitId: string) => {
    const draft = drafts[segmentId + unitId];
    if (!draft) return;
    store.judge(branch.id, {
      segmentId,
      unitId,
      action: draft.action,
      revisedText: draft.action === 'edit' ? draft.revisedText : undefined,
      rationale: draft.rationale || undefined,
      decidedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="branch-editor">
      <p className="hint">
        基线取自 {new Date(branch.baselineTakenAt).toLocaleString()}，按段落身份核对，移动段落不影响结论。
      </p>
      {doc.segments.map((segment) => {
        const unitIds = unitIdsForSegment(doc, segment.id);
        if (unitIds.length === 0) return null;
        const status = statusOf(segment.id);
        return (
          <div key={segment.id} className="branch-segment">
            <div className="branch-segment-head">
              <span className="source-text">{segment.text}</span>
              {status && <span className={`badge rec-${status}`}>{RECONCILE_LABELS[status]}</span>}
            </div>
            {status === 'recheck' && (
              <p className="hint">基线原文：{branch.baseline[segment.id]}</p>
            )}
            {unitIds.map((unitId) => {
              const unit = doc.units.find((u) => u.id === unitId);
              if (!unit) return null;
              const existing = judgmentFor(segment.id, unitId);
              const key = segment.id + unitId;
              const draft = drafts[key] ?? {
                action: existing?.action ?? 'accept',
                revisedText: existing?.revisedText ?? unit.text,
                rationale: existing?.rationale ?? '',
              };
              return (
                <div key={unitId} className="judgment-row">
                  <div className="unit-text">{unit.text || '（空译文）'}</div>
                  {existing && (
                    <span className="badge decided">
                      已决定：{ACTION_LABELS[existing.action]}
                      {existing.action === 'edit' ? ` → ${existing.revisedText}` : ''}
                    </span>
                  )}
                  <div className="judgment-controls">
                    {(['accept', 'edit', 'reject'] as const).map((action) => (
                      <label key={action}>
                        <input
                          type="radio"
                          name={key}
                          checked={draft.action === action}
                          disabled={branch.status !== 'open'}
                          onChange={() => setDrafts((d) => ({ ...d, [key]: { ...draft, action } }))}
                        />
                        {ACTION_LABELS[action]}
                      </label>
                    ))}
                    {draft.action === 'edit' && (
                      <input
                        value={draft.revisedText}
                        disabled={branch.status !== 'open'}
                        placeholder="改动后译文"
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [key]: { ...draft, revisedText: e.target.value } }))
                        }
                      />
                    )}
                    <input
                      value={draft.rationale}
                      disabled={branch.status !== 'open'}
                      placeholder="决定依据（可选）"
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [key]: { ...draft, rationale: e.target.value } }))
                      }
                    />
                    <button type="button" disabled={branch.status !== 'open'} onClick={() => commit(segment.id, unitId)}>
                      记录判断
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function MergeItemRow({ item, mergedId }: { item: MergeItem; mergedId: string }) {
  const store = useDocStore();
  const { doc } = store;
  const unit = doc.units.find((u) => u.id === item.unitId);
  const segment = doc.segments.find((s) => s.id === item.segmentId);
  const describe = (j?: ReviewJudgment) =>
    j ? `${ACTION_LABELS[j.action]}${j.action === 'edit' ? ` → ${j.revisedText}` : ''}${j.rationale ? `（${j.rationale}）` : ''}` : '—';
  return (
    <div className={`merge-item ${item.kind} ${item.pending ? 'pending' : ''}`}>
      <div className="merge-item-head">
        <span className={`badge kind-${item.kind}`}>{KIND_LABELS[item.kind]}</span>
        <span className="source-text">{segment?.text ?? item.segmentId}</span>
        <span className="unit-text">{unit?.text ?? ''}</span>
        {item.pending && <span className="badge review">待审（已撤回）</span>}
        {!item.pending && item.resolved && <span className="badge translated">已决定</span>}
        {!item.pending && !item.resolved && <span className="badge review">未决定</span>}
      </div>
      {item.kind === 'conflict' && !item.resolved && (
        <div className="conflict-picker">
          <span>甲：{describe(item.a)}</span>
          <span>乙：{describe(item.b)}</span>
          <button
            type="button"
            onClick={() =>
              item.a && store.resolveMergeConflict(mergedId, item.segmentId, item.unitId, item.a)
            }
          >
            采用甲
          </button>
          <button
            type="button"
            onClick={() =>
              item.b && store.resolveMergeConflict(mergedId, item.segmentId, item.unitId, item.b)
            }
          >
            采用乙
          </button>
        </div>
      )}
      {item.resolved && item.resolution && (
        <div className="merge-resolution">
          采用：{describe(item.resolution)}
          <button
            type="button"
            onClick={() => store.withdrawMerged(mergedId, item.segmentId, item.unitId)}
          >
            撤回该项决定
          </button>
        </div>
      )}
      {item.pending && (
        <div className="judgment-controls">
          {(['accept', 'edit', 'reject'] as const).map((action) => (
            <button
              key={action}
              type="button"
              onClick={() =>
                store.redecideMerged(mergedId, {
                  segmentId: item.segmentId,
                  unitId: item.unitId,
                  action,
                  revisedText: action === 'edit' ? item.resolution?.revisedText ?? unit?.text : undefined,
                  rationale: '撤回后重新决定',
                  decidedAt: new Date().toISOString(),
                })
              }
            >
              重新决定：{ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewBoard() {
  const store = useDocStore();
  const { review, doc } = store;
  const [reviewer, setReviewer] = useState('');
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [pickA, setPickA] = useState('');
  const [pickB, setPickB] = useState('');
  const [freezeError, setFreezeError] = useState('');

  const activeBranch = review.branches.find((b) => b.id === activeBranchId) ?? null;

  return (
    <section className="review-board" aria-label="审阅分支与发布">
      <h2>独立审阅分支</h2>
      <div className="branch-create">
        <input
          value={reviewer}
          placeholder="审阅者姓名"
          onChange={(e) => setReviewer(e.target.value)}
        />
        <button
          type="button"
          disabled={!reviewer.trim()}
          onClick={() => {
            const id = store.createReviewBranch(reviewer.trim());
            if (id) setActiveBranchId(id);
          }}
        >
          从当前原文建立审阅分支
        </button>
      </div>
      <div className="branch-list">
        {review.branches.map((branch) => (
          <div key={branch.id} className="branch-card">
            <strong>{branch.reviewer}</strong>
            <span className={`badge ${branch.status === 'open' ? 'review' : 'translated'}`}>
              {branch.status === 'open' ? '进行中' : '已提交'}
            </span>
            <span className="hint">
              已判断 {branch.judgments.length} 项 · 基线 {new Date(branch.baselineTakenAt).toLocaleString()}
            </span>
            <button type="button" onClick={() => setActiveBranchId(branch.id)}>
              {activeBranchId === branch.id ? '收起' : '继续审阅'}
            </button>
            {branch.status === 'open' ? (
              <button type="button" onClick={() => store.closeBranch(branch.id)}>提交审阅</button>
            ) : (
              <button type="button" onClick={() => store.reopenBranch(branch.id)}>重开审阅</button>
            )}
          </div>
        ))}
      </div>
      {activeBranch && <JudgmentEditor branch={activeBranch} />}

      <h2>汇总两个分支</h2>
      <div className="merge-controls-row">
        <select value={pickA} onChange={(e) => setPickA(e.target.value)} aria-label="分支甲">
          <option value="">选择分支甲</option>
          {review.branches.map((b) => (
            <option key={b.id} value={b.id}>{b.reviewer}</option>
          ))}
        </select>
        <select value={pickB} onChange={(e) => setPickB(e.target.value)} aria-label="分支乙">
          <option value="">选择分支乙</option>
          {review.branches.map((b) => (
            <option key={b.id} value={b.id}>{b.reviewer}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!pickA || !pickB || pickA === pickB}
          onClick={() => store.mergeReviewBranches(pickA, pickB)}
        >
          生成合并版本
        </button>
      </div>
      {review.mergedVersions.map((merged) => {
        const branchA = review.branches.find((b) => b.id === merged.branchIds[0]);
        const branchB = review.branches.find((b) => b.id === merged.branchIds[1]);
        const frozen = review.freezes.some((f) => f.mergedVersionId === merged.id);
        return (
          <div key={merged.id} className="merged-version">
            <h3>
              合并版本 {merged.id.slice(0, 10)}（{branchA?.reviewer} × {branchB?.reviewer}）
              {frozen && <span className="badge translated">已冻结</span>}
            </h3>
            <p className="hint">
              共同 {merged.items.filter((i) => i.kind === 'common').length} · 仅甲{' '}
              {merged.items.filter((i) => i.kind === 'onlyA').length} · 仅乙{' '}
              {merged.items.filter((i) => i.kind === 'onlyB').length} · 冲突{' '}
              {merged.items.filter((i) => i.kind === 'conflict').length} · 未决定{' '}
              {merged.items.filter((i) => !i.resolved || i.pending).length}
            </p>
            {merged.items.map((item) => (
              <MergeItemRow key={item.segmentId + item.unitId} item={item} mergedId={merged.id} />
            ))}
            <button
              type="button"
              className="primary"
              disabled={!canFreeze(merged) || frozen}
              onClick={() => {
                const id = store.freeze(merged.id);
                setFreezeError(id ? '' : '存在未决定的冲突或待审项，不能进入发布包');
              }}
            >
              发布冻结
            </button>
            {!canFreeze(merged) && !frozen && (
              <span className="hint">存在未决定的冲突或待审项，不能进入发布包。</span>
            )}
            {freezeError && <span className="bad">{freezeError}</span>}
          </div>
        );
      })}

      <h2>发布冻结快照</h2>
      {review.freezes.length === 0 && <p className="hint">尚无冻结版本。</p>}
      {review.freezes.map((freeze) => (
        <details key={freeze.id} className="freeze-card">
          <summary>
            冻结 {freeze.id.slice(0, 10)} · {new Date(freeze.frozenAt).toLocaleString()} ·{' '}
            {freeze.decisions.length} 项决定
          </summary>
          <p className="hint">冻结内容不可变；之后的审阅与合并不会影响此快照。</p>
          {freeze.segments.map((segment) => {
            const decisions = freeze.decisions.filter((d) => d.segmentId === segment.id);
            return (
              <div key={segment.id} className="freeze-segment">
                <div className="source-text">{segment.text}</div>
                {decisions.map((d) => (
                  <div key={d.unitId} className="freeze-decision">
                    {ACTION_LABELS[d.action]} → {d.text}
                    {d.rationale ? `（依据：${d.rationale}）` : ''}
                  </div>
                ))}
              </div>
            );
          })}
        </details>
      ))}
    </section>
  );
}
