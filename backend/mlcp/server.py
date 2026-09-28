"""标准库实现的 HTTP API（无第三方依赖）。

启动：python -m mlcp.server [--port 8000] [--data data/demo.json]
所有内容版本保存在内存文档中；可随时 GET /api/documents/<id>/save?path=...
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .model import Document, new_document
from . import alignment, history, export as export_mod, store

DOCUMENTS: dict[str, Document] = {}


class ApiError(Exception):
    pass


def seed_demo() -> str:
    doc = new_document(
        "示例：产品说明",
        ["本产品支持多语言内容制作。", "更新源文时译文不会丢失。", "拆分与合并保持段落身份。"],
        ["This product supports multilingual content production.",
         "Translations survive source updates.",
         "Split and merge preserve paragraph identity."],
    )
    DOCUMENTS[doc.name] = doc
    return doc.name


def _state(doc: Document) -> dict:
    return {
        "document": doc.to_dict(),
        "pairs": [
            {
                "source_ids": p.source_ids,
                "target_ids": p.target_ids,
                "state": p.state,
                "group_id": p.group_id,
            }
            for p in export_mod.build_pairs(doc)
        ],
        "revisions": history.list_revisions(doc),
    }


def route(method: str, path: str, query: dict, body: dict):
    parts = [p for p in path.split("/") if p]

    if method == "POST" and parts == ["api", "documents"]:
        doc = new_document(
            name=body["name"],
            source_paragraphs=body.get("source", []),
            target_paragraphs=body.get("target"),
            source_lang=body.get("source_lang", "zh"),
            target_lang=body.get("target_lang", "en"),
        )
        DOCUMENTS[doc.name] = doc
        return _state(doc)

    if method == "GET" and parts == ["api", "documents"]:
        return {"documents": list(DOCUMENTS)}

    if len(parts) >= 2 and parts[0] == "api" and parts[1] == "documents":
        doc_id = parts[2]
        if doc_id not in DOCUMENTS:
            raise ApiError(f"文档 {doc_id} 不存在", 404)
        doc = DOCUMENTS[doc_id]
        sub = parts[3:] if len(parts) > 3 else []

        if method == "GET" and not sub:
            return _state(doc)

        if method == "POST" and sub == ["split"]:
            history.commit(doc, body.get("note", "拆分段落"))
            alignment.split_segment(doc, body["seg_id"], body["parts"], body.get("side", "source"))
            return _state(doc)
        if method == "POST" and sub == ["merge"]:
            history.commit(doc, body.get("note", "合并段落"))
            alignment.merge_segments(doc, body["seg_ids"], body.get("side", "source"), body.get("separator", ""))
            return _state(doc)
        if method == "POST" and sub == ["correspond"]:
            history.commit(doc, "人工对应")
            gid = alignment.manual_correspond(doc, body["source_ids"], body["target_ids"])
            result = _state(doc)
            result["group_id"] = gid
            return result
        if method == "POST" and sub == ["resolve"]:
            history.commit(doc, "处理冲突")
            alignment.resolve_conflict(doc, body["group_id"], body["action"])
            return _state(doc)
        if method == "POST" and sub == ["update-source"]:
            history.commit(doc, "源文更新")
            report = alignment.update_source(doc, body["paragraphs"])
            result = _state(doc)
            result["report"] = report
            return result
        if method == "POST" and sub == ["edit"]:
            history.commit(doc, body.get("note", "编辑文本"))
            seg = doc.segments[body["seg_id"]]
            seg.text = body["text"]
            return _state(doc)
        if method == "POST" and sub == ["undo"]:
            history.undo(doc)
            return _state(doc)
        if method == "POST" and sub == ["save"]:
            store.save_document(doc, body["path"])
            return {"saved": body["path"]}
        if method == "POST" and sub == ["load"]:
            loaded = store.load_document(body["path"])
            DOCUMENTS[loaded.name] = loaded
            return _state(loaded)
        if method == "GET" and sub == ["export", "json"]:
            return export_mod.export_json(doc)
        if method == "GET" and sub == ["export", "txt"]:
            return export_mod.export_txt(doc)

    raise ApiError("not found", 404)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload, content_type="application/json; charset=utf-8"):
        if isinstance(payload, (dict, list)):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        else:
            data = str(payload).encode("utf-8")
            content_type = "text/plain; charset=utf-8"
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        self._dispatch("GET", parsed, {})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "请求体不是合法 JSON"})
            return
        self._dispatch("POST", parsed, body)

    def _dispatch(self, method, parsed, body):
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            result = route(method, parsed.path, query, body)
            self._send(200, result)
        except ApiError as exc:
            code = exc.args[1] if len(exc.args) > 1 else 400
            self._send(code, {"error": str(exc.args[0])})
        except (KeyError, ValueError) as exc:
            self._send(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": repr(exc)})

    def log_message(self, fmt, *args):  # 精简日志
        print(f"[api] {self.command} {self.path}")


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)
    demo_id = seed_demo()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"MLCP API 已启动: http://{args.host}:{args.port}  (示例文档: {demo_id})")
    server.serve_forever()


if __name__ == "__main__":
    main()
