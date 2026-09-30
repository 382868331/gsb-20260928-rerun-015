import { DocState } from './model';

/** 未被采用、仍需人工处理的状态（待核对 / 需重译 / 暂缓 / 未译）。 */
export const PENDING_STATUSES = new Set(['review', 'retranslate', 'deferred', 'untranslated']);

export interface ExportedSegment {
  index: number;
  segmentId: string;
  kind: 'heading' | 'paragraph';
  source: string;
  translations: Array<{ unitId: string; text: string; status: string }>;
  /** 已确认可采用的译文（provenance 与当前原文一致）。 */
  confirmedTranslations: Array<{ unitId: string; lang: string; text: string }>;
  /** 仍待处理的译文（待核对/需重译/暂缓/未译），不得当作成品。 */
  pendingTranslations: Array<{ unitId: string; lang: string; text: string; status: string; reason?: string }>;
}

export interface ExportPayload {
  title: string;
  /** 导出时间。 */
  exportedAt: string;
  segments: ExportedSegment[];
  /** 汇总：已确认译文条数；>0 的待处理条数意味着导出稿不完整。 */
  summary: { confirmedCount: number; pendingCount: number };
  orphanUnits: Array<{ unitId: string; lang: string; text: string; status: string }>;
}

export function buildExport(state: DocState): ExportPayload {
  const linkedUnitIds = new Set(state.links.map((l) => l.unitId));
  let confirmedCount = 0;
  let pendingCount = 0;
  const segments = state.segments.map((segment, index) => {
    const units = state.links
      .filter((l) => l.segmentId === segment.id)
      .map((l) => state.units.find((u) => u.id === l.unitId))
      .filter((u): u is NonNullable<typeof u> => Boolean(u));
    const confirmed = units
      .filter((u) => u.status === 'translated' && u.text.trim().length > 0)
      .map((u) => ({ unitId: u.id, lang: u.lang, text: u.text }));
    const pending = units
      .filter((u) => PENDING_STATUSES.has(u.status))
      .map((u) => ({
        unitId: u.id,
        lang: u.lang,
        text: u.text,
        status: u.status,
        reason: u.reason,
      }));
    confirmedCount += confirmed.length;
    pendingCount += pending.length;
    return {
      index,
      segmentId: segment.id,
      kind: segment.kind,
      source: segment.text,
      translations: units.map((unit) => ({ unitId: unit.id, text: unit.text, status: unit.status })),
      confirmedTranslations: confirmed,
      pendingTranslations: pending,
    };
  });
  return {
    title: state.title,
    exportedAt: new Date().toISOString(),
    segments,
    summary: { confirmedCount, pendingCount },
    orphanUnits: state.units
      .filter((u) => !linkedUnitIds.has(u.id))
      .map((u) => ({ unitId: u.id, lang: u.lang, text: u.text, status: u.status })),
  };
}

export function exportJSON(state: DocState): string {
  return JSON.stringify(buildExport(state), null, 2);
}

function statusLabel(status: string): string {
  switch (status) {
    case 'review':
      return '待核对';
    case 'retranslate':
      return '需重译';
    case 'deferred':
      return '暂缓';
    case 'untranslated':
      return '未译';
    default:
      return status;
  }
}

/**
 * 双语纯文本：已确认译文与待处理内容分区输出。
 * 待处理译文（含旧译文）只出现在“待处理”区，绝不混入正文，避免误用。
 */
export function exportBilingual(state: DocState): string {
  const payload = buildExport(state);
  const lines: string[] = [payload.title, ''];
  const pendingBlocks: string[] = [];
  for (const seg of payload.segments) {
    lines.push(seg.kind === 'heading' ? `# ${seg.source}` : seg.source);

    if (seg.confirmedTranslations.length > 0) {
      for (const item of seg.confirmedTranslations) {
        lines.push(`[已确认·${item.lang}] ${item.text}`);
      }
    } else {
      lines.push('[无已确认译文]');
    }
    lines.push('');

    if (seg.pendingTranslations.length > 0) {
      const block: string[] = [`【待处理】对应原文：${seg.source}`];
      for (const item of seg.pendingTranslations) {
        const label = statusLabel(item.status);
        const text = item.text.trim() ? item.text : '[空]';
        block.push(`  - [${label}·${item.lang}] ${text}`);
      }
      pendingBlocks.push(block.join('\n'));
    }
  }
  if (payload.orphanUnits.length > 0) {
    lines.push('--- 未关联译文（请人工处理，未参与正文导出）---');
    for (const unit of payload.orphanUnits) {
      lines.push(`- [${statusLabel(unit.status)}·${unit.lang}] ${unit.text.trim() ? unit.text : '[空译文单元]'}`);
    }
    lines.push('');
  }
  if (pendingBlocks.length > 0) {
    lines.push('=== 待处理内容（未确认，请勿作为成品使用）===');
    lines.push(...pendingBlocks, '');
  }
  lines.push(`导出汇总：已确认 ${payload.summary.confirmedCount} 条，待处理 ${payload.summary.pendingCount} 条。`);
  return lines.join('\n').trimEnd() + '\n';
}
