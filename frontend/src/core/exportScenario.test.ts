import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createUnitForSegment,
  mergeSegments,
  moveSegment,
  splitSegment,
  unlinkSegmentUnit,
  unitIdsForSegment,
  updateTranslation,
  confirmUnit,
} from './docOps';
import { DocState } from './model';
import { checkIntegrity } from './integrity';
import { buildExport, exportBilingual, exportJSON } from './exportDoc';

function buildScenarioDoc(): DocState {
  let doc = createDocument('重复句核对稿', [
    { kind: 'heading', text: '产品更新公告' },
    { text: '我们今天发布了新版本。' },
    { text: '新版本提升了稳定性。' },
    { text: '我们今天发布了新版本。' },
    { text: '感谢大家的支持与反馈。' },
  ]);
  const translations = [
    'Product Update Announcement',
    'We released a new version today.',
    'The new version improves stability.',
    'Different translation for the repeated line.',
    'Thanks for your support and feedback.',
  ];
  translations.forEach((text, index) => {
    const result = createUnitForSegment(doc, doc.segments[index].id);
    doc = confirmUnit(updateTranslation(result.state, result.unitId, text), result.unitId);
  });
  return doc;
}

describe('连续拆合、移位、保存重开与导出', () => {
  it('序列化往返不丢段、不错配', () => {
    let doc = buildScenarioDoc();
    const before: DocState = JSON.parse(JSON.stringify(doc));

    doc = moveSegment(doc, doc.segments[4].id, 0).state;
    const splitTarget = doc.segments.find((s) => s.text === '新版本提升了稳定性。')!;
    const splitOldUnit = unitIdsForSegment(doc, splitTarget.id)[0];
    doc = splitSegment(doc, splitTarget.id, ['新版本提升了', '稳定性。']).state;
    const partIds = doc.segments
      .filter((s) => s.text === '新版本提升了' || s.text === '稳定性。')
      .map((s) => s.id);
    doc = mergeSegments(doc, partIds, '').state;
    expect(checkIntegrity(doc).ok).toBe(true);

    const reopened: DocState = JSON.parse(JSON.stringify(doc));
    expect(checkIntegrity(reopened).ok).toBe(true);
    expect(reopened.segments).toHaveLength(before.segments.length);
    expect(reopened.units).toHaveLength(before.units.length);
    expect(reopened.units.find((u) => u.id === splitOldUnit)!.status).toBe('review');

    const payload = buildExport(reopened);
    expect(payload.segments).toHaveLength(before.segments.length);
    expect(payload.segments.map((s) => s.source).filter((t) => t === '我们今天发布了新版本。')).toHaveLength(2);
    const repeated = payload.segments.filter((s) => s.source === '我们今天发布了新版本。');
    const texts = repeated.map((s) => s.translations[0]?.text);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts).toContain('We released a new version today.');
    expect(texts).toContain('Different translation for the repeated line.');

    expect(() => JSON.parse(exportJSON(reopened))).not.toThrow();
    const bilingual = exportBilingual(reopened);
    expect(bilingual).toContain('产品更新公告');
    expect(bilingual.match(/我们今天发布了新版本。/g)).toHaveLength(2);
    expect(bilingual).toContain('待处理内容');
    expect(bilingual).toContain('待核对');
    expect(payload.summary.pendingCount).toBeGreaterThan(0);
  });

  it('孤儿译文导出时单列，不写入正文', () => {
    let doc = buildScenarioDoc();
    const segmentId = doc.segments[1].id;
    const unitId = unitIdsForSegment(doc, segmentId)[0];
    doc = unlinkSegmentUnit(doc, segmentId, unitId);

    const payload = buildExport(doc);
    expect(payload.orphanUnits.map((u) => u.unitId)).toContain(unitId);
    expect(payload.segments.find((s) => s.segmentId === segmentId)!.translations).toHaveLength(0);
    expect(exportBilingual(doc)).toContain('未关联译文');
    expect(checkIntegrity(doc).ok).toBe(true);
  });
});
