import { DocState } from './model';

export interface ExportedSegment {
  index: number;
  segmentId: string;
  kind: 'heading' | 'paragraph';
  source: string;
  translations: Array<{ unitId: string; text: string; status: string }>;
}

export interface ExportPayload {
  title: string;
  segments: ExportedSegment[];
  orphanUnits: Array<{ unitId: string; text: string; status: string }>;
}

export function buildExport(state: DocState): ExportPayload {
  const linkedUnitIds = new Set(state.links.map((l) => l.unitId));
  return {
    title: state.title,
    segments: state.segments.map((segment, index) => ({
      index,
      segmentId: segment.id,
      kind: segment.kind,
      source: segment.text,
      translations: state.links
        .filter((l) => l.segmentId === segment.id)
        .map((l) => state.units.find((u) => u.id === l.unitId))
        .filter((u): u is NonNullable<typeof u> => Boolean(u))
        .map((unit) => ({ unitId: unit.id, text: unit.text, status: unit.status })),
    })),
    orphanUnits: state.units
      .filter((u) => !linkedUnitIds.has(u.id))
      .map((u) => ({ unitId: u.id, text: u.text, status: u.status })),
  };
}

export function exportJSON(state: DocState): string {
  return JSON.stringify(buildExport(state), null, 2);
}

/** 双语纯文本：标题与段落按当前顺序，译文缺失时标注 [待翻译/待核对]。 */
export function exportBilingual(state: DocState): string {
  const payload = buildExport(state);
  const lines: string[] = [payload.title, ''];
  for (const seg of payload.segments) {
    lines.push(seg.kind === 'heading' ? `# ${seg.source}` : seg.source);
    const texts = seg.translations.map((t) => t.text.trim()).filter(Boolean);
    if (texts.length === 0) {
      lines.push('[待翻译]');
    } else {
      for (const text of texts) lines.push(text);
    }
    const needsReview = seg.translations.some((t) => t.status === 'review');
    if (needsReview) lines.push('（译文待核对）');
    lines.push('');
  }
  if (payload.orphanUnits.length > 0) {
    lines.push('--- 未关联译文（请人工处理，未参与正文导出）---');
    for (const unit of payload.orphanUnits) {
      lines.push(unit.text.trim() ? unit.text : '[空译文单元]');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}
