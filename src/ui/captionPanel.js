/**
 * キャプション生成パネル。字幕・尺・シーンから SNS 投稿文を組み立てる。
 */

import { PLATFORMS, TONES, generateCaption } from '../core/captions.js';
import { timelineDuration } from '../core/autoedit.js';
import { button, copyToClipboard, h, infoBox, select, toast, toggle } from './dom.js';
import { downloadText } from '../media/exporter.js';
import { sanitizeFilename } from './thumbnailEditor.js';

export function createCaptionPanel({ store }) {
  const output = h('textarea.caption-output', {
    rows: 14,
    attrs: { 'aria-label': '生成されたキャプション', spellcheck: 'false' },
    on: {
      input: (e) => {
        store.commit((draft) => {
          draft.caption.text = e.target.value;
        }, { label: 'キャプション編集', history: false });
        updateCounter();
      },
    },
  });
  const counter = h('p.caption-counter', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const noticeHost = h('div');
  const keywordHost = h('div.chip-row', { attrs: { 'aria-label': '抽出されたキーワード' } });
  const controlsHost = h('div.controls');

  const element = h('section.panel-section', {}, [
    controlsHost,
    noticeHost,
    h('h3.subheading', { text: '生成結果（編集可）' }),
    output,
    counter,
    h('h3.subheading', { text: '抽出キーワード' }),
    keywordHost,
    h('div.toolbar', {}, [
      button('クリップボードへコピー', {
        variant: 'primary',
        onClick: async () => {
          const text = output.value;
          if (!text.trim()) {
            toast('コピーする内容がありません。', { type: 'error' });
            return;
          }
          const ok = await copyToClipboard(text);
          toast(ok ? 'キャプションをコピーしました。' : 'コピーに失敗しました。手動で選択してください。', {
            type: ok ? 'success' : 'error',
          });
        },
      }),
      button('テキストファイルで保存', {
        onClick: () => {
          const state = store.getState();
          if (!output.value.trim()) {
            toast('保存する内容がありません。', { type: 'error' });
            return;
          }
          downloadText(output.value, `${sanitizeFilename(state.name)}_caption.txt`);
          toast('キャプションを保存しました。', { type: 'success' });
        },
      }),
    ]),
  ]);

  function updateCounter() {
    const state = store.getState();
    const platform = PLATFORMS[state.caption.platform] || PLATFORMS.youtube;
    const length = [...output.value].length;
    const over = length > platform.maxChars;
    counter.textContent = `${length.toLocaleString()} / ${platform.maxChars.toLocaleString()} 文字${over ? '（上限超過）' : ''}`;
    counter.classList.toggle('is-error', over);
  }

  function generate() {
    const state = store.getState();
    const cues = state.subtitles.filter((c) => c.text.trim());
    const result = generateCaption({
      cues,
      scenes: state.analysis.scenes,
      duration: timelineDuration(state.clips) || state.media?.duration || 0,
      platform: state.caption.platform,
      tone: state.caption.tone,
      includeChapters: state.caption.includeChapters,
      includeHashtags: state.caption.includeHashtags,
      title: state.thumbnail.title || state.name,
    });
    store.commit((draft) => {
      draft.caption.text = result.text;
    }, { label: 'キャプション生成' });
    output.value = result.text;
    updateCounter();

    keywordHost.replaceChildren(
      ...(result.keywords.length
        ? result.keywords.map((k) => h('span.chip', { text: `${k.word}（${k.count}）` }))
        : [h('p.hint', { text: '字幕テキストがないためキーワードを抽出できませんでした。' })]),
    );

    noticeHost.replaceChildren();
    if (!cues.length) {
      noticeHost.append(
        infoBox('字幕テキストがないため、尺とシーン情報のみでキャプションを作成しました。字幕を入力すると精度が上がります。'),
      );
    } else if (result.truncated) {
      noticeHost.append(infoBox(`${PLATFORMS[state.caption.platform].label} の文字数上限に合わせて末尾を調整しました。`));
    }
    toast('キャプションを生成しました。', { type: 'success' });
  }

  function renderControls() {
    const state = store.getState();
    const platformSelect = select({
      label: '投稿先',
      value: state.caption.platform,
      options: Object.values(PLATFORMS).map((p) => ({ value: p.id, label: `${p.label}（最大 ${p.maxChars.toLocaleString()} 文字）` })),
      onChange: (v) => {
        store.commit((draft) => {
          draft.caption.platform = v;
        }, { label: '投稿先を変更' });
        updateCounter();
        renderControls();
      },
    });
    const toneSelect = select({
      label: 'トーン',
      value: state.caption.tone,
      options: Object.values(TONES).map((t) => ({ value: t.id, label: t.label })),
      onChange: (v) => {
        store.commit((draft) => {
          draft.caption.tone = v;
        }, { label: 'トーンを変更' });
      },
    });
    const chapters = toggle({
      label: 'チャプターを含める（YouTube のみ）',
      checked: state.caption.includeChapters,
      onChange: (v) => {
        store.commit((draft) => {
          draft.caption.includeChapters = v;
        }, { label: 'チャプター設定' });
      },
    });
    chapters.input.disabled = !PLATFORMS[state.caption.platform]?.chapters;
    const hashtags = toggle({
      label: 'ハッシュタグを含める',
      checked: state.caption.includeHashtags,
      onChange: (v) => {
        store.commit((draft) => {
          draft.caption.includeHashtags = v;
        }, { label: 'ハッシュタグ設定' });
      },
    });

    controlsHost.replaceChildren(
      h('div.grid-2', {}, [platformSelect.element, toneSelect.element, chapters.element, hashtags.element]),
      h('div.toolbar', {}, [button('キャプションを生成', { variant: 'primary', onClick: generate })]),
    );
  }

  const unsubscribe = store.subscribe((state, meta) => {
    if (meta?.label === 'キャプション編集') return;
    if (output.value !== state.caption.text) output.value = state.caption.text;
    updateCounter();
  });

  renderControls();
  output.value = store.getState().caption.text;
  updateCounter();

  return { element, generate, refresh: renderControls, dispose: unsubscribe };
}
