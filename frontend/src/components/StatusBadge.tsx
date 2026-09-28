import type { SegStatus } from "../types";

const LABEL: Record<SegStatus, string> = {
  normal: "",
  moved: "已挪动",
  changed: "已改动",
  new: "新增",
  missing: "源文缺失",
  review: "待复核",
};

export function StatusBadge({ status }: { status: SegStatus }) {
  if (status === "normal") return null;
  return <span className={`badge badge-${status}`}>{LABEL[status]}</span>;
}
