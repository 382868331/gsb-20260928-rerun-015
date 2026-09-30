import { describe, expect, it } from 'vitest';
import {
  addLink,
  addTarget,
  approveSource,
  createDoc,
  editSourceText,
  exportDoc,
  importDoc,
  linksOfSource,
  mergeSources,
  moveSource,
  splitSource,
} from './doc';
import { isSubstantiveChange } from './text';

// 构造包含中文标题与重复句子的文稿。
function fixture() {
  return createDoc({
    blocks: [
      { kind: 'heading', text: '季度产品发布', translation: 'Quarterly Product Release' },
      { kind: 'paragraph', text: '重复句子在这里出现。', translation: 'The repeated sentence appears here.' },
      {
        kind: 'paragraph',
        text: '第一段独有内容。重复句子在这里出现。',
        translation: 'Content unique to the first paragraph. The repeated sentence appears here.',
      },
      { kind: 'paragraph', text: '最后一段保持不变。', translation: 'The last paragraph stays unchanged.' },
    ],
  });
}

describe('段落身份与移动', () => {
  it('移动位置时保留身份与已有译文，不错配', () => {
    const doc = fixture();
    const moved = doc.sources[1];
    const movedLinksBefore = linksOfSource(doc, moved.id).map((l) => l.id);

    const next = moveSource(doc, moved.id, 3);

    expect(next.sources[3].id).toBe(moved.id);
    const movedLinksAfter = linksOfSource(next, moved.id).map((l) => l.id);
    expect(movedLinksAfter).toEqual(movedLinksBefore);
    // 全部段、译文、关联均未丢失。
    expect(next.sources).toHaveLength(4);
    expect(next.targets).toHaveLength(4);
    expect(next.links).toHaveLength(4);
    // 每条关联仍指向存在的实体。
    for (const link of next.links) {
      expect(next.sources.some((s) => s.id === link.sourceId)).toBe(true);
      expect(next.targets.some((t) => t.id === link.targetId)).toBe(true);
    }
  });
});

describe('正文编辑的失效粒度', () => {
  it('实质改写只让受影响段落的译文进入待核对，不波及整篇', () => {
    const doc = fixture();
    const target = doc.sources[2];
    const next = editSourceText(doc, target.id, '第一段被彻底改写，意思完全不同。');

    const affected = linksOfSource(next, target.id);
    expect(affected.every((l) => l.status === 'needs_review')).toBe(true);
    const untouched = next.links.filter((l) => l.sourceId !== target.id);
    expect(untouched.every((l) => l.status === 'ok')).toBe(true);
  });

  it('仅空白变化不标记失效', () => {
    expect(isSubstantiveChange('你好 世界', ' 你好　世界\n')).toBe(false);
    const doc = fixture();
    const target = doc.sources[1];
    const next = editSourceText(doc, target.id, '  重复句子在这里出现。\n');
    expect(linksOfSource(next, target.id)[0].status).toBe('ok');
  });

  it('人工核对通过后恢复正常状态', () => {
    const doc = editSourceText(fixture(), fixture().sources[2].id, '全新的实质内容。');
    const link = linksOfSource(doc, doc.sources[2].id)[0];
    const next = approveSource(doc, doc.sources[2].id);
    expect(linksOfSource(next, next.sources[2].id)[0].id).toBe(link.id);
    expect(linksOfSource(next, next.sources[2].id)[0].status).toBe('ok');
  });
});

describe('拆分', () => {
  it('拆出的新段不继承旧译文，旧译文不会被误当成新内容译文', () => {
    const doc = fixture();
    const source = doc.sources[2];
    const oldLinks = linksOfSource(doc, source.id);
    const result = splitSource(doc, source.id, '第一段独有内容。', '重复句子在这里出现。');

    // 原段身份与关联保留。
    expect(result.state.sources[2].id).toBe(source.id);
    expect(linksOfSource(result.state, source.id).map((l) => l.id)).toEqual(
      oldLinks.map((l) => l.id),
    );
    // 新段（即使文字与其他段重复）没有任何自动关联。
    expect(linksOfSource(result.state, result.newId)).toHaveLength(0);
    expect(result.state.sources).toHaveLength(5);
    expect(result.state.links).toHaveLength(4);
  });
});

describe('合并与人工对应', () => {
  it('合并后关联迁移并待核对，支持人工调整为一对多', () => {
    let doc = fixture();
    const [a, b] = [doc.sources[1].id, doc.sources[2].id];
    const targetsOfA = linksOfSource(doc, a).map((l) => l.targetId);
    const targetsOfB = linksOfSource(doc, b).map((l) => l.targetId);

    const result = mergeSources(doc, [a, b]);
    doc = result.state;

    expect(doc.sources).toHaveLength(3);
    const mergedLinks = linksOfSource(doc, result.newId);
    // 一对多：两条旧译文都迁移到新段，且全部待核对。
    expect(mergedLinks).toHaveLength(2);
    expect(mergedLinks.map((l) => l.targetId).sort()).toEqual(
      [...targetsOfA, ...targetsOfB].sort(),
    );
    expect(mergedLinks.every((l) => l.status === 'needs_review')).toBe(true);

    // 人工解除其中一条并新建译文重新关联。
    const toRemove = mergedLinks[0];
    doc = {
      ...doc,
      links: doc.links.filter((l) => l.id !== toRemove.id),
    };
    const added = addTarget(doc, 'A fresh merged translation.');
    doc = added.state;
    doc = addLink(doc, result.newId, added.id, 'needs_review').state;
    const after = linksOfSource(doc, result.newId);
    expect(after).toHaveLength(2);
    expect(after.some((l) => l.targetId === added.id)).toBe(true);
    expect(after.some((l) => l.targetId === toRemove.targetId)).toBe(false);
  });

  it('允许人工配置多对一：多条正文对应同一条译文', () => {
    let doc = fixture();
    const t = doc.targets[1].id;
    const otherSource = doc.sources[3].id;
    doc = addLink(doc, otherSource, t, 'needs_review').state;
    const linksToT = doc.links.filter((l) => l.targetId === t);
    expect(linksToT).toHaveLength(2);
    expect(new Set(linksToT.map((l) => l.sourceId)).size).toBe(2);
  });
});

describe('导出往返', () => {
  it('连续拆合、移位后导出再导入，不丢段、不错配', () => {
    let doc = fixture();
    const s2 = doc.sources[1].id;
    const s3 = doc.sources[2].id;
    const split = splitSource(doc, s2, '重复句子', '在这里出现。');
    doc = split.state;
    const merged = mergeSources(doc, [split.newId, s3]);
    doc = merged.state;
    doc = moveSource(doc, doc.sources[0].id, doc.sources.length - 1);
    doc = editSourceText(doc, merged.newId, '合并段做了实质改写。');

    const payload = exportDoc(doc, () => new Date('2026-09-30T00:00:00Z'));
    const reopened = importDoc(payload);

    expect(reopened.sources.map((s) => s.id)).toEqual(doc.sources.map((s) => s.id));
    expect(reopened.targets.map((t) => t.id)).toEqual(doc.targets.map((t) => t.id));
    expect(reopened.links.map((l) => l.id).sort()).toEqual(doc.links.map((l) => l.id).sort());
    expect(reopened.sources.map((s) => s.text)).toEqual(doc.sources.map((s) => s.text));
    for (const link of reopened.links) {
      expect(reopened.sources.some((s) => s.id === link.sourceId)).toBe(true);
      expect(reopened.targets.some((t) => t.id === link.targetId)).toBe(true);
    }
    // 标题等中文内容原样保留。
    expect(reopened.sources.some((s) => s.kind === 'heading' && s.text === '季度产品发布')).toBe(true);
  });
});
