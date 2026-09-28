import { describe, it, expect } from "vitest";
import { buildPairs } from "./pairs";
import type { DocData } from "../types";

function seg(id: string, side: "source" | "target", text: string, origin: string[] = []) {
  return { id, side, text, status: "normal" as const, origin, retired: false };
}

function doc(orderSource: string[], orderTarget: string[], groups: DocData["groups"], segs: DocData["segments"]): DocData {
  return {
    name: "t", source_lang: "zh", target_lang: "en",
    order: { source: orderSource, target: orderTarget },
    segments: segs, groups,
    revisions: [],
  };
}

describe("buildPairs —— 与后端 mlcp/pairs.py 保持一致", () => {
  it("拆段后 1:N 对应、再合并回 1:1，配对始终锚定同组译文", () => {
    const segs: DocData["segments"] = {
      s1: seg("s1", "source", "第一"),
      s2: seg("s2", "source", "第二整段"),
      s3: seg("s3", "source", "第三"),
      t1: seg("t1", "target", "One"),
      t2: seg("t2", "target", "Two whole"),
      t3: seg("t3", "target", "Three"),
    };
    const g1 = { id: "g1", source_ids: ["s1"], target_ids: ["t1"], origin: "auto" as const, state: "active" as const };
    const g3 = { id: "g3", source_ids: ["s3"], target_ids: ["t3"], origin: "auto" as const, state: "active" as const };

    // 拆分 s2 -> s2a, s2b, 旧段 retired；译文 t2 整段保留
    segs["s2"].retired = true;
    Object.assign(segs, {
      s2a: seg("s2a", "source", "第二前半", ["s2"]),
      s2b: seg("s2b", "source", "后半", ["s2"]),
    });
    const splitGroups = [g1, g3, {
      id: "g2x", source_ids: ["s2a", "s2b"], target_ids: ["t2"],
      origin: "auto" as const, state: "active" as const,
    }];
    const splitDoc = doc(["s1", "s2a", "s2b", "s3"], ["t1", "t2", "t3"], splitGroups, segs);
    const splitPairs = buildPairs(splitDoc);
    expect(splitPairs.find((p) => p.group_id === "g2x")).toMatchObject({
      source_ids: ["s2a", "s2b"], target_ids: ["t2"], state: "active",
    });

    // 再合并 -> s2m；译文仍是同一段 t2
    segs["s2a"].retired = true;
    segs["s2b"].retired = true;
    Object.assign(segs, { s2m: seg("s2m", "source", "第二整段", ["s2"]) });
    const mergedGroups = [g1, g3, {
      id: "g2m", source_ids: ["s2m"], target_ids: ["t2"],
      origin: "auto" as const, state: "active" as const,
    }];
    const mergedDoc = doc(["s1", "s2m", "s3"], ["t1", "t2", "t3"], mergedGroups, segs);
    const mergedPairs = buildPairs(mergedDoc);
    expect(mergedPairs).toHaveLength(3);
    expect(mergedPairs.find((p) => p.group_id === "g2m")).toMatchObject({
      source_ids: ["s2m"], target_ids: ["t2"], state: "active",
    });
  });

  it("挪动顺序不改变对应内容；冲突组与无对应段都被列出", () => {
    const segs: DocData["segments"] = {
      s1: seg("s1", "source", "甲"), s2: seg("s2", "source", "乙"),
      t1: seg("t1", "target", "A"), t2: seg("t2", "target", "B"),
    };
    const d = doc(
      ["s2", "s1"], ["t1", "t2"],
      [
        { id: "g1", source_ids: ["s1"], target_ids: ["t1"], origin: "auto", state: "active" },
        { id: "g2", source_ids: ["s2"], target_ids: ["t2"], origin: "auto", state: "conflict" },
      ],
      segs,
    );
    const pairs = buildPairs(d);
    expect(pairs.map((p) => p.source_ids[0])).toEqual(["s2", "s1"]);
    expect(pairs.find((p) => p.group_id === "g2")?.state).toBe("conflict");
    expect(pairs.find((p) => p.group_id === "g1")?.target_ids).toEqual(["t1"]);
  });
});
