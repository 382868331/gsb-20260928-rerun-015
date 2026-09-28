"""第一版验收测试：身份保持、挪动/改动、冲突、拆后再合并、导出一致、撤销。"""

import pytest

from mlcp.model import new_document
from mlcp.alignment import (
    split_segment,
    merge_segments,
    manual_correspond,
    resolve_conflict,
    update_source,
)
from mlcp.history import commit, undo, list_revisions
from mlcp.pairs import build_pairs
from mlcp.export import export_json, export_txt
from mlcp.store import save_document, load_document
from mlcp.ids import IdGen


SRC = ["第一段。", "第二段。", "第三段。"]
TGT = ["Para one.", "Para two.", "Para three."]


def make_doc():
    ids = IdGen("x")
    return new_document("demo", SRC, TGT, id_func=ids), ids


def test_source_move_keeps_translations():
    doc, _ = make_doc()
    original_map = {
        tuple(p.source_ids): tuple(p.target_ids)
        for p in build_pairs(doc) if p.state == "active"
    }
    # 源文仅挪动顺序：3,1,2，文本不变
    report = update_source(doc, [SRC[2], SRC[0], SRC[1]])
    assert set(report["moved"]) == set(doc.order["source"])
    assert report["changed"] == [] and report["new"] == [] and report["missing"] == []
    # 译文全部保留且对应关系不变
    moved_map = {
        tuple(p.source_ids): tuple(p.target_ids)
        for p in build_pairs(doc) if p.state == "active"
    }
    assert moved_map == original_map
    assert doc.ordered("target") and all(s.text for s in doc.ordered("target"))


def test_substantive_change_reports_affected_targets():
    doc, _ = make_doc()
    old_two = doc.order["source"][1]
    tgt_two = doc.order["target"][1]
    report = update_source(doc, [SRC[0], "第二段内容被实质修改了。", SRC[2]])
    assert len(report["changed"]) == 1
    assert report["changed"][0]["old"] == old_two
    assert tgt_two in report["affected_targets"]
    # 旧译文没有作废：仍以 conflict 组保留，等用户处理
    conflict_groups = [g for g in doc.groups if g.state == "conflict"]
    assert any(tgt_two in g.target_ids for g in conflict_groups)
    assert doc.segments[tgt_two].text == "Para two."


def test_conflict_must_be_resolved_by_user_without_dropping():
    doc, _ = make_doc()
    s0, s1 = doc.order["source"][:2]
    t0 = doc.order["target"][0]
    # 把两个源段强行对应到同一译文：旧组退役，新组 conflict
    gid = manual_correspond(doc, [s0, s1], [t0])
    group = next(g for g in doc.groups if g.id == gid)
    assert group.state == "conflict"
    # 被覆盖的旧译文仍然存在
    t1 = doc.order["target"][1]
    assert doc.segments[t1].retired is False
    with pytest.raises(ValueError):
        manual_correspond(doc, [], [t1])
    # 用户确认后才转 active
    resolve_conflict(doc, gid, "keep")
    assert group.state == "active"


def test_split_then_merge_roundtrip_keeps_target():
    doc, ids = make_doc()
    s1 = doc.order["source"][1]
    t1 = doc.order["target"][1]
    commit(doc, "initial", id_func=ids)

    a, b, c = split_segment(doc, s1, ["第二", "段内", "容。"], id_func=ids)
    # 拆分后是 1 源:N -> 1 译 的组，译文完整保留
    group = next(g for g in doc.groups if g.state == "active" and t1 in g.target_ids)
    assert group.source_ids == [a, b, c]
    assert doc.segments[t1].text == "Para two."
    # 页面与导出此时一致
    page_pairs = [(tuple(p.source_ids), tuple(p.target_ids), p.state)
                  for p in build_pairs(doc)]
    exported = export_json(doc)
    exp_pairs = [(tuple(r["source_ids"]), tuple(r["target_ids"]), r["state"])
                 for r in exported["pairs"]]
    assert page_pairs == exp_pairs

    # 再次合回：译文对应仍在
    merged = merge_segments(doc, [a, b, c], id_func=ids)
    group2 = next(g for g in doc.groups if g.state == "active" and t1 in g.target_ids)
    assert group2.source_ids == [merged]
    merged_text = doc.segments[merged].text
    assert merged_text == "第二段内容。"
    # 合并后页面与导出依旧一致
    page_pairs2 = [(tuple(p.source_ids), tuple(p.target_ids), p.state)
                   for p in build_pairs(doc)]
    exp_pairs2 = [(tuple(r["source_ids"]), tuple(r["target_ids"]), r["state"])
                  for r in export_json(doc)["pairs"]]
    assert page_pairs2 == exp_pairs2
    # txt 导出行数与配对行数一致
    assert len([ln for ln in export_txt(doc).splitlines() if ln]) == len(page_pairs2)


def test_save_and_undo_keep_identities(tmp_path):
    doc, ids = make_doc()
    commit(doc, "v1", id_func=ids)
    s0 = doc.order["source"][0]
    t0 = doc.order["target"][0]
    split_segment(doc, s0, ["第一", "段。"], id_func=ids)
    commit(doc, "v2 split", id_func=ids)
    new_ids = set(doc.order["source"]) | set(doc.order["target"])

    path = tmp_path / "doc.json"
    save_document(doc, path)
    loaded = load_document(path)
    assert loaded.order == doc.order
    assert any(s.origin for s in loaded.segments.values())

    # 撤销回 v1：身份恢复且 t0 仍与原源段对应
    undo(loaded)
    undo(loaded)
    assert s0 in loaded.order["source"] and t0 in loaded.order["target"]
    pairs = build_pairs(loaded)
    assert any(p.source_ids == [s0] and p.target_ids == [t0] for p in pairs)
    # 保存再加载后撤销，身份仍稳定
    save_document(loaded, path)
    loaded2 = load_document(path)
    assert set(loaded2.order["source"]) <= set(new_ids) | {s0}
    assert list_revisions(loaded2) == []


def test_missing_source_keeps_orphan_target():
    doc, _ = make_doc()
    tgt_ids = list(doc.order["target"])
    report = update_source(doc, [SRC[0], SRC[1]])  # 第三段消失
    assert report["missing"] and tgt_ids[2] in doc.segments
    pair_rows = build_pairs(doc)
    assert any(p.source_ids == [] and p.target_ids == [tgt_ids[2]] for p in pair_rows)
