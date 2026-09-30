import { useEffect, useRef, useState } from 'react';
import { Segment } from '../core/model';
import { useDocStore } from '../store/docStore';
import { unitIdsForSegment } from '../core/docOps';

interface SegmentRowProps {
  segment: Segment;
  index: number;
  total: number;
  selected: boolean;
  splitMode: boolean;
  linkPickerOpen: boolean;
  onToggleSelect: () => void;
  onMove: (toIndex: number) => void;
  onCommitText: (text: string) => void;
  onEnterSplit: () => void;
  onCancelSplit: () => void;
  onConfirmSplit: (parts: string[]) => void;
  onPickLink: () => void;
  onClosePicker: () => void;
  onLinkUnit: (unitId: string) => void;
  onUnlink: (unitId: string) => void;
  onCreateUnit: () => void;
  onConfirmReview: (unitId: string) => void;
}

export function SegmentRow(props: SegmentRowProps) {
  const { segment, index, total } = props;
  const doc = useDocStore((s) => s.doc);
  const setTranslation = useDocStore((s) => s.setTranslation);
  const [draft, setDraft] = useState(segment.text);
  const [splitDraft, setSplitDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(segment.text);
  }, [segment.id, segment.text]);

  const unitIds = unitIdsForSegment(doc, segment.id);
  const units = unitIds
    .map((id) => doc.units.find((u) => u.id === id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u));

  const commitDraft = () => {
    if (draft !== segment.text) props.onCommitText(draft);
  };

  const handleSplit = () => {
    const parts = splitDraft
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) props.onConfirmSplit(parts);
  };

  const splitAtCursor = () => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? segment.text.length;
    props.onConfirmSplit([segment.text.slice(0, cursor), segment.text.slice(cursor)]);
  };

  return (
    <article className={`segment-card ${segment.kind}`}>
      <div className="segment-head">
        <label className="select-box">
          <input type="checkbox" checked={props.selected} onChange={props.onToggleSelect} />
          #{index + 1}
        </label>
        <code className="seg-id">{segment.id.slice(0, 10)}</code>
        <span className="kind-tag">{segment.kind === 'heading' ? '标题' : '正文'}</span>
        <div className="row-actions">
          <button type="button" onClick={() => props.onMove(index - 1)} disabled={index === 0}>
            ↑
          </button>
          <button type="button" onClick={() => props.onMove(index + 1)} disabled={index === total - 1}>
            ↓
          </button>
          <button type="button" onClick={splitAtCursor}>
            光标处拆分
          </button>
          <button type="button" onClick={() => (props.splitMode ? props.onCancelSplit() : props.onEnterSplit())}>
            {props.splitMode ? '取消多行拆分' : '多行拆分'}
          </button>
        </div>
      </div>

      {segment.kind === 'heading' ? (
        <textarea
          ref={textareaRef}
          className="segment-text heading-text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          rows={1}
          aria-label="标题正文"
        />
      ) : (
        <textarea
          ref={textareaRef}
          className="segment-text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          rows={2}
          aria-label="段落正文"
        />
      )}

      {props.splitMode && (
        <div className="split-editor">
          <p className="hint">每行一个拆分段（至少两行），确认后旧译文会进入待核对。</p>
          <textarea
            value={splitDraft}
            onChange={(event) => setSplitDraft(event.target.value)}
            rows={4}
            placeholder={'第一段\n第二段'}
          />
          <button type="button" onClick={handleSplit}>
            确认拆分
          </button>
        </div>
      )}

      <div className="units-area">
        {units.map((unit) => (
          <div key={unit.id} className={`unit-card ${unit.status}`}>
            <div className="unit-meta">
              <code>{unit.id.slice(0, 10)}</code>
              <span className={`badge ${unit.status}`}>
                {unit.status === 'translated' ? '已译' : unit.status === 'review' ? '待核对' : '未译'}
              </span>
              {unit.reason && <span className="reason">{unit.reason}</span>}
              <button type="button" className="link-btn" onClick={() => props.onUnlink(unit.id)}>
                解除关联
              </button>
              {unit.status === 'review' && (
                <button type="button" className="link-btn" onClick={() => props.onConfirmReview(unit.id)}>
                  核对无误
                </button>
              )}
            </div>
            <textarea
              className={`translation-text ${unit.status}`}
              value={unit.text}
              onChange={(event) => setTranslation(unit.id, event.target.value)}
              rows={2}
              placeholder="输入译文…"
              aria-label="译文"
            />
          </div>
        ))}
        <div className="unit-actions">
          <button type="button" onClick={props.onCreateUnit}>
            新建译文
          </button>
          <button type="button" onClick={() => (props.linkPickerOpen ? props.onClosePicker() : props.onPickLink())}>
            {props.linkPickerOpen ? '取消关联选择' : '关联已有译文'}
          </button>
        </div>
        {props.linkPickerOpen && (
          <div className="link-picker">
            {doc.units
              .filter((u) => !unitIds.includes(u.id))
              .map((u) => (
                <button key={u.id} type="button" onClick={() => props.onLinkUnit(u.id)}>
                  {u.text ? u.text.slice(0, 24) : `[空] ${u.id.slice(0, 8)}`}
                </button>
              ))}
            {doc.units.filter((u) => !unitIds.includes(u.id)).length === 0 && (
              <span className="hint">没有可关联的其他译文单元</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
