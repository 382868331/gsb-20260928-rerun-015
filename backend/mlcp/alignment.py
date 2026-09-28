"""段落操作与源文更新：拆分、合并、人工对应、冲突处理、源文更新。

铁律：任何操作都不删除已有译文段落。译文与源文的对应只通过 LinkGroup 表达；
关系不确定时标记为 conflict 交用户处理，绝不静默丢弃。
"""

from __future__ import annotations

from .ids import new_id
from .model import Document, Segment, LinkGroup


def _retire_group(doc: Document, group: LinkGroup) -> None:
    group.state = "retired"


def _retire_segment_keep_text(doc: Document, seg: Segment) -> None:
    """段落退出当前序列（拆分/合并后），保留其文本与译文身份。"""
    seg.retired = True
    doc.order[seg.side] = [i for i in doc.order[seg.side] if i != seg.id]


def split_segment(
    doc: Document,
    seg_id: str,
    parts: list[str],
    side: str = "source",
    id_func=None,
) -> list[str]:
    """把段落按 parts 拆成多段。

    旧段落保留为 retired；源文拆出 N 段、译文为 1 段时建立 1:N 分组，
    译文文本完整保留，等用户进一步切分或人工对应。
    返回新段落 id 列表。
    """
    id_func = id_func or new_id
    parts = [p for p in parts if p != ""]
    if seg_id not in doc.segments or len(parts) < 2:
        raise ValueError("split 需要存在的段落且至少两个非空片段")
    original = doc.segments[seg_id]
    if original.retired:
        raise ValueError("不能拆分已退出序列的段落")

    other = "target" if side == "source" else "source"
    affected = [g for g in doc.groups if g.touches(side, seg_id) and g.state != "retired"]
    other_ids: list[str] = []
    for g in affected:
        _retire_group(doc, g)
        other_ids += getattr(g, f"{other}_ids")
    other_ids = list(dict.fromkeys(other_ids))

    idx = doc.order[side].index(seg_id)
    new_ids: list[str] = []
    prefix = "s" if side == "source" else "t"
    for offset, text in enumerate(parts):
        seg = Segment(
            id=id_func(prefix),
            side=side,  # type: ignore[arg-type]
            text=text,
            origin=[seg_id],
        )
        doc.segments[seg.id] = seg
        doc.order[side].insert(idx + offset, seg.id)
        new_ids.append(seg.id)

    _retire_segment_keep_text(doc, original)

    if other_ids:
        if side == "source":
            doc.groups.append(
                LinkGroup(
                    id=id_func("g"), source_ids=new_ids, target_ids=other_ids
                )
            )
        else:
            doc.groups.append(
                LinkGroup(
                    id=id_func("g"), source_ids=other_ids, target_ids=new_ids
                )
            )
    return new_ids


def merge_segments(
    doc: Document,
    seg_ids: list[str],
    side: str = "source",
    separator: str = "",
    id_func=None,
) -> str:
    """按给定顺序合并同侧段落为新段落；旧段落 retired 保留。

    若这些段落恰好是由同一段落拆分而来（拆后再合并场景），新段落 origin
    指向更早祖先；对侧译文分组合并为 N:1，译文不丢。
    返回新段落 id。
    """
    id_func = id_func or new_id
    seg_ids = list(seg_ids)
    segs = [doc.segments.get(i) for i in seg_ids]
    if len(seg_ids) < 2 or any(s is None or s.retired for s in segs):
        raise ValueError("merge 需要至少两个当前序列中的段落")
    sides = {s.side for s in segs}
    if len(sides) != 1:
        raise ValueError("只能合并同一侧的段落")
    order = doc.order[side]
    positions = [order.index(i) for i in seg_ids]
    if positions != list(range(min(positions), max(positions) + 1)):
        raise ValueError("只能合并相邻段落")

    other = "target" if side == "source" else "source"
    affected = [
        g for g in doc.groups
        if g.state != "retired"
        and any(g.touches(side, i) for i in seg_ids)
    ]
    other_ids: list[str] = []
    for g in affected:
        _retire_group(doc, g)
        other_ids += getattr(g, f"{other}_ids")
    other_ids = list(dict.fromkeys(other_ids))

    origins = list(dict.fromkeys(o for s in segs for o in s.origin)) or list(seg_ids)
    merged = Segment(
        id=id_func("s" if side == "source" else "t"),
        side=side,  # type: ignore[arg-type]
        text=separator.join(s.text for s in segs),
        origin=origins,
    )
    doc.segments[merged.id] = merged
    idx = min(positions)
    for i in seg_ids:
        doc.order[side].remove(i)
    doc.order[side].insert(idx, merged.id)
    for s in segs:
        _retire_segment_keep_text(doc, s)

    if other_ids:
        if side == "source":
            doc.groups.append(
                LinkGroup(id=id_func("g"), source_ids=[merged.id], target_ids=other_ids)
            )
        else:
            doc.groups.append(
                LinkGroup(id=id_func("g"), source_ids=other_ids, target_ids=[merged.id])
            )
    return merged.id


def manual_correspond(
    doc: Document,
    source_ids: list[str],
    target_ids: list[str],
    id_func=None,
) -> str:
    """人工指定对应关系（支持任意基数）。

    与新关系重叠的旧分组全部 retired；但若形成歧义（某段还被另一个未处理
    分组引用），新组标记为 conflict 并保留旧译文，等待 resolve_conflict。
    """
    id_func = id_func or new_id
    source_ids = list(source_ids)
    target_ids = list(target_ids)
    if not source_ids or not target_ids:
        raise ValueError("人工对应必须同时选择源段与译文段")
    for i in source_ids + target_ids:
        seg = doc.segments.get(i)
        if seg is None or seg.retired:
            raise ValueError(f"段落 {i} 不存在或已退出序列")

    involved = set(source_ids) | set(target_ids)
    overlapping = [
        g for g in doc.groups
        if g.state != "retired"
        and (any(i in g.source_ids for i in source_ids)
             or any(i in g.target_ids for i in target_ids))
    ]
    for g in overlapping:
        _retire_group(doc, g)

    # 歧义检测：重叠组中存在未被本次选择覆盖的第三方段落
    covered = set(source_ids) | set(target_ids)
    ambiguous = any(
        sid not in covered
        for g in overlapping
        for sid in (g.source_ids + g.target_ids)
    )
    group = LinkGroup(
        id=id_func("g"),
        source_ids=source_ids,
        target_ids=target_ids,
        origin="manual",
        state="conflict" if ambiguous else "active",
    )
    doc.groups.append(group)
    return group.id


def resolve_conflict(doc: Document, group_id: str, action: str) -> None:
    """处理冲突分组。

    action:
      keep   — 确认该人工对应，转为 active（旧译文仍在 retired 组中可查）
      detach — 放弃这次对应：组 retired，所涉双方恢复为无对应，译文不删除
    """
    group = next((g for g in doc.groups if g.id == group_id), None)
    if group is None or group.state != "conflict":
        raise ValueError("分组不存在或不在冲突状态")
    if action == "keep":
        group.state = "active"
    elif action == "detach":
        group.state = "retired"
    else:
        raise ValueError("action 必须是 keep 或 detach")


def update_source(
    doc: Document,
    new_paragraphs: list[str],
    id_func=None,
) -> dict:
    """源文发布新版本后重新对齐。

    - 文本相同仅位置变化：标记 moved，沿用原分组，译文保留。
    - 文本实质改变：标记 changed，旧分组保留但转 conflict（旧译文不丢，等用户处理），
      并报告受影响译文范围。
    - 新增段落标记 new；源文中消失的段落标记 missing，其译文保留为无对应。
    返回受影响范围报告：{moved, changed(含 target 段), new, missing}。
    """
    id_func = id_func or new_id
    old_sources = doc.ordered("source")
    text_to_ids: dict[str, list[str]] = {}
    for seg in old_sources:
        text_to_ids.setdefault(seg.text, []).append(seg.id)

    consumed: set[str] = set()
    new_order: list[str] = []
    report = {"moved": [], "changed": [], "new": [], "missing": [],
              "affected_targets": []}

    # 新位置映射（同文本多份时按出现顺序消费）
    old_positions = {seg.id: i for i, seg in enumerate(old_sources)}
    matched_old: list[str | None] = []
    for text in new_paragraphs:
        candidates = [i for i in text_to_ids.get(text, []) if i not in consumed]
        if candidates:
            seg_id = candidates[0]
            consumed.add(seg_id)
            new_order.append(seg_id)
            matched_old.append(seg_id)
        else:
            seg = Segment(id=id_func("s"), side="source", text=text, status="new")
            doc.segments[seg.id] = seg
            new_order.append(seg.id)
            matched_old.append(None)
            report["new"].append(seg.id)

    # moved 判定：匹配段的新位置序列与旧位置不一致
    new_positions = {sid: i for i, sid in enumerate(new_order)}
    for sid in new_order:
        if sid in old_positions and new_positions[sid] != old_positions[sid]:
            doc.segments[sid].status = "moved"
            report["moved"].append(sid)
        elif sid in old_positions:
            doc.segments[sid].status = "normal"

    # 未匹配的旧段与新段：优先用编辑距离找相似段（挪动且有改动），
    # 找不到时按位置顺序对齐（该位置内容实质改变），仍有剩余才算新增/消失。
    unmatched_old = [s for s in old_sources if s.id not in consumed]
    unmatched_new_idx = [i for i, m in enumerate(matched_old) if m is None]

    def _similar(old_seg, ni):
        new_text = new_paragraphs[ni]
        longest = max(len(old_seg.text), len(new_text), 1)
        return 1 - _levenshtein(old_seg.text, new_text) / longest >= 0.35

    changed_pairs: list[tuple[object, int]] = []
    for old_seg in unmatched_old:
        candidates = [ni for ni in unmatched_new_idx if _similar(old_seg, ni)]
        if candidates:
            ni = min(candidates, key=lambda i: _levenshtein(old_seg.text, new_paragraphs[i]))
            changed_pairs.append((old_seg, ni))
            unmatched_new_idx.remove(ni)
    changed_old_ids = {o.id for o, _ in changed_pairs}
    remaining_old = [s for s in unmatched_old if s.id not in changed_old_ids]
    for old_seg, ni in zip(remaining_old, unmatched_new_idx):
        changed_pairs.append((old_seg, ni))
    matched_old_idx = {ni for _, ni in changed_pairs}
    for ni in unmatched_new_idx:
        if ni not in matched_old_idx:
            pass  # 保持 new，译文无对应

    for old_seg, ni in changed_pairs:
        new_id_seg = new_order[ni]
        doc.segments[new_id_seg].status = "changed"
        doc.segments[new_id_seg].origin = [old_seg.id]
        targets = []
        for g in doc.groups:
            if g.state != "retired" and old_seg.id in g.source_ids:
                targets.extend(g.target_ids)
                _retire_group(doc, g)
        targets = list(dict.fromkeys(targets))
        if targets:
            doc.groups.append(LinkGroup(
                id=id_func("g"),
                source_ids=[new_id_seg],
                target_ids=targets,
                origin="auto",
                state="conflict",
            ))
            report["affected_targets"].extend(targets)
        report["changed"].append(
            {"old": old_seg.id, "new": new_id_seg, "targets": targets}
        )
        _retire_segment_keep_text(doc, old_seg)

    # 真正消失的旧段：退出序列，旧分组退役（译文文本保留，成为无对应段）
    for seg in old_sources:
        if seg.id not in consumed and seg.id not in changed_old_ids:
            seg.status = "missing"
            for g in doc.groups:
                if g.state != "retired" and seg.id in g.source_ids:
                    _retire_group(doc, g)
            _retire_segment_keep_text(doc, seg)
            report["missing"].append(seg.id)

    # 新增段保持 new；译文无对应
    doc.order["source"] = new_order
    return report


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (ca != cb),
            ))
        prev = cur
    return prev[-1]
