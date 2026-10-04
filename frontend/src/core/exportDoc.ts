import { DocState } from './model';
import { linkReviewCategory } from './terms';
import {
  MergedVersion,
  ReleaseFreeze,
  ReviewWorkspaceState,
  reconcileMergedItem,
} from './reviewBranch';

export interface ExportedSegment {
  index: number;
  segmentId: string;
  kind: 'heading' | 'paragraph';
  source: string;
  sourceBefore?: string;
  /** 已针对当前原文确认、可随正文交付的译文。 */
  confirmedTranslations: Array<{ unitId: string; text: string; status: string }>;
  /** 明确保留的术语例外（带依据），不混入正式译文批次。 */
  exceptionTranslations: Array<{ unitId: string; text: string; status: string; rationale?: string }>;
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
    pendingSegmentCount: number;
    missingSegmentCount: number;
  };
}

export function buildExport(state: DocState): ExportPayload {
  const linkedUnitIds = new Set(state.links.map((l) => l.unitId));
  const segments = state.segments.map((segment, index) => {
    const links = state.links.filter((l) => l.segmentId === segment.id);
    const confirmedTranslations: ExportedSegment['confirmedTranslations'] = [];
    const exceptionTranslations: ExportedSegment['exceptionTranslations'] = [];
    const pendingTranslations: ExportedSegment['pendingTranslations'] = [];
    for (const link of links) {
      const unit = state.units.find((u) => u.id === link.unitId);
      if (!unit) continue;
      const entry = { unitId: unit.id, text: unit.text, status: unit.status };
      const category = linkReviewCategory(state, link);
      if (category === 'confirmed') {
        confirmedTranslations.push(entry);
      } else if (category === 'exception') {
        const rationale = link.termDispositions
          ?.filter((d) => d.type === 'kept')
          .slice(-1)[0]?.rationale;
        exceptionTranslations.push({ ...entry, rationale });
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
        (s) =>
          s.confirmedTranslations.length > 0 &&
          s.pendingTranslations.length === 0 &&
          s.exceptionTranslations.length === 0,
      ).length,
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

/** 审阅导出中单个合并条目：固定创建时快照，并单独标注当前原文变化。 */
export interface ExportedMergeItem {
  segmentId: string;
  unitId: string;
  kind: MergedVersion['items'][number]['kind'];
  /** 合并创建时固定的原文与译文（决定依据所针对的内容）。 */
  sourceAtMerge: string;
  translationAtMerge: string;
  /** 当前主文档中的原文；段落被拆并时为 null。 */
  currentSource: string | null;
  /** applies=仍适用；recheck=原文已变需复核；removed=原段已拆并。 */
  reconcileStatus: 'applies' | 'recheck' | 'removed';
  pending: boolean;
  resolved: boolean;
  resolution?: {
    action: string;
    revisedText?: string;
    rationale?: string;
    decidedAt: string;
  };
}

export interface ReviewExportPayload {
  /** 导出时的当前主文档标题（当前修订）。 */
  currentTitle: string;
  exportedAt: string;
  mergedVersions: Array<{
    id: string;
    createdAt: string;
    items: ExportedMergeItem[];
  }>;
  /** 发布冻结快照：内容独立保存，不随主文档或合并版本变化。 */
  freezes: Array<{
    id: string;
    mergedVersionId: string;
    frozenAt: string;
    title: string;
    segments: ReleaseFreeze['segments'];
    decisions: ReleaseFreeze['decisions'];
  }>;
}

/**
 * 审阅导出：原合并依据（创建时快照）、当前修订与冻结内容分列，
 * 保存重开后三者仍可区分。
 */
export function buildReviewExport(
  state: DocState,
  review: ReviewWorkspaceState,
  exportedAt = new Date().toISOString(),
): ReviewExportPayload {
  return {
    currentTitle: state.title,
    exportedAt,
    mergedVersions: review.mergedVersions.map((merged) => ({
      id: merged.id,
      createdAt: merged.createdAt,
      items: merged.items.map((item) => {
        const entry = reconcileMergedItem(state, item);
        return {
          segmentId: item.segmentId,
          unitId: item.unitId,
          kind: item.kind,
          sourceAtMerge: item.sourceText,
          translationAtMerge: item.unitText,
          currentSource: entry.currentText ?? null,
          reconcileStatus: entry.status === 'new' ? 'recheck' : entry.status,
          pending: item.pending,
          resolved: item.resolved,
          resolution: item.resolution
            ? {
                action: item.resolution.action,
                revisedText: item.resolution.revisedText,
                rationale: item.resolution.rationale,
                decidedAt: item.resolution.decidedAt,
              }
            : undefined,
        };
      }),
    })),
    freezes: review.freezes.map((freeze) => ({
      id: freeze.id,
      mergedVersionId: freeze.mergedVersionId,
      frozenAt: freeze.frozenAt,
      title: freeze.title,
      segments: freeze.segments,
      decisions: freeze.decisions,
    })),
  };
}

export function exportReviewJSON(state: DocState, review: ReviewWorkspaceState): string {
  return JSON.stringify(buildReviewExport(state, review), null, 2);
}

/** 双语纯文本：标题与段落按当前顺序，译文缺失时标注 [待翻译/待核对]。 */
export function exportBilingual(state: DocState): string {
  const payload = buildExport(state);
  const lines: string[] = [payload.title, ''];
  const pendingBlock: string[] = [];
  const exceptionBlock: string[] = [];
  for (const seg of payload.segments) {
    lines.push(seg.kind === 'heading' ? `# ${seg.source}` : seg.source);
    const confirmed = seg.confirmedTranslations.map((t) => t.text.trim()).filter(Boolean);
    const exceptions = seg.exceptionTranslations.map((t) => t.text.trim()).filter(Boolean);
    if (confirmed.length > 0) {
      for (const text of confirmed) lines.push(text);
    } else if (seg.missingTranslation) {
      lines.push('[待翻译：不交付]');
    } else {
      lines.push('[译文待核对，暂不交付]');
    }
    lines.push('');

    if (seg.missingTranslation || seg.pendingTranslations.length > 0 || confirmed.length === 0) {
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
    if (exceptions.length > 0) {
      exceptionBlock.push(
        seg.kind === 'heading' ? `# ${seg.source}` : seg.source,
      );
      for (const t of seg.exceptionTranslations) {
        exceptionBlock.push(
          `[术语例外·已保留] ${t.text.trim() || '（空）'}（依据：${t.rationale ?? '未记录'}）`,
        );
      }
      exceptionBlock.push('');
    }
  }
  lines.push(`=== 已确认 ${payload.summary.confirmedSegmentCount} 段 · 待处理 ${payload.summary.pendingSegmentCount} 段 · 待翻译 ${payload.summary.missingSegmentCount} 段 ===`, '');
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
  if (exceptionBlock.length > 0) {
    lines.push('--- 明确保留的术语例外（不随正式译文批量交付）---');
    lines.push(...exceptionBlock);
  }
  return lines.join('\n').trimEnd() + '\n';
}
