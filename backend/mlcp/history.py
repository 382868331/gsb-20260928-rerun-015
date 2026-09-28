"""版本管理：每次操作保存不可变快照，undo 回滚到上一版本。

保存与撤销都基于完整文档快照（含段落 id 与分组 id），因此段落身份在
保存、撤销、导出全流程中稳定不变。
"""

from __future__ import annotations

import copy

from .ids import new_id
from .model import Document, Revision


def commit(doc: Document, note: str, id_func=None) -> str:
    """把当前文档状态固化为一个版本，返回版本 id。"""
    id_func = id_func or new_id
    snapshot = copy.deepcopy(doc.to_dict())
    snapshot.pop("revisions", None)
    rev = Revision(id=id_func("r"), note=note, snapshot=snapshot)
    doc.revisions.append(rev)
    return rev.id


def undo(doc: Document) -> str | None:
    """回滚到最近一次 commit 的快照；无历史时返回 None。"""
    if not doc.revisions:
        return None
    rev = doc.revisions.pop()
    restored = Document.from_dict(copy.deepcopy(rev.snapshot))
    doc.name = restored.name
    doc.source_lang = restored.source_lang
    doc.target_lang = restored.target_lang
    doc.order = restored.order
    doc.segments = restored.segments
    doc.groups = restored.groups
    return rev.id


def list_revisions(doc: Document) -> list[dict]:
    return [{"id": r.id, "note": r.note} for r in doc.revisions]
