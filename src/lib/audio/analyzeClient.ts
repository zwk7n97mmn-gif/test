import { analyzeAudio, downmixToMono } from './analyze';
import { decodeAudioBlob } from './decode';
import type { AnalyzeResponse } from './analyze.worker';
import type { AudioAnalysis } from './types';

export interface AnalyzeProgress {
  phase: string;
  ratio: number;
}

/** 解析に時間がかかりすぎる場合の上限（分）。超える音源は先頭を切り出して解析する。 */
export const MAX_ANALYZE_MINUTES = 10;

/**
 * Blob を解析する。Worker が使える環境では Worker 上で実行し、UI をブロックしない。
 * Worker の生成に失敗した場合はメインスレッドにフォールバックする（機能は落とさない）。
 */
export async function analyzeAudioBlob(
  blob: Blob,
  onProgress?: (progress: AnalyzeProgress) => void,
  signal?: AbortSignal,
): Promise<{ analysis: AudioAnalysis; buffer: AudioBuffer }> {
  onProgress?.({ phase: 'デコード', ratio: 0.02 });
  const buffer = await decodeAudioBlob(blob);
  throwIfAborted(signal);

  let mono = downmixToMono(buffer);
  const maxSamples = Math.floor(buffer.sampleRate * 60 * MAX_ANALYZE_MINUTES);
  let truncated = false;
  if (mono.length > maxSamples) {
    mono = mono.slice(0, maxSamples);
    truncated = true;
  }

  const analysis = await runAnalysis(mono, buffer.sampleRate, onProgress, signal);
  if (truncated) {
    analysis.warnings.push(
      `音源が長いため、先頭 ${MAX_ANALYZE_MINUTES} 分のみを解析しました。それ以降の区間は解析結果に含まれません。`,
    );
  }
  return { analysis, buffer };
}

function runAnalysis(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (progress: AnalyzeProgress) => void,
  signal?: AbortSignal,
): Promise<AudioAnalysis> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) {
    // Worker が使えない環境（一部の埋め込みブラウザ）でも解析自体は必ず行う
    return Promise.resolve(
      analyzeAudio(samples, sampleRate, undefined, (phase, ratio) => onProgress?.({ phase, ratio })),
    );
  }

  return new Promise<AudioAnalysis>((resolve, reject) => {
    const cleanup = () => {
      worker?.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const err = new Error('解析を中止しました。');
      err.name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.({ phase: message.phase, ratio: message.ratio });
      } else if (message.type === 'result') {
        cleanup();
        resolve(message.analysis);
      } else {
        cleanup();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(`解析ワーカーでエラーが発生しました: ${event.message}`));
    };

    // 転送してコピーを避ける（大きな音源でもメモリを二重に使わない）
    const copy = samples.slice();
    worker.postMessage({ type: 'analyze', samples: copy, sampleRate }, [copy.buffer]);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('処理を中止しました。');
    err.name = 'AbortError';
    throw err;
  }
}
