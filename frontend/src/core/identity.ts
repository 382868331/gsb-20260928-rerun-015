let counter = 0;

/** 可注入序列，便于测试得到确定性 id。 */
let seqFn: (() => string) | null = null;

export function setIdSequence(fn: (() => string) | null): void {
  seqFn = fn;
}

export function nextId(prefix: 'seg' | 'unit'): string {
  if (seqFn) return seqFn();
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}
