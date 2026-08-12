export class AudioDecodeError extends Error {
  constructor(message: string, readonly cause?: unknown, readonly hint?: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

/** 音声デコード専用の AudioContext（使い回してリソースを節約する）。 */
let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new AudioDecodeError(
        'このブラウザは Web Audio API に対応していません。',
        null,
        'Chrome / Edge / Safari の最新版をご利用ください。',
      );
    }
    sharedContext = new Ctor();
  }
  return sharedContext;
}

/** ユーザー操作起点で AudioContext を再開する（自動再生ポリシー対策）。 */
export async function resumeAudioContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
}

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await blob.arrayBuffer();
  } catch (err) {
    throw new AudioDecodeError('ファイルの読み込みに失敗しました。', err);
  }
  if (arrayBuffer.byteLength === 0) {
    throw new AudioDecodeError('ファイルが空です。', null, '中身のある音声ファイルを選択してください。');
  }
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw new AudioDecodeError(
      'この音声ファイルをデコードできませんでした。',
      err,
      'MP3 / M4A(AAC) / WAV / OGG など、ブラウザが対応する形式に変換してからお試しください。動画ファイルの場合は音声のみを抽出してください。',
    );
  }
}
