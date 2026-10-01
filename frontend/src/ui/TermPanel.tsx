import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { unitLanguageLabel } from '../core/termOps';

export function TermPanel() {
  const doc = useDocStore((state) => state.doc);
  const createTerm = useDocStore((state) => state.createTerm);
  const revokeTerm = useDocStore((state) => state.revokeTerm);
  const saveLanguageLabel = useDocStore((state) => state.setLanguageLabel);
  const [term, setTerm] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [languageLabel, setLanguageLabelDraft] = useState<Record<string, string>>({});
  const [adopted, setAdopted] = useState<Record<string, string>>({});
  const [previous, setPrevious] = useState<Record<string, string>>({});
  const setLanguageLabelLocal = (unitId: string, value: string) =>
    setLanguageLabelDraft((current) => ({ ...current, [unitId]: value }));

  const candidateSegments = useMemo(() => {
    const keyword = term.trim();
    if (!keyword) return [];
    return doc.segments.filter((segment) => segment.text.includes(keyword));
  }, [doc.segments, term]);

  const activeScopes = candidateSegments.filter((segment) => selectedScopes.has(segment.id));

  const toggleScope = (id: string) => {
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    const translations = doc.units
      .filter((unit) => adopted[unit.id]?.trim())
      .map((unit) => ({
        unitId: unit.id,
        adopted: adopted[unit.id],
        previous: previous[unit.id],
      }));
    const termId = createTerm({
      term,
      scopeSegmentIds: activeScopes.map((segment) => segment.id),
      translations,
    });
    if (termId) {
      setTerm('');
      setSelectedScopes(new Set());
      setAdopted({});
      setPrevious({});
    }
  };

  return (
    <section className="term-panel" aria-label="术语决定">
      <h2>术语决定</h2>
      <p className="hint">先限定实际出现该词的段落与语言，再逐段决定按新术语修改、保留有据例外或暂缓；不会全局无差别替换。</p>
      <div className="term-form">
        <label>
          源文术语
          <input value={term} onChange={(event) => { setTerm(event.target.value); setSelectedScopes(new Set()); }} placeholder="例如：云盘" />
        </label>
        {candidateSegments.length > 0 && (
          <div className="term-scope-list">
            <span className="hint">实际出现该词的段落：</span>
            {candidateSegments.map((segment) => (
              <label key={segment.id} className="scope-option">
                <input type="checkbox" checked={selectedScopes.has(segment.id)} onChange={() => toggleScope(segment.id)} />
                <span>#{doc.segments.indexOf(segment) + 1} {segment.text}</span>
              </label>
            ))}
          </div>
        )}
        {term && candidateSegments.length === 0 && <p className="hint">当前原文中没有实际使用该词的段落。</p>}
        {activeScopes.length > 0 && (
          <div className="term-language-grid">
            {doc.units.length === 0 && <p className="hint">请先在段落中新建至少一种语言的译文。</p>}
            {doc.units.map((unit) => (
              <div key={unit.id} className="term-language-row">
                <input
                  value={languageLabel[unit.id] ?? unit.languageLabel ?? ''}
                  onChange={(event) => setLanguageLabelLocal(unit.id, event.target.value)}
                  onBlur={() => saveLanguageLabel(unit.id, languageLabel[unit.id] ?? '')}
                  placeholder="语言名（可选）"
                />
                <input value={previous[unit.id] ?? ''} onChange={(event) => setPrevious((current) => ({ ...current, [unit.id]: event.target.value }))} placeholder="旧译法（可选）" />
                <input value={adopted[unit.id] ?? ''} onChange={(event) => setAdopted((current) => ({ ...current, [unit.id]: event.target.value }))} placeholder="采用译法" />
                <span className="hint">{unitLanguageLabel(unit)}：{unit.text || '（空译文）'}</span>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="primary" onClick={submit} disabled={!term.trim() || activeScopes.length === 0}>
          创建术语决定
        </button>
      </div>

      <div className="term-decisions">
        {doc.termDecisions.map((decision) => (
          <details key={decision.id} className={`term-decision ${decision.status}`} open={decision.status === 'active'}>
            <summary>
              <strong>{decision.term}</strong>
              <span className="badge translated">{decision.status === 'active' ? `修订 ${decision.revision}` : '已撤销'}</span>
              <span className="hint">{decision.scopeSegmentIds.length} 段</span>
            </summary>
            {decision.scopeSegmentIds.map((segmentId) => {
              const segment = doc.segments.find((item) => item.id === segmentId);
              if (!segment) return null;
              return (
                <div key={segmentId} className="term-usage">
                  <p>{segment.text}</p>
                  {decision.translations.map((choice) => {
                    const unit = doc.units.find((item) => item.id === choice.unitId);
                    return (
                      <p key={choice.unitId} className="hint">
                        {unitLanguageLabel(unit)}：现译“{unit?.text || '（空）'}” → 采用“{choice.adopted}”{choice.previous ? `，旧译法“${choice.previous}”` : ''}
                      </p>
                    );
                  })}
                </div>
              );
            })}
            {decision.status === 'active' && (
              <button type="button" onClick={() => revokeTerm(decision.id)}>撤销该术语决定</button>
            )}
            {decision.status === 'revoked' && <p className="hint">撤销不会恢复另一轮审阅确认；相关译文需重新处理。</p>}
          </details>
        ))}
      </div>
    </section>
  );
}
