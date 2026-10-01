import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { buildReviewWorkspace } from '../core/reviewWorkspace';
import { unitLanguageLabel } from '../core/termOps';

const CAUSE_TEXT = {
  'source-change': '原文改写待核对',
  'term-change': '仅术语决定变化',
  both: '原文与术语同轮变化',
  unresolved: '待确认对应',
} as const;

export function ReviewWorkspace() {
  const doc = useDocStore((state) => state.doc);
  const confirmTranslation = useDocStore((state) => state.confirmTranslation);
  const confirmSegment = useDocStore((state) => state.confirmSegment);
  const retranslate = useDocStore((state) => state.retranslate);
  const defer = useDocStore((state) => state.defer);
  const setTranslation = useDocStore((state) => state.setTranslation);
  const applyTerm = useDocStore((state) => state.applyTerm);
  const keepTerm = useDocStore((state) => state.keepTerm);
  const deferTerm = useDocStore((state) => state.deferTerm);
  const acknowledgeRevokedTerm = useDocStore((state) => state.acknowledgeRevokedTerm);
  const [rationale, setRationale] = useState<Record<string, string>>({});

  const entries = useMemo(() => buildReviewWorkspace(doc), [doc]);

  if (entries.length === 0) {
    return (
      <section className="review-workspace" aria-label="译文核对工作区">
        <h2>核对工作区</h2>
        <p className="hint">没有待核对译文：确认均同时对应当前原文与当前采用的术语决定。</p>
      </section>
    );
  }

  return (
    <section className="review-workspace term-change" aria-label="译文核对工作区">
      <h2>核对工作区（{entries.length} 段待处理）</h2>
      <p className="hint">橙色表示原文改写，紫色表示术语决定变化；术语按段落与语言单独处理，同词在不同语境可保留例外。</p>
      {entries.map((entry) => (
        <article key={entry.segmentId} className="review-entry">
          <div className="review-source">
            <div>
              <span className="hint">旧原文{entry.units.some((unit) => unit.reviewCause === 'term-change') && !entry.sourceBefore ? '（本项未改写原文）' : ''}</span>
              <p className="source-before">{entry.sourceBefore ?? '（无更早版本）'}</p>
            </div>
            <div>
              <span className="hint">当前原文</span>
              <p className="source-after">{entry.sourceAfter}</p>
            </div>
          </div>
          <div className="review-actions-row">
            <button type="button" onClick={() => confirmSegment(entry.segmentId)}>整段各语言最终确认</button>
          </div>
          {entry.units.map((view) => (
            <div key={view.unit.id} className={`review-unit ${view.unit.status} cause-${view.reviewCause}`}>
              <div className="unit-meta">
                <code>{unitLanguageLabel(view.unit)}</code>
                <span className={`badge ${view.unit.status}`}>{CAUSE_TEXT[view.reviewCause]}</span>
                {view.deferred && <span className="reason">已暂缓</span>}
                {view.unit.reason && <span className="reason">{view.unit.reason}</span>}
              </div>
              <textarea
                className="translation-text"
                value={view.unit.text}
                rows={2}
                aria-label="待核对译文"
                onChange={(event) => setTranslation(view.unit.id, event.target.value)}
              />
              {view.termItems.map((item) => {
                const key = `${entry.segmentId}:${view.unit.id}:${item.decision.id}`;
                return (
                  <div key={item.decision.id} className={`term-resolution state-${item.state}`}>
                    <div className="term-resolution-head">
                      <strong>“{item.decision.term}”</strong>
                      <span>{item.decision.status === 'revoked' ? '术语决定已撤销' : `采用译法：${item.choice.adopted}`}</span>
                      <span className="badge translated">{item.state}</span>
                    </div>
                    {item.state === 'exception' && item.resolution?.rationale && (
                      <p className="hint">保留依据：{item.resolution.rationale}</p>
                    )}
                    {item.state === 'applied' && (
                      <p className="hint">本语境已按修订 {item.resolution?.revision} 的术语决定处理。</p>
                    )}
                    {(item.state === 'missing' || item.state === 'outdated') && (
                      <div className="term-resolution-actions">
                        {item.decision.status === 'active' && (
                          <>
                            <button
                              type="button"
                              onClick={() => applyTerm(entry.segmentId, view.unit.id, item.decision.id)}
                              disabled={!item.oldTermFound && !view.unit.text.includes(item.choice.adopted)}
                            >
                              按新术语修改
                            </button>
                            <button type="button" onClick={() => keepTerm(entry.segmentId, view.unit.id, item.decision.id, rationale[key] ?? '')} disabled={!rationale[key]?.trim()}>
                              保留原译文为例外
                            </button>
                            <button type="button" onClick={() => deferTerm(entry.segmentId, view.unit.id, item.decision.id)}>暂缓</button>
                          </>
                        )}
                        {item.decision.status === 'revoked' && (
                          <button type="button" onClick={() => acknowledgeRevokedTerm(entry.segmentId, view.unit.id, item.decision.id)}>
                            已知撤销，重新按当前原文核对
                          </button>
                        )}
                      </div>
                    )}
                    {item.state === 'missing' && !item.oldTermFound && !view.unit.text.includes(item.choice.adopted) && (
                      <p className="hint">当前语境找不到指定旧译法，不能自动替换；请人工编辑译文、保留例外或暂缓。</p>
                    )}
                    {item.decision.status === 'active' && (item.state === 'missing') && (
                      <input
                        value={rationale[key] ?? ''}
                        onChange={(event) => setRationale((current) => ({ ...current, [key]: event.target.value }))}
                        placeholder="保留原译文的语境依据（必填）"
                      />
                    )}
                  </div>
                );
              })}
              {view.exceptionRationales.length > 0 && (
                <div className="exception-list">
                  {view.exceptionRationales.map((text) => <p key={text}>人工例外：{text}</p>)}
                </div>
              )}
              <div className="review-unit-actions">
                <button type="button" className="primary" onClick={() => confirmTranslation(entry.segmentId, view.unit.id)}>
                  确认采用当前内容
                </button>
                <button type="button" onClick={() => retranslate(entry.segmentId, view.unit.id)}>重译</button>
                <button type="button" onClick={() => defer(entry.segmentId, view.unit.id)}>暂缓</button>
              </div>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
