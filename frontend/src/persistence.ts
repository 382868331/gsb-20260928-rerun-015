import { importDoc } from './model/doc';
import type { DocState, ExportedDoc } from './types';
import { createSampleDoc } from './model/sample';

export const STORAGE_KEY = 'mlcp.doc.v1';

export function loadSavedDoc(): DocState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return importDoc(JSON.parse(raw) as ExportedDoc);
    }
  } catch {
    // 存储损坏时回退到示例文稿。
  }
  return createSampleDoc();
}
