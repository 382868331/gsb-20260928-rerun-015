import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { LANGUAGE_LABELS, LanguageCode, TermCoordination } from '../core/model';
import { activeTermDecisions } from '../core/terms';
import { CoordinationCandidate, findTermCoordinationCandidates, previewTermCoordination } from '../core/termCoordination';

const kindLabel: Record<CoordinationCandidate['candidateKind'], string> = {
  same_concept: '真正同一概念',
  different_context: '同文不同语境',
  split_merged_origin: '段落拆合来源',
};

function CoordinationDraft({ coordination }: { coordination: TermCoordination }) {
  const confirmCoordination = useDocStore((s) => s.confirmCoordination);
  const withdrawCoordination = useDocStore((s) => s.withdrawCoordination);
  const eligible = coordination.items.filter((item) => item.eligible);
  return (
    <article className="coordination-card">
      <header>
        <strong>{coordination.term}</strong>
        <code>{LANGUAGE_LABELS[coordination.language]}</code>
        <span>→ {coordination.targetRendering}</span>
        <span className="badge translated">可应用 {eligible.length} 项</span>
      </header>
      <p className="hint">确认只作用于下列已批准具体段落；被阻止项不会被全局替换。</p>
      {coordination.items.map((item) => (
        <div key={`${item.segmentId}:${item.unitId}`} className={`coordination-item ${item.eligible ? 'eligible' : 'blocked'}`}>
          <span className="trigger-badge trigger-term">{kindLabel[item.candidateKind]}</span>
          <p>{item.sourceText}</p>
          <p><del>{item.beforeText}</del></p>
          <p>{item.afterText}</p>
          {!item.eligible && <ul>{item.blockedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        </div>
      ))}
      <div className="term-decision-actions">
        <button type="button" className="primary" disabled={eligible.length === 0} onClick={() => confirmCoordination(coordination.id)}>
          确认并只应用合格项
        </button>
        <button type="button" onClick={() => withdrawCoordination(coordination.id)}>撤回整组候选</button>
      </div>
    </article>
  );
}

export function TermCoordinationPanel() {
  const doc = useDocStore((s) => s.doc);
  const createCoordination = useDocStore((s) => s.createCoordination);
  const withdrawCoordination = useDocStore((s) => s.withdrawCoordination);
  const decisions = activeTermDecisions(doc);
  const [decisionId, setDecisionId] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('en');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const effectiveDecisionId = decisionId || decisions[0]?.id || '';
  const decision = decisions.find((item) => item.id === effectiveDecisionId);
  const languageChoices = decision?.renderings.map((item) => item.language) ?? [];
  const effectiveLanguage = languageChoices.includes(language) ? language : languageChoices[0];
  const candidates = useMemo(
    () => effectiveDecisionId && effectiveLanguage
      ? findTermCoordinationCandidates(doc, effectiveDecisionId, effectiveLanguage)
      : [],
    [doc, effectiveDecisionId, effectiveLanguage],
  );
  const drafts = doc.termCoordinations.filter((item) => item.status === 'draft');

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const buildPreview = () => {
    if (!decision || !effectiveLanguage) return;
    const selectedKeys = [...checked].map((key) => {
      const [segmentId, unitId] = key.split('::');
      return { segmentId, unitId };
    });
    const preview = previewTermCoordination(doc, {
      decisionId: decision.id,
      language: effectiveLanguage,
      targetRendering: decision.renderings.find((item) => item.language === effectiveLanguage)!.adopted,
      selectedKeys,
      textOverrides: revisions,
    });
    const eligibleCount = preview.coordination.items.filter((item) => item.eligible).length;
    if (eligibleCount === 0) {
      alert('没有已勾选且可安全应用的候选；例外和未确认段落不会被替换。');
      return;
    }
    createCoordination({
      decisionId: decision.id,
      language: effectiveLanguage,
      targetRendering: preview.coordination.targetRendering,
      selectedKeys,
      textOverrides: revisions,
    });
    setChecked(new Set());
    setRevisions({});
  };

  return (
    <div className="coordination-panel">
      <h3>跨段术语候选协调</h3>
      <p className="hint">先声明允许译法和必须保留的例外语境；系统按段落身份、同形异义和拆合来源分类。</p>
      <div className="coordination-controls">
        <select value={effectiveDecisionId} onChange={(event) => { setDecisionId(event.target.value); setChecked(new Set()); setRevisions({}); }}>
          {decisions.map((item) => <option key={item.id} value={item.id}>{item.term} v{item.version}</option>)}
        </select>
        <select value={effectiveLanguage ?? ''} onChange={(event) => { setLanguage(event.target.value as LanguageCode); setChecked(new Set()); setRevisions({}); }}>
          {languageChoices.map((item) => <option key={item} value={item}>{LANGUAGE_LABELS[item]}</option>)}
        </select>
        <button type="button" className="primary" onClick={buildPreview}>生成协调替换预览</button>
      </div>
      <div className="coordination-candidates">
        {candidates.map((candidate) => {
          const key = `${candidate.segmentId}::${candidate.unitId}`;
          return (
            <label key={key} className={`coordination-item ${candidate.eligible ? 'eligible' : 'blocked'}`}>
              <input type="checkbox" disabled={!candidate.eligible} checked={checked.has(key)} onChange={() => toggle(key)} />
              <span className="trigger-badge trigger-term">{kindLabel[candidate.candidateKind]}</span>
              <span>{candidate.sourceText}</span>
              <span>{candidate.beforeText} → {candidate.afterText}</span>
              {candidate.eligible && (
                <textarea
                  rows={2}
                  placeholder="必要时填写替换后译文（必须包含目标译法）"
                  value={revisions[key] ?? ''}
                  onChange={(event) => setRevisions((prev) => ({ ...prev, [key]: event.target.value }))}
                />
              )}
              {!candidate.eligible && <span className="hint">{candidate.blockedReasons.join('；')}</span>}
            </label>
          );
        })}
        {candidates.length === 0 && <p className="hint">当前没有可分析的跨段冲突候选。</p>}
      </div>
      {drafts.map((item) => <CoordinationDraft key={item.id} coordination={item} />)}
      {doc.termCoordinations.some((item) => item.status !== 'draft') && (
        <div className="coordination-history">
          <h4>已确认/已撤回协调</h4>
          {doc.termCoordinations.filter((item) => item.status !== 'draft').map((item) => (
            <div key={item.id} className="coordination-card">
              <strong>{item.term}</strong> <code>{item.status}</code>
              {item.status === 'confirmed' && <button type="button" onClick={() => withdrawCoordination(item.id)}>撤回，保留后续独立裁决</button>}
              {item.withdrawReason && <p className="hint">{item.withdrawReason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
