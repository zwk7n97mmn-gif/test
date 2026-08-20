/**
 * サムネイル作成パネル。
 * 解析済みフレーム品質から候補を自動抽出し、テキストを載せて PNG (1280×720) で書き出す。
 */

import { THUMBNAIL_SIZE, rankThumbnailCandidates, suggestThumbnailTitle } from '../core/thumbnail.js';
import { findAsset } from '../core/assets.js';
import { resolveOutputSize, sizingSource } from '../core/layout.js';
import { assetAnalysis } from '../core/project.js';
import { clamp, describeError, formatTime } from '../core/util.js';
import { drawThumbnail } from '../media/render.js';
import { renderThumbnail } from '../media/exporter.js';
import { button, emptyState, h, imeSafeInput, loading, select, toast, toggle } from './dom.js';
import { shareFile } from '../media/share.js';

export function createThumbnailEditor({ store, getThumbElement, getAssetUrl }) {
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

  /** サムネイルに使う素材の要素 */
  function currentElement() {
    const state = store.getState();
    return getThumbElement(state.thumbnail.sourceAssetId) || null;
  }

  /** プレビュー canvas を出力の向きへ合わせる */
  function syncPreviewSize() {
    const state = store.getState();
    const size = resolveOutputSize(state.output, sizingSource(state.assets));
    const ratio = size.width / size.height;
    const width = ratio >= 1 ? THUMBNAIL_SIZE.width : Math.round(THUMBNAIL_SIZE.height * ratio);
    const height = ratio >= 1 ? Math.round(THUMBNAIL_SIZE.width / ratio) : THUMBNAIL_SIZE.height;
    if (preview.width !== width || preview.height !== height) {
      preview.width = width;
      preview.height = height;
    }
  }

  function drawPreview() {
    const state = store.getState();
    syncPreviewSize();
    const video = currentElement();
    const ctx = preview.getContext('2d');
    if (!video || !state.assets.length) {
      ctx.fillStyle = '#0b0e11';
      ctx.fillRect(0, 0, preview.width, preview.height);
      ctx.fillStyle = '#a7b4c2';
      ctx.font = '32px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('素材を読み込むとプレビューされます', preview.width / 2, preview.height / 2);
      return;
    }
    drawThumbnail(ctx, video, state.thumbnail, preview.width, preview.height, {
      fit: state.output?.fit === 'contain' ? 'contain' : 'cover',
      background: state.output?.background,
    });
  }

  async function seekThumbVideo(assetId, time) {
    const element = getThumbElement(assetId);
    if (!(element instanceof HTMLVideoElement)) return; // 画像はシーク不要
    await new Promise((resolve) => {
      const done = () => resolve();
      element.addEventListener('seeked', done, { once: true });
      setTimeout(done, 2500);
      try {
        element.currentTime = clamp(time, 0, Math.max(0, (element.duration || 0) - 0.05));
      } catch {
        done();
      }
    });
  }

  async function setSource(assetId, time) {
    patch((thumb) => {
      thumb.sourceAssetId = assetId;
      thumb.sourceTime = time;
    }, 'サムネイルの位置を変更');
    await seekThumbVideo(assetId, time);
    drawPreview();
  }

  async function buildCandidates() {
    const state = store.getState();
    if (busy) return;
    if (!state.assets.length) {
      toast('先に素材を追加してください。', { type: 'error' });
      return;
    }

    // 動画は品質スコア上位のフレーム、画像はそのまま候補にする
    const candidates = [];
    for (const asset of state.assets) {
      if (asset.kind === 'image') {
        candidates.push({ assetId: asset.id, t: 0, score: 0.5, name: asset.name, isImage: true });
        continue;
      }
      const frames = assetAnalysis(state, asset.id).frames;
      if (!frames.length) continue;
      const ranked = rankThumbnailCandidates(frames, assetAnalysis(state, asset.id).scenes, assetAnalysis(state, asset.id).speech, {
        limit: 4,
        duration: asset.duration,
      });
      for (const cand of ranked) candidates.push({ assetId: asset.id, t: cand.t, score: cand.score, name: asset.name, isImage: false });
    }
    candidates.sort((a, b) => b.score - a.score);
    const picked = candidates.slice(0, 9);

    if (!picked.length) {
      statusHost.replaceChildren(emptyState('候補が見つかりません', '動画素材の解析を実行すると候補を抽出できます。'));
      return;
    }

    busy = true;
    const token = ++candidatesToken;
    const progress = loading('候補フレームを生成中…', { determinate: true });
    statusHost.replaceChildren(progress.element);
    candidateHost.replaceChildren();

    try {
      for (let i = 0; i < picked.length; i += 1) {
        if (token !== candidatesToken) return;
        const cand = picked[i];
        const element = getThumbElement(cand.assetId);
        if (!element) continue;
        if (!cand.isImage) await seekThumbVideo(cand.assetId, cand.t);

        const canvas = h('canvas', { width: 256, height: 144 });
        const ctx = canvas.getContext('2d');
        const sw = element.videoWidth || element.naturalWidth || 16;
        const sh = element.videoHeight || element.naturalHeight || 9;
        const scale = Math.min(256 / sw, 144 / sh);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 256, 144);
        try {
          ctx.drawImage(element, (256 - sw * scale) / 2, (144 - sh * scale) / 2, sw * scale, sh * scale);
        } catch {
          /* 描画できないフレームはスキップ表示 */
        }
        const label = cand.isImage ? cand.name : `${cand.name} ${formatTime(cand.t)}`;
        const item = h('div.thumb-candidate', { attrs: { role: 'listitem' } }, [
          h('button.thumb-candidate__btn', {
            type: 'button',
            attrs: { 'aria-label': `候補 ${i + 1}：${label} を使用（スコア ${(cand.score * 100).toFixed(0)}）` },
            on: { click: () => setSource(cand.assetId, cand.t) },
          }, [canvas]),
          h('span.thumb-candidate__meta', { text: label }),
        ]);
        candidateHost.append(item);
        progress.setRatio((i + 1) / picked.length);
      }
      statusHost.replaceChildren();
      const current = store.getState().thumbnail;
      await seekThumbVideo(current.sourceAssetId, current.sourceTime);
      drawPreview();
      toast(`${picked.length} 件の候補を生成しました。`, { type: 'success' });
    } catch (error) {
      statusHost.replaceChildren(h('p.alert.alert--error', { attrs: { role: 'alert' }, text: describeError(error) }));
    } finally {
      busy = false;
    }
  }

  async function exportPng() {
    const state = store.getState();
    const url = getAssetUrl(state.thumbnail.sourceAssetId);
    if (!url) {
      toast('サムネイルに使う素材が読み込まれていません。', { type: 'error' });
      return;
    }
    const asset = findAsset(state.assets, state.thumbnail.sourceAssetId);
    try {
      const blob = await renderThumbnail(state, url, { isImage: asset?.kind === 'image' });
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
        button('表示を更新', {
          onClick: async () => {
            const thumb = store.getState().thumbnail;
            await setSource(thumb.sourceAssetId, thumb.sourceTime);
          },
          attrs: { 'aria-label': 'サムネイルのプレビューを再描画' },
        }),
        button('📤 サムネを共有 / 保存', { variant: 'primary', onClick: exportPng }),
      ]),
      h('p.hint', {
        text: `使用素材: ${findAsset(state.assets, thumb.sourceAssetId)?.name ?? '未選択'}｜位置 ${formatTime(thumb.sourceTime, { ms: true })}｜出力 ${preview.width}×${preview.height}`,
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
    /** 外部（タイムライン等）から抽出位置を指定する */
    setSource,
    dispose: unsubscribe,
  };
}

export function sanitizeFilename(name) {
  return String(name || 'project').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'project';
}
