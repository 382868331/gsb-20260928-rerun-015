"""端到端 HTTP 流程：创建 → 拆分 → 合并 → 更新 → 导出，身份全程稳定。"""

import json

from mlcp import server


def _call(method, path, body=None):
    result = server.route(method, path, {}, body or {})
    return result


def test_end_to_end_split_merge_export(tmp_path):
    state = _call("POST", "/api/documents", {
        "name": "e2e",
        "source": ["第一段。", "第二段较长内容。", "第三段。"],
        "target": ["One.", "Two is longer.", "Three."],
    })
    doc = state["document"]
    s2 = doc["order"]["source"][1]
    t2 = doc["order"]["target"][1]

    state = _call("POST", "/api/documents/e2e/split", {
        "seg_id": s2, "parts": ["第二段", "较长内容。"],
    })
    page_pairs = [(tuple(p["source_ids"]), tuple(p["target_ids"]), p["state"])
                  for p in state["pairs"]]
    exported = _call("GET", "/api/documents/e2e/export/json")
    export_pairs = [(tuple(r["source_ids"]), tuple(r["target_ids"]), r["state"])
                    for r in exported["pairs"]]
    assert page_pairs == export_pairs

    split_ids = next(p[0] for p in page_pairs if t2 in p[1])
    state = _call("POST", "/api/documents/e2e/merge", {"seg_ids": list(split_ids)})
    exported2 = _call("GET", "/api/documents/e2e/export/json")
    t2_row = next(r for r in exported2["pairs"] if t2 in r["target_ids"])
    assert len(t2_row["source_ids"]) == 1
    assert t2_row["target"] == ["Two is longer."]

    # 撤销两次回到拆分前，身份不变
    _call("POST", "/api/documents/e2e/undo")
    state = _call("POST", "/api/documents/e2e/undo")
    assert s2 in state["document"]["order"]["source"]

    # 保存为 JSON 后重新加载，仍可导出一致结果
    path = str(tmp_path / "e2e.json")
    _call("POST", "/api/documents/e2e/save", {"path": path})
    _call("POST", "/api/documents/e2e/load", {"path": path})
    loaded_export = _call("GET", "/api/documents/e2e/export/json")
    assert json.loads(json.dumps(loaded_export))["name"] == "e2e"


def test_source_update_flow():
    _call("POST", "/api/documents", {
        "name": "upd", "source": ["甲。", "乙。"], "target": ["A.", "B."],
    })
    state = _call("POST", "/api/documents/upd/update-source", {"paragraphs": ["乙。", "甲。"]})
    assert len(state["report"]["moved"]) == 2
    assert state["report"]["changed"] == []
    # 译文关系原样保留
    pairs = state["pairs"]
    assert all(p["state"] == "active" for p in pairs)
