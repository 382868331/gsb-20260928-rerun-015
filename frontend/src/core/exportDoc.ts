import { DocState } from './model';
import { isLinkConfirmed } from './reviewWorkspace';
import { normalizeText } from './similarity';

export interface ExportedSegment {
  index: number;
  segmentId: string;
  kind: 'heading' | 'paragraph';
  source: string;
  sourceBefore?: string;
  /** 已针对当前原文确认、可随正文交付的译文。 */
  confirmedTranslations: Array<{ unitId: string; text: string; status: string; termBasis?: Array<{ term: string; adopted: string; revision: number }> }>;
  /** 已逐段确认，但明确保留旧译法的语境例外；与当前术语确认分开交付。 */
  exceptionTranslations: Array<{ unitId: string; text: string; status: string; rationales: string[] }>;
  /** 仍待处理（待核对/暂缓/重译中）或原文无译文的内容，不能交付。 */
  pendingTranslations: Array<{ unitId: string; text: string; status: string; reason?: string }>;
  /** 该段原文本身缺少任何译文。 */
  missingTranslation: boolean;
}

export interface ExportPayload {
  title: string;
  segments: ExportedSegment[];
  orphanUnits: Array<{ unitId: string; text: string; status: string }>;
  summary: {
    confirmedSegmentCount: number;
    exceptionSegmentCount: number;
    pendingSegmentCount: number;
    missingSegmentCount: number;
  };
}

export function buildExport(state: DocState): ExportPayload {
  const linkedUnitIds = new Set(state.links.map((l) => l.unitId));
  const termDecisions = state.termDecisions ?? [];
  const segments = state.segments.map((segment, index) => {
    const links = state.links.filter((l) => l.segmentId === segment.id);
    const confirmedTranslations: ExportedSegment['confirmedTranslations'] = [];
    const exceptionTranslations: ExportedSegment['exceptionTranslations'] = [];
    const pendingTranslations: ExportedSegment['pendingTranslations'] = [];
    for (const link of links) {
      const unit = state.units.find((u) => u.id === link.unitId);
      if (!unit) continue;
      const entry = { unitId: unit.id, text: unit.text, status: unit.status };
      const resolutions = Object.values(link.termResolutions ?? {});
      const activeResolutions = link.deferred
        ? []
        : resolutions.filter((resolution) => {
            const decision = termDecisions.find((term) => term.id === resolution.termId);
            const segment = state.segments.find((s) => s.id === link.segmentId);
            return decision?.status === 'active' &&
              decision.revision === resolution.revision &&
              segment &&
              resolution.sourceFingerprint === normalizeText(segment.text);
          });
      const termBasis = activeResolutions
        .filter((resolution) => resolution.decision === 'applied')
        .map((resolution) => ({ term: resolution.term, adopted: resolution.adopted, revision: resolution.revision }));
      const rationales = activeResolutions
        .filter((resolution) => resolution.decision === 'exception' && resolution.rationale)
        .map((resolution) => `${resolution.term}：${resolution.rationale}`);
      if (isLinkConfirmed(state, link) && rationales.length > 0) {
        exceptionTranslations.push({ ...entry, rationales });
      } else if (isLinkConfirmed(state, link)) {
        confirmedTranslations.push({ ...entry, termBasis });
      } else {
        pendingTranslations.push({ ...entry, reason: unit.reason });
      }
    }
    const hasContent = links.some((l) => {
      const unit = state.units.find((u) => u.id === l.unitId);
      return unit && unit.text.trim().length > 0;
    });
    return {
      index,
      segmentId: segment.id,
      kind: segment.kind,
      source: segment.text,
      sourceBefore: links.map((l) => l.sourceBefore).find(Boolean),
      confirmedTranslations,
      exceptionTranslations,
      pendingTranslations,
      missingTranslation: !hasContent,
    };
  });
  return {
    title: state.title,
    segments,
    orphanUnits: state.units
      .filter((u) => !linkedUnitIds.has(u.id))
      .map((u) => ({ unitId: u.id, text: u.text, status: u.status })),
    summary: {
      confirmedSegmentCount: segments.filter(
        (s) => s.confirmedTranslations.length > 0 && s.pendingTranslations.length === 0 && s.exceptionTranslations.length === 0,
      ).length,
      exceptionSegmentCount: segments.filter((s) => s.exceptionTranslations.length > 0).length,
      missingSegmentCount: segments.filter((s) => s.missingTranslation).length,
      pendingSegmentCount: segments.filter(
        (s) => !s.missingTranslation &&
          (s.pendingTranslations.length > 0 || s.confirmedTranslations.length === 0),
      ).length,
    },
  };
}

export function exportJSON(state: DocState): string {
  return JSON.stringify(buildExport(state), null, 2);
}

/** 双语纯文本：标题与段落按当前顺序，译文缺失时标注 [待翻译/待核对]。 */
export function exportBilingual(state: DocState): string {
  const payload = buildExport(state);
  const lines: string[] = [payload.title, ''];
  const pendingBlock: string[] = [];
  for (const seg of payload.segments) {
    lines.push(seg.kind === 'heading' ? `# ${seg.source}` : seg.source);
    const confirmed = seg.confirmedTranslations.map((t) => t.text.trim()).filter(Boolean);
    const exceptions = seg.exceptionTranslations;
    if (confirmed.length > 0 || exceptions.length > 0) {
      for (const text of confirmed) lines.push(text);
      for (const item of exceptions) {
        lines.push(`[语境例外·已确认] ${item.text.trim()}`);
        lines.push(...item.rationales.map((rationale) => `  保留依据：${rationale}`));
      }
    } else if (seg.missingTranslation) {
      lines.push('[待翻译：不交付]');
    } else {
      lines.push('[译文待核对，暂不交付]');
    }
    lines.push('');

    if (seg.missingTranslation || seg.pendingTranslations.length > 0 || (confirmed.length === 0 && exceptions.length === 0)) {
      pendingBlock.push(
        seg.kind === 'heading' ? `# ${seg.source}` : seg.source,
      );
      if (seg.sourceBefore) pendingBlock.push(`原文（旧）：${seg.sourceBefore}`);
      for (const t of seg.pendingTranslations) {
        pendingBlock.push(`[待处理·${t.status}] ${t.text.trim() || '（空）'}${t.reason ? `（${t.reason}）` : ''}`);
      }
      if (seg.missingTranslation) pendingBlock.push('[尚无译文]');
      pendingBlock.push('');
    }
  }
  lines.push(`=== 当前术语确认 ${payload.summary.confirmedSegmentCount} 段 · 语境例外 ${payload.summary.exceptionSegmentCount} 段 · 待处理 ${payload.summary.pendingSegmentCount} 段 · 待翻译 ${payload.summary.missingSegmentCount} 段 ===`, '');
  const exceptionBlock: string[] = [];
  for (const seg of payload.segments) {
    if (seg.exceptionTranslations.length === 0) continue;
    exceptionBlock.push(seg.kind === 'heading' ? `# ${seg.source}` : seg.source);
    for (const item of seg.exceptionTranslations) {
      exceptionBlock.push(`[语境例外] ${item.text.trim()}`);
      exceptionBlock.push(...item.rationales.map((rationale) => `保留依据：${rationale}`));
    }
    exceptionBlock.push('');
  }
  if (exceptionBlock.length > 0) {
    lines.push('--- 明确保留的术语例外（单列，不按当前术语归类）---');
    lines.push(...exceptionBlock);
  }
  if (payload.orphanUnits.length > 0) {
    lines.push('--- 未关联译文（请人工处理，未参与正文导出）---');
    for (const unit of payload.orphanUnits) {
      lines.push(unit.text.trim() ? unit.text : '[空译文单元]');
    }
  }
  if (pendingBlock.length > 0) {
    lines.push('--- 待处理内容（不得作为正式译文交付）---');
    lines.push(...pendingBlock);
  }
  return lines.join('\n').trimEnd() + '\n';
}
