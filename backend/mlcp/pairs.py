"""页面展示与导出共用的对应关系构建。

唯一事实来源：文档的 LinkGroup。编辑器行与导出文件必须由同一套逻辑生成，
因此本模块的算法与前端 src/lib/pairs.ts 保持逐行一致（见测试test_roundtrip）。
"""

from __future__ import annotations

from dataclasses import dataclass

from .model import Document, LinkGroup


@dataclass
class Pair:
    source_ids: list[str]
    target_ids: list[str]
    state: str  # active | conflict | none
    group_id: str | None

    @property
    def is_conflict(self) -> bool:
        return self.state == "conflict"


def build_pairs(doc: Document) -> list[Pair]:
    visible_groups = [g for g in doc.groups if g.state != "retired"]

    # 以源文顺序锚定：每组按其在源文序列中最先出现的成员排序
    src_index = {sid: i for i, sid in enumerate(doc.order["source"])}
    tgt_index = {tid: i for i, tid in enumerate(doc.order["target"])}

    def anchor(g: LinkGroup) -> tuple[int, int]:
        s_pos = [src_index[i] for i in g.source_ids if i in src_index]
        t_pos = [tgt_index[i] for i in g.target_ids if i in tgt_index]
        return (min(s_pos) if s_pos else 10**9,
                min(t_pos) if t_pos else 10**9)

    pairs: list[Pair] = []
    grouped_sources: set[str] = set()
    grouped_targets: set[str] = set()
    for g in sorted(visible_groups, key=anchor):
        pairs.append(Pair(
            source_ids=list(g.source_ids),
            target_ids=list(g.target_ids),
            state=g.state,
            group_id=g.id,
        ))
        grouped_sources.update(g.source_ids)
        grouped_targets.update(g.target_ids)

    # 无对应源段（含 changed/new 尚未处理）
    for sid in doc.order["source"]:
        if sid not in grouped_sources:
            pairs.append(Pair([sid], [], "none", None))
    # 无对应译文段（missing 源文留下的译文等）
    for tid in doc.order["target"]:
        if tid not in grouped_targets:
            pairs.append(Pair([], [tid], "none", None))
    return pairs
