import { DocState, TranslationUnit, languageLabel } from './model';
import { unitsForSegment } from './docOps';

/** 需要在核对工作区处理的状态。 */
export const PENDING_REVIEW_STATUSES = new Set(['review', 'retranslate', 'deferred']);

export interface ReviewItem {
  unitId: string;
  lang: string;
  langLabel: string;
  status: TranslationUnit['status'];
  currentText: string;
  reason?: string;
}

export interface ReviewWorkEntry {
  segmentId: string;
  index: number;
  kind: 'heading' | 'paragraph';
  beforeText: string;
  afterText: string;
  items: ReviewItem[];
}

/**
 * 构建核对工作区：逐段展示原文前后内容与各语言现有译文，
 * 一次原文改动影响多种语言时每种语言一个可单独决策的条目。
 * beforeText 优先取该单元 reviewContext 记录的改前快照。
 */
export function buildReviewWorkspace(state: DocState): ReviewWorkEntry[] {
  const entries: ReviewWorkEntry[] = [];
  state.segments.forEach((segment, index) => {
    const units = unitsForSegment(state, segment.id).filter((u) =>
      PENDING_REVIEW_STATUSES.has(u.status),
    );
    if (units.length === 0) return;

    let beforeText = '';
    for (const unit of units) {
      const snapshot = unit.reviewContext?.[segment.id];
      if (snapshot?.before) {
        beforeText = snapshot.before;
        break;
      }
    }

    entries.push({
      segmentId: segment.id,
      index,
      kind: segment.kind,
      beforeText,
      afterText: segment.text,
      items: units.map((unit) => ({
        unitId: unit.id,
        lang: unit.lang,
        langLabel: languageLabel(unit.lang),
        status: unit.status,
        currentText: unit.text,
        reason: unit.reason,
      })),
    });
  });
  return entries;
}

export function pendingReviewCount(state: DocState): number {
  return state.units.filter((u) => PENDING_REVIEW_STATUSES.has(u.status)).length;
}
