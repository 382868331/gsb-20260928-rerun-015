import { useStore } from "../store";

export function ReportBanner() {
  const { state, report } = useStore();
  if (!state || !report) return null;
  const changedCount = report.changed.length;
  const affected = new Set(report.affected_targets).size;
  return (
    <div className="report">
      <span className="badge badge-moved">挪动 {report.moved.length}</span>
      <span className="badge badge-changed">实质改动 {changedCount}</span>
      <span className="badge badge-new">新增 {report.new.length}</span>
      <span className="badge badge-missing">缺失 {report.missing.length}</span>
      {changedCount > 0 && (
        <em className="report-note">{affected} 段旧译文受影响，已标为冲突，确认后才会替换，不会自动丢弃。</em>
      )}
    </div>
  );
}
