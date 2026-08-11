/**
 * サムネイル作成パネル。
 * 解析済みフレーム品質から候補を自動抽出し、テキストを載せて PNG (1280×720) で書き出す。
 */

import { THUMBNAIL_SIZE, rankThumbnailCandidates, suggestThumbnailTitle } from '../core/thumbnail.js';
import { clamp, describeError, formatTime } from '../core/util.js';
import { drawThumbnail } from '../media/render.js';
import { renderThumbnail } from '../media/exporter.js';
import { button, emptyState, h, imeSafeInput, loading, select, toast, toggle } from './dom.js';
import { shareFile } from '../media/share.js';

export function createThumbnailEditor({ store, getThumbVideo, getSourceUrl }) {
  const preview = h('canvas.thumb-preview', {
    width: THUMBNAIL_SIZE.width,
    height: THUMBNAIL_SIZE.height,
    attrs: { role: 'img', 'aria-label': 'サムネイルのプレビュー' },
  });
  const candidateHost = h('div.thumb-candidates', { attrs: { role: 'list', 'aria-label': 'サムネイル候補' } });
  const statusHost = h('div');
  const controlsHost = h('div.controls');
  const element = h('section.panel-section', {}, [
    h('div.thumb-preview-wrap', {}, [preview]),
    controlsHost,
    h('h3.subheading', { text: '候補フレーム' }),
    statusHost,
    candidateHost,
  ]);

  let candidatesToken = 0;
  let busy = false;

  function patch(mutator, label) {
    store.commit((draft) => {
      mutator(draft.thumbnail, draft);
    }, { label });
  }

  function drawPreview() {
    const state = store.getState();
    const video = getThumbVideo();
    const ctx = preview.getContext('2d');
    if (!video || !state.media) {
      ctx.fillStyle = '#0b0e11';
      ctx.fillRect(0, 0, preview.width, preview.height);
      ctx.fillStyle = '#a7b4c2';
      ctx.font = '32px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('素材を読み込むとプレビューされます', preview.width / 2, preview.height / 2);
      return;
    }
    drawThumbnail(ctx, video, state.thumbnail, preview.width, preview.height);
  }

  async function seekThumbVideo(time) {
    const video = getThumbVideo();
    if (!video) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 2500);
      try {
        video.currentTime = clamp(time, 0, Math.max(0, (video.duration || 0) - 0.05));
      } catch {
        done();
      }
    });
  }

  async function setSourceTime(time) {
    patch((thumb) => {
      thumb.sourceTime = time;
    }, 'サムネイルの位置を変更');
    await seekThumbVideo(time);
    drawPreview();
  }

  async function buildCandidates() {
    const state = store.getState();
    if (busy) return;
    const video = getThumbVideo();
    if (!video || !state.media) {
      toast('先に素材を読み込んでください。', { type: 'error' });
      return;
    }
    const frames = state.analysis.frames;
    if (!frames.length) {
      toast('先に解析を実行してください。候補の抽出にはフレーム解析が必要です。', { type: 'error' });
      return;
    }
    const ranked = rankThumbnailCandidates(frames, state.analysis.scenes, state.analysis.speech, {
      limit: 8,
      duration: state.media.duration,
    });
    if (!ranked.length) {
      statusHost.replaceChildren(emptyState('候補が見つかりません', '解析結果が不足しています。再解析をお試しください。'));
      return;
    }

    busy = true;
    const token = ++candidatesToken;
    const progress = loading('候補フレームを生成中…', { determinate: true });
    statusHost.replaceChildren(progress.element);
    candidateHost.replaceChildren();

    const wasTime = video.currentTime;
    try {
      for (let i = 0; i < ranked.length; i += 1) {
        if (token !== candidatesToken) return;
        const cand = ranked[i];
        await seekThumbVideo(cand.t);
        const canvas = h('canvas', { width: 256, height: 144 });
        const ctx = canvas.getContext('2d');
        const scale = Math.min(256 / (video.videoWidth || 16), 144 / (video.videoHeight || 9));
        const dw = (video.videoWidth || 16) * scale;
        const dh = (video.videoHeight || 9) * scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 256, 144);
        try {
          ctx.drawImage(video, (256 - dw) / 2, (144 - dh) / 2, dw, dh);
        } catch {
          /* 描画できないフレームはスキップ表示 */
        }
        const item = h('div.thumb-candidate', { attrs: { role: 'listitem' } }, [
          h('button.thumb-candidate__btn', {
            type: 'button',
            attrs: {
              'aria-label': `候補 ${i + 1}：${formatTime(cand.t)} を使用（スコア ${(cand.score * 100).toFixed(0)}）`,
            },
            on: { click: () => setSourceTime(cand.t) },
          }, [canvas]),
          h('span.thumb-candidate__meta', { text: `${formatTime(cand.t)} / スコア ${(cand.score * 100).toFixed(0)}` }),
        ]);
        candidateHost.append(item);
        progress.setRatio((i + 1) / ranked.length);
      }
      statusHost.replaceChildren();
      await seekThumbVideo(store.getState().thumbnail.sourceTime || wasTime);
      drawPreview();
      toast(`${ranked.length} 件の候補を生成しました。`, { type: 'success' });
    } catch (error) {
      statusHost.replaceChildren(h('p.alert.alert--error', { attrs: { role: 'alert' }, text: describeError(error) }));
    } finally {
      busy = false;
    }
  }

  async function exportPng() {
    const state = store.getState();
    const url = getSourceUrl();
    if (!url) {
      toast('素材が読み込まれていません。', { type: 'error' });
      return;
    }
    try {
      const blob = await renderThumbnail(state, url);
      const filename = `${sanitizeFilename(state.name)}_thumbnail.png`;
      const shared = await shareFile({ blob, filename, title: state.thumbnail.title || state.name });
      toast(
        shared.method === 'share' ? 'サムネイルを共有しました。' : 'サムネイルを保存しました（1280×720 PNG）。',
        { type: 'success' },
      );
    } catch (error) {
      toast(describeError(error), { type: 'error' });
    }
  }

  function renderControls() {
    const state = store.getState();
    const thumb = state.thumbnail;

    const titleInput = h('input', {
      type: 'text',
      value: thumb.title,
      maxlength: '120',
      attrs: { 'aria-label': 'サムネイルの見出し', placeholder: '例）3分でわかる自動字幕' },
      on: imeSafeInput((value) => patchLive('title', value)),
    });
    const subtitleInput = h('input', {
      type: 'text',
      value: thumb.subtitle,
      maxlength: '160',
      attrs: { 'aria-label': 'サムネイルのサブテキスト', placeholder: '例）初心者向け / 完全解説' },
      on: imeSafeInput((value) => patchLive('subtitle', value)),
    });
    const badgeInput = h('input', {
      type: 'text',
      value: thumb.badge,
      maxlength: '24',
      attrs: { 'aria-label': 'バッジ文字（右上）', placeholder: '例）NEW' },
      on: imeSafeInput((value) => patchLive('badge', value)),
    });
    const accentInput = h('input', {
      type: 'color',
      value: thumb.accent,
      attrs: { 'aria-label': 'アクセント色' },
      on: { input: (e) => { patchLive('accent', e.target.value); } },
    });

    const templateSelect = select({
      label: 'テンプレート',
      value: thumb.template,
      options: [
        { value: 'boldBottom', label: '太字ボトム（王道）' },
        { value: 'leftPanel', label: '左パネル（解説向け）' },
        { value: 'centerImpact', label: 'センターインパクト' },
      ],
      onChange: (v) => {
        patch((t) => {
          t.template = v;
        }, 'テンプレート変更');
        drawPreview();
      },
    });

    const scrimToggle = toggle({
      label: '文字を読みやすくする暗幕を敷く',
      checked: thumb.scrim !== false,
      onChange: (v) => {
        patch((t) => {
          t.scrim = v;
        }, '暗幕切替');
        drawPreview();
      },
    });

    controlsHost.replaceChildren(
      h('div.grid-2', {}, [
        templateSelect.element,
        labeled('見出し', titleInput, '20 文字前後が読みやすいです。長い場合は自動で縮小・折返しします。'),
        labeled('サブテキスト', subtitleInput),
        labeled('バッジ', badgeInput),
        labeled('アクセント色', accentInput),
        scrimToggle.element,
      ]),
      h('div.toolbar', {}, [
        button('候補を自動抽出', { variant: 'primary', onClick: buildCandidates }),
        button('字幕から見出しを提案', {
          onClick: () => {
            const suggestion = suggestThumbnailTitle(store.getState().subtitles);
            if (!suggestion) {
              toast('字幕テキストがないため提案できません。先に字幕を入力してください。', { type: 'error' });
              return;
            }
            patch((t) => {
              t.title = suggestion;
            }, '見出しを提案');
            renderControls();
            drawPreview();
            toast('見出しを提案しました。', { type: 'success' });
          },
        }),
        button('現在の再生位置を使う', {
          onClick: async () => {
            const time = store.getState().thumbnail.sourceTime;
            await setSourceTime(time);
          },
          attrs: { 'aria-label': '現在のサムネイル位置を再取得' },
        }),
        button('📤 サムネを共有 / 保存', { variant: 'primary', onClick: exportPng }),
      ]),
      h('p.hint', {
        text: `使用フレーム: ${formatTime(thumb.sourceTime, { ms: true })} / 出力サイズ 1280×720`,
      }),
    );
  }

  function labeled(labelText, control, hint) {
    const id = `thumb_${labelText}_${Math.random().toString(36).slice(2, 7)}`;
    control.id = id;
    return h('div.field', {}, [
      h('label', { attrs: { for: id }, text: labelText }),
      control,
      hint ? h('p.hint', { text: hint }) : null,
    ]);
  }

  let liveTimer = null;
  function patchLive(key, value) {
    // 入力中は履歴を汚さず、停止後にのみ 1 件の履歴を積む
    store.commit((draft) => {
      draft.thumbnail[key] = value;
    }, { label: 'サムネイル編集', history: false });
    drawPreview();
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      store.commit((draft) => {
        draft.thumbnail[key] = value;
      }, { label: 'サムネイル編集' });
    }, 600);
  }

  const unsubscribe = store.subscribe((_, meta) => {
    if (meta?.label === 'サムネイル編集') return;
    drawPreview();
  });

  renderControls();
  drawPreview();

  return {
    element,
    /** 素材読み込み後などに呼ぶ */
    refresh() {
      renderControls();
      drawPreview();
    },
    setSourceTime,
    dispose: unsubscribe,
  };
}

export function sanitizeFilename(name) {
  return String(name || 'project').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'project';
}
