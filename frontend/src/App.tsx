import { useMemo, useState } from 'react';
import { useEditorStore } from './store';
import { linksOfSource, linksOfTarget } from './model/doc';
import type { ExportedDoc } from './types';

export function App() {
  const store = useEditorStore();
  const { doc } = store;
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');

  const targetById = useMemo(
    () => new Map(doc.targets.map((t) => [t.id, t])),
    [doc.targets],
  );

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 2500);
  }

  function handleSave() {
    store.save();
    flash('已保存，刷新或重开后段落身份与关联保持不变');
  }

  function handleExport() {
    const payload = store.exportJson();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `doc-${payload.exportedAt.replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    flash('已导出 JSON（含段落身份与对应关系）');
  }

  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result)) as ExportedDoc;
        store.loadImport(payload);
        setMergeIds([]);
        setLinkingSourceId(null);
        flash('已导入导出文件');
      } catch {
        flash('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  function toggleMerge(id: string) {
    setMergeIds((ids) =>
      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
    );
  }

  function handleMerge() {
    if (mergeIds.length < 2) {
      flash('请先勾选至少两个要合并的正文段落');
      return;
    }
    store.merge(mergeIds);
    setMergeIds([]);
    flash('已合并，旧译文已迁移为待核对，可继续调整对应');
  }

  const reviewCount = doc.links.filter((link) => link.status === 'needs_review').length;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>多语言内容制作平台</h1>
        <div className="toolbar-actions">
          <button onClick={store.undo} disabled={!store.canUndo}>撤销</button>
          <button onClick={store.redo} disabled={!store.canRedo}>重做</button>
          <button onClick={handleSave}>{store.dirty ? '保存*' : '保存'}</button>
          <button onClick={handleExport}>导出 JSON</button>
          <label className="file-button">
            导入 JSON
            <input
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleImport(file);
                event.target.value = '';
              }}
            />
          </label>
          <button onClick={() => store.addParagraph()}>新增正文段</button>
          <button onClick={() => store.addTranslation('')}>新增译文段</button>
          <button
            className="danger"
            onClick={handleMerge}
            disabled={mergeIds.length < 2}
          >
            合并勾选段（{mergeIds.length}）
          </button>
        </div>
        <div className="status-line">
          <span>正文 {doc.sources.length} 段</span>
          <span>译文 {doc.targets.length} 条</span>
          <span>对应 {doc.links.length} 条</span>
          {reviewCount > 0 && <span className="review-badge">待核对 {reviewCount}</span>}
          {message && <span className="flash">{message}</span>}
        </div>
      </header>

      <main className="columns">
        <section className="column source-column">
          <h2>正文（{doc.sourceLanguage}）</h2>
          {doc.sources.map((source, index) => {
            const links = linksOfSource(doc, source.id);
            const checked = mergeIds.includes(source.id);
            return (
              <article key={source.id} className={`card ${checked ? 'checked' : ''}`}>
                <div className="card-head">
                  <label className="merge-pick" title="勾选后与其他段合并">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMerge(source.id)}
                    />
                    #{index + 1}
                  </label>
                  <span className="kind">{source.kind === 'heading' ? '标题' : '段落'}</span>
                  <code className="sid">{source.id}</code>
                  <span className="spacer" />
                  <button
                    disabled={index === 0}
                    onClick={() => store.move(source.id, index - 1)}
                  >
                    上移
                  </button>
                  <button
                    disabled={index === doc.sources.length - 1}
                    onClick={() => store.move(source.id, index + 1)}
                  >
                    下移
                  </button>
                  <button onClick={() => setSplittingId(splittingId === source.id ? null : source.id)}>
                    拆分
                  </button>
                </div>

                {splittingId === source.id ? (
                  <SplitEditor
                    initial={source.text}
                    onCancel={() => setSplittingId(null)}
                    onConfirm={(left, right) => {
                      store.split(source.id, left, right);
                      setSplittingId(null);
                    }}
                  />
                ) : (
                  <textarea
                    value={source.text}
                    rows={Math.min(6, Math.max(2, source.text.split('\n').length))}
                    onChange={(event) => store.editSource(source.id, event.target.value)}
                  />
                )}

                <div className="link-list">
                  {links.length === 0 && <span className="muted">尚无对应译文</span>}
                  {links.map((link) => {
                    const target = targetById.get(link.targetId);
                    return (
                      <div key={link.id} className={`link-row ${link.status}`}>
                        <span className="status-dot" />
                        <span className="link-text">{target?.text ?? '（译文已删除）'}</span>
                        {link.status === 'needs_review' && (
                          <button onClick={() => store.confirmLink(link.id)}>核对无误</button>
                        )}
                        <button className="ghost" onClick={() => store.unlink(link.id)}>解除</button>
                      </div>
                    );
                  })}
                </div>

                <div className="card-foot">
                  {linkingSourceId === source.id ? (
                    <button onClick={() => setLinkingSourceId(null)}>取消关联模式</button>
                  ) : (
                    <button onClick={() => setLinkingSourceId(source.id)}>调整对应…</button>
                  )}
                  {links.some((link) => link.status === 'needs_review') && (
                    <button onClick={() => store.confirmSource(source.id)}>全部核对通过</button>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <section className="column target-column">
          <h2>译文（{doc.targetLanguage}）</h2>
          {linkingSourceId && (
            <div className="link-hint">
              正在为正文段建立/调整对应，点击下方译文即可关联（支持一对多、多对一）。
            </div>
          )}
          {doc.targets.map((target, index) => {
            const links = linksOfTarget(doc, target.id);
            const alreadyLinked = linkingSourceId
              ? links.some((link) => link.sourceId === linkingSourceId)
              : false;
            return (
              <article key={target.id} className="card target-card">
                <div className="card-head">
                  <span>#{index + 1}</span>
                  <code className="sid">{target.id}</code>
                  <span className="muted">
                    对应正文：{links.length === 0 ? '无' : links.map((link) => {
                      const pos = doc.sources.findIndex((s) => s.id === link.sourceId);
                      return `#${pos + 1}`;
                    }).join(', ')}
                  </span>
                </div>
                <textarea
                  value={target.text}
                  rows={Math.min(6, Math.max(2, target.text.split('\n').length))}
                  onChange={(event) => store.editTarget(target.id, event.target.value)}
                />
                {linkingSourceId && (
                  <div className="card-foot">
                    <button
                      disabled={alreadyLinked}
                      onClick={() => {
                        store.link(linkingSourceId, target.id);
                        flash('已建立对应（默认待核对）');
                      }}
                    >
                      {alreadyLinked ? '已关联' : '关联到选中正文'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      </main>
    </div>
  );
}

function SplitEditor({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string;
  onConfirm: (left: string, right: string) => void;
  onCancel: () => void;
}) {
  const midpoint = Math.floor(initial.length / 2);
  const [left, setLeft] = useState(initial.slice(0, midpoint));
  const [right, setRight] = useState(initial.slice(midpoint));
  return (
    <div className="split-editor">
      <textarea value={left} onChange={(e) => setLeft(e.target.value)} rows={3} />
      <div className="split-divider">⇅ 拆为两段（下段为新身份，不继承旧译文）</div>
      <textarea value={right} onChange={(e) => setRight(e.target.value)} rows={3} />
      <div className="card-foot">
        <button disabled={!left.trim() || !right.trim()} onClick={() => onConfirm(left, right)}>
          确认拆分
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}
