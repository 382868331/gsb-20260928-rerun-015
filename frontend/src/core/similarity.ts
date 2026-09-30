/** 去除所有空白后比较，使仅空格/排版变化不算实质改写。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, '');
}

function bigrams(text: string): Map<string, number> {
  const result = new Map<string, number>();
  if (text.length === 1) {
    result.set(text, 1);
    return result;
  }
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    result.set(gram, (result.get(gram) ?? 0) + 1);
  }
  return result;
}

/** 基于字符二元组的 Sørensen–Dice 相似度，兼容中英文。 */
export function similarity(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let overlap = 0;
  for (const [gram, count] of leftGrams) {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  const total = left.length + right.length - 2;
  if (total <= 0) return 0;
  return (2 * overlap) / total;
}

export function isSubstantiveRewrite(before: string, after: string, threshold: number): boolean {
  if (normalizeText(before) === normalizeText(after)) return false;
  return similarity(before, after) < threshold;
}
