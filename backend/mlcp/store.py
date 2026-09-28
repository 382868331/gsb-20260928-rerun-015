"""JSON 文件持久化；保存/加载保留全部段落与分组身份。"""

from __future__ import annotations

import json
from pathlib import Path

from .model import Document


def save_document(doc: Document, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(doc.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_document(path: str | Path) -> Document:
    return Document.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
