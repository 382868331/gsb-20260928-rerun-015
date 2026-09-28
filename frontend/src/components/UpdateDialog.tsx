import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { docName, state, run } = useStore();
  const [text, setText] = useState(
    () => state?.document.order.source.map((id) => state.document.segments[id].text).join("\n") ?? ""
  );
  if (!docName) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>发布新源文</h3>
        <p className="hint">每行一段。仅挪动位置会保留译文；实质改动会标出受影响译文并生成待处理对应。</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} />
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() =>
            run(() => api.updateSource(docName, text.split("\n").map((s) => s.trim()).filter(Boolean)))
              .then(onClose)
          }>
            更新并对比
          </button>
        </div>
      </div>
    </div>
  );
}
