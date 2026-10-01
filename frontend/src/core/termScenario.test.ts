import { describe, expect, it } from 'vitest';
import { createDocument, createUnitForSegment, editSegment, unitIdsForSegment, updateTranslation } from './docOps';
import { buildExport } from './exportDoc';
import { DocState } from './model';
import { buildReviewWorkspace, confirmLink } from './reviewWorkspace';
import {
  acknowledgeRevokedTerm,
  applyTermDecision,
  createTermDecision,
  keepTermException,
  revokeTermDecision,
} from './termOps';

function buildTermDoc(): DocState {
  let doc = createDocument('术语核对稿', [
    { text: '云盘支持文件共享。' },
    { text: '旧版云盘入口即将关闭。' },
  ]);
  const first = createUnitForSegment(doc, doc.segments[0].id);
  doc = updateTranslation(first.state, first.unitId, 'The cloud disk supports file sharing.');
  const second = createUnitForSegment(doc, doc.segments[1].id);
  doc = updateTranslation(second.state, second.unitId, 'The cloud disk entrance will close.');
  return doc;
}

describe('术语决定逐段核对', () => {
  it('只影响指定段落，同词不同语境可修改或保留有据例外', () => {
    let doc = buildTermDoc();
    const [firstSegment, secondSegment] = doc.segments;
    const firstUnit = unitIdsForSegment(doc, firstSegment.id)[0];
    const secondUnit = unitIdsForSegment(doc, secondSegment.id)[0];

    const created = createTermDecision(doc, {
      term: '云盘',
      scopeSegmentIds: [firstSegment.id, secondSegment.id],
      translations: [
        { unitId: firstUnit, previous: 'cloud disk', adopted: 'Cloud Drive' },
        { unitId: secondUnit, previous: 'cloud disk', adopted: 'Cloud Drive' },
      ],
    });
    doc = created.state;

    let workspace = buildReviewWorkspace(doc);
    expect(workspace).toHaveLength(2);
    expect(workspace.every((entry) => entry.units[0].reviewCause === 'term-change')).toBe(true);

    const applied = applyTermDecision(doc, firstSegment.id, firstUnit, created.termId);
    doc = applied.state;
    expect(doc.units.find((unit) => unit.id === applied.unitId)!.text).toContain('Cloud Drive');

    doc = keepTermException(doc, secondSegment.id, secondUnit, created.termId, '入口文案指旧产品名称 cloud disk，不能替换');
    expect(() => keepTermException(doc, secondSegment.id, secondUnit, created.termId, ' ')).not.toThrow();
    doc = confirmLink(doc, firstSegment.id, applied.unitId);
    doc = confirmLink(doc, secondSegment.id, secondUnit);

    const payload = buildExport(doc);
    expect(payload.segments[0].confirmedTranslations[0].termBasis).toEqual([
      { term: '云盘', adopted: 'Cloud Drive', revision: 1 },
    ]);
    expect(payload.segments[1].confirmedTranslations).toHaveLength(0);
    expect(payload.segments[1].exceptionTranslations).toHaveLength(1);
    expect(payload.segments[1].exceptionTranslations[0].rationales[0]).toContain('旧产品名称');
    expect(buildExport(doc).summary.confirmedSegmentCount).toBe(1);
    expect(buildExport(doc).summary.exceptionSegmentCount).toBe(1);
  });

  it('共享译文在一个语境修改时会分裂，不会无差别替换另一语境', () => {
    let doc = createDocument('共享译文术语稿', [
      { text: '云盘支持共享。' },
      { text: '云盘入口关闭。' },
    ]);
    const createdUnit = createUnitForSegment(doc, doc.segments[0].id);
    doc = updateTranslation(createdUnit.state, createdUnit.unitId, 'Cloud disk text.');
    doc = {
      ...doc,
      links: [...doc.links, { segmentId: doc.segments[1].id, unitId: createdUnit.unitId }],
    };

    const term = createTermDecision(doc, {
      term: '云盘',
      scopeSegmentIds: doc.segments.map((segment) => segment.id),
      translations: [{ unitId: createdUnit.unitId, previous: 'Cloud disk', adopted: 'Cloud Drive' }],
    });
    doc = term.state;
    const applied = applyTermDecision(doc, doc.segments[0].id, createdUnit.unitId, term.termId);
    doc = applied.state;

    expect(applied.unitId).not.toBe(createdUnit.unitId);
    expect(doc.units.find((unit) => unit.id === applied.unitId)!.text).toBe('Cloud Drive text.');
    expect(doc.units.find((unit) => unit.id === createdUnit.unitId)!.text).toBe('Cloud disk text.');
    expect(unitIdsForSegment(doc, doc.segments[0].id)).toEqual([applied.unitId]);
    expect(unitIdsForSegment(doc, doc.segments[1].id)).toEqual([createdUnit.unitId]);
  });

  it('原文与术语同轮变化时同时显示两种状态，撤销术语不恢复另一轮确认', () => {
    let doc = buildTermDoc();
    const segmentId = doc.segments[0].id;
    const unitId = unitIdsForSegment(doc, segmentId)[0];
    doc = editSegment(doc, segmentId, '云盘支持安全共享。').state;
    const term = createTermDecision(doc, {
      term: '云盘',
      scopeSegmentIds: [segmentId],
      translations: [{ unitId, previous: 'cloud disk', adopted: 'Cloud Drive' }],
    });
    doc = term.state;

    expect(buildReviewWorkspace(doc)[0].units[0].reviewCause).toBe('both');
    doc = applyTermDecision(doc, segmentId, unitId, term.termId).state;
    doc = confirmLink(doc, segmentId, unitId);
    expect(buildReviewWorkspace(doc)).toHaveLength(0);

    doc = revokeTermDecision(doc, term.termId);
    expect(buildReviewWorkspace(doc)).toHaveLength(1);
    expect(buildReviewWorkspace(doc)[0].units[0].reviewCause).toBe('term-change');
    doc = acknowledgeRevokedTerm(doc, segmentId, unitId, term.termId);
    doc = confirmLink(doc, segmentId, unitId);
    expect(buildReviewWorkspace(doc)).toHaveLength(0);
    expect(doc.links.find((link) => link.segmentId === segmentId && link.unitId === unitId)!.termResolutions).toEqual({});
  });

  it('序列化后继续保留未完成术语项与例外依据', () => {
    let doc = buildTermDoc();
    const segmentId = doc.segments[1].id;
    const unitId = unitIdsForSegment(doc, segmentId)[0];
    const term = createTermDecision(doc, {
      term: '云盘',
      scopeSegmentIds: [segmentId],
      translations: [{ unitId, previous: 'cloud disk', adopted: 'Cloud Drive' }],
    });
    doc = keepTermException(term.state, segmentId, unitId, term.termId, '品牌历史名称');
    const reopened: DocState = JSON.parse(JSON.stringify(doc));
    const entry = buildReviewWorkspace(reopened).find((item) => item.segmentId === segmentId)!;
    expect(entry).toBeTruthy();
    expect(entry.units[0].reviewCause).toBe('term-change');
    expect(entry.units[0].termItems[0].state).toBe('exception');
    expect(buildExport(reopened).segments[1].exceptionTranslations).toHaveLength(0);
    const confirmed = confirmLink(reopened, segmentId, unitId);
    expect(buildExport(confirmed).segments[1].exceptionTranslations[0].rationales.join(' ')).toContain('品牌历史名称');
  });
});
