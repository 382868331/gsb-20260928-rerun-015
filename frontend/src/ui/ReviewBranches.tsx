import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { useReviewStore } from '../store/reviewStore';
import {
  MergeItem,
  ReviewBranch,
  branchApplicability,
  effectiveJudgment,
  judgmentApplicability,
  judgmentKey,
  publishBlockers,
} from '../core/reviewBranch';

const JUDGMENT_LABELS: Record<string, string> = {
  confirmed: '采用现有译文',
  revised: '修改后采用',
  deferred: '暂缓',
};

const CATEGORY_LABELS: Record<MergeItem['category'], string> = {
  common: '共同修改',
  'left-only': '仅左侧',
  'right-only': '仅右侧',
  conflict: '冲突',
  'both-pending': '双方未决定',
};

function applicabilityLabel(
  branch: ReviewBranch,
  segmentId: string,
  unitId: string,
  doc: ReturnType<typeof useDocStore.getState>['doc'],
): { text: string; className: string } {
  const judgment = branch.judgments.find(
    (j) => judgmentKey(j.segmentId, j.unitId) === judgmentKey(segmentId, unitId),
  );
  if (!judgment) return { text: '未知', className: 'bad' };
  const status = judgmentApplicability(judgment, doc);
  if (status === 'applicable') return { text: '判断仍适用', className: 'ok' };
  if (status === 'recheck') return { text: '原文已修订，必须复核', className: 'bad' };
  return { text: '段落已拆分/合并，旧判断不可套用', className: 'bad' };
}

function BranchEditor({ branch }: { branch: ReviewBranch }) {
  const doc = useDocStore((s) => s.doc);
  const editJudgmentText = useReviewStore((s) => s.editJudgmentText);
  const decide = useReviewStore((s) => s.decide);
  const [open, setOpen] = useState(false);
  const decided = branch.judgments.filter((j) => j.judgment != null).length;
  const report = useMemo(() => branchApplicability(branch, doc), [branch, doc]);

  return (
    <div className="branch-card">
      <div className="branch-head">
        <strong>{branch.reviewer}</strong>
        <span className="hint">
          创建于 {new Date(branch.createdAt).toLocaleString()} · 已决定 {decided}/
          {branch.judgments.length}
          {branch.savedAt ? ` · 保存于 ${new Date(branch.savedAt).toLocaleString()}` : ''}
        </span>
        {(report.recheck.length > 0 || report.gone.length > 0) && (
          <span className="bad">
            {`原文在审阅期间已修订：${report.recheck.length + report.gone.length} 项必须复核，${report.applicable.length} 项判断仍适用`}
          </span>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '继续审阅'}
        </button>
      </div>
      {open && (
        <div className="branch-body">
          {branch.judgments.map((judgment) => {
            const key = judgmentKey(judgment.segmentId, judgment.unitId);
            const applicability = applicabilityLabel(
              branch,
              judgment.segmentId,
              judgment.unitId,
              doc,
            );
            return (
              <div key={key} className="judgment-row">
                <div className="judgment-source">
                  <span className="hint">原文基线</span>
                  <p>{judgment.baselineSource}</p>
                  <span className={applicability.className}>{applicability.text}</span>
                </div>
                <textarea
                  rows={2}
                  value={judgment.text}
                  aria-label={`审阅译文 ${key}`}
                  onChange={(event) =>
                    editJudgmentText(branch.id, key, event.target.value)
                  }
                />
                <div className="judgment-actions">
                  {(['confirmed', 'revised', 'deferred'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={judgment.judgment === type ? 'primary' : ''}
                      onClick={() => decide(branch.id, key, type)}
                    >
                      {JUDGMENT_LABELS[type]}
                    </button>
                  ))}
                  <span className="hint">
                    {judgment.judgment
                      ? `已决定：${JUDGMENT_LABELS[judgment.judgment]}`
                      : '未决定'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MergeItemRow({ mergedId, item }: { mergedId: string; item: MergeItem }) {
  const resolve = useReviewStore((s) => s.resolve);
  const withdraw = useReviewStore((s) => s.withdraw);
  const effective = effectiveJudgment(item);
  return (
    <div className={`merge-item cat-${item.category}${item.withdrawn ? ' withdrawn' : ''}`}>
      <div className="merge-item-head">
        <span className={`trigger-badge cat-${item.category}`}>
          {CATEGORY_LABELS[item.category]}
        </span>
        {item.withdrawn && <span className="bad">已撤回，依赖项重新待审</span>}
        <span className="hint">{item.baselineSource}</span>
      </div>
      <div className="merge-sides">
        <div>
          <span className="hint">左侧</span>
          <p>{item.left?.text ?? '（无）'}</p>
          <span className="hint">
            {item.left?.judgment ? JUDGMENT_LABELS[item.left.judgment] : '未决定'}
          </span>
        </div>
        <div>
          <span className="hint">右侧</span>
          <p>{item.right?.text ?? '（无）'}</p>
          <span className="hint">
            {item.right?.judgment ? JUDGMENT_LABELS[item.right.judgment] : '未决定'}
          </span>
        </div>
      </div>
      <div className="merge-item-actions">
        {(item.category === 'conflict' || item.withdrawn) && (
          <>
            <button type="button" onClick={() => resolve(mergedId, item.key, 'left')}>
              采用左侧
            </button>
            <button type="button" onClick={() => resolve(mergedId, item.key, 'right')}>
              采用右侧
            </button>
          </>
        )}
        {item.category === 'conflict' && item.resolution && !item.withdrawn && (
          <span className="ok">已裁决：采用{item.resolution === 'left' ? '左' : '右'}侧</span>
        )}
        {effective && !item.withdrawn && (
          <span className="hint">生效译文：{effective.text}</span>
        )}
        {!item.withdrawn && item.category !== 'both-pending' && (
          <button type="button" onClick={() => withdraw(mergedId, item.key)}>
            撤回该决定
          </button>
        )}
      </div>
    </div>
  );
}

// 独立审阅分支 → 汇总 → 发布冻结 的完整入口。
// 两名审阅者从同一原文基线独立工作；合并结果另存为独立版本；
// 未裁决冲突不能进入发布包；冻结后内容不再被后续审阅改变。
export function ReviewBranches() {
  const doc = useDocStore((s) => s.doc);
  const branches = useReviewStore((s) => s.branches);
  const merged = useReviewStore((s) => s.merged);
  const freezes = useReviewStore((s) => s.freezes);
  const openBranch = useReviewStore((s) => s.openBranch);
  const save = useReviewStore((s) => s.save);
  const merge = useReviewStore((s) => s.merge);
  const freeze = useReviewStore((s) => s.freeze);
  const savedAt = useReviewStore((s) => s.savedAt);
  const [reviewer, setReviewer] = useState('');
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');

  return (
    <section className="review-branches" aria-label="审阅分支与发布">
      <h2>审阅分支 · 汇总 · 发布冻结</h2>
      <p className="hint">
        从当前原文版本创建独立审阅分支，两名审阅者互不可见地逐项判断；保存后可关闭重开继续。
        汇总区分共同修改、单侧修改与真正冲突；未裁决的冲突不能进入发布包。
        {savedAt ? `（已保存 ${savedAt}）` : ''}
      </p>

      <div className="branch-create">
        <input
          value={reviewer}
          placeholder="审阅者姓名"
          aria-label="审阅者姓名"
          onChange={(event) => setReviewer(event.target.value)}
        />
        <button
          type="button"
          className="primary"
          disabled={!reviewer.trim()}
          onClick={() => {
            openBranch(doc, reviewer);
            setReviewer('');
          }}
        >
          从当前原文创建审阅分支
        </button>
        <button type="button" onClick={() => save()}>
          保存全部审阅状态
        </button>
      </div>

      {branches.map((branch) => (
        <BranchEditor key={branch.id} branch={branch} />
      ))}

      <h3>汇总两份审阅</h3>
      <div className="merge-create">
        <select
          value={leftId}
          aria-label="左侧审阅分支"
          onChange={(event) => setLeftId(event.target.value)}
        >
          <option value="">选择左侧分支</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.reviewer}（{new Date(b.createdAt).toLocaleString()}）
            </option>
          ))}
        </select>
        <select
          value={rightId}
          aria-label="右侧审阅分支"
          onChange={(event) => setRightId(event.target.value)}
        >
          <option value="">选择右侧分支</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.reviewer}（{new Date(b.createdAt).toLocaleString()}）
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          disabled={!leftId || !rightId || leftId === rightId}
          onClick={() => merge(leftId, rightId)}
        >
          汇总为独立合并版本
        </button>
      </div>

      {merged.map((version) => {
        const blockers = publishBlockers(version);
        return (
          <div key={version.id} className="merged-card">
            <div className="branch-head">
              <strong>
                合并版本：{version.reviewers[0]} × {version.reviewers[1]}
              </strong>
              <span className="hint">
                {new Date(version.createdAt).toLocaleString()} · 作为独立版本保存，不覆盖原审阅
              </span>
              {blockers.length > 0 ? (
                <span className="bad">{`${blockers.length} 项未决，不能发布`}</span>
              ) : (
                <span className="ok">全部已决定，可发布冻结</span>
              )}
              <button
                type="button"
                className="primary"
                disabled={blockers.length > 0}
                onClick={() => freeze(doc, version.id)}
              >
                发布冻结
              </button>
            </div>
            {blockers.length > 0 && (
              <ul className="blocker-list">
                {blockers.map((blocker) => (
                  <li key={blocker.key} className="bad">
                    {blocker.reason}
                  </li>
                ))}
              </ul>
            )}
            {version.items.map((item) => (
              <MergeItemRow key={item.key} mergedId={version.id} item={item} />
            ))}
          </div>
        );
      })}

      <h3>已冻结发布（{freezes.length}）</h3>
      <p className="hint">冻结保留当时的原文、译文与决定依据；之后继续审阅不会改变已冻结内容。</p>
      {freezes.map((frozen) => (
        <div key={frozen.id} className="freeze-card">
          <div className="branch-head">
            <strong>冻结于 {new Date(frozen.frozenAt).toLocaleString()}</strong>
            <span className="hint">
              审阅者：{frozen.reviewers[0]} / {frozen.reviewers[1]} · {frozen.decisions.length} 项决定
            </span>
          </div>
          {frozen.decisions.map((decision) => (
            <div key={judgmentKey(decision.segmentId, decision.unitId)} className="freeze-row">
              <p className="source-after">{decision.source}</p>
              <p>{decision.translation}</p>
              <span className="hint">
                {JUDGMENT_LABELS[decision.judgment]} · 依据：{decision.basis}
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
