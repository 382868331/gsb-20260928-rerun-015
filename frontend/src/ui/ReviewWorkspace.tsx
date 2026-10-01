import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { buildReviewWorkspace } from '../core/reviewWorkspace';

function triggerLabel(trigger: 'source' | 'term' | 'mixed'): string {
  if (trigger === 'term') return '仅术语变化';
  if (trigger === 'mixed') return '原文与术语均变化';
  return '原文已改写';
}

// 同一轮审阅中原文修改与术语变化都可能发生：
// 逐段展示前后原文、各语言译文与待处置术语，逐语言决定保留、按新术语修改或暂缓。
export function ReviewWorkspace() {
  const doc = useDocStore((s) => s.doc);
  const confirmTranslation = useDocStore((s) => s.confirmTranslation);
  const confirmSegment = useDocStore((s) => s.confirmSegment);
  const retranslate = useDocStore((s) => s.retranslate);
  const defer = useDocStore((s) => s.defer);
  const setTranslation = useDocStore((s) => s.setTranslation);
  const decideTerm = useDocStore((s) => s.decideTerm);
  const [rationaleDrafts, setRationaleDrafts] = useState<Record<string, string>>({});

  const entries = useMemo(() => buildReviewWorkspace(doc), [doc]);
  const draftKey = (segmentId: string, unitId: string, decisionId: string) =>
    `${segmentId}:${unitId}:${decisionId}`;

  if (entries.length === 0) {
    return (
      <section className="review-workspace" aria-label="译文核对工作区">
        <h2>核对工作区</h2>
        <p className="hint">没有待核对译文：所有现有译文均已按当前原文与当前术语决定逐段确认。</p>
      </section>
    );
  }

  return (
    <section className="review-workspace" aria-label="译文核对工作区">
      <h2>核对工作区（{entries.length} 段待处理）</h2>
      <p className="hint">
        术语待核对与原文改写分开标注；同一词出现在不同语境时逐段决定，不会一律替换。保留原译文必须填写依据。
      </p>
      {entries.map((entry) => (
        <article key={entry.segmentId} className={`review-entry trigger-${entry.trigger}`}>
          <div className="review-entry-head">
            <span className={`trigger-badge trigger-${entry.trigger}`}>{triggerLabel(entry.trigger)}</span>
          </div>
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
                <span className={`trigger-badge trigger-${view.trigger}`}>{triggerLabel(view.trigger)}</span>
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
              {view.termIssues.map((issue) => {
                const key = draftKey(entry.segmentId, view.unit.id, issue.decisionId);
                return (
                  <fieldset key={issue.decisionId} className="term-decision-box">
                    <legend>
                      术语“{issue.term}”v{issue.version} → 采用译法“{issue.adopted}”
                      {issue.scope && <span className="hint">（适用范围：{issue.scope}）</span>}
                    </legend>
                    {issue.dispositionType && (
                      <p className="hint">上一轮处置：{issue.dispositionType === 'kept' ? '保留例外' : issue.dispositionType === 'applied' ? '已按新术语' : '暂缓'}</p>
                    )}
                    <input
                      className="term-rationale-input"
                      value={rationaleDrafts[key] ?? ''}
                      placeholder={issue.dispositionType === 'kept' ? '保留依据（已记录可补充）' : '保留原译文时必须填写依据'}
                      onChange={(e) =>
                        setRationaleDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                    />
                    <div className="term-decision-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          decideTerm(entry.segmentId, view.unit.id, issue.decisionId, 'applied', {
                            revisedText: view.unit.text,
                          })
                        }
                      >
                        按新术语修改并采用
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const rationale = (rationaleDrafts[key] ?? '').trim();
                          if (!rationale) {
                            setRationaleDrafts((prev) => ({ ...prev, [key]: '' }));
                            alert('人工保留例外必须说明依据');
                            return;
                          }
                          decideTerm(entry.segmentId, view.unit.id, issue.decisionId, 'kept', { rationale });
                        }}
                      >
                        保留原译文（例外，需依据）
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          decideTerm(entry.segmentId, view.unit.id, issue.decisionId, 'deferred')
                        }
                      >
                        暂缓该术语
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <div className="review-unit-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => confirmTranslation(entry.segmentId, view.unit.id)}
                >
                  确认采用当前译文
                </button>
                <button type="button" onClick={() => retranslate(entry.segmentId, view.unit.id)}>
                  重译
                </button>
                <button type="button" onClick={() => defer(entry.segmentId, view.unit.id)}>
                  暂缓整段核对
                </button>
              </div>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
