/**
 * 書き出しパネル：動画 / 字幕 / プロジェクトファイル。
 */

import { editSummary, timelineDuration } from '../core/autoedit.js';
import { toSRT, toVTT } from '../core/subtitles.js';
import { serializeProject } from '../core/project.js';
import { describeError, formatTime, speakableTime } from '../core/util.js';
import { downloadBlob, downloadText, isExportSupported, pickOutputFormat, renderVideo } from '../media/exporter.js';
import { announce, button, errorBox, h, infoBox, loading, select, toast } from './dom.js';
import { sanitizeFilename } from './thumbnailEditor.js';

export function createExportPanel({ store, getSourceUrl, getBgmBuffer, beforeExport }) {
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
    if (!getSourceUrl()) {
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
    controller = new AbortController();
    const progress = loading(`書き出し中… 0%（実時間でレンダリングします：約 ${speakableTime(total)}）`, { determinate: true });
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
      const { blob, format } = await renderVideo({
        project: state,
        sourceUrl: getSourceUrl(),
        bgmBuffer: getBgmBuffer(),
        width: target.width,
        height: target.height,
        fps: state.media?.fps || 30,
        signal: controller.signal,
        onProgress: ({ ratio, currentSec }) => {
          progress.setRatio(ratio);
          progress.setLabel(`書き出し中… ${Math.round(ratio * 100)}%（${formatTime(currentSec)} / ${formatTime(total)}）`);
        },
      });
      downloadBlob(blob, `${sanitizeFilename(state.name)}.${format.ext}`);
      progressHost.replaceChildren(infoBox(`書き出しが完了しました：${format.label} / ${(blob.size / 1024 / 1024).toFixed(1)} MB`));
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
      renderControls(false);
    }
  }

  function resolutionSize(state, mode) {
    const w = state.media?.width || 1280;
    const h2 = state.media?.height || 720;
    if (mode === 'source') return { width: w, height: h2 };
    const targetHeight = Number(mode);
    const scale = targetHeight / Math.max(1, h2);
    return { width: Math.round(w * scale), height: targetHeight };
  }

  function renderSummary() {
    const state = store.getState();
    if (!state.media) {
      summaryHost.replaceChildren(h('p.hint', { text: '素材が読み込まれていません。' }));
      return;
    }
    const summary = editSummary(state.clips, state.media.duration);
    const cues = state.subtitles.filter((c) => c.text.trim()).length;
    const format = pickOutputFormat();
    summaryHost.replaceChildren(
      h('dl.summary', {}, [
        h('dt', { text: '出力尺' }),
        h('dd', { text: `${formatTime(summary.timelineDuration, { ms: true })}（元 ${formatTime(summary.sourceDuration, { ms: true })}）` }),
        h('dt', { text: 'カット' }),
        h('dd', { text: `${summary.clipCount} クリップ / ${(summary.removedRatio * 100).toFixed(1)}% 削減` }),
        h('dt', { text: '焼き込み字幕' }),
        h('dd', { text: `${cues} 件` }),
        h('dt', { text: '出力形式' }),
        h('dd', { text: format ? format.label : '未対応（この環境では動画書き出し不可）' }),
      ]),
    );
  }

  function renderControls(busy) {
    const state = store.getState();
    const resSelect = select({
      label: '解像度',
      value: resolution,
      options: [
        { value: 'source', label: `元の解像度（${state.media?.width || '—'}×${state.media?.height || '—'}）` },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
      ],
      onChange: (v) => {
        resolution = v;
      },
    });
    const startButton = button(busy ? '書き出し中…' : '動画を書き出す', { variant: 'primary', onClick: startExport });
    startButton.disabled = busy;
    resSelect.input.disabled = busy;
    controlsHost.replaceChildren(
      h('div.grid-2', {}, [resSelect.element]),
      h('div.toolbar', {}, [startButton]),
      h('p.hint', {
        text: '書き出しは実時間でレンダリングされます（10 分の動画なら約 10 分）。タブを閉じずにお待ちください。',
      }),
    );
  }

  const unsubscribe = store.subscribe(() => {
    renderSummary();
    if (!controller) renderControls(false);
  });

  renderSummary();
  renderControls(false);

  return { element, dispose: unsubscribe };
}
