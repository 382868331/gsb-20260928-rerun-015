import { createDoc } from './doc';

// 测试/演示文稿：含中文标题与重复句子。
export function createSampleDoc() {
  return createDoc({
    blocks: [
      { kind: 'heading', text: '多语言发布说明', translation: 'Multilingual Release Notes' },
      {
        kind: 'paragraph',
        text: '本季度我们优化了编辑流程。系统会保留段落身份。',
        translation: 'This quarter we improved the editing workflow. The system keeps paragraph identities.',
      },
      { kind: 'paragraph', text: '同一个句子会重复出现。', translation: 'The same sentence appears more than once.' },
      {
        kind: 'paragraph',
        text: '请在发布前完成全部译文核对。同一个句子会重复出现。',
        translation: 'Please finish reviewing all translations before release. The same sentence appears more than once.',
      },
    ],
  });
}
