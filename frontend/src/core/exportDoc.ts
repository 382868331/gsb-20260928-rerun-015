import { DocState } from './model';
import { linkReviewCategory } from './terms';
import {
  ReleaseFreeze,
  ReviewWorkspaceState,
  reconcileMergedVersion,
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
  /** 审阅合并版本：冻结的裁决依据与当前文档修订分列，撤回重开项单列。 */
  mergedVersions?: Array<{
    mergedId: string;
    createdAt: string;
    titleSnapshot: string;
    currentTitle: string;
    titleChanged: boolean;
    items: Array<{
      segmentId: string;
      unitId: string;
      kind: string;
      resolved: boolean;
      pending: boolean;
      frozenSourceText: string;
      frozenUnitText: string;
      frozenResolvedText: string;
      frozenRationale?: string;
      currentSourceText?: string;
      currentUnitText?: string;
      driftStatus: string;
      needsRecheck: boolean;
    }>;
  }>;
  /** 已发布冻结：裁决内容不可变，当前修订仅作对照。 */
  freezes?: Array<{
    freezeId: string;
    frozenAt: string;
    title: string;
    currentTitle: string;
    decisions: Array<{
      segmentId: string;
      unitId: string;
      action: string;
      sourceText: string;
      text: string;
      rationale?: string;
      currentSourceText?: string;
      currentUnitText?: string;
      driftStatus?: string;
    }>;
  }>;
}

export function buildExport(state: DocState, review?: ReviewWorkspaceState): ExportPayload {
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
  const payload: ExportPayload = {
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
  if (review) {
    payload.mergedVersions = review.mergedVersions.map((merged) => {
      const drift = reconcileMergedVersion(state, merged);
      const driftByKey = new Map(
        drift.entries.map((entry) => [entry.segmentId + '::' + entry.unitId, entry]),
      );
      return {
        mergedId: merged.id,
        createdAt: merged.createdAt,
        titleSnapshot: merged.titleSnapshot,
        currentTitle: drift.currentTitle,
        titleChanged: drift.titleChanged,
        items: merged.items.map((item) => {
          const entry = driftByKey.get(item.segmentId + '::' + item.unitId);
          return {
            segmentId: item.segmentId,
            unitId: item.unitId,
            kind: item.kind,
            resolved: item.resolved,
            pending: item.pending,
            frozenSourceText: item.frozen.sourceText,
            frozenUnitText: item.frozen.unitText,
            frozenResolvedText: item.frozen.resolvedText,
            frozenRationale: item.frozen.rationale,
            currentSourceText: entry?.currentSourceText,
            currentUnitText: entry?.currentUnitText,
            driftStatus: entry?.status ?? 'applies',
            needsRecheck: entry ? entry.status !== 'applies' : false,
          };
        }),
      };
    });
    payload.freezes = review.freezes.map((freeze: ReleaseFreeze) => ({
      freezeId: freeze.id,
      frozenAt: freeze.frozenAt,
      title: freeze.title,
      currentTitle: freeze.currentTitle,
      decisions: freeze.decisions.map((d) => ({
        segmentId: d.segmentId,
        unitId: d.unitId,
        action: d.action,
        sourceText: d.sourceText,
        text: d.text,
        rationale: d.rationale,
        currentSourceText: d.currentSourceText,
        currentUnitText: d.currentUnitText,
        driftStatus: d.driftStatus,
      })),
    }));
  }
  return payload;
}

export function exportJSON(state: DocState, review?: ReviewWorkspaceState): string {
  return JSON.stringify(buildExport(state, review), null, 2);
}

/** 双语纯文本：标题与段落按当前顺序，译文缺失时标注 [待翻译/待核对]。 */
export function exportBilingual(state: DocState, review?: ReviewWorkspaceState): string {
  const payload = buildExport(state, review);
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
  if (payload.mergedVersions) {
    for (const merged of payload.mergedVersions) {
      lines.push(`--- 审阅合并版本 ${merged.mergedId.slice(0, 10)}（裁决依据冻结于 ${new Date(merged.createdAt).toLocaleString()}）---`);
      lines.push(`裁决标题：${merged.titleSnapshot}${merged.titleChanged ? ` · 当前标题：${merged.currentTitle}（已修订，需复核）` : ''}`);
      for (const item of merged.items) {
        const status = item.pending ? '已撤回·重新待审' : item.needsRecheck ? `需复核（${item.driftStatus}）` : '裁决有效';
        lines.push(`[${item.kind}·${status}] 冻结原文：${item.frozenSourceText}`);
        lines.push(`  裁决译文：${item.frozenResolvedText || item.frozenUnitText}${item.frozenRationale ? `（依据：${item.frozenRationale}）` : ''}`);
        if (item.needsRecheck && !item.pending) {
          if (item.currentSourceText !== undefined && item.currentSourceText !== item.frozenSourceText) {
            lines.push(`  当前原文（修订）：${item.currentSourceText}`);
          }
          if ((item.currentUnitText ?? '') !== item.frozenUnitText) {
            lines.push(`  当前译文（修订）：${item.currentUnitText || '（空）'}`);
          }
          if (item.driftStatus === 'removed') {
            lines.push('  原段已拆分/合并删除，旧结论不自动套用，请按新段落复核。');
          }
        }
      }
      lines.push('');
    }
  }
  if (payload.freezes) {
    for (const freeze of payload.freezes) {
      lines.push(`--- 发布冻结 ${freeze.freezeId.slice(0, 10)}（${new Date(freeze.frozenAt).toLocaleString()}，不可变）---`);
      lines.push(`裁决标题：${freeze.title}${freeze.currentTitle !== freeze.title ? ` · 冻结时当前标题：${freeze.currentTitle}（修订仅对照）` : ''}`);
      for (const d of freeze.decisions) {
        lines.push(`裁决原文：${d.sourceText} → ${d.text}${d.rationale ? `（依据：${d.rationale}）` : ''}`);
        if (d.currentSourceText !== undefined && d.currentSourceText !== d.sourceText) {
          lines.push(`  冻结时当前原文（修订，不属本裁决）：${d.currentSourceText}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}
