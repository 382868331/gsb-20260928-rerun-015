// 规范化文本用于实质内容比较：统一空白（含全角空格）为单空格并去首尾空白。
export function normalizeText(text: string): string {
  return text
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 仅空白差异不算实质改写；标点、用词变化算。
export function isSubstantiveChange(before: string, after: string): boolean {
  return normalizeText(before) !== normalizeText(after);
}
