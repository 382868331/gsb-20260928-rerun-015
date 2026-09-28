"""导出：与编辑器页面使用同一个 build_pairs，保证对应关系一致。"""

from __future__ import annotations

import json

from .model import Document
from .pairs import build_pairs


def _texts(doc: Document, ids: list[str]) -> list[str]:
    return [doc.segments[i].text for i in ids if i in doc.segments]


def export_json(doc: Document) -> dict:
    """结构化导出：每一行携带段落身份，拆/合并不影响追踪。"""
    rows = []
    for idx, pair in enumerate(build_pairs(doc), 1):
        rows.append({
            "row": idx,
            "state": pair.state,
            "group_id": pair.group_id,
            "source_ids": pair.source_ids,
            "target_ids": pair.target_ids,
            "source": _texts(doc, pair.source_ids),
            "target": _texts(doc, pair.target_ids),
        })
    return {
        "name": doc.name,
        "source_lang": doc.source_lang,
        "target_lang": doc.target_lang,
        "pairs": rows,
    }


def export_txt(doc: Document) -> str:
    """纯文本导出（双栏），行序与结构化导出一致。"""
    lines = []
    for pair in build_pairs(doc):
        src = " ".join(_texts(doc, pair.source_ids))
        tgt = " ".join(_texts(doc, pair.target_ids))
        flag = "" if pair.state == "active" else f"[{pair.state}] "
        lines.append(f"{flag}{src}\t{tgt}")
    return "\n".join(lines)


def export_json_string(doc: Document) -> str:
    return json.dumps(export_json(doc), ensure_ascii=False, indent=2)
