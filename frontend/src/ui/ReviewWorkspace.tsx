import { useMemo } from 'react';
import { useDocStore } from '../store/docStore';
import { buildReviewWorkspace } from '../core/reviewWorkspace';

function statusBadge(status: string): string {
  if (status === 'review') return '待核对';
  if (status === 'retranslate') return '需重译';
  if (status === 'deferred') return '暂缓';
  return status;
}

/**
 * 原文修改核对工作区：逐段展示修改前后内容与各语言现有译文，
 * 每种语言可分别“确认采用 / 重译 / 暂缓”。
 */
export function ReviewWorkspace() {
  const doc = useDocStore((s) => s.doc);
  const confirmReview = useDocStore((s) => s.confirmReview);
  const decide = useDocStore((s) => s.decideReview);
  const setTranslation = useDocStore((s) => s.setTranslation);
  const entries = useMemo(() => buildReviewWorkspace(doc), [doc]);

  if (entries.length === 0) {
    return (
      <section className="review-workspace" aria-label="原文修改核对工作区">
        <h2>原文修改核对工作区</h2>
        <p className="hint">没有待核对译文。原文任何实际内容变化后，相关语言译文会集中到这里确认。</p>
      </section>
    );
  }

  return (
    <section className="review-workspace" aria-label="原文修改核对工作区">
      <h2>原文修改核对工作区（{entries.length} 段待处理）</h2>
      <p className="hint">逐段核对：旧译文未经确认不会进入导出成品；可按语言分别确认、重译或暂缓。</p>
      {entries.map((entry) => (
        <article key={entry.segmentId} className="review-entry">
          <div className="review-diff">
            <div className="diff-col">
              <span className="diff-tag before">修改前</span>
              <p>{entry.beforeText || '（无更早快照，可能来自拆合操作）'}</p>
            </div>
            <div className="diff-arrow">→</div>
            <div className="diff-col">
              <span className="diff-tag after">修改后</span>
              <p>{entry.afterText}</p>
            </div>
          </div>
          <div className="review-items">
            {entry.items.map((item) => (
              <div key={item.unitId} className={`review-item ${item.status}`}>
                <div className="review-item-head">
                  <span className="lang-tag">{item.langLabel}（{item.lang}）</span>
                  <span className={`badge ${item.status}`}>{statusBadge(item.status)}</span>
                  {item.reason && <span className="reason">{item.reason}</span>}
                </div>
                <textarea
                  className="translation-text"
                  value={item.currentText}
                  onChange={(event) => setTranslation(item.unitId, event.target.value)}
                  rows={2}
                  aria-label={`${item.langLabel}现有译文`}
                />
                <div className="review-actions">
                  <button type="button" onClick={() => confirmReview(item.unitId)}>
                    确认采用
                  </button>
                  <button type="button" onClick={() => decide(item.unitId, 'retranslate')}>
                    重译
                  </button>
                  <button type="button" onClick={() => decide(item.unitId, 'defer')}>
                    暂缓
                  </button>
                </div>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
