import { useState } from "react";
import { api } from "../api";
import { usePairs, useStore } from "../store";
import { pairKey } from "../lib/pairs";
import { StatusBadge } from "./StatusBadge";
import type { Segment } from "../types";

function SegCell({
  seg,
  side,
  selected,
  conflict,
}: {
  seg: Segment;
  side: "source" | "target";
  selected: boolean;
  conflict: boolean;
}) {
  const { toggleSelect, docName, run } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seg.text);

  return (
    <div className={`seg ${selected ? "selected" : ""} ${conflict ? "conflict" : ""}`}>
      <div className="seg-head">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => toggleSelect(side, seg.id)}
          title="选择以拆分/合并/人工对应"
        />
        <code className="seg-id">{seg.id}</code>
        <StatusBadge status={seg.status} />
      </div>
      {editing ? (
        <div>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} />
          <div className="seg-actions">
            <button onClick={() => { setEditing(false); setDraft(seg.text); }}>取消</button>
            <button className="primary" onClick={() =>
              docName && run(() => api.edit(docName, seg.id, draft)).then(() => setEditing(false))
            }>
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="seg-text" onDoubleClick={() => setEditing(true)} title="双击编辑">
          {seg.text}
        </div>
      )}
    </div>
  );
}

export function PairTable() {
  const pairs = usePairs();
  const { state, docName, run, selected } = useStore();
  if (!state) return null;
  const segs = state.document.segments;

  const isSelected = (side: "source" | "target", id: string) => selected[side].has(id);
  const srcSelected = [...selected.source].sort(
    (a, b) => state.document.order.source.indexOf(a) - state.document.order.source.indexOf(b)
  );
  const tgtSelected = [...selected.target].sort(
    (a, b) => state.document.order.target.indexOf(a) - state.document.order.target.indexOf(b)
  );

  const splitSel = (side: "source" | "target") => {
    const ids = side === "source" ? srcSelected : tgtSelected;
    const first = ids[0];
    if (!first || ids.length !== 1) return;
    const raw = prompt("拆分为多段（每行一个片段）：", segs[first].text);
    if (raw === null) return;
    const parts = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && docName) void run(() => api.split(docName, first, parts, side));
  };

  const mergeSel = (side: "source" | "target") => {
    const ids = side === "source" ? srcSelected : tgtSelected;
    if (ids.length < 2 || !docName) return;
    void run(() => api.merge(docName, ids, side));
  };

  const linkSel = () => {
    if ((srcSelected.length + tgtSelected.length) < 2 || !docName) return;
    if (srcSelected.length === 0 || tgtSelected.length === 0) {
      alert("人工对应需要在两侧各选至少一个段落");
      return;
    }
    void run(() => api.correspond(docName, srcSelected, tgtSelected));
  };

  return (
    <div>
      <div className="bulk-bar">
        <span>已选：源 {srcSelected.length} / 译 {tgtSelected.length}</span>
        <button disabled={srcSelected.length !== 1} onClick={() => splitSel("source")}>拆源段</button>
        <button disabled={srcSelected.length < 2} onClick={() => mergeSel("source")}>合源段</button>
        <button disabled={tgtSelected.length !== 1} onClick={() => splitSel("target")}>拆译段</button>
        <button disabled={tgtSelected.length < 2} onClick={() => mergeSel("target")}>合译段</button>
        <button className="primary" disabled={!srcSelected.length || !tgtSelected.length} onClick={linkSel}>
          人工对应
        </button>
      </div>

      <div className="pair-row pair-head">
        <div>{state.document.source_lang} 源文</div>
        <div className="pair-link-col">状态</div>
        <div>{state.document.target_lang} 译文</div>
      </div>

      {pairs.map((pair, index) => {
        const conflict = pair.state === "conflict";
        return (
          <div className={`pair-row ${conflict ? "row-conflict" : ""} ${pair.state === "none" ? "row-none" : ""}`}
               key={pairKey(pair, index)}>
            <div className="pair-cell">
              {pair.source_ids.map((id) => (
                <SegCell key={id} seg={segs[id]} side="source" selected={isSelected("source", id)} conflict={conflict} />
              ))}
              {!pair.source_ids.length && <div className="empty-cell">（无源段）</div>}
            </div>
            <div className="pair-link-col">
              {pair.state === "active" && <span className="link-ok">对应</span>}
              {pair.state === "none" && <span className="link-none">未对应</span>}
              {conflict && (
                <div className="conflict-box">
                  <span className="link-conflict">冲突待处理</span>
                  {pair.group_id && (
                    <>
                      <button onClick={() => docName && run(() => api.resolve(docName, pair.group_id!, "keep"))}>
                        保留新对应
                      </button>
                      <button onClick={() => docName && run(() => api.resolve(docName, pair.group_id!, "detach"))}>
                        撤回（译文保留）
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="pair-cell">
              {pair.target_ids.map((id) => (
                <SegCell key={id} seg={segs[id]} side="target" selected={isSelected("target", id)} conflict={conflict} />
              ))}
              {!pair.target_ids.length && <div className="empty-cell">（无译文）</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
