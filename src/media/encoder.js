/**
 * WebCodecs によるオフライン書き出し。
 *
 * 従来の MediaRecorder 方式は「再生しながら録画」するため、
 *   - 実時間でしか書き出せない（10 分の動画に 10 分）
 *   - 画面ロックやアプリ切り替えで壊れる
 * という、特にスマートフォンで致命的な弱点があった。
 *
 * ここではフレームを 1 枚ずつ取り出してエンコーダへ渡し、
 * 音声は OfflineAudioContext で一括生成するため、再生時間に縛られない。
 * 描画は render.js を共有しているのでプレビューと結果は一致する。
 */

import { Mp4Muxer } from '../core/mp4.js';
import { timelineDuration, timelineToSource } from '../core/autoedit.js';
import { cueAt } from '../core/subtitles.js';
import { projectCuesToTimeline } from '../core/autoedit.js';
import { clamp } from '../core/util.js';
import { drawSubtitle, drawVideoFrame } from './render.js';
import { decodeForExport, renderTimelineAudio, toPlanarBlocks } from './audio-offline.js';
import { createFrameSource } from './framesource.js';

/**
 * 対応コーデックを上から順に試す。
 * H.264 / AAC を最優先にするのは、スマートフォンと SNS アプリが確実に読めるため。
 * H.264 エンコーダを持たない環境（一部の Linux 版 Chromium など）では VP9 / Opus へ退避する。
 */
const VIDEO_CODECS = [
  { codec: 'avc1.640028', kind: 'avc' },
  { codec: 'avc1.4d0028', kind: 'avc' },
  { codec: 'avc1.42e028', kind: 'avc' },
  { codec: 'avc1.4d001f', kind: 'avc' },
  { codec: 'avc1.42e01e', kind: 'avc' },
  { codec: 'vp09.00.41.08', kind: 'vp9' },
  { codec: 'vp09.00.10.08', kind: 'vp9' },
];
const AUDIO_CODECS = [
  { codec: 'mp4a.40.2', kind: 'aac' },
  { codec: 'opus', kind: 'opus' },
];
const KEYFRAME_INTERVAL_SEC = 2;

export function hasWebCodecs() {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof EncodedVideoChunk !== 'undefined'
  );
}

/**
 * この環境で WebCodecs 書き出しが使えるか調べる。
 * @returns {Promise<{video:string|null, audio:string|null, usable:boolean, reason:string}>}
 */
export async function probeCodecs({ width, height, fps = 30, needsAudio = true, sampleRate = 48000, channels = 2 } = {}) {
  if (!hasWebCodecs()) {
    return { video: null, audio: null, usable: false, reason: 'このブラウザは WebCodecs に対応していません。' };
  }
  const w = evenSize(width || 1280);
  const h = evenSize(height || 720);

  let video = null;
  for (const candidate of VIDEO_CODECS) {
    const config = {
      codec: candidate.codec,
      width: w,
      height: h,
      framerate: fps,
      bitrate: estimateBitrate(w, h, fps),
    };
    if (candidate.kind === 'avc') config.avc = { format: 'avc' };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support?.supported) {
        video = candidate;
        break;
      }
    } catch {
      /* 次の候補を試す */
    }
  }
  if (!video) {
    return { video: null, audio: null, usable: false, reason: 'この解像度に対応する映像エンコーダが見つかりませんでした。' };
  }

  let audio = null;
  if (needsAudio && typeof AudioEncoder !== 'undefined') {
    for (const candidate of AUDIO_CODECS) {
      try {
        const support = await AudioEncoder.isConfigSupported({
          codec: candidate.codec,
          sampleRate,
          numberOfChannels: channels,
          bitrate: 128000,
        });
        if (support?.supported) {
          audio = candidate;
          break;
        }
      } catch {
        /* 次の候補を試す */
      }
    }
  }
  if (needsAudio && !audio) {
    return { video, audio: null, usable: false, reason: 'この環境では音声をエンコードできません。' };
  }
  return { video, audio, usable: true, reason: '' };
}

/** 出力形式の表示名 */
export function describeFormat(video, audio) {
  const v = video?.kind === 'vp9' ? 'VP9' : 'H.264';
  if (!audio) return `MP4 (${v}・音声なし)`;
  return `MP4 (${v} / ${audio.kind === 'opus' ? 'Opus' : 'AAC'})`;
}

function evenSize(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function estimateBitrate(width, height, fps) {
  return clamp(Math.round(width * height * fps * 0.08), 400000, 24000000);
}

function abortError() {
  const error = new Error('書き出しをキャンセルしました。');
  error.name = 'AbortError';
  return error;
}

/**
 * 書き出しを実行する。
 *
 * @param {{project:object, sourceUrl:string, sourceFile?:File|Blob, bgmBuffer?:AudioBuffer,
 *          width?:number, height?:number, fps?:number, signal?:AbortSignal,
 *          onProgress?:(p:{ratio:number, phase:string, detail:string})=>void}} opt
 * @returns {Promise<{blob:Blob, format:{ext:string,label:string,mimeType:string}, durationSec:number}>}
 */
export async function renderWithCodecs(opt) {
  const project = opt.project;
  const total = timelineDuration(project.clips);
  if (total <= 0) throw new Error('書き出す区間がありません。');
  if (opt.signal?.aborted) throw abortError();

  const width = evenSize(opt.width || project.media?.width || 1280);
  const height = evenSize(opt.height || project.media?.height || 720);
  const fps = clamp(Math.round(opt.fps || project.media?.fps || 30), 1, 60);

  const progress = (ratio, phase, detail = '') => opt.onProgress?.({ ratio: clamp(ratio, 0, 1), phase, detail });

  /* ---------- 1. 音声を先に用意する（失敗しても映像は出せるようにする） ---------- */
  progress(0, '音声を準備中', '');
  const audio = await prepareAudio(opt, project, total);
  if (opt.signal?.aborted) throw abortError();

  const capability = await probeCodecs({
    width,
    height,
    fps,
    needsAudio: Boolean(audio.buffer),
    sampleRate: audio.buffer?.sampleRate || 48000,
    channels: audio.buffer?.numberOfChannels || 2,
  });
  if (!capability.usable) throw new Error(capability.reason);

  const muxer = new Mp4Muxer({
    width,
    height,
    videoCodec: capability.video.kind,
    videoCodecString: capability.video.codec,
    audio: audio.buffer
      ? { sampleRate: audio.buffer.sampleRate, channels: audio.buffer.numberOfChannels }
      : null,
    audioCodec: capability.audio?.kind || 'aac',
  });

  /* ---------- 2. 映像をフレーム単位でエンコード ---------- */
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  const cues = projectCuesToTimeline(project.subtitles, project.clips);
  const totalFrames = Math.max(1, Math.round(total * fps));

  // 各出力フレームに対応する素材内の時刻をあらかじめ求めておく
  const sourceTimes = [];
  for (let index = 0; index < totalFrames; index += 1) {
    const mapped = timelineToSource(project.clips, Math.min(index / fps, total - 1e-4));
    sourceTimes.push(mapped ? mapped.sourceTime : 0);
  }
  const frameSource = createFrameSource({ sourceUrl: opt.sourceUrl, times: sourceTimes, lookahead: opt.lookahead, signal: opt.signal });

  let encoderError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description) {
        muxer.setVideoDescription(new Uint8Array(metadata.decoderConfig.description));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addVideoChunk({
        data,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration || Math.round(1e6 / fps),
        isKey: chunk.type === 'key',
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });
  const videoConfig = {
    codec: capability.video.codec,
    width,
    height,
    framerate: fps,
    bitrate: estimateBitrate(width, height, fps),
    latencyMode: 'quality',
  };
  if (capability.video.kind === 'avc') videoConfig.avc = { format: 'avc' };
  videoEncoder.configure(videoConfig);

  const keyframeEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC));
  try {
    for (;;) {
      if (opt.signal?.aborted) throw abortError();
      if (encoderError) throw encoderError;

      const entry = await frameSource.next();
      if (!entry) break;
      const { video, index, release } = entry;

      drawVideoFrame(ctx, video, width, height);
      const cue = cueAt(cues, index / fps);
      if (cue && !cue.needsText) drawSubtitle(ctx, cue, project.subtitleStyle, width, height);
      release(); // 先読みを再開させる

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((index * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      videoEncoder.encode(frame, { keyFrame: index % keyframeEvery === 0 });
      frame.close();

      // エンコーダが詰まったら待つ（メモリの急増を防ぐ）
      while (videoEncoder.encodeQueueSize > 8) {
        await nextTick();
        if (opt.signal?.aborted) throw abortError();
      }
      if (index % 5 === 0 || index === totalFrames - 1) {
        progress(0.05 + (index / totalFrames) * 0.8, '映像を書き出し中', `${index + 1} / ${totalFrames} フレーム`);
      }
    }
    await videoEncoder.flush();
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
    frameSource.dispose();
  }
  if (encoderError) throw encoderError;

  /* ---------- 3. 音声をエンコード ---------- */
  if (audio.buffer && capability.audio) {
    if (opt.signal?.aborted) throw abortError();
    progress(0.88, '音声を書き出し中', '');
    await encodeAudio({
      buffer: audio.buffer,
      codec: capability.audio.codec,
      muxer,
      signal: opt.signal,
      onProgress: (r) => progress(0.88 + r * 0.1, '音声を書き出し中', ''),
    });
  }

  /* ---------- 4. 多重化 ---------- */
  progress(0.99, 'ファイルを作成中', '');
  const { parts, durationSec } = muxer.finalize();
  const blob = new Blob(parts, { type: 'video/mp4' });
  progress(1, '完了', '');

  return {
    blob,
    format: {
      ext: 'mp4',
      label: describeFormat(capability.video, audio.buffer ? capability.audio : null),
      mimeType: 'video/mp4',
    },
    durationSec,
    notice: audio.notice,
  };
}

/** 素材音声をデコードし、タイムライン音声を生成する */
async function prepareAudio(opt, project, total) {
  let sourceBuffer = null;
  let notice = '';
  const needsSource = project.media?.hasAudio !== false;

  if (needsSource) {
    try {
      const arrayBuffer = opt.sourceFile
        ? await opt.sourceFile.arrayBuffer()
        : await (await fetch(opt.sourceUrl)).arrayBuffer();
      const decoded = await decodeForExport(arrayBuffer);
      sourceBuffer = decoded.buffer;
      if (!sourceBuffer) notice = decoded.reason;
    } catch {
      notice = 'メモリ不足のため音声を読み込めませんでした。解像度か長さを下げてお試しください。';
    }
  }

  if (!sourceBuffer && !opt.bgmBuffer) return { buffer: null, notice };

  try {
    const buffer = await renderTimelineAudio({
      project,
      sourceBuffer,
      bgmBuffer: opt.bgmBuffer || null,
      sampleRate: sourceBuffer?.sampleRate || opt.bgmBuffer?.sampleRate || 48000,
      channels: Math.max(1, Math.min(2, sourceBuffer?.numberOfChannels || 2)),
    });
    void total;
    return { buffer, notice };
  } catch {
    return { buffer: null, notice: '音声の合成に失敗したため、映像のみ書き出します。' };
  }
}

async function encodeAudio({ buffer, codec, muxer, signal, onProgress }) {
  let encoderError = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description) {
        muxer.setAudioDescription(new Uint8Array(metadata.decoderConfig.description));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addAudioChunk({
        data,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration || 0,
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure({
    codec,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    bitrate: 128000,
  });

  const blocks = toPlanarBlocks(buffer);
  try {
    for (let i = 0; i < blocks.length; i += 1) {
      if (signal?.aborted) throw abortError();
      if (encoderError) throw encoderError;
      const block = blocks[i];
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: buffer.sampleRate,
        numberOfFrames: block.frames,
        numberOfChannels: buffer.numberOfChannels,
        timestamp: block.timestampUs,
        data: block.data,
      });
      encoder.encode(audioData);
      audioData.close();
      while (encoder.encodeQueueSize > 8) {
        await nextTick();
      }
      if (i % 20 === 0) onProgress?.(i / blocks.length);
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (encoderError) throw encoderError;
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
