"""mlcp — 多语言内容制作平台核心包（段落身份、对齐、版本与导出）。"""

from .model import Document, Segment, LinkGroup, Revision
from .alignment import (
    split_segment,
    merge_segments,
    manual_correspond,
    resolve_conflict,
    update_source,
)
from .history import commit, undo, list_revisions
from .pairs import build_pairs, Pair
from .export import export_json, export_txt
from .store import save_document, load_document

__all__ = [
    "Document",
    "Segment",
    "LinkGroup",
    "Revision",
    "split_segment",
    "merge_segments",
    "manual_correspond",
    "resolve_conflict",
    "update_source",
    "commit",
    "undo",
    "list_revisions",
    "build_pairs",
    "Pair",
    "export_json",
    "export_txt",
    "save_document",
    "load_document",
]
