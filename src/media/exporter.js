/**
 * 書き出し：Canvas + WebAudio → MediaRecorder。
 * プレビューと同じ TimelinePlayer / render.js を使うため、見た目と成果物が一致する。
 *
 * 注意（AC-08b）: 外部バイナリ無しの制約下では、MediaRecorder が対応するコンテナのみ選択できる。
 * MP4 が使えない環境では WebM を選び、UI に実際の出力形式を明示する。
 */

import { timelineDuration } from '../core/autoedit.js';
import { THUMBNAIL_SIZE } from '../core/thumbnail.js';
import { clamp } from '../core/util.js';
import { TimelinePlayer } from './player.js';
import { drawThumbnail } from './render.js';

const CANDIDATE_TYPES = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264 / AAC)' },
  { mimeType: 'video/mp4', ext: 'mp4', label: 'MP4' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9 / Opus)' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8 / Opus)' },
  { mimeType: 'video/webm', ext: 'webm', label: 'WebM' },
];

/** この環境で利用できる出力形式を返す。無ければ null。 */
export function pickOutputFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported?.(candidate.mimeType)) return candidate;
  }
  return null;
}

export function isExportSupported() {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickOutputFormat() !== null
  );
}

function abortError() {
  const error = new Error('書き出しをキャンセルしました。');
  error.name = 'AbortError';
  return error;
}

/**
 * 動画を書き出す。
 * @param {{project:object, sourceUrl:string, bgmBuffer?:AudioBuffer, width?:number, height?:number,
 *          fps?:number, videoBitsPerSecond?:number, signal?:AbortSignal,
 *          onProgress?:(p:{ratio:number, currentSec:number, totalSec:number})=>void}} opt
 * @returns {Promise<{blob:Blob, format:object, durationSec:number}>}
 */
export async function renderVideo(opt) {
  const format = pickOutputFormat();
  if (!format) throw new Error('このブラウザは動画の書き出しに対応していません（MediaRecorder 非対応）。');
  const project = opt.project;
  const totalSec = timelineDuration(project.clips);
  if (totalSec <= 0) throw new Error('書き出す区間がありません。クリップを 1 つ以上有効にしてください。');
  if (opt.signal?.aborted) throw abortError();

  const width = Math.round(clamp(opt.width || project.media?.width || 1280, 160, 3840) / 2) * 2;
  const height = Math.round(clamp(opt.height || project.media?.height || 720, 90, 2160) / 2) * 2;
  const fps = clamp(Math.round(opt.fps || project.media?.fps || 30), 1, 60);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const video = document.createElement('video');
  video.src = opt.sourceUrl;
  video.playsInline = true;
  video.preload = 'auto';
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('書き出し用に素材を読み込めませんでした。')), { once: true });
  });

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtor();
  const audioDest = audioContext.createMediaStreamDestination();

  const player = new TimelinePlayer({
    video,
    canvas,
    audioContext,
    destination: audioDest,
    getProject: () => project,
  });
  if (opt.bgmBuffer) player.setBgmBuffer(opt.bgmBuffer);

  const stream = canvas.captureStream(fps);
  for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: opt.videoBitsPerSecond || Math.round(width * height * fps * 0.09),
  });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const cleanup = () => {
    try {
      player.dispose();
      for (const track of stream.getTracks()) track.stop();
      audioContext.close();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* 後片付けの失敗は無視 */
    }
  };

  return new Promise((resolve, reject) => {
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      try {
        recorder.stop();
      } catch {
        /* 停止済み */
      }
      cleanup();
      reject(abortError());
    };
    opt.signal?.addEventListener('abort', onAbort, { once: true });

    recorder.onerror = (event) => {
      if (finished) return;
      finished = true;
      opt.signal?.removeEventListener('abort', onAbort);
      cleanup();
      reject(new Error(`書き出し中にエラーが発生しました: ${event.error?.message || '不明なエラー'}`));
    };

    recorder.onstop = () => {
      if (finished) return;
      finished = true;
      opt.signal?.removeEventListener('abort', onAbort);
      const blob = new Blob(chunks, { type: format.mimeType.split(';')[0] });
      cleanup();
      if (blob.size === 0) {
        reject(new Error('書き出し結果が空でした。素材と設定を確認してください。'));
        return;
      }
      resolve({ blob, format, durationSec: totalSec });
    };

    player.onTime = (current) => {
      opt.onProgress?.({ ratio: clamp(current / totalSec, 0, 1), currentSec: current, totalSec });
    };
    player.onEnded = () => {
      // 末尾フレームを確実に含めるため少し待ってから停止する
      setTimeout(() => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* 停止済み */
        }
      }, 250);
    };
    player.onError = (error) => {
      if (finished) return;
      finished = true;
      opt.signal?.removeEventListener('abort', onAbort);
      cleanup();
      reject(error);
    };

    recorder.start(1000);
    player.seek(0).then(() => player.play()).catch((error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
  });
}

/**
 * サムネイル PNG を生成する。
 * @returns {Promise<Blob>}
 */
export async function renderThumbnail(project, sourceUrl, { width = THUMBNAIL_SIZE.width, height = THUMBNAIL_SIZE.height } = {}) {
  if (!sourceUrl) throw new Error('素材が読み込まれていません。');
  const video = document.createElement('video');
  video.src = sourceUrl;
  video.muted = true;
  video.playsInline = true;
  await new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('サムネイル用に素材を読み込めませんでした。')), { once: true });
  });
  await new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    setTimeout(done, 3000);
    video.currentTime = clamp(project.thumbnail.sourceTime, 0, Math.max(0, video.duration - 0.05));
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  drawThumbnail(ctx, video, project.thumbnail, width, height);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の生成に失敗しました。'))), 'image/png');
  });
  video.removeAttribute('src');
  video.load();
  return blob;
}

/** Blob をダウンロードさせる */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** テキストをファイルとして保存 */
export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
