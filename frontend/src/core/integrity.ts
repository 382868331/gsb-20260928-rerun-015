import { DocState } from './model';

export interface IntegrityReport {
  segmentCount: number;
  unitCount: number;
  /** link 指向不存在的段落或单元。 */
  danglingLinks: number;
  /** 重复 id。 */
  duplicateSegmentIds: string[];
  duplicateUnitIds: string[];
  /** 没有任何译文关联的源文段落。 */
  unlinkedSegmentIds: string[];
  /** 失去段落关联的译文单元（仍保留，未丢失）。 */
  orphanUnitIds: string[];
  /** 处于待核对状态的译文单元。 */
  reviewUnitIds: string[];
  ok: boolean;
}

export function checkIntegrity(state: DocState): IntegrityReport {
  const segmentIds = new Set<string>();
  const duplicateSegmentIds = new Set<string>();
  for (const s of state.segments) {
    if (segmentIds.has(s.id)) duplicateSegmentIds.add(s.id);
    segmentIds.add(s.id);
  }
  const unitIds = new Set<string>();
  const duplicateUnitIds = new Set<string>();
  for (const u of state.units) {
    if (unitIds.has(u.id)) duplicateUnitIds.add(u.id);
    unitIds.add(u.id);
  }
  const danglingLinks = state.links.filter(
    (l) => !segmentIds.has(l.segmentId) || !unitIds.has(l.unitId),
  ).length;
  const linkedSegments = new Set(state.links.map((l) => l.segmentId));
  const linkedUnits = new Set(state.links.map((l) => l.unitId));
  return {
    segmentCount: state.segments.length,
    unitCount: state.units.length,
    danglingLinks,
    duplicateSegmentIds: [...duplicateSegmentIds],
    duplicateUnitIds: [...duplicateUnitIds],
    unlinkedSegmentIds: state.segments.filter((s) => !linkedSegments.has(s.id)).map((s) => s.id),
    orphanUnitIds: state.units.filter((u) => !linkedUnits.has(u.id)).map((u) => u.id),
    reviewUnitIds: state.units.filter((u) => u.status === 'review').map((u) => u.id),
    get ok() {
      return (
        this.danglingLinks === 0 &&
        this.duplicateSegmentIds.length === 0 &&
        this.duplicateUnitIds.length === 0
      );
    },
  };
}
