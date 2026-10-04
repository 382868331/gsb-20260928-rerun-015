import { useMemo, useState } from 'react';
import { useDocStore } from '../store/docStore';
import { segmentIdsForUnit, unitIdsForSegment } from '../core/docOps';
import { checkIntegrity } from '../core/integrity';
import { exportBilingual, exportJSON } from '../core/exportDoc';
import { SegmentRow } from './SegmentRow';
import { ReviewWorkspace } from './ReviewWorkspace';
import { ReviewBranches } from './ReviewBranches';
import { TermPanel } from './TermPanel';

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const store = useDocStore();
  const { doc } = store;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [splitMode, setSplitMode] = useState<string | null>(null);
  const [linkPicker, setLinkPicker] = useState<string | null>(null);

  const report = useMemo(() => checkIntegrity(doc), [doc]);
  const linkedUnitIds = useMemo(() => new Set(doc.links.map((l) => l.unitId)), [doc]);
  const orphanUnits = doc.units.filter((u) => !linkedUnitIds.has(u.id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedOrdered = doc.segments.filter((s) => selected.has(s.id)).map((s) => s.id);

  const handleMerge = () => {
    if (selectedOrdered.length < 2) return;
    store.mergeSegments(selectedOrdered);
    setSelected(new Set());
  };

  return (
    <div className="app">
      <header className="topbar">
        <input
          className="doc-title-input"
          value={doc.title}
          onChange={(event) => store.setTitle(event.target.value)}
          aria-label="文档标题"
        />
        <div className="toolbar">
          <button type="button" onClick={() => store.undo()} disabled={store.past.length === 0}>
            撤销
          </button>
          <button type="button" onClick={() => store.redo()} disabled={store.future.length === 0}>
            重做
          </button>
          <button type="button" className="primary" onClick={() => store.save()}>
            保存
          </button>
          <button type="button" onClick={() => download(`${doc.title}.json`, exportJSON(doc))}>
            导出 JSON
          </button>
          <button type="button" onClick={() => download(`${doc.title}.txt`, exportBilingual(doc))}>
            导出双语文本
          </button>
          <button type="button" onClick={() => store.resetToSample()}>
            重置示例
          </button>
        </div>
      </header>

      <div className="statusline">
        <span>
          段落 {report.segmentCount} · 译文单元 {report.unitCount} · 待核对{' '}
          {report.reviewUnitIds.length} · 未确认段 {report.unconfirmedSegmentIds.length}
        </span>
        <span className={report.ok ? 'ok' : 'bad'}>
          {report.ok ? '一致性正常（无丢段/无悬空关联）' : '存在一致性问题'}
        </span>
        <span>{store.dirty ? '未保存' : `已保存 ${store.savedAt ?? ''}`}</span>
        <span className="merge-controls">
          <input
            type="checkbox"
            checked={false}
            readOnly
            aria-hidden
            style={{ display: 'none' }}
          />
          已勾选 {selectedOrdered.length} 段
          <button type="button" onClick={handleMerge} disabled={selectedOrdered.length < 2}>
            合并勾选段落
          </button>
        </span>
      </div>

      <main className="layout">
        <section className="column source-column" aria-label="源文段落">
          <h2>源文（身份固定，移动不改身份）</h2>
          {doc.segments.map((segment, index) => (
            <SegmentRow
              key={segment.id}
              segment={segment}
              index={index}
              total={doc.segments.length}
              selected={selected.has(segment.id)}
              splitMode={splitMode === segment.id}
              onToggleSelect={() => toggleSelect(segment.id)}
              onMove={(to) => store.moveSegment(segment.id, to)}
              onCommitText={(text) => store.editSegment(segment.id, text)}
              onEnterSplit={() => setSplitMode(segment.id)}
              onCancelSplit={() => setSplitMode(null)}
              onConfirmSplit={(parts) => {
                store.splitSegment(segment.id, parts);
                setSplitMode(null);
              }}
              onPickLink={() => setLinkPicker(segment.id)}
              onUnlink={(unitId) => store.unlink(segment.id, unitId)}
              onCreateUnit={() => store.createUnit(segment.id)}
              linkPickerOpen={linkPicker === segment.id}
              onClosePicker={() => setLinkPicker(null)}
              onLinkUnit={(unitId) => {
                store.link(segment.id, unitId);
                setLinkPicker(null);
              }}
              onConfirmReview={(unitId) => store.setStatus(unitId, 'translated')}
            />
          ))}
        </section>

        <section className="column orphan-column" aria-label="未关联译文">
          <h2>译文单元池</h2>
          <p className="hint">解除关联的旧译文保留在这里，可重新挂到段落，避免旧译文被误当成新内容。</p>
          {doc.units.length === 0 && <p className="hint">尚无译文单元。在段落上点击“新建译文”开始。</p>}
          {doc.units.map((unit) => {
            const segmentCount = segmentIdsForUnit(doc, unit.id).length;
            return (
              <div key={unit.id} className={`unit-card orphan ${unit.status}`}>
                <div className="unit-meta">
                  <code>{unit.id.slice(0, 10)}</code>
                  <span className={`badge ${unit.status}`}>
                    {unit.status === 'translated' ? '已译' : unit.status === 'review' ? '待核对' : '未译'}
                  </span>
                  <span className="hint">关联 {segmentCount} 段</span>
                </div>
                {segmentCount === 0 ? (
                  <details>
                    <summary>挂到段落</summary>
                    <div className="link-list">
                      {doc.segments
                        .filter((s) => !unitIdsForSegment(doc, s.id).includes(unit.id))
                        .map((s) => (
                          <button key={s.id} type="button" onClick={() => store.link(s.id, unit.id)}>
                            → {s.text.slice(0, 18)}
                          </button>
                        ))}
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })}
          {orphanUnits.length > 0 && (
            <p className="hint">未关联 {orphanUnits.length} 个：导出时单列，不会写入正文。</p>
          )}
        </section>
      </main>

      <ReviewWorkspace />
      <ReviewBranches />
      <TermPanel />
    </div>
  );
}
