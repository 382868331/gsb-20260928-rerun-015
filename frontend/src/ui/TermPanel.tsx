import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { LANGUAGE_LABELS, LanguageCode, TermRendering } from '../core/model';
import { activeTermDecisions, findTermUsages } from '../core/terms';
import { previewCoordination } from '../core/termCoordination';

const KIND_LABELS = {
  'same-concept': '同一概念',
  'different-context': '例外语境',
  'split-origin': '拆合来源',
} as const;

/** 单个术语决定下的跨段协调：形成方案、预览影响、确认或撤回。 */
function CoordinationSection({ decisionId }: { decisionId: string }) {
  const doc = useDocStore((s) => s.doc);
  const planTermCoordination = useDocStore((s) => s.planTermCoordination);
  const applyTermCoordination = useDocStore((s) => s.applyTermCoordination);
  const withdrawTermCoordination = useDocStore((s) => s.withdrawTermCoordination);
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [from, setFrom] = useState('');
  const plans = (doc.coordinations ?? []).filter((c) => c.decisionId === decisionId);

  return (
    <div className="coordination-section">
      <h4>跨段一致性协调</h4>
      <div className="coordination-form">
        <select value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode)}>
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{LANGUAGE_LABELS[lang]}</option>
          ))}
        </select>
        <input
          aria-label="冲突译法"
          placeholder="冲突译法（旧译法）"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <button
          type="button"
          disabled={!from.trim()}
          onClick={() => {
            if (planTermCoordination(decisionId, language, from.trim())) setFrom('');
          }}
        >
          形成协调方案
        </button>
      </div>
      {plans.map((plan) => {
        const preview = plan.status === 'draft' ? previewCoordination(doc, plan.id) : null;
        return (
          <article key={plan.id} className="coordination-card">
            <header className="term-decision-head">
              <span>
                <code>{plan.language}</code> “{plan.from}” → “{plan.to}”
              </span>
              <code>{plan.status === 'draft' ? '草案' : plan.status === 'applied' ? '已确认' : '已撤回'}</code>
              {plan.status === 'draft' && (
                <button type="button" className="primary" onClick={() => applyTermCoordination(plan.id)}>
                  确认协调（{preview?.applicableCount ?? 0} 处可应用）
                </button>
              )}
              {plan.status === 'applied' && (
                <button type="button" onClick={() => withdrawTermCoordination(plan.id)}>撤回协调</button>
              )}
            </header>
            <ul>
              {plan.targets.map((target) => {
                const item = preview?.items.find(
                  (i) => i.target.segmentId === target.segmentId && i.target.unitId === target.unitId,
                );
                return (
                  <li key={`${target.segmentId}:${target.unitId}`}>
                    <span className={target.eligible ? 'ok' : 'bad'}>{KIND_LABELS[target.kind]}</span>{' '}
                    <span className="hint">{target.currentText.slice(0, 40)}</span>
                    {target.proposedText && target.eligible && (
                      <span> → {target.proposedText.slice(0, 40)}</span>
                    )}
                    {target.originSegmentIds && (
                      <span className="hint">（来源段：{target.originSegmentIds.join(', ')}）</span>
                    )}
                    {item?.action === 'skip' && <span className="bad">跳过：{item.skipReason}</span>}
                    {!target.eligible && <span className="bad">{target.blockReason}</span>}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

const LANGUAGES: LanguageCode[] = ['en', 'ja', 'fr', 'de'];

/** 术语决定面板：先看哪些已有段落实际用了它，再指定各语言采用译法与适用范围。 */
export function TermPanel() {
  const doc = useDocStore((s) => s.doc);
  const createTerm = useDocStore((s) => s.createTerm);
  const reviseTerm = useDocStore((s) => s.reviseTerm);
  const revokeTerm = useDocStore((s) => s.revokeTerm);
  const [term, setTerm] = useState('');
  const emptyRenderings = () => ({
    en: { adopted: '', scope: '' },
    ja: { adopted: '', scope: '' },
    fr: { adopted: '', scope: '' },
    de: { adopted: '', scope: '' },
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
    for (const r of decision.renderings) next[r.language] = { adopted: r.adopted, scope: r.scope };
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
            <CoordinationSection decisionId={decision.id} />
          </article>
        ))}
        {doc.termDecisions.some((d) => d.revokedAt) && (
          <p className="hint">已撤销的术语决定保留备查；撤销不会恢复其他轮次的确认。</p>
        )}
      </div>
    </section>
  );
}
