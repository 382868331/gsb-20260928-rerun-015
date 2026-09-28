import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export function Toolbar({ onShowUpdate }: { onShowUpdate: () => void }) {
  const [savePath, setSavePath] = useState("data/saved.json");
  const { docName, state, run } = useStore();
  const revisionCount = state?.revisions.length ?? 0;

  if (!docName) return null;

  return (
    <div className="toolbar">
      <button onClick={() => run(() => api.undo(docName))} disabled={revisionCount === 0}>
        撤销 ({revisionCount})
      </button>
      <button onClick={onShowUpdate}>源文更新…</button>
      <span className="sep" />
      <input
        value={savePath}
        onChange={(e) => setSavePath(e.target.value)}
        placeholder="保存路径"
        className="save-path"
      />
      <button onClick={() => run(async () => {
        await api.save(docName, savePath);
        return api.get(docName);
      })}>
        保存版本
      </button>
      <a className="btn" href={api.exportJsonUrl(docName)} target="_blank" rel="noreferrer">
        导出 JSON
      </a>
      <a className="btn" href={api.exportTxtUrl(docName)} target="_blank" rel="noreferrer">
        导出 TXT
      </a>
    </div>
  );
}
