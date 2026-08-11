/**
 * 素材の読み込みと解析用データ抽出（DOM / WebAudio 依存）。
 */

import { computeEnvelope, detectScenes, detectSpeech, frameHistogram, frameQuality, measureLoudness, mixToMono } from '../core/analysis.js';
import { clamp } from '../core/util.js';

export const SUPPORTED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg'];
export const MAX_RECOMMENDED_BYTES = 2 * 1024 ** 3;
/** 解析するフレーム数の上限（長尺でメモリと解析時間が発散しないようにする） */
export const MAX_ANALYSIS_FRAMES = 1200;

/**
 * File から <video> を作り、メタデータを取得する。
 * @returns {Promise<{video:HTMLVideoElement, url:string, meta:object}>}
 */
export function loadVideo(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('ファイルが選択されていません。'));
      return;
    }
    if (file.size === 0) {
      reject(new Error('ファイルが空です（0 バイト）。'));
      return;
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.muted = true;

    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = async () => {
      cleanup();
      const duration = await resolveDuration(video);
      if (!duration || duration <= 0) {
        URL.revokeObjectURL(url);
        reject(new Error('動画の長さを取得できませんでした。ファイルが破損している可能性があります。'));
        return;
      }
      resolve({
        video,
        url,
        meta: {
          name: file.name,
          size: file.size,
          type: file.type || '不明',
          duration,
          width: video.videoWidth,
          height: video.videoHeight,
          fps: 30,
          hasAudio: false, // decodeAudio 成否で更新する
        },
      });
    };
    const onError = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('この動画を再生できません。MP4(H.264) または WebM をお試しください。'));
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = url;
  });
}

/**
 * 動画の長さを確定させる。
 *
 * MediaRecorder が生成した WebM（画面録画やブラウザ録画）はコンテナに尺が書かれておらず、
 * `video.duration` が Infinity になる。末尾へ強制的にシークすると実尺が確定するため、
 * その挙動を利用して解決し、位置を先頭へ戻す。
 *
 * @returns {Promise<number>} 秒。確定できない場合は 0
 */
export function resolveDuration(video, timeoutMs = 5000) {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('timeupdate', onDurationChange);
      try {
        video.currentTime = 0;
      } catch {
        /* シークできなくても尺は取得済み */
      }
      resolve(value);
    };
    const onDurationChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
    };
    const timer = setTimeout(() => finish(Number.isFinite(video.duration) ? video.duration : 0), timeoutMs);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('timeupdate', onDurationChange);
    try {
      // 表現可能な最大時刻へシークすると、ブラウザが実際の末尾で尺を確定させる
      video.currentTime = 1e101;
    } catch {
      finish(0);
    }
  });
}

/**
 * 再生開始直後のフレーム間隔から fps を推定する。取得できない場合は 30 を返す。
 */
export async function estimateFps(video, timeoutMs = 1500) {
  if (typeof video.requestVideoFrameCallback !== 'function') return 30;
  const wasMuted = video.muted;
  const startTime = video.currentTime;
  video.muted = true;
  const stamps = [];
  try {
    await video.play().catch(() => {});
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const step = (now) => {
        stamps.push(now);
        if (stamps.length >= 20) {
          clearTimeout(timer);
          resolve();
          return;
        }
        video.requestVideoFrameCallback(step);
      };
      video.requestVideoFrameCallback(step);
    });
  } finally {
    video.pause();
    video.currentTime = startTime;
    video.muted = wasMuted;
  }
  if (stamps.length < 5) return 30;
  const deltas = [];
  for (let i = 1; i < stamps.length; i += 1) deltas.push(stamps[i] - stamps[i - 1]);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const fps = median > 0 ? 1000 / median : 30;
  return clamp(Math.round(fps), 1, 240);
}

/**
 * 解析に使うサンプルレート。
 *
 * 発話区間の検出・ラウドネス測定・STT 送信のいずれも 16kHz で十分であり、
 * 48kHz のまま展開すると 10 分のステレオ素材だけで約 230MB を消費して
 * スマートフォンのタブが強制終了される。ここで 1/12 に落とす。
 */
export const ANALYSIS_SAMPLE_RATE = 16000;

/**
 * 音声トラックを解析用に低いサンプルレートでデコードする。
 * 音声が無い / 対応外 / メモリ不足でも例外にせず理由を返す。
 *
 * @returns {Promise<{buffer:AudioBuffer|null, reason:string}>}
 */
export async function decodeAudio(file, audioContext, sampleRate = ANALYSIS_SAMPLE_RATE) {
  if (!file) return { buffer: null, reason: 'ファイルがありません。' };
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const Ctx = audioContext?.constructor || window.AudioContext || window.webkitAudioContext;
  if (!Offline && !Ctx) return { buffer: null, reason: 'この環境では音声を解析できません。' };

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    return {
      buffer: null,
      reason: 'ファイルが大きすぎて読み込めませんでした。短く分割するか、解像度を下げた素材でお試しください。',
    };
  }

  // OfflineAudioContext に渡すと、その文脈のサンプルレートへリサンプルして返る
  if (Offline) {
    try {
      const ctx = new Offline(1, 1, sampleRate);
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      if (buffer && buffer.length) return { buffer, reason: '' };
    } catch {
      /* 元のサンプルレートで再試行する */
    }
  }
  try {
    const ctx = audioContext || new Ctx();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    if (!buffer || buffer.length === 0) return { buffer: null, reason: '音声トラックが見つかりませんでした。' };
    return { buffer, reason: '' };
  } catch {
    return {
      buffer: null,
      reason: '音声トラックをデコードできませんでした（音声なし、非対応コーデック、またはメモリ不足）。映像のみで続行します。',
    };
  }
}

/**
 * 一定間隔で動画をシークしてフレームを取得し、ヒストグラムと品質指標を計算する。
 * @param {HTMLVideoElement} video
 * @param {{duration:number, intervalSec?:number, width?:number, height?:number,
 *          signal?:AbortSignal, onProgress?:(ratio:number)=>void}} options
 */
export async function sampleFrames(video, options) {
  const duration = Math.max(0, options.duration || 0);
  const interval = Math.max(0.05, options.intervalSec ?? 0.25);
  const w = options.width ?? 64;
  const h = options.height ?? 36;
  const frames = [];
  if (duration <= 0) return frames;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const times = [];
  for (let t = 0; t < duration; t += interval) times.push(Math.min(t, Math.max(0, duration - 0.05)));

  const wasPaused = video.paused;
  if (!wasPaused) video.pause();

  for (let i = 0; i < times.length; i += 1) {
    if (options.signal?.aborted) throw makeAbortError();
    const t = times[i];
    const ok = await seekTo(video, t);
    if (!ok) continue;
    ctx.drawImage(video, 0, 0, w, h);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, w, h);
    } catch {
      throw new Error('フレームを読み取れませんでした（セキュリティ制限）。ローカルファイルを直接選択してください。');
    }
    const quality = frameQuality(imageData.data, w, h);
    frames.push({ t, hist: frameHistogram(imageData.data), ...quality });
    if (options.onProgress && i % 4 === 0) options.onProgress((i + 1) / times.length);
  }
  options.onProgress?.(1);
  return frames;
}

function seekTo(video, time, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = time;
    } catch {
      done(false);
    }
  });
}

function makeAbortError() {
  const error = new Error('処理をキャンセルしました。');
  error.name = 'AbortError';
  return error;
}

/**
 * 解析パイプライン全体。段階ごとに進捗を通知する。
 * @returns {Promise<{analysis:object, monoSamples:Float32Array|null, sampleRate:number, fps:number}>}
 */
export async function analyzeMedia({ file, video, duration, audioContext, signal, onStage }) {
  const stage = (name, ratio) => onStage?.({ name, ratio: clamp(ratio, 0, 1) });
  const warnings = [];

  stage('音声をデコード中…', 0.05);
  const { buffer, reason } = await decodeAudio(file, audioContext);
  if (!buffer && reason) warnings.push(reason);
  if (signal?.aborted) throw makeAbortError();

  let envelope = { hopSec: 0.01, db: [], peakDb: -100 };
  let speech = [];
  let loudness = { integratedDb: -70, peakDb: -100, noiseFloorDb: -100 };
  let mono = null;
  let sampleRate = 0;

  if (buffer) {
    stage('音量の包絡を計算中…', 0.2);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
    mono = mixToMono(channels);
    sampleRate = buffer.sampleRate;
    envelope = computeEnvelope(mono, sampleRate);
    stage('発話区間を検出中…', 0.35);
    const vad = detectSpeech(envelope);
    speech = vad.segments;
    loudness = measureLoudness(envelope, speech);
    if (!speech.length) warnings.push('発話区間を検出できませんでした。BGM のみの素材の可能性があります。');
  }
  if (signal?.aborted) throw makeAbortError();

  stage('フレームを解析中…', 0.45);
  const frames = await sampleFrames(video, {
    duration,
    // 長尺でもフレーム数の上限を超えないよう間隔を自動的に広げる（メモリと時間の上限）
    intervalSec: clamp(duration / MAX_ANALYSIS_FRAMES, 0.25, 3),
    signal,
    onProgress: (r) => stage('フレームを解析中…', 0.45 + r * 0.45),
  });

  stage('シーンを判定中…', 0.92);
  const scenes = detectScenes(frames, duration);

  const fps = await estimateFps(video).catch(() => 30);
  stage('完了', 1);

  return {
    analysis: {
      done: true,
      envelope: { hopSec: envelope.hopSec, db: envelope.db },
      speech,
      scenes,
      frames: frames.map((f) => ({
        t: f.t,
        sharp: f.sharp,
        contrast: f.contrast,
        colorful: f.colorful,
        exposure: f.exposure,
        score: 0,
      })),
      loudness: { ...loudness, peakDb: envelope.peakDb },
      warnings,
    },
    monoSamples: mono,
    sampleRate,
    fps,
    hasAudio: Boolean(buffer),
  };
}

/** BGM 等の音声ファイルをデコードする */
export async function decodeAudioFile(file, audioContext) {
  const arrayBuffer = await file.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer);
}
