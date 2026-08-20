/**
 * 書き出しパネル：動画 / 字幕 / プロジェクトファイル。
 */

import { editSummary, timelineDuration } from '../core/autoedit.js';
import { MAX_OUTPUT_SIZE, describeFraming, resolveOutputSize, sizingSource } from '../core/layout.js';
import { toSRT, toVTT } from '../core/subtitles.js';
import { serializeProject } from '../core/project.js';
import { describeError, formatTime, speakableTime } from '../core/util.js';
import { downloadBlob, downloadText, isExportSupported, renderVideo, resolveExportPlan } from '../media/exporter.js';
import { shareFile } from '../media/share.js';
import { createWakeLock } from '../media/wakelock.js';
import { announce, button, errorBox, h, infoBox, loading, select, toast } from './dom.js';
import { sanitizeFilename } from './thumbnailEditor.js';

export function createExportPanel({ store, getAssetUrl, getAssetFile, getAssetImage, getBgmBuffer, beforeExport }) {
  const wakeLock = createWakeLock();
  /** 出力形式の判定は非同期なので結果を保持する */
  let cachedPlan = null;
  let lastResult = null;
  const summaryHost = h('div.export-summary');
  const progressHost = h('div');
  const controlsHost = h('div.controls');
  let controller = null;
  let resolution = 'source';

  const element = h('section.panel-section', {}, [
    summaryHost,
    controlsHost,
    progressHost,
    h('h3.subheading', { text: '字幕ファイル' }),
    h('div.toolbar', {}, [
      button('SRT を保存', { onClick: () => exportSubtitle('srt') }),
      button('WebVTT を保存', { onClick: () => exportSubtitle('vtt') }),
    ]),
    h('h3.subheading', { text: 'プロジェクト' }),
    h('div.toolbar', {}, [
      button('プロジェクトを保存 (JSON)', { onClick: exportProject }),
      button('プロジェクトを読み込み', { onClick: () => projectInput.click() }),
    ]),
    h('p.hint', {
      text: 'プロジェクトファイルには編集内容と解析結果のみが含まれます（動画ファイル自体は含まれません）。',
    }),
  ]);

  const projectInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'sr-only',
    attrs: { 'aria-label': 'プロジェクトファイル（JSON）を選択' },
    on: {
      change: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          store.replace(data, { label: 'プロジェクトを読み込み' });
          toast('プロジェクトを読み込みました。素材ファイルを再選択してください。', { type: 'success' });
        } catch (error) {
          toast(`プロジェクトを読み込めませんでした: ${describeError(error)}`, { type: 'error' });
        }
      },
    },
  });
  element.append(projectInput);

  function exportSubtitle(kind) {
    const state = store.getState();
    const cues = state.subtitles.filter((c) => c.text.trim());
    if (!cues.length) {
      toast('書き出せる字幕がありません（テキストが未入力です）。', { type: 'error' });
      return;
    }
    const opt = { maxCharsPerLine: state.subtitleStyle.maxCharsPerLine, maxLines: state.subtitleStyle.maxLines };
    const text = kind === 'srt' ? toSRT(cues, opt) : toVTT(cues, opt);
    downloadText(text, `${sanitizeFilename(state.name)}.${kind}`, kind === 'srt' ? 'application/x-subrip' : 'text/vtt');
    toast(`${kind.toUpperCase()} を保存しました（${cues.length} 件）。`, { type: 'success' });
  }

  function exportProject() {
    const state = store.getState();
    downloadText(JSON.stringify(serializeProject(state), null, 2), `${sanitizeFilename(state.name)}.kirinuki.json`, 'application/json');
    toast('プロジェクトを保存しました。', { type: 'success' });
  }

  async function startExport() {
    const state = store.getState();
    if (!state.assets.length) {
      toast('素材が読み込まれていません。', { type: 'error' });
      return;
    }
    const total = timelineDuration(state.clips);
    if (total <= 0) {
      toast('書き出す区間がありません。クリップを有効にしてください。', { type: 'error' });
      return;
    }
    if (!isExportSupported()) {
      progressHost.replaceChildren(
        errorBox('このブラウザは動画の書き出しに対応していません。Chrome / Edge の最新版をお試しください。字幕・サムネイル・キャプションの書き出しは利用できます。'),
      );
      return;
    }
    beforeExport?.();

    const target = resolutionSize(state, resolution);
    const plan = await currentPlan();
    controller = new AbortController();
    await wakeLock.request();

    const estimate = plan.realtime
      ? `実時間でレンダリングします：約 ${speakableTime(total)}`
      : '再生せずに書き出すため、画面を触っていても中断しません';
    const progress = loading(`書き出し中… 0%（${estimate}）`, { determinate: true });
    const cancelButton = button('キャンセル', {
      variant: 'danger',
      onClick: () => {
        controller?.abort();
      },
    });
    progressHost.replaceChildren(h('div.export-progress', {}, [progress.element, cancelButton]));
    renderControls(true);
    announce('書き出しを開始しました。');

    try {
      const result = await renderVideo({
        project: state,
        plan,
        getAssetUrl,
        getAssetFile,
        getAssetImage,
        bgmBuffer: getBgmBuffer(),
        maxSize: target.maxSize,
        fps: state.media?.fps || 30,
        signal: controller.signal,
        onProgress: ({ ratio, currentSec, phase, detail }) => {
          progress.setRatio(ratio);
          const where = phase
            ? `${phase}${detail ? `（${detail}）` : ''}`
            : `${formatTime(currentSec || 0)} / ${formatTime(total)}`;
          progress.setLabel(`書き出し中… ${Math.round(ratio * 100)}% ${where}`);
        },
      });
      lastResult = { blob: result.blob, filename: `${sanitizeFilename(state.name)}.${result.format.ext}` };
      showResult(result);
      toast('動画を書き出しました。', { type: 'success' });
      announce('書き出しが完了しました。');
    } catch (error) {
      if (error.name === 'AbortError') {
        progressHost.replaceChildren(infoBox('書き出しをキャンセルしました。'));
        announce('書き出しをキャンセルしました。');
      } else {
        progressHost.replaceChildren(errorBox(describeError(error)));
      }
    } finally {
      controller = null;
      await wakeLock.release();
      renderControls(false);
    }
  }

  /** 書き出し後の導線：共有を最優先に置く（スマホではこれが無いと完結しない） */
  function showResult(result) {
    const sizeMb = (result.blob.size / 1024 / 1024).toFixed(1);
    progressHost.replaceChildren(
      h('div.result', {}, [
        infoBox(`書き出しが完了しました：${result.format.label} / ${sizeMb} MB`),
        result.notice ? infoBox(result.notice) : null,
        h('div.toolbar', {}, [
          button('📤 共有 / 保存', {
            variant: 'primary',
            onClick: async () => {
              if (!lastResult) return;
              const shared = await shareFile({
                blob: lastResult.blob,
                filename: lastResult.filename,
                title: store.getState().name,
                text: store.getState().caption.text || '',
              });
              if (shared.method === 'download') toast('端末に保存しました。', { type: 'success' });
              if (shared.method === 'share') toast('共有しました。', { type: 'success' });
            },
          }),
          button('端末に保存', {
            onClick: () => {
              if (!lastResult) return;
              downloadBlob(lastResult.blob, lastResult.filename);
              toast('端末に保存しました。', { type: 'success' });
            },
          }),
        ]),
        h('p.hint', { text: '「共有」から SNS アプリへ直接送れます（対応していない環境では保存になります）。' }),
      ].filter(Boolean)),
    );
  }

  /** 出力形式を判定して結果を覚えておく */
  async function currentPlan() {
    const state = store.getState();
    const needsAudio = (state.assets || []).some((a) => a.hasAudio) || Boolean(getBgmBuffer());
    // 解析前は音声の有無が未確定なので、判定結果のキーに含めて取り直す
    const src = sizingSource(state.assets);
    const key = `${Math.round(src.width)}x${Math.round(src.height)}@${state.media?.fps}:${resolution}:${needsAudio}:${state.output?.aspect}:${state.output?.fit}`;
    if (cachedPlan && cachedPlan.key === key) return cachedPlan.plan;
    const target = resolutionSize(state, resolution);
    const plan = await resolveExportPlan({
      width: target.width,
      height: target.height,
      fps: state.media?.fps || 30,
      needsAudio,
    });
    cachedPlan = { key, plan };
    return plan;
  }

  /**
   * 画質の指定を「長辺の上限」へ変換する。
   * 実際の縦横比は project.output（向き）が決めるので、ここではサイズだけを扱う。
   */
  function resolutionSize(state, mode) {
    const maxSize = mode === 'source' ? MAX_OUTPUT_SIZE : Number(mode);
    const size = resolveOutputSize({ ...state.output, maxSize }, sizingSource(state.assets));
    return { ...size, maxSize };
  }

  function renderSummary() {
    const state = store.getState();
    if (!state.assets.length) {
      summaryHost.replaceChildren(h('p.hint', { text: '素材が読み込まれていません。' }));
      return;
    }
    const sourceTotal = (state.assets || []).reduce((sum, a) => sum + a.duration, 0);
    const summary = editSummary(state.clips, sourceTotal);
    const cues = state.subtitles.filter((c) => c.text.trim()).length;
    const formatDd = h('dd', { text: '判定中…' });
    summaryHost.replaceChildren(
      h('dl.summary', {}, [
        h('dt', { text: '出力尺' }),
        h('dd', { text: `${formatTime(summary.timelineDuration, { ms: true })}（元 ${formatTime(summary.sourceDuration, { ms: true })}）` }),
        h('dt', { text: 'カット' }),
        h('dd', { text: `${summary.clipCount} クリップ / ${(summary.removedRatio * 100).toFixed(1)}% 削減` }),
        h('dt', { text: '焼き込み字幕' }),
        h('dd', { text: `${cues} 件` }),
        h('dt', { text: '出力サイズ' }),
        h('dd', { text: (() => {
          const src = sizingSource(state.assets);
          return describeFraming(src.width, src.height, {
            ...state.output,
            maxSize: resolutionSize(state, resolution).maxSize,
          });
        })() }),
        h('dt', { text: '出力形式' }),
        formatDd,
      ]),
    );
    currentPlan().then((plan) => {
      formatDd.textContent = plan.mode
        ? `${plan.label}${plan.realtime ? '（実時間）' : '（高速・再生に依存しない）'}`
        : '未対応（この環境では動画書き出し不可）';
    }).catch(() => {
      formatDd.textContent = '判定できませんでした';
    });
  }

  function renderControls(busy) {
    const resSelect = select({
      label: '画質（長辺の上限）',
      value: resolution,
      options: [
        { value: 'source', label: '素材のまま（画質優先）' },
        { value: '1920', label: '1920（フル HD 相当）' },
        { value: '1080', label: '1080' },
        { value: '720', label: '720' },
        { value: '480', label: '480' },
      ],
      hint: '「素材のまま」は素材の解像度をそのまま使います（拡大はしません）。4K 素材ではファイルが大きく、書き出しにも時間がかかります。',
      onChange: (v) => {
        resolution = v;
        cachedPlan = null;
        renderSummary();
        renderControls(false);
      },
    });
    const startButton = button(busy ? '書き出し中…' : '動画を書き出す', { variant: 'primary', onClick: startExport });
    startButton.disabled = busy;
    resSelect.input.disabled = busy;
    controlsHost.replaceChildren(
      h('div.grid-2', {}, [resSelect.element]),
      h('div.toolbar', {}, [startButton]),
      h('p.hint', { id: 'export-note', text: '書き出し方式を判定しています…' }),
    );
    currentPlan().then((plan) => {
      const note = controlsHost.querySelector('#export-note');
      if (!note) return;
      note.textContent = plan.realtime
        ? 'この環境では再生しながらの書き出しになります（10 分の動画なら約 10 分）。画面を消さずにお待ちください。'
        : '再生せずに書き出すため、画面ロックやアプリ切り替えで壊れません。書き出し中は画面が消えないようにします。';
    }).catch(() => {});
  }

  const unsubscribe = store.subscribe(() => {
    renderSummary();
    if (!controller) renderControls(false);
  });

  renderSummary();
  renderControls(false);

  return { element, dispose: unsubscribe };
}
