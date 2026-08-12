import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { mapLandmarksToRig, postProcessFrames } from './normalize';
import type { MotionClip, MotionFrame } from './types';

export type ExtractPhase = 'loading-model' | 'decoding-video' | 'extracting' | 'post-processing' | 'done';

export interface ExtractProgress {
  phase: ExtractPhase;
  /** 0..1 */
  ratio: number;
  message: string;
  /** 抽出中の最新プレビュー用ランドマーク（描画に使う。無い場合は null） */
  preview?: MotionFrame | null;
}

export interface ExtractOptions {
  /** 解析フレームレート。動画fpsより低くすると高速になる（既定 30） */
  targetFps?: number;
  /** 解析する開始秒 */
  start?: number;
  /** 解析する終了秒（未指定なら動画末尾） */
  end?: number;
  /** 'lite' は高速、'full' は高精度 */
  model?: 'lite' | 'full';
  signal?: AbortSignal;
  onProgress?: (progress: ExtractProgress) => void;
}

export class PoseExtractionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    /** 利用者が取れる対処を日本語で示す */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PoseExtractionError';
  }
}

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_PATHS: Record<'lite' | 'full', string> = {
  lite: `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`,
  full: `${import.meta.env.BASE_URL}models/pose_landmarker_full.task`,
};

/** 解析対象の上限。これを超える動画はユーザーに区間指定を促す。 */
export const MAX_CLIP_SECONDS = 60;

let landmarkerCache: { key: string; instance: PoseLandmarker } | null = null;

async function getLandmarker(model: 'lite' | 'full'): Promise<PoseLandmarker> {
  if (landmarkerCache?.key === model) return landmarkerCache.instance;
  landmarkerCache?.instance.close();
  landmarkerCache = null;

  let fileset;
  try {
    fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  } catch (err) {
    throw new PoseExtractionError(
      '姿勢推定エンジン（WASM）の読み込みに失敗しました。',
      err,
      '`npm run fetch:models` を実行して public/mediapipe/wasm を配置してください。',
    );
  }

  try {
    const instance = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATHS[model], delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    landmarkerCache = { key: model, instance };
    return instance;
  } catch (gpuError) {
    // GPU デリゲートが使えない環境（一部の Linux/仮想GPU）では CPU にフォールバックする
    try {
      const instance = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATHS[model], delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      landmarkerCache = { key: model, instance };
      return instance;
    } catch (cpuError) {
      throw new PoseExtractionError(
        '姿勢推定モデルの読み込みに失敗しました。',
        cpuError ?? gpuError,
        `public/models/pose_landmarker_${model}.task が存在するか確認してください（\`npm run fetch:models\`）。`,
      );
    }
  }
}

/** モーション抽出エンジンが利用可能かを事前確認する（UIの事前チェック用）。 */
export async function checkEngineAvailability(model: 'lite' | 'full' = 'lite'): Promise<
  { available: true } | { available: false; reason: string; hint?: string }
> {
  try {
    const res = await fetch(MODEL_PATHS[model], { method: 'HEAD' });
    if (!res.ok) {
      return {
        available: false,
        reason: `姿勢推定モデルが見つかりません（HTTP ${res.status}）。`,
        hint: '`npm run fetch:models` を実行してください。',
      };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: '姿勢推定モデルの確認に失敗しました。',
      hint: err instanceof Error ? err.message : String(err),
    };
  }
}

/** File から <video> を作り、メタデータが読めるまで待つ。 */
export async function loadVideoElement(file: File): Promise<{ video: HTMLVideoElement; revoke: () => void }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(
        new PoseExtractionError(
          'この動画ファイルを読み込めませんでした。',
          video.error,
          'ブラウザが対応する形式（MP4/H.264, WebM/VP9 など）に変換してから再度お試しください。',
        ),
      );
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });

  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    URL.revokeObjectURL(url);
    throw new PoseExtractionError(
      '動画の長さを取得できませんでした。',
      null,
      '破損していないファイルか確認してください。',
    );
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    URL.revokeObjectURL(url);
    throw new PoseExtractionError(
      '動画の映像トラックが見つかりません。',
      null,
      '音声のみのファイルではなく、映像を含む動画を選択してください。',
    );
  }

  return { video, revoke: () => URL.revokeObjectURL(url) };
}

/** 指定時刻へシークし、フレームが描画可能になるまで待つ。 */
function seekTo(video: HTMLVideoElement, time: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new PoseExtractionError(`動画のシークがタイムアウトしました（${time.toFixed(2)}秒地点）。`));
    }, timeoutMs);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new PoseExtractionError('シーク中に動画の読み込みエラーが発生しました。', video.error));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = time;
  });
}

/**
 * 動画からモーションクリップを抽出する。
 *
 * 元動画の見た目（人物の容姿・背景）は一切保持しない。取り出すのは
 * 正規化された関節座標＝「動き」だけで、これを任意のキャラクターに適用する。
 */
export async function extractMotionFromVideo(
  file: File,
  options: ExtractOptions = {},
): Promise<MotionClip> {
  const { targetFps = 30, model = 'lite', signal, onProgress } = options;
  if (targetFps <= 0 || targetFps > 60) {
    throw new PoseExtractionError('解析フレームレートは 1〜60 の範囲で指定してください。');
  }

  onProgress?.({ phase: 'loading-model', ratio: 0, message: '姿勢推定エンジンを読み込んでいます…' });
  const landmarker = await getLandmarker(model);
  throwIfAborted(signal);

  onProgress?.({ phase: 'decoding-video', ratio: 0.05, message: '動画を読み込んでいます…' });
  const { video, revoke } = await loadVideoElement(file);

  try {
    const start = Math.max(0, options.start ?? 0);
    const end = Math.min(video.duration, options.end ?? video.duration);
    if (end - start <= 0) {
      throw new PoseExtractionError('抽出区間の長さが0です。開始・終了時刻を確認してください。');
    }
    if (end - start > MAX_CLIP_SECONDS) {
      throw new PoseExtractionError(
        `抽出区間が長すぎます（${(end - start).toFixed(0)}秒）。`,
        null,
        `1回あたり ${MAX_CLIP_SECONDS} 秒までにしてください。長い動画は区間を分けて取り込みます。`,
      );
    }

    const frameCount = Math.max(1, Math.floor((end - start) * targetFps));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new PoseExtractionError('Canvas 2D コンテキストを作成できませんでした。');

    const rawFrames: Array<MotionFrame | null> = [];
    // MediaPipe の VIDEO モードは単調増加のタイムスタンプを要求する
    let timestampMs = 0;

    for (let i = 0; i < frameCount; i++) {
      throwIfAborted(signal);
      const t = start + i / targetFps;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      timestampMs += 1000 / targetFps;
      let result: PoseLandmarkerResult;
      try {
        result = landmarker.detectForVideo(canvas, timestampMs);
      } catch (err) {
        throw new PoseExtractionError('姿勢推定の実行中にエラーが発生しました。', err);
      }

      const landmarks = result.landmarks?.[0];
      const frame = landmarks
        ? mapLandmarksToRig(landmarks, video.videoWidth, video.videoHeight, i / targetFps)
        : null;
      rawFrames.push(frame);

      if (i % 3 === 0 || i === frameCount - 1) {
        onProgress?.({
          phase: 'extracting',
          ratio: 0.1 + 0.8 * ((i + 1) / frameCount),
          message: `モーションを抽出しています… ${i + 1}/${frameCount} フレーム`,
          preview: frame,
        });
        // UI を固めないために毎回イベントループへ制御を返す
        await nextTick();
      }
    }

    onProgress?.({ phase: 'post-processing', ratio: 0.92, message: 'モーションを整形しています…' });
    const processed = postProcessFrames(rawFrames, targetFps);

    if (processed.frames.length === 0) {
      throw new PoseExtractionError(
        '人物の姿勢を検出できませんでした。',
        null,
        '全身（頭から足先まで）が映っていて、被写体が十分大きい動画を使ってください。',
      );
    }

    onProgress?.({ phase: 'done', ratio: 1, message: '完了しました' });

    return {
      id: crypto.randomUUID(),
      name: stripExtension(file.name),
      fps: targetFps,
      duration: processed.frames[processed.frames.length - 1].t,
      frames: processed.frames,
      source: {
        kind: 'video',
        fileName: file.name,
        backend: `mediapipe-pose-${model}`,
        width: video.videoWidth,
        height: video.videoHeight,
      },
      quality: {
        detectionRate: processed.detectionRate,
        meanConfidence: processed.meanConfidence,
        warnings: processed.warnings,
      },
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    revoke();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('処理が中止されました。');
    err.name = 'AbortError';
    throw err;
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
