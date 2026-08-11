/**
 * 字幕エディタ。5,000 件規模でも破綻しないよう可視範囲のみ描画する（仮想スクロール）。
 */

import { charsPerSecond, normalizeCues, parseSubtitles, shiftCues, validateCues } from '../core/subtitles.js';
import { clamp, ellipsize, formatTime, parseTime, uid } from '../core/util.js';
import { button, confirmDialog, emptyState, h, toast } from './dom.js';

const ROW_HEIGHT = 108;
const OVERSCAN = 4;

export function createSubtitleEditor({ store, onSeek, onAutoGenerate }) {
  let selfEditing = false;
  let filterNeedsText = false;

  const list = h('div.cue-list', { attrs: { role: 'list', 'aria-label': '字幕一覧' } });
  const spacer = h('div.cue-list__spacer');
  const viewport = h('div.cue-viewport', { tabindex: '-1' }, [spacer, list]);
  const statusLine = h('p.cue-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const emptyHost = h('div');

  const importInput = h('input', {
    type: 'file',
    accept: '.srt,.vtt,text/plain',
    class: 'sr-only',
    attrs: { 'aria-label': '字幕ファイル（SRT / VTT）を選択' },
    on: {
      change: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
          toast('字幕ファイルが大きすぎます（20MB まで）。', { type: 'error' });
          return;
        }
        const text = await file.text();
        const { cues, errors } = parseSubtitles(text);
        if (!cues.length) {
          toast(errors[0] || '字幕を読み込めませんでした。', { type: 'error' });
          return;
        }
        store.commit((draft) => {
          draft.subtitles = cues;
        }, { label: '字幕を取り込み' });
        toast(`${cues.length} 件の字幕を取り込みました。${errors.length ? `（${errors.length} 件スキップ）` : ''}`, { type: 'success' });
      },
    },
  });

  const toolbar = h('div.toolbar', {}, [
    button('字幕を自動生成', { variant: 'primary', onClick: () => onAutoGenerate() }),
    button('SRT / VTT を取込', { onClick: () => importInput.click() }),
    button('全体を +0.5 秒', { onClick: () => shift(0.5) }),
    button('全体を −0.5 秒', { onClick: () => shift(-0.5) }),
    button('未入力へ移動', { onClick: jumpToNeedsText }),
    button('行を追加', { onClick: addCue }),
    h('label.filter', {}, [
      h('input', {
        type: 'checkbox',
        on: {
          change: (e) => {
            filterNeedsText = e.target.checked;
            render();
          },
        },
      }),
      ' 未入力のみ表示',
    ]),
    importInput,
  ]);

  const element = h('section.panel-section', {}, [toolbar, statusLine, emptyHost, viewport]);

  viewport.addEventListener('scroll', () => renderWindow(), { passive: true });

  function visibleCues() {
    const cues = store.getState().subtitles;
    return filterNeedsText ? cues.filter((c) => c.needsText || !c.text.trim()) : cues;
  }

  function shift(delta) {
    const cues = store.getState().subtitles;
    if (!cues.length) {
      toast('字幕がありません。', { type: 'error' });
      return;
    }
    store.commit((draft) => {
      draft.subtitles = normalizeCues(shiftCues(draft.subtitles, delta), draft.media?.duration || 0);
    }, { label: '字幕をシフト' });
    toast(`字幕全体を ${delta > 0 ? '+' : ''}${delta} 秒ずらしました。`, { type: 'success' });
  }

  function addCue() {
    const duration = store.getState().media?.duration || 0;
    const last = store.getState().subtitles.at(-1);
    const start = last ? Math.min(last.end + 0.1, Math.max(0, duration - 1)) : 0;
    store.commit((draft) => {
      draft.subtitles = normalizeCues(
        [...draft.subtitles, { id: uid('cue'), start, end: Math.min(start + 2, duration || start + 2), text: '', needsText: true }],
        duration,
      );
    }, { label: '字幕を追加' });
  }

  function jumpToNeedsText() {
    const cues = store.getState().subtitles;
    const index = cues.findIndex((c) => c.needsText || !c.text.trim());
    if (index === -1) {
      toast('未入力の字幕はありません。', { type: 'success' });
      return;
    }
    viewport.scrollTop = index * ROW_HEIGHT;
    renderWindow();
    requestAnimationFrame(() => {
      const el = list.querySelector(`[data-cue-id="${cues[index].id}"] textarea`);
      el?.focus();
    });
  }

  function updateCue(id, patch, { history = true } = {}) {
    selfEditing = true;
    store.commit((draft) => {
      const cue = draft.subtitles.find((c) => c.id === id);
      if (!cue) return;
      Object.assign(cue, patch);
      if ('text' in patch) cue.needsText = String(patch.text).trim() === '';
    }, { label: '字幕を編集', history });
    selfEditing = false;
    // 行の再構築はフォーカスを奪うため行わないが、件数表示だけは追従させる
    renderStatus();
    const row = list.querySelector(`[data-cue-id="${id}"]`);
    if (row && 'text' in patch) row.querySelector('.badge--warn')?.remove();
  }

  /** 件数・警告のサマリだけを更新する（行 DOM には触れない） */
  function renderStatus() {
    const cues = store.getState().subtitles;
    if (!cues.length) {
      statusLine.textContent = '字幕 0 件';
      return;
    }
    const errors = validateCues(cues).filter((i) => i.level === 'error').length;
    const needs = cues.filter((c) => c.needsText || !c.text.trim()).length;
    statusLine.textContent = `字幕 ${cues.length} 件 / 未入力 ${needs} 件${errors ? ` / 要修正 ${errors} 件` : ''}${
      cues.length > 1000 ? '（大量のため表示は可視範囲のみ）' : ''
    }`;
  }

  async function removeCue(id) {
    if (!(await confirmDialog('この字幕を削除しますか？', { confirmLabel: '削除', danger: true }))) return;
    store.commit((draft) => {
      draft.subtitles = draft.subtitles.filter((c) => c.id !== id);
    }, { label: '字幕を削除' });
  }

  function splitCue(id) {
    store.commit((draft) => {
      const index = draft.subtitles.findIndex((c) => c.id === id);
      if (index === -1) return;
      const cue = draft.subtitles[index];
      const mid = (cue.start + cue.end) / 2;
      if (mid - cue.start < 0.2 || cue.end - mid < 0.2) return;
      const chars = [...cue.text];
      const half = Math.ceil(chars.length / 2);
      const first = { ...cue, end: mid, text: chars.slice(0, half).join('') };
      const second = { ...cue, id: uid('cue'), start: mid, text: chars.slice(half).join('') };
      first.needsText = !first.text.trim();
      second.needsText = !second.text.trim();
      draft.subtitles.splice(index, 1, first, second);
    }, { label: '字幕を分割' });
  }

  function buildRow(cue, index, top) {
    const cps = charsPerSecond(cue);
    const warn = cue.needsText || !cue.text.trim();
    const tooFast = cps > 12;

    const startInput = h('input.time-input', {
      type: 'text',
      value: formatTime(cue.start, { ms: true }),
      attrs: { 'aria-label': `${index + 1} 番目の字幕の開始時刻`, inputmode: 'numeric' },
      on: {
        change: (e) => {
          const parsed = parseTime(e.target.value);
          if (parsed === null) {
            toast('時刻の書式が不正です（例 00:12.500）。', { type: 'error' });
            e.target.value = formatTime(cue.start, { ms: true });
            return;
          }
          updateCue(cue.id, { start: clamp(parsed, 0, cue.end - 0.05) });
        },
      },
    });
    const endInput = h('input.time-input', {
      type: 'text',
      value: formatTime(cue.end, { ms: true }),
      attrs: { 'aria-label': `${index + 1} 番目の字幕の終了時刻`, inputmode: 'numeric' },
      on: {
        change: (e) => {
          const parsed = parseTime(e.target.value);
          if (parsed === null) {
            toast('時刻の書式が不正です（例 00:12.500）。', { type: 'error' });
            e.target.value = formatTime(cue.end, { ms: true });
            return;
          }
          const duration = store.getState().media?.duration || parsed;
          updateCue(cue.id, { end: clamp(parsed, cue.start + 0.05, duration) });
        },
      },
    });

    const textarea = h('textarea.cue-text', {
      value: cue.text,
      rows: 2,
      attrs: {
        'aria-label': `${index + 1} 番目の字幕テキスト`,
        placeholder: '字幕テキストを入力',
        maxlength: '10000',
      },
      on: {
        input: (e) => updateCue(cue.id, { text: e.target.value }, { history: false }),
        change: (e) => updateCue(cue.id, { text: e.target.value }),
        keydown: (e) => {
          if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const cues = visibleCues();
            const next = cues[index + (e.key === 'ArrowDown' ? 1 : -1)];
            if (!next) return;
            viewport.scrollTop = clamp((index + (e.key === 'ArrowDown' ? 1 : -1)) * ROW_HEIGHT - ROW_HEIGHT, 0, spacerHeight());
            renderWindow();
            requestAnimationFrame(() => list.querySelector(`[data-cue-id="${next.id}"] textarea`)?.focus());
          }
        },
      },
    });

    return h('div.cue-row', {
      dataset: { cueId: cue.id },
      attrs: { role: 'listitem' },
      style: { top: `${top}px`, height: `${ROW_HEIGHT}px` },
    }, [
      h('div.cue-row__head', {}, [
        h('span.cue-row__index', { text: `#${index + 1}` }),
        startInput,
        h('span.cue-row__sep', { text: '→', attrs: { 'aria-hidden': 'true' } }),
        endInput,
        h('span.cue-row__meta', {
          class: tooFast ? 'is-warn' : '',
          text: `${cps.toFixed(1)} 字/秒`,
        }),
        warn ? h('span.badge.badge--warn', { text: '要入力' }) : null,
      ]),
      textarea,
      h('div.cue-row__actions', {}, [
        button('▶ 位置へ', { onClick: () => onSeek(cue.start) }),
        button('分割', { onClick: () => splitCue(cue.id) }),
        button('削除', { variant: 'danger', onClick: () => removeCue(cue.id) }),
      ]),
    ]);
  }

  function spacerHeight() {
    return visibleCues().length * ROW_HEIGHT;
  }

  function renderWindow() {
    const cues = visibleCues();
    spacer.style.height = `${cues.length * ROW_HEIGHT}px`;
    if (!cues.length) {
      list.replaceChildren();
      return;
    }
    const scrollTop = viewport.scrollTop;
    const height = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(cues.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    const nodes = [];
    for (let i = first; i < last; i += 1) nodes.push(buildRow(cues[i], i, i * ROW_HEIGHT));
    list.replaceChildren(...nodes);
  }

  function render() {
    const state = store.getState();
    const cues = state.subtitles;

    emptyHost.replaceChildren();
    if (!cues.length) {
      viewport.hidden = true;
      emptyHost.append(
        emptyState(
          '字幕はまだありません',
          state.analysis.done
            ? '「字幕を自動生成」で発話区間から作成するか、SRT / VTT を取り込んでください。'
            : 'まず素材を読み込み、解析を実行してください。',
          button('字幕を自動生成', { variant: 'primary', onClick: () => onAutoGenerate() }),
        ),
      );
      statusLine.textContent = '字幕 0 件';
      return;
    }
    viewport.hidden = false;
    renderStatus();
    renderWindow();
  }

  const unsubscribe = store.subscribe(() => {
    if (selfEditing) return; // 入力中の再描画はフォーカスを失うため行わない
    render();
  });

  render();

  return {
    element,
    render,
    /** 現在再生位置の字幕へスクロール */
    revealAt(sourceTime) {
      const cues = visibleCues();
      const index = cues.findIndex((c) => sourceTime >= c.start && sourceTime < c.end);
      if (index === -1) return;
      const target = index * ROW_HEIGHT;
      if (target < viewport.scrollTop || target > viewport.scrollTop + viewport.clientHeight - ROW_HEIGHT) {
        viewport.scrollTop = target;
        renderWindow();
      }
    },
    summary() {
      const cues = store.getState().subtitles;
      return ellipsize(cues.map((c) => c.text).join(' '), 200);
    },
    dispose: unsubscribe,
  };
}
