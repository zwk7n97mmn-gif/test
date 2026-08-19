/**
 * Kirinuki Studio — 合成ルート。
 * 状態ストア・メディア・パネル・キーボード操作を配線する。
 */

import { buildCutPlanForClips, editSummary, layoutClips, sanitizeClips, splitAt, timelineDuration, timelineToSource } from './core/autoedit.js';
import { IMAGE_DURATION_RANGE, clipsFromAssets, findAsset, moveAsset, removeAsset, setImageDuration } from './core/assets.js';
import { ASPECTS, BACKGROUNDS, FITS, describeFraming, resolveOutputSize } from './core/layout.js';
import { buildAudioPlan, describeAudioPlan } from './core/audio.js';
import { analysisWarnings, assetAnalysis, createPersistence, createProject, createStore, isAnalysisDone, pendingAnalysisAssets, speechByAsset } from './core/project.js';
import { STT_PROVIDERS, alignTextToSegments, transcribeRemote, transcribeWithVad } from './core/stt.js';
import { encodeWav, resample } from './core/wav.js';
import { clamp, debounce, describeError, formatBytes, formatTime, speakableTime } from './core/util.js';
import { MAX_RECOMMENDED_BYTES, analyzeMedia, decodeAudioFile } from './media/decoder.js';
import { createAssetRuntime, isImageFile, isVideoFile, loadImage, loadVideoAsset } from './media/assetstore.js';
import { TimelinePlayer } from './media/player.js';
import { clearSourceFile, isOpfsAvailable, loadSourceFile, pruneSavedAssets, saveSourceFile } from './media/storage.js';
import { createWakeLock } from './media/wakelock.js';
import { announce, button, confirmDialog, emptyState, errorBox, field, h, infoBox, loading, openDialog, qs, select, slider, toast, toggle } from './ui/dom.js';
import { createTimeline } from './ui/timeline.js';
import { createSubtitleEditor } from './ui/subtitleEditor.js';
import { createThumbnailEditor } from './ui/thumbnailEditor.js';
import { createCaptionPanel } from './ui/captionPanel.js';
import { createExportPanel } from './ui/exportPanel.js';

/* ------------------------------------------------------------------ */
/* 状態                                                                */
/* ------------------------------------------------------------------ */

const store = createStore(createProject());
const persistence = createPersistence(safeLocalStorage());

/** 永続化できないランタイム資源 */
const media = {
  /** 素材 ID → { file, url, element, thumb } */
  runtime: createAssetRuntime(),
  audioContext: null,
  /** STT へ送るための解析済み PCM（素材 ID ごと） */
  samplesByAsset: new Map(),
  bgmBuffer: null,
  player: null,
};

let analysisController = null;
let sttApiKey = ''; // メモリ上のみ。保存しない。
/** 解析・書き出し中に画面が消えないようにする（スマートフォンでは処理が絞られるため） */
const wakeLock = createWakeLock();

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

const dom = {
  dropzone: qs('#dropzone'),
  fileInput: qs('#file-input'),
  preview: qs('#preview-canvas'),
  previewOverlay: qs('#preview-overlay'),
  transport: qs('#transport'),
  timelineHost: qs('#timeline-host'),
  saveStatus: qs('#save-status'),
  projectName: qs('#project-name'),
  undo: qs('#btn-undo'),
  redo: qs('#btn-redo'),
  help: qs('#btn-help'),
  panels: {
    media: qs('#panel-media'),
    subtitles: qs('#panel-subtitles'),
    edit: qs('#panel-edit'),
    audio: qs('#panel-audio'),
    thumbnail: qs('#panel-thumbnail'),
    caption: qs('#panel-caption'),
    export: qs('#panel-export'),
  },
};

const timeline = createTimeline({
  getProject: () => store.getState(),
  onSeek: (t) => seek(t),
});
dom.timelineHost.append(timeline.element);

const subtitleEditor = createSubtitleEditor({
  store,
  onSeek: (sourceTime, assetId) => {
    const { timelineTime } = sourceToTimelineSafe(sourceTime, assetId);
    seek(timelineTime);
  },
  onAutoGenerate: () => runAutoSubtitles(),
});
dom.panels.subtitles.append(subtitleEditor.element);

const thumbnailEditor = createThumbnailEditor({
  store,
  getThumbElement: (assetId) => media.runtime.thumbElement(assetId),
  getAssetUrl: (assetId) => media.runtime.url(assetId),
});
dom.panels.thumbnail.append(thumbnailEditor.element);

const captionPanel = createCaptionPanel({ store });
dom.panels.caption.append(captionPanel.element);

const exportPanel = createExportPanel({
  store,
  getAssetUrl: (assetId) => media.runtime.url(assetId),
  getAssetFile: (assetId) => media.runtime.file(assetId),
  getAssetImage: (assetId) => {
    const element = media.runtime.element(assetId);
    return element instanceof HTMLImageElement ? element : null;
  },
  getBgmBuffer: () => media.bgmBuffer,
  beforeExport: () => media.player?.pause(),
});
dom.panels.export.append(exportPanel.element);

/* ------------------------------------------------------------------ */
/* 素材パネル                                                          */
/* ------------------------------------------------------------------ */

const mediaPanelHost = h('div');
dom.panels.media.append(mediaPanelHost);

/**
 * 再描画中に再描画が始まるのを防ぐ。
 *
 * 入力欄で change → commit → 再描画 と進むと、フォーカス中の要素が
 * 差し替えで外れて blur が同期的に発火し、その中で再び再描画が走る。
 * DOM の差し替え中に差し替えが重なると NotFoundError になるため、
 * 内側の要求は「あとでもう一度」に畳む。
 */
let mediaPanelRendering = false;
let mediaPanelPending = false;

function renderMediaPanel(extra) {
  if (mediaPanelRendering) {
    mediaPanelPending = true;
    return;
  }
  mediaPanelRendering = true;
  try {
    renderMediaPanelNow(extra);
  } finally {
    mediaPanelRendering = false;
  }
  if (mediaPanelPending) {
    mediaPanelPending = false;
    renderMediaPanel();
  }
}

function renderMediaPanelNow(extra) {
  const state = store.getState();
  const children = [];

  if (!state.assets.length) {
    children.push(
      emptyState(
        '素材がありません',
        '動画と画像を追加できます。画像は 1 枚あたり既定 3 秒で表示されます。',
        h('div.toolbar', {}, [
          button('動画・画像を追加', { variant: 'primary', onClick: () => dom.fileInput.click() }),
        ]),
      ),
    );
  } else {
    const videos = state.assets.filter((a) => a.kind === 'video').length;
    const images = state.assets.filter((a) => a.kind === 'image').length;
    const sourceTotal = state.assets.reduce((sum, a) => sum + a.duration, 0);

    children.push(
      h('dl.summary', {}, [
        h('dt', { text: '素材' }),
        h('dd', { text: `動画 ${videos} 件 / 画像 ${images} 枚` }),
        h('dt', { text: '合計の長さ' }),
        h('dd', { text: formatTime(sourceTotal, { ms: true }) }),
        h('dt', { text: '解析' }),
        h('dd', { text: isAnalysisDone(state) ? '完了' : `未解析 ${pendingAnalysisAssets(state).length} 件` }),
      ]),
      h('div.toolbar', {}, [
        button('動画・画像を追加', { variant: 'primary', onClick: () => dom.fileInput.click() }),
        pendingAnalysisAssets(state).length
          ? button('解析を実行', { variant: 'primary', onClick: () => runAnalysis() })
          : button('再解析する', { onClick: () => reanalyzeAll() }),
        button('おまかせ自動処理', { onClick: () => runAutoPipeline() }),
      ]),
      h('h3.subheading', { text: `素材リスト（${state.assets.length}）` }),
      renderAssetList(state),
    );
    for (const warning of analysisWarnings(state)) children.push(infoBox(warning));
  }

  children.push(
    h('h3.subheading', { text: '出力の向き' }),
    renderOutputSettings(state),
    h('h3.subheading', { text: '音声認識（STT）の設定' }),
    renderSttSettings(),
  );

  // 差し替えでフォーカスが飛ぶとキーボード操作の位置を見失う。
  // id が同じ要素へ戻し、テキスト入力ならキャレット位置も復元する。
  const active = document.activeElement;
  const focusId = active && active.id && mediaPanelHost.contains(active) ? active.id : '';
  const caret = focusId && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  mediaPanelHost.replaceChildren(...children, extra || h('div'));

  if (focusId) {
    const next = mediaPanelHost.querySelector(`#${CSS.escape(focusId)}`);
    if (next) {
      next.focus({ preventScroll: true });
      if (caret !== null && typeof next.setSelectionRange === 'function') {
        try {
          next.setSelectionRange(caret, caret);
        } catch {
          /* number 入力など、選択範囲を持たない型では無視 */
        }
      }
    }
  }
}

/** 素材の一覧。並べ替え・削除・画像の表示秒数をここで扱う。 */
function renderAssetList(state) {
  const rows = state.assets.map((asset, index) => {
    const analysis = assetAnalysis(state, asset.id);
    const meta = asset.kind === 'image'
      ? `画像 ${asset.width}×${asset.height}`
      : `動画 ${asset.width}×${asset.height} / ${formatTime(asset.duration, { ms: true })}${asset.hasAudio ? ' / 音声あり' : ' / 音声なし'}`;

    const controls = [
      button('▲', {
        onClick: () => reorderAsset(index, index - 1),
        attrs: { 'aria-label': `${asset.name} を前へ移動` },
      }),
      button('▼', {
        onClick: () => reorderAsset(index, index + 1),
        attrs: { 'aria-label': `${asset.name} を後ろへ移動` },
      }),
      button('削除', {
        variant: 'danger',
        onClick: () => deleteAsset(asset.id),
        attrs: { 'aria-label': `${asset.name} を削除` },
      }),
    ];
    controls[0].disabled = index === 0;
    controls[1].disabled = index === state.assets.length - 1;

    const body = [
      h('div.asset-item__head', {}, [
        h('span.asset-item__kind', { text: asset.kind === 'image' ? '🖼' : '🎞', attrs: { 'aria-hidden': 'true' } }),
        h('span.asset-item__name', { text: asset.name }),
        asset.kind === 'video' && !analysis.done ? h('span.badge.badge--warn', { text: '未解析' }) : null,
      ].filter(Boolean)),
      h('p.asset-item__meta', { text: meta }),
    ];

    if (asset.kind === 'image') {
      const inputId = `dur_${asset.id}`;
      const durationInput = h('input.asset-item__duration', {
        id: inputId,
        type: 'number',
        value: String(asset.duration),
        min: String(IMAGE_DURATION_RANGE.min),
        max: String(IMAGE_DURATION_RANGE.max),
        step: '0.5',
        attrs: { inputmode: 'decimal' },
        on: {
          change: (event) => changeImageDuration(asset.id, Number(event.target.value)),
        },
      });
      body.push(h('div.asset-item__duration-row', {}, [
        h('label', { attrs: { for: inputId }, text: '表示秒数' }),
        durationInput,
        h('span.hint', { text: '秒' }),
      ]));
    }

    body.push(h('div.asset-item__actions', {}, controls));
    return h('div.asset-item', { attrs: { role: 'listitem' } }, body);
  });

  return h('div.asset-list', { attrs: { role: 'list', 'aria-label': '素材リスト' } }, rows);
}

function reorderAsset(from, to) {
  if (to < 0 || to >= store.getState().assets.length) return;
  store.commit((draft) => {
    const result = moveAsset(draft.assets, draft.clips, from, to);
    draft.assets = result.assets;
    draft.clips = result.clips;
  }, { label: '素材を並べ替え' });
  media.player?.seek(0);
  toast('素材の順番を変更しました。', { duration: 2000 });
}

function changeImageDuration(assetId, seconds) {
  store.commit((draft) => {
    const result = setImageDuration(draft.assets, draft.clips, assetId, seconds);
    draft.assets = result.assets;
    draft.clips = result.clips;
  }, { label: '画像の表示秒数を変更' });
  media.player?.seek(Math.min(currentTime, timelineDuration(store.getState().clips)));
}

async function reanalyzeAll() {
  store.commit((draft) => {
    draft.analysis = { done: false, byAsset: {} };
  }, { label: '解析をやり直す' });
  await runAnalysis();
}

/** 出力の向き・フィット・余白の設定 */
function renderOutputSettings(state) {
  const source = state.media || { width: 1280, height: 720 };
  const aspectSelect = select({
    label: '動画の向き',
    value: state.output.aspect,
    options: Object.values(ASPECTS).map((a) => ({ value: a.id, label: `${a.label} — ${a.hint}` })),
    onChange: (v) => patchOutput({ aspect: v }),
  });
  const fitSelect = select({
    label: '素材の収め方',
    value: state.output.fit,
    options: Object.values(FITS).map((f) => ({ value: f.id, label: `${f.label} — ${f.hint}` })),
    onChange: (v) => patchOutput({ fit: v }),
  });
  const backgroundSelect = select({
    label: '余白の埋め方',
    value: state.output.background,
    options: Object.values(BACKGROUNDS).map((b) => ({ value: b.id, label: `${b.label} — ${b.hint}` })),
    onChange: (v) => patchOutput({ background: v }),
  });
  backgroundSelect.input.disabled = state.output.fit === 'cover';

  return h('div.controls', {}, [
    aspectSelect.element,
    fitSelect.element,
    backgroundSelect.element,
    h('p.plan-summary', {
      attrs: { role: 'status' },
      text: state.assets.length ? describeFraming(source.width, source.height, state.output) : '素材を追加すると出力サイズが決まります。',
    }),
  ]);
}

function patchOutput(patch) {
  store.commit((draft) => {
    Object.assign(draft.output, patch);
  }, { label: '出力設定' });
  resizePreviewCanvas();
  media.player?.renderFrame();
  renderMediaPanel();
  thumbnailEditor.refresh();
}

function renderSttSettings() {
  const state = store.getState();
  const provider = STT_PROVIDERS[state.stt.providerId] || STT_PROVIDERS.vad;
  const providerSelect = select({
    label: '文字起こしの方法',
    value: state.stt.providerId,
    options: Object.values(STT_PROVIDERS).map((p) => ({ value: p.id, label: p.label })),
    hint: provider.description,
    onChange: (v) => {
      store.commit((draft) => {
        draft.stt.providerId = v;
      }, { label: 'STT 設定' });
      renderMediaPanel();
    },
  });

  const children = [providerSelect.element];
  if (state.stt.providerId === 'remote') {
    const endpoint = h('input', {
      type: 'url',
      value: state.stt.endpoint,
      attrs: { placeholder: 'https://api.openai.com/v1/audio/transcriptions', spellcheck: 'false' },
      on: {
        change: (e) => store.commit((draft) => {
          draft.stt.endpoint = e.target.value;
        }, { label: 'STT 設定' }),
      },
    });
    const model = h('input', {
      type: 'text',
      value: state.stt.model,
      attrs: { placeholder: 'whisper-1', spellcheck: 'false' },
      on: {
        change: (e) => store.commit((draft) => {
          draft.stt.model = e.target.value;
        }, { label: 'STT 設定' }),
      },
    });
    const language = h('input', {
      type: 'text',
      value: state.stt.language,
      attrs: { placeholder: 'ja', spellcheck: 'false' },
      on: {
        change: (e) => store.commit((draft) => {
          draft.stt.language = e.target.value;
        }, { label: 'STT 設定' }),
      },
    });
    const apiKey = h('input', {
      type: 'password',
      value: sttApiKey,
      attrs: { placeholder: 'sk-...', autocomplete: 'off', spellcheck: 'false' },
      on: { input: (e) => { sttApiKey = e.target.value; } },
    });
    children.push(
      field('エンドポイント', endpoint),
      field('モデル', model),
      field('言語コード', language, { hint: '空欄で自動判定。日本語なら ja。' }),
      field('API キー', apiKey, { hint: 'キーはこのタブのメモリ上にのみ保持し、保存も送信先以外への送出も行いません。' }),
      infoBox('この方法では音声データが設定したエンドポイントへ送信されます。取り扱いにご注意ください。'),
    );
  }
  return h('div.controls', {}, children);
}

/* ------------------------------------------------------------------ */
/* 編集パネル                                                          */
/* ------------------------------------------------------------------ */

const editPanelHost = h('div');
dom.panels.edit.append(editPanelHost);

function renderEditPanel() {
  const state = store.getState();
  if (!state.assets.length) {
    editPanelHost.replaceChildren(emptyState('素材が必要です', '先に動画や画像を追加してください。'));
    return;
  }
  const cfg = state.autoEdit;
  const sourceTotal = state.assets.reduce((sum, a) => sum + a.duration, 0);
  const summary = editSummary(state.clips, sourceTotal);

  const modeSelect = select({
    label: '無音の扱い',
    value: cfg.mode,
    options: [
      { value: 'cut', label: 'カットする（尺を詰める）' },
      { value: 'speed', label: '倍速にする（テンポを保つ）' },
    ],
    onChange: (v) => patchAutoEdit({ mode: v }),
  });

  const padStart = slider({
    label: '発話前の余白',
    min: 0, max: 1, step: 0.05, value: cfg.padStart,
    format: (v) => `${v.toFixed(2)} 秒`,
    onInput: (v) => patchAutoEdit({ padStart: v }, false),
  });
  const padEnd = slider({
    label: '発話後の余白',
    min: 0, max: 1.5, step: 0.05, value: cfg.padEnd,
    format: (v) => `${v.toFixed(2)} 秒`,
    onInput: (v) => patchAutoEdit({ padEnd: v }, false),
  });
  const minGap = slider({
    label: 'カットする無音の最小長',
    min: 0.2, max: 3, step: 0.1, value: cfg.minGap,
    format: (v) => `${v.toFixed(1)} 秒`,
    onInput: (v) => patchAutoEdit({ minGap: v }, false),
  });
  const minClip = slider({
    label: '最短クリップ長',
    min: 0.2, max: 3, step: 0.1, value: cfg.minClip,
    format: (v) => `${v.toFixed(1)} 秒`,
    onInput: (v) => patchAutoEdit({ minClip: v }, false),
  });
  const speedFactor = slider({
    label: '無音の倍速率',
    min: 1.2, max: 6, step: 0.1, value: cfg.speedFactor,
    format: (v) => `${v.toFixed(1)}×`,
    onInput: (v) => patchAutoEdit({ speedFactor: v }, false),
  });
  speedFactor.input.disabled = cfg.mode !== 'speed';

  const clipList = h('div.clip-list', { attrs: { role: 'list', 'aria-label': 'クリップ一覧' } },
    state.clips.length
      ? state.clips.slice(0, 200).map((clip, index) => {
        const asset = findAsset(state.assets, clip.assetId);
        const isImage = asset?.kind === 'image';
        return h('div.clip-item', { attrs: { role: 'listitem' } }, [
          h('span.clip-item__label', {
            text: `#${index + 1} ${isImage ? '🖼' : '🎞'} ${asset?.name ?? '不明な素材'}｜${formatTime(clip.start, { ms: true })} → ${formatTime(clip.end, { ms: true })}${
              clip.speed !== 1 ? ` / ${clip.speed.toFixed(1)}×` : ''
            }`,
          }),
          h('label.clip-item__toggle', {}, [
            h('input', {
              type: 'checkbox',
              checked: clip.enabled,
              attrs: { 'aria-label': `クリップ ${index + 1} を使用する` },
              on: {
                change: (e) => {
                  const checked = e.target.checked;
                  store.commit((draft) => {
                    const target = draft.clips.find((c) => c.id === clip.id);
                    if (target) target.enabled = checked;
                  }, { label: 'クリップ切替' });
                },
              },
            }),
            ' 使用',
          ]),
          button('▶', {
            onClick: () => seek(sourceToTimelineSafe(clip.start, clip.assetId).timelineTime),
            attrs: { 'aria-label': `クリップ ${index + 1} の先頭へ移動` },
          }),
        ]);
      })
      : [h('p.hint', { text: 'クリップがありません。' })],
  );

  editPanelHost.replaceChildren(
    h('dl.summary', {}, [
      h('dt', { text: '現在の尺' }),
      h('dd', { text: `${formatTime(summary.timelineDuration, { ms: true })} / ${summary.clipCount} クリップ` }),
      h('dt', { text: '削減' }),
      h('dd', { text: `${formatTime(summary.removedDuration)}（${(summary.removedRatio * 100).toFixed(1)}%）` }),
    ]),
    h('div.controls', {}, [
      modeSelect.element,
      padStart.element,
      padEnd.element,
      minGap.element,
      minClip.element,
      speedFactor.element,
    ]),
    h('div.toolbar', {}, [
      button('自動カットを適用', { variant: 'primary', onClick: () => applyAutoCut() }),
      button('現在位置で分割 (S)', { onClick: () => splitAtPlayhead() }),
      button('全クリップを元に戻す', { onClick: () => resetClips() }),
    ]),
    isAnalysisDone(state) && Object.values(speechByAsset(state)).every((list) => !list.length)
      ? infoBox('発話区間が検出されていないため、自動カットではクリップがそのまま残ります。')
      : h('div'),
    h('h3.subheading', { text: `クリップ（${state.clips.length} 件${state.clips.length > 200 ? ' / 先頭 200 件を表示' : ''}）` }),
    clipList,
  );
}

const commitAutoEditDebounced = debounce(() => {
  store.commit((draft) => draft, { label: '自動編集設定' });
}, 500);

function patchAutoEdit(patch, immediate = true) {
  store.commit((draft) => {
    Object.assign(draft.autoEdit, patch);
  }, { label: '自動編集設定', history: immediate });
  if (!immediate) commitAutoEditDebounced();
  if ('mode' in patch) renderEditPanel();
}

function applyAutoCut() {
  const state = store.getState();
  if (!state.assets.length) return;
  if (!isAnalysisDone(state)) {
    toast('先に解析を実行してください。', { type: 'error' });
    return;
  }
  const clips = buildCutPlanForClips(state.clips, {
    assets: state.assets,
    speechByAsset: speechByAsset(state),
    options: state.autoEdit,
  });
  const sourceTotal = state.assets.reduce((sum, a) => sum + a.duration, 0);
  store.commit((draft) => {
    draft.clips = clips;
    draft.autoEdit.enabled = true;
  }, { label: '自動カットを適用' });
  const summary = editSummary(clips, sourceTotal);
  toast(`自動カットを適用しました：${summary.clipCount} クリップ / ${(summary.removedRatio * 100).toFixed(1)}% 削減`, {
    type: 'success',
  });
  announce(`自動カットを適用しました。出力尺は ${speakableTime(summary.timelineDuration)} です。`);
  media.player?.refreshPlan();
}

function resetClips() {
  const state = store.getState();
  if (!state.assets.length) return;
  store.commit((draft) => {
    draft.clips = clipsFromAssets(draft.assets);
    draft.autoEdit.enabled = false;
  }, { label: 'クリップをリセット' });
  toast('クリップを素材そのままの並びに戻しました。', { type: 'success' });
}

function splitAtPlayhead() {
  const state = store.getState();
  if (!state.clips.length) {
    toast('分割できるクリップがありません。', { type: 'error' });
    return;
  }
  const mapped = timelineToSource(state.clips, currentTime);
  if (!mapped) return;
  const asset = findAsset(state.assets, mapped.assetId);
  if (asset?.kind === 'image') {
    toast('画像は分割できません。表示秒数を変えてください。', { type: 'error' });
    return;
  }
  const before = state.clips.length;
  store.commit((draft) => {
    draft.clips = sanitizeClips(splitAt(draft.clips, mapped.sourceTime, mapped.assetId), draft.assets);
  }, { label: 'クリップを分割' });
  if (store.getState().clips.length === before) {
    toast('この位置では分割できません。クリップの内側へ再生位置を移動してください。', { type: 'error' });
    return;
  }
  toast(`${formatTime(mapped.sourceTime, { ms: true })} で分割しました。`, { type: 'success' });
  announce(`${formatTime(mapped.sourceTime)} でクリップを分割しました。`);
}

/* ------------------------------------------------------------------ */
/* 音声パネル                                                          */
/* ------------------------------------------------------------------ */

const audioPanelHost = h('div');
dom.panels.audio.append(audioPanelHost);

const bgmInput = h('input', {
  type: 'file',
  accept: 'audio/*',
  class: 'sr-only',
  attrs: { 'aria-label': 'BGM の音声ファイルを選択' },
  on: {
    change: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        ensureAudioContext();
        media.bgmBuffer = await decodeAudioFile(file, media.audioContext);
        store.commit((draft) => {
          draft.audio.bgmName = file.name;
        }, { label: 'BGM を追加' });
        media.player?.setBgmBuffer(media.bgmBuffer);
        toast(`BGM を読み込みました：${file.name}（${formatTime(media.bgmBuffer.duration)}）`, { type: 'success' });
      } catch (error) {
        toast(`BGM を読み込めませんでした：${describeError(error)}`, { type: 'error' });
      }
    },
  },
});

function renderAudioPanel() {
  const state = store.getState();
  const cfg = state.audio;
  const total = timelineDuration(state.clips);
  const plan = media.player?.refreshPlan() || buildAudioPlan(cfg, { integratedDb: -70, peakDb: -100 }, [], total);

  const normalizeToggle = toggle({
    label: '音量を自動で整える（ラウドネス正規化）',
    checked: cfg.normalize,
    hint: '発話区間の平均レベルを目標値へ合わせ、ピークがクリップしないよう制限します。',
    onChange: (v) => patchAudio({ normalize: v }),
  });
  const targetDb = slider({
    label: '目標ラウドネス',
    min: -30, max: -8, step: 1, value: cfg.targetDb,
    format: (v) => `${v} dB`,
    onInput: (v) => patchAudio({ targetDb: v }, false),
  });
  targetDb.input.disabled = !cfg.normalize;

  const duckToggle = toggle({
    label: '発話中に BGM を自動で下げる（ダッキング）',
    checked: cfg.duck,
    onChange: (v) => patchAudio({ duck: v }),
  });
  const duckDb = slider({
    label: 'ダッキング量',
    min: -30, max: 0, step: 1, value: cfg.duckDb,
    format: (v) => `${v} dB`,
    onInput: (v) => patchAudio({ duckDb: v }, false),
  });
  duckDb.input.disabled = !cfg.duck;

  const bgmGain = slider({
    label: 'BGM の音量',
    min: -40, max: 0, step: 1, value: cfg.bgmGainDb,
    format: (v) => `${v} dB`,
    onInput: (v) => patchAudio({ bgmGainDb: v }, false),
  });
  const fadeIn = slider({
    label: 'フェードイン',
    min: 0, max: 5, step: 0.1, value: cfg.fadeIn,
    format: (v) => `${v.toFixed(1)} 秒`,
    onInput: (v) => patchAudio({ fadeIn: v }, false),
  });
  const fadeOut = slider({
    label: 'フェードアウト',
    min: 0, max: 5, step: 0.1, value: cfg.fadeOut,
    format: (v) => `${v.toFixed(1)} 秒`,
    onInput: (v) => patchAudio({ fadeOut: v }, false),
  });

  audioPanelHost.replaceChildren(
    state.assets.length && !state.assets.some((a) => a.hasAudio)
      ? infoBox('音声を持つ素材がありません。BGM の追加とフェードのみ利用できます。')
      : h('div'),
    h('div.controls', {}, [
      normalizeToggle.element,
      targetDb.element,
      duckToggle.element,
      duckDb.element,
      fadeIn.element,
      fadeOut.element,
    ]),
    h('h3.subheading', { text: 'BGM' }),
    h('div.toolbar', {}, [
      button(cfg.bgmName ? 'BGM を差し替える' : 'BGM を追加', { onClick: () => bgmInput.click() }),
      cfg.bgmName
        ? button('BGM を外す', {
          variant: 'danger',
          onClick: () => {
            media.bgmBuffer = null;
            media.player?.setBgmBuffer(null);
            store.commit((draft) => {
              draft.audio.bgmName = '';
            }, { label: 'BGM を削除' });
            toast('BGM を外しました。', { type: 'success' });
          },
        })
        : null,
      bgmInput,
    ].filter(Boolean)),
    cfg.bgmName ? h('p.hint', { text: `使用中の BGM: ${cfg.bgmName}` }) : h('p.hint', { text: 'BGM は未設定です。' }),
    bgmGain.element,
    h('h3.subheading', { text: '適用される処理' }),
    h('p.plan-summary', { attrs: { role: 'status' }, text: describeAudioPlan(plan) }),
    plan.limitedByPeak ? infoBox(plan.normalizeReason) : h('div'),
  );
}

const commitAudioDebounced = debounce(() => {
  store.commit((draft) => draft, { label: '音声設定' });
}, 500);

function patchAudio(patch, immediate = true) {
  store.commit((draft) => {
    Object.assign(draft.audio, patch);
  }, { label: '音声設定', history: immediate });
  if (!immediate) commitAudioDebounced();
  media.player?.refreshPlan();
  if (typeof patch.normalize === 'boolean' || typeof patch.duck === 'boolean') renderAudioPanel();
}

/* ------------------------------------------------------------------ */
/* メディア読み込み                                                    */
/* ------------------------------------------------------------------ */

function ensureAudioContext() {
  if (!media.audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('この環境では音声を扱えません。');
    media.audioContext = new Ctor();
  }
  return media.audioContext;
}

/**
 * 選ばれたファイル（動画・画像・複数可）を素材として取り込む。
 */
async function addFiles(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;

  const accepted = files.filter((f) => isVideoFile(f) || isImageFile(f));
  const rejected = files.length - accepted.length;
  if (!accepted.length) {
    toast('動画または画像を選んでください（MP4 / WebM / MOV / JPEG / PNG など）。', { type: 'error' });
    return;
  }

  for (const file of accepted) {
    if (isVideoFile(file) && file.size > MAX_RECOMMENDED_BYTES) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await confirmDialog(
        `${file.name} は ${formatBytes(file.size)} と大きいため、解析に時間がかかり動作が不安定になる場合があります。続行しますか？`,
        { confirmLabel: '続行' },
      );
      if (!ok) return;
    }
  }

  const progress = loading(`素材を読み込み中…（0 / ${accepted.length}）`);
  renderMediaPanel(progress.element);
  if (!store.getState().assets.length) setPreviewOverlay('素材を読み込んでいます…');

  const added = [];
  const failures = [];
  for (let i = 0; i < accepted.length; i += 1) {
    const file = accepted[i];
    progress.setLabel(`素材を読み込み中…（${i + 1} / ${accepted.length}）${file.name}`);
    try {
      // eslint-disable-next-line no-await-in-loop
      const loaded = isImageFile(file)
        ? await loadImage(file, store.getState().imageDefaults.durationSec)
        : await loadVideoAsset(file);
      // eslint-disable-next-line no-await-in-loop
      await media.runtime.add({ ...loaded, file });
      added.push(loaded.asset);
    } catch (error) {
      failures.push(`${file.name}: ${describeError(error)}`);
    }
  }

  if (!added.length) {
    renderMediaPanel(errorBox(failures[0] || '素材を読み込めませんでした。'));
    toast(failures[0] || '素材を読み込めませんでした。', { type: 'error' });
    return;
  }

  const isFirst = store.getState().assets.length === 0;
  store.commit((draft) => {
    draft.assets = [...draft.assets, ...added];
    draft.clips = [...draft.clips, ...clipsFromAssets(added)];
    if (isFirst) {
      draft.name = added[0].name.replace(/\.[^.]+$/, '') || '無題のプロジェクト';
      draft.thumbnail.sourceAssetId = added[0].id;
      draft.thumbnail.sourceTime = Math.min(1, added[0].duration / 2);
    }
  }, { label: '素材を追加' });

  await ensurePlayer();
  setPreviewOverlay('');
  dom.dropzone.hidden = true;
  thumbnailEditor.refresh();
  renderMediaPanel();

  const summary = `${added.length} 件の素材を追加しました（${added.filter((a) => a.kind === 'image').length} 枚の画像を含む）`;
  toast(failures.length ? `${summary}。${failures.length} 件は読み込めませんでした。` : summary, {
    type: failures.length ? 'error' : 'success',
  });
  announce(summary);
  if (rejected > 0) toast(`${rejected} 件は対応していない形式のため無視しました。`, { type: 'error' });

  for (const asset of added) persistAsset(asset.id);
  if (added.some((a) => a.kind === 'video')) await runAnalysis({ askAfter: isFirst });
  else await media.player?.seek(currentTime);
}

/** プレビュー用の再生エンジンを用意する（最初の素材追加時に 1 度だけ） */
async function ensurePlayer() {
  ensureAudioContext();
  if (!media.player) {
    media.player = new TimelinePlayer({
      canvas: dom.preview,
      audioContext: media.audioContext,
      runtime: media.runtime,
      getProject: () => store.getState(),
      onTime: (t, total) => onPlaybackTime(t, total),
      onEnded: () => renderTransport(),
      onError: (error) => toast(describeError(error), { type: 'error' }),
    });
    if (media.bgmBuffer) media.player.setBgmBuffer(media.bgmBuffer);
  }
  resizePreviewCanvas();
  await media.player.seek(Math.min(currentTime, timelineDuration(store.getState().clips)));
}

/**
 * 素材を端末に保存しておく。
 * スマートフォンではタブが頻繁に破棄されるため、これが無いと
 * 復帰のたびに素材を選び直すことになる。
 */
async function persistAsset(assetId) {
  if (!isOpfsAvailable()) return;
  const file = media.runtime.file(assetId);
  if (!file) return;
  const result = await saveSourceFile(file, assetId);
  if (!result.ok && result.reason) dom.saveStatus.textContent = result.reason;
}

/** 素材を削除する */
async function deleteAsset(assetId) {
  const asset = findAsset(store.getState().assets, assetId);
  if (!asset) return;
  if (!(await confirmDialog(`「${asset.name}」を削除しますか？この素材のクリップと字幕も消えます。`, {
    confirmLabel: '削除', danger: true,
  }))) return;

  media.player?.pause();
  store.commit((draft) => {
    const result = removeAsset(draft.assets, draft.clips, assetId);
    draft.assets = result.assets;
    draft.clips = result.clips;
    draft.subtitles = draft.subtitles.filter((c) => c.assetId !== assetId);
    delete draft.analysis.byAsset[assetId];
    if (draft.thumbnail.sourceAssetId === assetId) {
      draft.thumbnail.sourceAssetId = draft.assets[0]?.id ?? null;
      draft.thumbnail.sourceTime = 0;
    }
  }, { label: '素材を削除' });

  media.runtime.remove(assetId);
  media.samplesByAsset.delete(assetId);
  await clearSourceFile(assetId);
  if (!store.getState().assets.length) {
    dom.dropzone.hidden = false;
    setPreviewOverlay('');
  }
  await media.player?.seek(0);
  thumbnailEditor.refresh();
  toast('素材を削除しました。', { type: 'success' });
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

async function runAnalysis({ askAfter = false } = {}) {
  const state = store.getState();
  const pending = pendingAnalysisAssets(state);
  if (!pending.length) {
    if (state.assets.length) toast('解析が必要な動画素材はありません。', { type: 'success' });
    else toast('先に素材を追加してください。', { type: 'error' });
    return;
  }
  if (analysisController) {
    toast('解析を実行中です。', { type: 'error' });
    return;
  }

  media.player?.pause();
  analysisController = new AbortController();
  await wakeLock.request();
  const progress = loading('解析を開始しています…', { determinate: true });
  const cancel = button('キャンセル', { variant: 'danger', onClick: () => analysisController?.abort() });
  renderMediaPanel(h('div.export-progress', {}, [progress.element, cancel]));

  let analyzed = 0;
  try {
    for (let i = 0; i < pending.length; i += 1) {
      const asset = pending[i];
      const element = media.runtime.element(asset.id);
      const file = media.runtime.file(asset.id);
      if (!element || !file) continue;

      // eslint-disable-next-line no-await-in-loop
      const result = await analyzeMedia({
        file,
        video: element,
        duration: asset.duration,
        audioContext: ensureAudioContext(),
        signal: analysisController.signal,
        onStage: ({ name, ratio }) => {
          const overall = (i + ratio) / pending.length;
          progress.setLabel(`${asset.name}: ${name}（${Math.round(overall * 100)}%）`);
          progress.setRatio(overall);
        },
      });

      if (result.monoSamples) {
        media.samplesByAsset.set(asset.id, { samples: result.monoSamples, sampleRate: result.sampleRate });
      }
      store.commit((draft) => {
        draft.analysis.byAsset[asset.id] = result.analysis;
        const target = findAsset(draft.assets, asset.id);
        if (target) {
          target.fps = result.fps;
          target.hasAudio = result.hasAudio;
        }
        draft.analysis.done = draft.assets
          .filter((a) => a.kind === 'video')
          .every((a) => draft.analysis.byAsset[a.id]?.done === true);
      }, { label: '解析' });
      analyzed += 1;
    }

    await media.player?.seek(0);
    timeline.refresh();
    const total = store.getState();
    const scenes = total.assets.reduce((sum, a) => sum + assetAnalysis(total, a.id).scenes.length, 0);
    const speech = total.assets.reduce((sum, a) => sum + assetAnalysis(total, a.id).speech.length, 0);
    toast(`解析が完了しました：${analyzed} 素材 / シーン ${scenes} 件 / 発話区間 ${speech} 件`, { type: 'success' });
    announce('解析が完了しました。');
    renderMediaPanel();
    if (askAfter) await offerAutoPipeline();
  } catch (error) {
    if (error.name === 'AbortError') {
      renderMediaPanel(infoBox(`解析をキャンセルしました。${analyzed > 0 ? `（${analyzed} 素材は完了）` : ''}`));
    } else {
      renderMediaPanel(errorBox(describeError(error), button('再試行', { onClick: () => runAnalysis() })));
      toast(describeError(error), { type: 'error' });
    }
  } finally {
    analysisController = null;
    await wakeLock.release();
  }
}

/* ------------------------------------------------------------------ */
/* 自動処理（字幕・編集・音声）                                        */
/* ------------------------------------------------------------------ */

async function offerAutoPipeline() {
  const state = store.getState();
  const provider = STT_PROVIDERS[state.stt.providerId];
  const totalSpeech = state.assets.reduce((sum, a) => sum + assetAnalysis(state, a.id).speech.length, 0);
  const subCheck = h('input', { type: 'checkbox', checked: true, id: 'auto-sub' });
  const cutCheck = h('input', { type: 'checkbox', checked: totalSpeech > 0, id: 'auto-cut' });
  const audioCheck = h('input', { type: 'checkbox', checked: true, id: 'auto-audio' });

  const content = h('div', {}, [
    h('p', { text: '解析が完了しました。以下の自動処理を実行しますか？（実行後も Ctrl+Z で元に戻せます）' }),
    h('ul.check-list', {}, [
      h('li', {}, [subCheck, h('label', { attrs: { for: 'auto-sub' }, text: `字幕を自動生成（${provider.label}）` })]),
      h('li', {}, [cutCheck, h('label', { attrs: { for: 'auto-cut' }, text: '無音を自動カット（画像はそのまま）' })]),
      h('li', {}, [audioCheck, h('label', { attrs: { for: 'auto-audio' }, text: '音量の正規化とダッキングを有効化' })]),
    ]),
    provider.producesText
      ? null
      : h('p.hint', { text: '※ オフラインの方法ではタイムコードのみ生成され、テキストは未入力のままになります。' }),
  ]);

  const answer = await openDialog({
    title: '自動処理',
    content,
    actions: [
      { label: 'あとで', value: 'skip' },
      { label: '実行する', value: 'run', variant: 'primary' },
    ],
  });
  if (answer !== 'run') return;
  await runAutoPipeline({
    subtitles: subCheck.checked,
    cut: cutCheck.checked,
    audio: audioCheck.checked,
  });
}

async function runAutoPipeline(options = { subtitles: true, cut: true, audio: true }) {
  if (!isAnalysisDone(store.getState())) {
    toast('先に解析を実行してください。', { type: 'error' });
    return;
  }
  if (options.audio) {
    store.commit((draft) => {
      draft.audio.normalize = true;
      draft.audio.duck = true;
      if (draft.audio.fadeIn === 0) draft.audio.fadeIn = 0.4;
      if (draft.audio.fadeOut === 0) draft.audio.fadeOut = 0.8;
    }, { label: '音声自動設定' });
    media.player?.refreshPlan();
  }
  if (options.cut) applyAutoCut();
  if (options.subtitles) await runAutoSubtitles({ silent: true });
  toast('自動処理が完了しました。', { type: 'success' });
  announce('自動処理が完了しました。');
}

/** 素材ごとの発話区間から字幕を作る */
async function runAutoSubtitles({ silent = false } = {}) {
  const state = store.getState();
  if (!isAnalysisDone(state)) {
    toast('先に解析を実行してください。', { type: 'error' });
    return;
  }
  const speechMap = speechByAsset(state);
  const totalSpeech = Object.values(speechMap).reduce((sum, list) => sum + list.length, 0);
  if (!totalSpeech) {
    const hasAudio = state.assets.some((a) => a.hasAudio);
    toast(
      hasAudio ? '発話区間を検出できませんでした。手動で字幕を追加してください。'
        : '音声のある素材が無いため字幕を自動生成できません。手動で追加してください。',
      { type: 'error' },
    );
    return;
  }

  if (state.subtitles.length && !silent) {
    const ok = await confirmDialog(`既存の字幕 ${state.subtitles.length} 件を置き換えます。よろしいですか？`, {
      confirmLabel: '置き換える',
      danger: true,
    });
    if (!ok) return;
  }

  if (state.stt.providerId === 'remote') {
    await runRemoteStt(speechMap);
    return;
  }

  // 素材ごとにタイムコードを作り、assetId を付けて 1 つの配列にまとめる
  const cues = [];
  let segments = 0;
  for (const [assetId, speech] of Object.entries(speechMap)) {
    if (!speech.length) continue;
    segments += speech.length;
    for (const cue of transcribeWithVad(speech).cues) cues.push({ ...cue, assetId });
  }
  store.commit((draft) => {
    draft.subtitles = cues;
  }, { label: '字幕を自動生成' });
  const notice = `${segments} 件の発話区間からタイムコードを生成しました。テキストを入力してください。`;
  toast(notice, { type: 'success' });
  announce(notice);
}

/** 外部 STT。素材ごとに音声を送って文字起こしする。 */
async function runRemoteStt(speechMap) {
  const state = store.getState();
  if (!state.stt.endpoint) {
    toast('STT のエンドポイントを設定してください。', { type: 'error' });
    return;
  }
  if (!sttApiKey) {
    toast('API キーを入力してください（保存はされません）。', { type: 'error' });
    return;
  }

  const targets = state.assets.filter((a) => a.kind === 'video' && (speechMap[a.id] || []).length > 0);
  if (!targets.length) {
    toast('文字起こしできる素材がありません。', { type: 'error' });
    return;
  }

  const controller = new AbortController();
  const progress = loading('音声を送信して文字起こし中…', { determinate: true });
  const cancel = button('キャンセル', { variant: 'danger', onClick: () => controller.abort() });
  renderMediaPanel(h('div.export-progress', {}, [progress.element, cancel]));

  const cues = [];
  const failures = [];
  try {
    for (let i = 0; i < targets.length; i += 1) {
      const asset = targets[i];
      progress.setLabel(`文字起こし中…（${i + 1} / ${targets.length}）${asset.name}`);
      progress.setRatio(i / targets.length);

      const pcm = media.samplesByAsset.get(asset.id);
      if (!pcm) {
        failures.push(`${asset.name}: 音声データがありません。再解析してください。`);
        continue;
      }
      const targetRate = 16000;
      const wav = encodeWav(resample(pcm.samples, pcm.sampleRate, targetRate), targetRate);
      const sizeMb = wav.byteLength / 1024 / 1024;
      if (sizeMb > 24) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await confirmDialog(
          `${asset.name} の送信データが ${sizeMb.toFixed(1)} MB あります。多くの API は 25MB を上限としており失敗する可能性があります。続行しますか？`,
          { confirmLabel: '送信する' },
        );
        if (!ok) continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const response = await transcribeRemote(
        {
          blob: new Blob([wav], { type: 'audio/wav' }),
          filename: `${asset.id}.wav`,
          endpoint: state.stt.endpoint,
          model: state.stt.model,
          language: state.stt.language,
          apiKey: sttApiKey,
        },
        { signal: controller.signal },
      );

      if (response.errors?.length && !response.cues.length && !response.plainText) {
        failures.push(`${asset.name}: ${response.errors[0]}`);
        continue;
      }
      const assetCues = response.cues.length
        ? response.cues
        : alignTextToSegments(response.plainText || '', speechMap[asset.id]);
      for (const cue of assetCues) cues.push({ ...cue, assetId: asset.id });
    }

    if (!cues.length) {
      renderMediaPanel(errorBox(
        `文字起こしに失敗しました：${failures[0] || '結果が空でした。'}`,
        button('タイムコードのみ生成する', {
          onClick: () => {
            const fallback = [];
            for (const [assetId, speech] of Object.entries(speechMap)) {
              for (const cue of transcribeWithVad(speech).cues) fallback.push({ ...cue, assetId });
            }
            store.commit((draft) => {
              draft.subtitles = fallback;
            }, { label: '字幕を自動生成' });
            renderMediaPanel();
            toast('タイムコードのみ生成しました。', { type: 'success' });
          },
        }),
      ));
      return;
    }

    store.commit((draft) => {
      draft.subtitles = cues;
    }, { label: '字幕を自動生成' });
    renderMediaPanel();
    const message = `文字起こしが完了しました（${cues.length} 件）${failures.length ? `／${failures.length} 素材は失敗` : ''}。`;
    toast(message, { type: failures.length ? 'error' : 'success' });
    announce(message);
  } catch (error) {
    if (error.name === 'AbortError') {
      renderMediaPanel(infoBox('文字起こしをキャンセルしました。'));
    } else {
      renderMediaPanel(errorBox(`文字起こしに失敗しました：${describeError(error)}`));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 再生・トランスポート                                                */
/* ------------------------------------------------------------------ */

let currentTime = 0;

function onPlaybackTime(t, total) {
  currentTime = t;
  timeline.setPlayhead(t);
  updateTransportTime(t, total);
  const mapped = timelineToSource(store.getState().clips, t);
  if (mapped) subtitleEditor.revealAt(mapped.sourceTime);
}

/**
 * タイムライン時刻へ移動する。
 * 表示上の位置は同期的に更新し、デコーダのシーク完了を待たない。
 * （待ってしまうと、矢印キーの連打時に古い位置から計算されて移動が飛ぶ）
 */
function seek(timelineTime) {
  const total = timelineDuration(store.getState().clips);
  currentTime = clamp(timelineTime, 0, total);
  timeline.setPlayhead(currentTime);
  updateTransportTime(currentTime, total);
  return media.player ? media.player.seek(currentTime) : Promise.resolve();
}

async function togglePlay() {
  if (!media.player) {
    toast('先に素材を読み込んでください。', { type: 'error' });
    return;
  }
  if (media.player.playing) media.player.pause();
  else await media.player.play();
  renderTransport();
}

const transportUi = {
  playButton: null,
  timeLabel: null,
};

let lastRenderedPlaying = null;

function renderTransport({ force = false } = {}) {
  const state = store.getState();
  const total = timelineDuration(state.clips);
  const playing = Boolean(media.player?.playing);
  // 操作中にフォーカスを失わないよう、再生状態が変わったときだけ作り直す
  if (!force && lastRenderedPlaying === playing && dom.transport.childElementCount > 0) {
    updateTransportTime(currentTime, total);
    return;
  }
  lastRenderedPlaying = playing;

  transportUi.playButton = button(playing ? '⏸ 一時停止' : '▶ 再生', {
    variant: 'primary',
    onClick: togglePlay,
    attrs: { 'aria-pressed': String(playing), 'aria-keyshortcuts': 'Space' },
  });
  transportUi.timeLabel = h('span.transport__time', {
    attrs: { role: 'timer', 'aria-live': 'off' },
    text: `${formatTime(currentTime, { ms: true })} / ${formatTime(total, { ms: true })}`,
  });

  dom.transport.replaceChildren(
    transportUi.playButton,
    button('⏮ 先頭', { onClick: () => seek(0), attrs: { 'aria-label': '先頭へ移動' } }),
    button('◀ 1秒', { onClick: () => seek(Math.max(0, currentTime - 1)), attrs: { 'aria-label': '1 秒戻る' } }),
    button('1秒 ▶', { onClick: () => seek(Math.min(total, currentTime + 1)), attrs: { 'aria-label': '1 秒進む' } }),
    button('⏭ 末尾', { onClick: () => seek(total), attrs: { 'aria-label': '末尾へ移動' } }),
    transportUi.timeLabel,
    h('span.transport__hint', { text: 'Space 再生 / ← → 移動 / S 分割' }),
  );
}

function updateTransportTime(t, total) {
  if (transportUi.timeLabel) {
    transportUi.timeLabel.textContent = `${formatTime(t, { ms: true })} / ${formatTime(total, { ms: true })}`;
  }
}

function setPreviewOverlay(text) {
  dom.previewOverlay.textContent = text;
  dom.previewOverlay.hidden = !text;
}

function resizePreviewCanvas() {
  const state = store.getState();
  const size = resolveOutputSize(
    { ...state.output, maxSize: Math.min(state.output?.maxSize ?? 1920, 1280) },
    state.media || { width: 1280, height: 720 },
  );
  dom.preview.width = size.width;
  dom.preview.height = size.height;
  // 縦動画のときはプレビュー枠も縦にする。
  // 高さだけを max-height で抑えると枠がはみ出て上下が切れるため、
  // 「上限の高さ×縦横比」で幅の側を抑える（CSS 側で --preview-max-h を持つ）。
  const frame = dom.preview.parentElement;
  frame.style.aspectRatio = `${size.width} / ${size.height}`;
  frame.style.maxWidth = `calc(var(--preview-max-h) * ${size.width} / ${size.height})`;
}

function sourceToTimelineSafe(sourceTime, assetId) {
  const state = store.getState();
  const laid = layoutClips(state.clips).filter((c) => !assetId || c.assetId === assetId);
  if (!laid.length) return { timelineTime: 0, visible: false };
  for (const clip of laid) {
    if (sourceTime >= clip.start && sourceTime <= clip.end) {
      return { timelineTime: clip.timelineStart + (sourceTime - clip.start) / (clip.speed || 1), visible: true };
    }
  }
  return { timelineTime: laid[0].timelineStart, visible: false };
}

/* ------------------------------------------------------------------ */
/* タブ                                                                */
/* ------------------------------------------------------------------ */

const tabs = [...document.querySelectorAll('[role="tab"]')];

function activateTab(id, { focus = true } = {}) {
  for (const tab of tabs) {
    const selected = tab.id === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activateTab(tab.id, { focus: false }));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') [next] = tabs;
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    activateTab(next.id);
  });
}
activateTab(tabs[0].id, { focus: false });

/* ------------------------------------------------------------------ */
/* キーボードショートカット                                            */
/* ------------------------------------------------------------------ */

const SHORTCUTS = [
  ['Space', '再生 / 一時停止'],
  ['← / →', '1 フレーム移動（Shift で 1 秒）'],
  ['Home / End', '先頭 / 末尾へ'],
  ['S', '再生位置でクリップを分割'],
  ['Ctrl + Z', '元に戻す'],
  ['Ctrl + Shift + Z', 'やり直す'],
  ['1 – 7', 'パネル切替'],
  ['?', 'このヘルプを表示'],
];

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const typing = isTypingTarget(event.target);

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      if (store.redo()) toast('やり直しました。', { duration: 2000 });
    } else if (store.undo()) {
      toast('元に戻しました。', { duration: 2000 });
    }
    return;
  }
  if (typing) return;

  if (event.key === '?' || (event.shiftKey && event.key === '/')) {
    event.preventDefault();
    showHelp();
    return;
  }
  if (/^[1-7]$/.test(event.key)) {
    event.preventDefault();
    activateTab(tabs[Number(event.key) - 1].id);
    return;
  }
  const total = timelineDuration(store.getState().clips);
  const fps = store.getState().media?.fps || 30;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      seek(Math.max(0, currentTime - (event.shiftKey ? 1 : 1 / fps)));
      break;
    case 'ArrowRight':
      event.preventDefault();
      seek(Math.min(total, currentTime + (event.shiftKey ? 1 : 1 / fps)));
      break;
    case 'Home':
      event.preventDefault();
      seek(0);
      break;
    case 'End':
      event.preventDefault();
      seek(total);
      break;
    case 's':
    case 'S':
      event.preventDefault();
      splitAtPlayhead();
      break;
    default:
      break;
  }
});

function showHelp() {
  openDialog({
    title: 'キーボードショートカット',
    content: h('dl.shortcut-list', {}, SHORTCUTS.flatMap(([key, desc]) => [h('dt', { text: key }), h('dd', { text: desc })])),
    actions: [{ label: '閉じる', value: null, variant: 'primary' }],
  });
}

dom.help.addEventListener('click', showHelp);
dom.undo.addEventListener('click', () => {
  if (!store.undo()) toast('これ以上戻せません。', { duration: 2000 });
});
dom.redo.addEventListener('click', () => {
  if (!store.redo()) toast('これ以上やり直せません。', { duration: 2000 });
});

/* ------------------------------------------------------------------ */
/* ドラッグ＆ドロップ / ファイル選択                                   */
/* ------------------------------------------------------------------ */

dom.fileInput.addEventListener('change', (event) => {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  addFiles(files);
});

for (const type of ['dragenter', 'dragover']) {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('is-dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('is-dragover');
  });
}
dom.dropzone.addEventListener('drop', (event) => {
  addFiles(event.dataTransfer?.files);
});
dom.dropzone.addEventListener('click', () => dom.fileInput.click());
dom.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    dom.fileInput.click();
  }
});

dom.projectName.addEventListener('change', (event) => {
  store.commit((draft) => {
    draft.name = event.target.value || '無題のプロジェクト';
  }, { label: 'プロジェクト名を変更' });
});

/* ------------------------------------------------------------------ */
/* 自動保存 / 復元                                                     */
/* ------------------------------------------------------------------ */

const saveNow = debounce(() => {
  const result = persistence.save(store.getState());
  if (result.ok) {
    dom.saveStatus.textContent = `自動保存しました（${formatTime((Date.now() % 86400000) / 1000)}）`;
  } else {
    dom.saveStatus.textContent = `保存に失敗: ${describeError(result.error)}`;
  }
}, 1200);

/** 入力中のコントロールが作り直されるのを防ぐため、これらの変更ではパネルを再構築しない */
const SKIP_PANEL_RERENDER = new Set([
  '音声設定',
  '自動編集設定',
  'サムネイル編集',
  'キャプション編集',
  '字幕を編集',
  'STT 設定',
]);

store.subscribe((state, meta) => {
  dom.undo.disabled = !store.canUndo();
  dom.redo.disabled = !store.canRedo();
  if (dom.projectName.value !== state.name) dom.projectName.value = state.name;
  // クリップが変わると総尺も変わるため、再生位置と aria 値を追従させる
  currentTime = clamp(currentTime, 0, timelineDuration(state.clips));
  timeline.setPlayhead(currentTime);
  renderTransport();
  if (!SKIP_PANEL_RERENDER.has(meta?.label)) {
    renderMediaPanel();
    renderEditPanel();
    renderAudioPanel();
  }
  saveNow();
});

async function restore() {
  const result = persistence.load();
  if (!result.ok) {
    toast(`前回の作業を復元できませんでした：${describeError(result.error)}`, { type: 'error' });
    return;
  }
  if (!result.value || !result.value.assets?.length) return;
  store.replace(result.value, { label: '復元' });

  setPreviewOverlay('前回の続きを復元しています…');
  const assets = store.getState().assets;
  const missing = [];
  for (const asset of assets) {
    // eslint-disable-next-line no-await-in-loop
    const file = await loadSourceFile(asset.id).catch(() => null);
    if (!file) {
      missing.push(asset);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const loaded = asset.kind === 'image'
        ? await loadImage(file, asset.duration)
        : await loadVideoAsset(file);
      // 保存前の ID を維持しないとクリップ・字幕との対応が切れる
      // eslint-disable-next-line no-await-in-loop
      await media.runtime.add({ ...loaded, asset: { ...loaded.asset, id: asset.id }, file });
    } catch {
      missing.push(asset);
    }
  }

  if (media.runtime.ids().length) {
    await ensurePlayer();
    setPreviewOverlay('');
    dom.dropzone.hidden = true;
    thumbnailEditor.refresh();
    renderMediaPanel();
    toast(
      missing.length
        ? `前回の続きから再開できます（${missing.length} 件の素材は復元できませんでした）。`
        : '前回の続きから再開できます。',
      { type: missing.length ? 'error' : 'success' },
    );
    // 復元できなかった素材はプロジェクトからも外す（参照切れを残さない）
    if (missing.length) {
      store.commit((draft) => {
        for (const asset of missing) {
          const removed = removeAsset(draft.assets, draft.clips, asset.id);
          draft.assets = removed.assets;
          draft.clips = removed.clips;
          draft.subtitles = draft.subtitles.filter((c) => c.assetId !== asset.id);
        }
      }, { label: '復元できない素材を除外', history: false });
    }
    await pruneSavedAssets(store.getState().assets.map((a) => a.id));
    return;
  }

  setPreviewOverlay('前回の編集内容を復元しました。素材を選び直すと再生できます。');
  toast('前回の編集内容を復元しました。素材を選び直してください。', { type: 'info', duration: 9000 });
}

/* ------------------------------------------------------------------ */
/* 初期描画                                                            */
/* ------------------------------------------------------------------ */

function safeLocalStorage() {
  try {
    const key = '__kirinuki_test__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return window.localStorage;
  } catch {
    return null;
  }
}

window.addEventListener('beforeunload', (event) => {
  if (media.player?.playing || analysisController) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/**
 * Service Worker を登録して「ホーム画面に追加」とオフライン起動を可能にする。
 * 失敗してもアプリは通常どおり動くため、エラーは通知しない。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  });
}

renderMediaPanel();
renderEditPanel();
renderAudioPanel();
renderTransport();
resizePreviewCanvas();
registerServiceWorker();
restore();
dom.saveStatus.textContent = persistence.available ? '自動保存は有効です' : 'この環境では自動保存できません';
