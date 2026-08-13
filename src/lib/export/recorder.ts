import type { AudioAnalysis } from '../audio/types';
import { getAudioContext, resumeAudioContext } from '../audio/decode';
import type { AvatarRig } from '../character/avatarRetarget';
import type { MotionClip } from '../pose/types';
import { canvasSize, type Project } from '../project/types';
import { effectiveRange, renderFrame } from '../render/composer';

export class ExportError extends Error {
  constructor(message: string, readonly cause?: unknown, readonly hint?: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportProgress {
  ratio: number;
  message: string;
  /** 経過秒 / 全体秒 */
  currentTime: number;
  totalTime: number;
}

export interface ExportOptions {
  project: Project;
  clip: MotionClip | null;
  analysis: AudioAnalysis | null;
  /** 読み込み済みの外部アバター（未指定なら内蔵キャラクター） */
  avatar?: AvatarRig | null;
  /** 音声を含める場合に渡す。null なら無音の映像のみ。 */
  audioBuffer: AudioBuffer | null;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  /** 書き出し中に音を鳴らすか（既定 false） */
  monitor?: boolean;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  durationSeconds: number;
}

const MIME_CANDIDATES = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
] as const;

export function pickMimeType(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return { mimeType: candidate.mimeType, extension: candidate.extension };
    }
  }
  return null;
}

/** 書き出し機能が使えるかを事前判定する（UIでボタンを無効化するため）。 */
export function checkExportSupport(): { supported: true } | { supported: false; reason: string } {
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, reason: 'このブラウザは録画API（MediaRecorder）に対応していません。' };
  }
  const canvas = document.createElement('canvas');
  if (typeof canvas.captureStream !== 'function') {
    return { supported: false, reason: 'このブラウザは canvas.captureStream に対応していません。' };
  }
  if (!pickMimeType()) {
    return { supported: false, reason: '対応する動画コーデックが見つかりませんでした。' };
  }
  return { supported: true };
}

/**
 * プレビューと同じ合成処理を実時間で走らせ、MediaRecorder で録画する。
 *
 * 注意: MediaRecorder は実時間キャプチャのため、書き出しには動画の尺と同じ時間がかかる。
 * その代わり音声と映像が確実に同期し、追加の依存ライブラリが不要になる。
 */
export async function exportVideo(options: ExportOptions): Promise<ExportResult> {
  const { project, clip, analysis, audioBuffer, onProgress, signal } = options;
  const avatar = options.avatar ?? null;

  const support = checkExportSupport();
  if (!support.supported) {
    throw new ExportError(support.reason, null, 'Chrome / Edge / Firefox の最新版でお試しください。');
  }
  if (!clip || clip.frames.length === 0) {
    throw new ExportError(
      'モーションが設定されていないため書き出せません。',
      null,
      '「モーション」タブで動画からモーションを抽出してください。',
    );
  }

  const mime = pickMimeType()!;
  const { start, end } = effectiveRange(project, analysis, clip);
  const totalTime = Math.max(0.1, end - start);

  const { width, height } = canvasSize(project.canvas.presetId);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new ExportError('描画コンテキストを作成できませんでした。');

  const fps = project.canvas.fps;
  const stream = canvas.captureStream(fps);

  // --- 音声トラック ---------------------------------------------------------
  let audioContext: AudioContext | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;
  if (audioBuffer) {
    await resumeAudioContext();
    audioContext = getAudioContext();
    const destination = audioContext.createMediaStreamDestination();
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(destination);
    if (options.monitor) sourceNode.connect(audioContext.destination);
    for (const track of destination.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime.mimeType,
    videoBitsPerSecond: Math.round(width * height * fps * 0.12),
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (event) =>
      reject(new ExportError('録画中にエラーが発生しました。', (event as unknown as { error?: unknown }).error));
  });

  let rafId = 0;
  let stopped = false;
  const stopAll = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(rafId);
    try {
      sourceNode?.stop();
    } catch {
      /* すでに停止済み */
    }
    if (recorder.state !== 'inactive') recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  };

  const onAbort = () => stopAll();
  signal?.addEventListener('abort', onAbort);

  try {
    // 最初のフレームを描いてから録画を開始する（先頭の黒フレームを防ぐ）
    renderFrame(ctx, start, { project, clip, analysis, avatar });
    recorder.start(1000);
    const startedAt = performance.now();
    if (sourceNode && audioBuffer) {
      sourceNode.start(0, Math.min(start, Math.max(0, audioBuffer.duration - 0.01)), totalTime);
    }

    await new Promise<void>((resolve) => {
      const tick = () => {
        if (stopped) {
          resolve();
          return;
        }
        const elapsed = (performance.now() - startedAt) / 1000;
        const time = start + elapsed;
        if (elapsed >= totalTime) {
          resolve();
          return;
        }
        renderFrame(ctx, time, { project, clip, analysis, avatar });
        onProgress?.({
          ratio: Math.min(1, elapsed / totalTime),
          message: '書き出し中…（プレビューと同じ速度で処理しています）',
          currentTime: elapsed,
          totalTime,
        });
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });

    stopAll();
    await finished;

    if (signal?.aborted) {
      const err = new Error('書き出しを中止しました。');
      err.name = 'AbortError';
      throw err;
    }

    const blob = new Blob(chunks, { type: mime.mimeType });
    if (blob.size === 0) {
      throw new ExportError(
        '書き出したファイルが空でした。',
        null,
        'タブを非アクティブにすると録画が停止することがあります。書き出し中はこのタブを表示したままにしてください。',
      );
    }
    onProgress?.({ ratio: 1, message: '完了しました', currentTime: totalTime, totalTime });
    return { blob, mimeType: mime.mimeType, extension: mime.extension, durationSeconds: totalTime };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stopAll();
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari で即座に revoke するとダウンロードが中断されることがあるため遅延させる
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFileName(name: string, extension: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'motion-muse';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  return `${base}_${stamp}.${extension}`;
}
