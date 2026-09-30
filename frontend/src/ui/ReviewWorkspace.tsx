import { useMemo } from 'react';
import { useDocStore } from '../store/docStore';
import { buildReviewWorkspace } from '../core/reviewWorkspace';

/**
 * 一次原文修改影响多种语言时的核对工作区：
 * 逐段展示前后原文与各语言现有译文，可分别确认 / 重译 / 暂缓。
 */
export function ReviewWorkspace() {
  const doc = useDocStore((s) => s.doc);
  const confirmTranslation = useDocStore((s) => s.confirmTranslation);
  const confirmSegment = useDocStore((s) => s.confirmSegment);
  const retranslate = useDocStore((s) => s.retranslate);
  const defer = useDocStore((s) => s.defer);
  const setTranslation = useDocStore((s) => s.setTranslation);

  const entries = useMemo(() => buildReviewWorkspace(doc), [doc]);

  if (entries.length === 0) {
    return (
      <section className="review-workspace" aria-label="译文核对工作区">
        <h2>核对工作区</h2>
        <p className="hint">没有待核对译文：所有现有译文均已按当前原文逐段确认。</p>
      </section>
    );
  }

  return (
    <section className="review-workspace" aria-label="译文核对工作区">
      <h2>核对工作区（{entries.length} 段待处理）</h2>
      <p className="hint">
        原文任意内容变化（如“允许”改为“禁止”）都会令旧译文进入待核对，需逐语言确认后才可重新采用；暂缓项不会进入导出正文。
      </p>
      {entries.map((entry) => (
        <article key={entry.segmentId} className="review-entry">
          <div className="review-source">
            <div>
              <span className="hint">旧原文</span>
              <p className="source-before">{entry.sourceBefore ?? '（无更早版本）'}</p>
            </div>
            <div>
              <span className="hint">当前原文</span>
              <p className="source-after">{entry.sourceAfter}</p>
            </div>
          </div>
          <div className="review-actions-row">
            <button type="button" onClick={() => confirmSegment(entry.segmentId)}>
              整段各语言全部确认
            </button>
          </div>
          {entry.units.map((view) => (
            <div key={view.unit.id} className={`review-unit ${view.unit.status}`}>
              <div className="unit-meta">
                <code>{view.unit.id.slice(0, 10)}</code>
                <span className={`badge ${view.unit.status}`}>
                  {view.confirmed ? '本语言已确认' : view.unit.status === 'review' ? '待核对' : '已译'}
                </span>
                {view.unit.reason && <span className="reason">{view.unit.reason}</span>}
              </div>
              <textarea
                className="translation-text"
                value={view.unit.text}
                rows={2}
                aria-label="待核对译文"
                onChange={(event) => setTranslation(view.unit.id, event.target.value)}
              />
              <div className="review-unit-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => confirmTranslation(entry.segmentId, view.unit.id)}
                >
                  确认采用
                </button>
                <button type="button" onClick={() => retranslate(entry.segmentId, view.unit.id)}>
                  重译
                </button>
                <button type="button" onClick={() => defer(entry.segmentId, view.unit.id)}>
                  暂缓
                </button>
              </div>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
