import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { LANGUAGE_LABELS, LanguageCode, TermRendering } from '../core/model';
import { activeTermDecisions, findTermUsages } from '../core/terms';
import { TermCoordinationPanel } from './TermCoordinationPanel';

const LANGUAGES: LanguageCode[] = ['en', 'ja', 'fr', 'de'];

/** 术语决定面板：先看哪些已有段落实际用了它，再指定各语言采用译法与适用范围。 */
export function TermPanel() {
  const doc = useDocStore((s) => s.doc);
  const createTerm = useDocStore((s) => s.createTerm);
  const reviseTerm = useDocStore((s) => s.reviseTerm);
  const revokeTerm = useDocStore((s) => s.revokeTerm);
  const [term, setTerm] = useState('');
  const emptyRenderings = () => ({
    en: { adopted: '', scope: '', allowed: '', exceptionContexts: '' },
    ja: { adopted: '', scope: '', allowed: '', exceptionContexts: '' },
    fr: { adopted: '', scope: '', allowed: '', exceptionContexts: '' },
    de: { adopted: '', scope: '', allowed: '', exceptionContexts: '' },
  });
  const [renderings, setRenderings] = useState(emptyRenderings());
  const [editingId, setEditingId] = useState<string | null>(null);

  const preview = useMemo(
    () => (term.trim() ? findTermUsages(doc, term) : []),
    [doc, term],
  );
  const decisions = activeTermDecisions(doc);

  const collectRenderings = (): TermRendering[] =>
    LANGUAGES.filter((lang) => renderings[lang].adopted.trim().length > 0).map((lang) => ({
      language: lang,
      adopted: renderings[lang].adopted.trim(),
      scope: renderings[lang].scope.trim(),
      allowed: renderings[lang].allowed.split(/[;；,，]/).map((v) => v.trim()).filter(Boolean),
      exceptionContexts: renderings[lang].exceptionContexts.split(/[;；,，]/).map((v) => v.trim()).filter(Boolean),
    }));

  const submit = () => {
    if (!term.trim() || collectRenderings().length === 0) return;
    if (editingId) reviseTerm(editingId, collectRenderings());
    else createTerm(term.trim(), collectRenderings());
    setEditingId(null);
  };

 const startEdit = (decisionId: string) => {
    const decision = decisions.find((d) => d.id === decisionId);
    if (!decision) return;
    setEditingId(decisionId);
    setTerm(decision.term);
    const next = emptyRenderings();
    for (const r of decision.renderings) next[r.language] = {
      adopted: r.adopted,
      scope: r.scope,
      allowed: (r.allowed ?? []).join('；'),
      exceptionContexts: (r.exceptionContexts ?? []).join('；'),
    };
   setRenderings(next);
 };

  return (
    <section className="term-panel" aria-label="术语决定">
      <h2>术语决定</h2>
      <p className="hint">
        指定各语言采用译法与适用范围后，仅实际使用该术语的段落进入术语待核对；同一词在不同语境可逐段保留或修改。
      </p>
      <div className="term-form">
        <label className="term-term-input">
          源文术语
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="如：新版本" />
        </label>
        <div className="term-rendering-grid">
          {LANGUAGES.map((lang) => (
            <div key={lang} className="term-rendering-cell">
              <span>{LANGUAGE_LABELS[lang]}</span>
              <input
                aria-label={`${lang} 采用译法`}
                placeholder="采用译法"
                value={renderings[lang].adopted}
                onChange={(e) =>
                  setRenderings((prev) => ({ ...prev, [lang]: { ...prev[lang], adopted: e.target.value } }))
                }
              />
              <input
                aria-label={`${lang} 适用范围`}
                placeholder="适用范围（可空）"
                value={renderings[lang].scope}
                onChange={(e) =>
                  setRenderings((prev) => ({ ...prev, [lang]: { ...prev[lang], scope: e.target.value } }))
                }
              />
              <input
                aria-label={`${lang} 允许译法`}
                placeholder="允许译法（分号分隔）"
                value={renderings[lang].allowed}
                onChange={(e) =>
                  setRenderings((prev) => ({ ...prev, [lang]: { ...prev[lang], allowed: e.target.value } }))
                }
              />
              <input
                aria-label={`${lang} 例外语境`}
                placeholder="必须保留的例外语境"
                value={renderings[lang].exceptionContexts}
                onChange={(e) =>
                  setRenderings((prev) => ({ ...prev, [lang]: { ...prev[lang], exceptionContexts: e.target.value } }))
                }
              />
            </div>
          ))}
        </div>
        <div className="term-form-actions">
          <button type="button" className="primary" onClick={submit}>
            {editingId ? '提交修订（旧处置需重新核对）' : '作出术语决定'}
          </button>
          {editingId && (
            <button type="button" onClick={() => { setEditingId(null); setTerm(''); }}>
              取消修订
            </button>
          )}
        </div>
      </div>

      {term.trim() && (
        <div className="term-usage-preview">
          <h3>已有段落使用情况（{preview.length} 个译文）</h3>
          {preview.length === 0 && <p className="hint">当前没有段落的原文包含“{term}”。</p>}
          {preview.map((usage) => (
            <div key={`${usage.segmentId}:${usage.unitId}`} className="term-usage-row">
              <code>{usage.language}</code>
              <span className="hint">{usage.segmentText.slice(0, 30)}</span>
              <span>→ {usage.translationText.slice(0, 40)}</span>
              {usage.rendering && (
                <span className={usage.usesAdopted ? 'ok' : 'bad'}>
                  {usage.usesAdopted ? '已含采用译法' : `未使用“${usage.rendering.adopted}”`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="term-decision-list">
        {decisions.map((decision) => (
          <article key={decision.id} className="term-decision-card">
            <header className="term-decision-head">
              <strong>{decision.term}</strong>
              <code>v{decision.version}</code>
              <button type="button" onClick={() => startEdit(decision.id)}>修订</button>
              <button type="button" onClick={() => revokeTerm(decision.id)}>撤销决定</button>
            </header>
            <ul>
              {decision.renderings.map((r) => (
                <li key={r.language}>
                  <code>{r.language}</code> {r.adopted}
                  {r.scope && <span className="hint">（适用范围：{r.scope}）</span>}
                </li>
              ))}
            </ul>
          </article>
        ))}
        {doc.termDecisions.some((d) => d.revokedAt) && (
          <p className="hint">已撤销的术语决定保留备查；撤销不会恢复其他轮次的确认。</p>
        )}
      </div>
      <TermCoordinationPanel />
    </section>
  );
}
