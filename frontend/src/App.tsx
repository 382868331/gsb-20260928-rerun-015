import { useEffect, useState } from "react";
import { Toolbar } from "./components/Toolbar";
import { PairTable } from "./components/PairTable";
import { ReportBanner } from "./components/ReportBanner";
import { UpdateDialog } from "./components/UpdateDialog";
import { useStore } from "./store";

export default function App() {
  const { state, error, load, loading } = useStore();
  const [showUpdate, setShowUpdate] = useState(false);

  useEffect(() => {
    void load("示例：产品说明");
  }, [load]);

  return (
    <div className="app">
      <header>
        <h1>多语言内容制作平台</h1>
        <span className="subtitle">段落身份稳定 · 源文挪动不废译文 · 冲突由人工裁决</span>
      </header>
      {error && <div className="error-bar">{error}（请确认后端已启动：python -m mlcp.server）</div>}
      {state && (
        <>
          <Toolbar onShowUpdate={() => setShowUpdate(true)} />
          <ReportBanner />
          {loading && <div className="loading">处理中…</div>}
          <PairTable />
          {showUpdate && <UpdateDialog onClose={() => setShowUpdate(false)} />}
        </>
      )}
    </div>
  );
}
