"""核心数据模型。

设计要点：
- 段落（Segment）拥有稳定身份 id；拆分/合并不让译文消失，旧段落以 retired 标记保留。
- 对应关系以分组（LinkGroup）表达，支持 1:1、1:N、N:1、N:N。
- 冲突分组 state="conflict" 仍然保留旧译文，由用户 resolve_conflict 决定取舍。
- 每次操作追加一条 Revision（快照），undo 即回滚快照；保存为 JSON，身份不丢失。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Literal

Side = Literal["source", "target"]
GroupState = Literal["active", "conflict", "retired"]
GroupOrigin = Literal["auto", "manual"]
SegStatus = Literal[
    "normal", "moved", "changed", "new", "missing", "review"
]


@dataclass
class Segment:
    id: str
    side: Side
    text: str
    status: SegStatus = "normal"
    # 溯源：本段由哪些段落拆分/合并而来，用于拆后再合并恢复身份
    origin: list[str] = field(default_factory=list)
    retired: bool = False


@dataclass
class LinkGroup:
    id: str
    source_ids: list[str] = field(default_factory=list)
    target_ids: list[str] = field(default_factory=list)
    origin: GroupOrigin = "auto"
    state: GroupState = "active"

    def touches(self, side: str, seg_id: str) -> bool:
        return seg_id in (self.source_ids if side == "source" else self.target_ids)


@dataclass
class Revision:
    id: str
    note: str
    snapshot: dict


@dataclass
class Document:
    name: str = "untitled"
    source_lang: str = "zh"
    target_lang: str = "en"
    # 两侧的段落顺序，仅保存当前生效段落的 id
    order: dict[str, list[str]] = field(
        default_factory=lambda: {"source": [], "target": []}
    )
    segments: dict[str, Segment] = field(default_factory=dict)
    groups: list[LinkGroup] = field(default_factory=list)
    revisions: list[Revision] = field(default_factory=list)

    # ---- 便捷访问 ----
    def ordered(self, side: Side) -> list[Segment]:
        return [self.segments[i] for i in self.order[side] if i in self.segments]

    def active_groups(self) -> list[LinkGroup]:
        return [g for g in self.groups if g.state == "active"]

    def groups_of(self, side: Side, seg_id: str) -> list[LinkGroup]:
        return [g for g in self.groups if g.state != "retired" and g.touches(side, seg_id)]

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Document":
        doc = cls(name=data.get("name", "untitled"))
        doc.source_lang = data.get("source_lang", "zh")
        doc.target_lang = data.get("target_lang", "en")
        doc.order = {
            "source": list(data.get("order", {}).get("source", [])),
            "target": list(data.get("order", {}).get("target", [])),
        }
        doc.segments = {
            sid: Segment(**sdata) for sid, sdata in data.get("segments", {}).items()
        }
        doc.groups = [LinkGroup(**g) for g in data.get("groups", [])]
        doc.revisions = [Revision(**r) for r in data.get("revisions", [])]
        return doc


def new_document(
    name: str,
    source_paragraphs: list[str],
    target_paragraphs: list[str] | None = None,
    source_lang: str = "zh",
    target_lang: str = "en",
    id_func=None,
) -> Document:
    """按段落列表建文档；提供译文时按位置自动 1:1 对应。"""
    if id_func is None:
        from .ids import new_id as id_func
    doc = Document(name=name, source_lang=source_lang, target_lang=target_lang)
    for text in source_paragraphs:
        seg = Segment(id=id_func("s"), side="source", text=text)
        doc.segments[seg.id] = seg
        doc.order["source"].append(seg.id)
    for text in target_paragraphs or []:
        seg = Segment(id=id_func("t"), side="target", text=text)
        doc.segments[seg.id] = seg
        doc.order["target"].append(seg.id)
    for sid, tid in zip(doc.order["source"], doc.order["target"]):
        doc.groups.append(
            LinkGroup(id=id_func("g"), source_ids=[sid], target_ids=[tid])
        )
    return doc
