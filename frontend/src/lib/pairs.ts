import type { DocData, Pair, LinkGroup } from "../types";

/**
 * 与后端 mlcp/pairs.py 完全对应的配对算法：页面行与导出共用同一逻辑。
 * 以源文顺序锚定分组，再追加无对应的源段与译文段。
 */
export function buildPairs(doc: DocData): Pair[] {
  const visibleGroups = doc.groups.filter((g) => g.state !== "retired");
  const srcIndex = new Map(doc.order.source.map((id, i) => [id, i]));
  const tgtIndex = new Map(doc.order.target.map((id, i) => [id, i]));

  const anchor = (g: LinkGroup): [number, number] => {
    const sPos = g.source_ids
      .filter((id) => srcIndex.has(id))
      .map((id) => srcIndex.get(id)!);
    const tPos = g.target_ids
      .filter((id) => tgtIndex.has(id))
      .map((id) => tgtIndex.get(id)!);
    return [
      sPos.length ? Math.min(...sPos) : 1e9,
      tPos.length ? Math.min(...tPos) : 1e9,
    ];
  };

  const pairs: Pair[] = [];
  const groupedSources = new Set<string>();
  const groupedTargets = new Set<string>();
  for (const g of [...visibleGroups].sort((a, b) => {
    const [sa, ta] = anchor(a);
    const [sb, tb] = anchor(b);
    return sa - sb || ta - tb;
  })) {
    pairs.push({
      source_ids: [...g.source_ids],
      target_ids: [...g.target_ids],
      state: g.state,
      group_id: g.id,
    });
    g.source_ids.forEach((id) => groupedSources.add(id));
    g.target_ids.forEach((id) => groupedTargets.add(id));
  }

  for (const id of doc.order.source) {
    if (!groupedSources.has(id)) pairs.push({ source_ids: [id], target_ids: [], state: "none", group_id: null });
  }
  for (const id of doc.order.target) {
    if (!groupedTargets.has(id)) pairs.push({ source_ids: [], target_ids: [id], state: "none", group_id: null });
  }
  return pairs;
}

export function pairKey(pair: Pair, index: number): string {
  return pair.group_id ?? `${index}:${pair.source_ids.join(".")}-${pair.target_ids.join(".")}`;
}
