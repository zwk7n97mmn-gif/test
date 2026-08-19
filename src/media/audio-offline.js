/**
 * タイムライン音声の非実時間レンダリング。
 *
 * 従来は再生しながら録音していたため「実時間でしか書き出せない」「バックグラウンドで壊れる」
 * という制約があった。ここでは OfflineAudioContext でカット・正規化・ダッキング・フェードを
 * まとめて適用し、完成した音声バッファを一度に得る。
 */

import { buildAudioPlan } from '../core/audio.js';
import { layoutClips, timelineDuration } from '../core/autoedit.js';
import { clamp, dbToGain } from '../core/util.js';

export const EXPORT_SAMPLE_RATES = [48000, 44100, 24000];

/**
 * 素材の音声をデコードする。メモリ不足時は段階的に低いサンプルレートへ落とす。
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {number[]} [rates] 試行するサンプルレート（高い順）
 * @returns {Promise<{buffer:AudioBuffer|null, sampleRate:number, reason:string}>}
 */
export async function decodeForExport(arrayBuffer, rates = EXPORT_SAMPLE_RATES) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) return { buffer: null, sampleRate: 0, reason: 'この環境では音声を扱えません。' };

  let lastError = null;
  for (const rate of rates) {
    try {
      // 長さ 1 の文脈でも decodeAudioData は文脈のサンプルレートへリサンプルする
      const ctx = new Ctor(1, 1, rate);
      // decodeAudioData は ArrayBuffer を消費するため、試行ごとに複製する
      const copy = arrayBuffer.slice(0);
      const buffer = await ctx.decodeAudioData(copy);
      if (buffer && buffer.length) return { buffer, sampleRate: buffer.sampleRate, reason: '' };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    buffer: null,
    sampleRate: 0,
    reason: lastError
      ? '音声をデコードできませんでした（音声なし、非対応コーデック、またはメモリ不足）。映像のみで書き出します。'
      : '音声トラックがありません。',
  };
}

/**
 * クリップ・音量・ダッキング・フェードを適用した完成音声をレンダリングする。
 *
 * 素材ごとに音声バッファを受け取り、クリップの参照先に応じて並べる。
 * 画像素材や音声を持たない素材のクリップは、そのぶん無音として残る。
 *
 * @param {{project:object, buffersByAsset:Record<string,AudioBuffer>, bgmBuffer:AudioBuffer|null,
 *          sampleRate?:number, channels?:number, plan?:object}} opt
 * @returns {Promise<AudioBuffer|null>}
 */
export async function renderTimelineAudio(opt) {
  const project = opt.project;
  const total = timelineDuration(project.clips);
  if (total <= 0) return null;
  const buffers = opt.buffersByAsset || {};
  const anyBuffer = Object.values(buffers).find(Boolean) || null;
  if (!anyBuffer && !opt.bgmBuffer) return null;

  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) return null;

  const sampleRate = opt.sampleRate || anyBuffer?.sampleRate || opt.bgmBuffer?.sampleRate || 48000;
  const channels = clamp(opt.channels || Math.max(1, anyBuffer?.numberOfChannels || 2), 1, 2);
  const frames = Math.ceil(total * sampleRate);
  const ctx = new Ctor(channels, frames, sampleRate);

  const plan = opt.plan || buildAudioPlan(project.audio, { integratedDb: -70, peakDb: -100 }, [], total);

  const master = ctx.createGain();
  master.connect(ctx.destination);
  applyFades(master.gain, plan, total, ctx.currentTime);

  if (anyBuffer) {
    const voice = ctx.createGain();
    voice.gain.value = dbToGain(plan.normalizeGainDb);
    voice.connect(master);
    scheduleClips(ctx, buffers, project.clips, voice);
  }

  if (opt.bgmBuffer) {
    const bgm = ctx.createGain();
    bgm.connect(master);
    applyDucking(bgm.gain, plan, total);
    const source = ctx.createBufferSource();
    source.buffer = opt.bgmBuffer;
    source.loop = true;
    source.connect(bgm);
    source.start(0);
    source.stop(total);
  }

  return ctx.startRendering();
}

/** 各クリップを、参照先の素材バッファから切り出してタイムライン上に並べる */
function scheduleClips(ctx, buffersByAsset, clips, destination) {
  for (const clip of layoutClips(clips)) {
    const buffer = buffersByAsset[clip.assetId];
    if (!buffer) continue; // 画像・音声なしの素材はそのぶん無音になる
    const sourceLength = Math.min(clip.end, buffer.duration) - clip.start;
    if (sourceLength <= 0) continue;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = clamp(clip.speed || 1, 0.25, 8);
    node.connect(destination);
    // start(開始位置, 素材内オフセット, 素材内の長さ)
    node.start(clip.timelineStart, clip.start, sourceLength);
  }
}

function applyFades(gainParam, plan, total, now) {
  gainParam.setValueAtTime(plan.fadeIn > 0 ? 0 : 1, now);
  if (plan.fadeIn > 0) gainParam.linearRampToValueAtTime(1, plan.fadeIn);
  if (plan.fadeOut > 0) {
    gainParam.setValueAtTime(1, Math.max(plan.fadeIn, total - plan.fadeOut));
    gainParam.linearRampToValueAtTime(0, total);
  }
}

function applyDucking(gainParam, plan, total) {
  const base = dbToGain(plan.bgmGainDb);
  if (!plan.duck || !plan.duckAutomation.length) {
    gainParam.setValueAtTime(base, 0);
    return;
  }
  const [first, ...rest] = plan.duckAutomation;
  gainParam.setValueAtTime(base * first.gain, 0);
  for (const point of rest) {
    gainParam.linearRampToValueAtTime(base * point.gain, clamp(point.time, 0, total));
  }
}

/**
 * AudioBuffer を planar Float32 のブロック列に切り出す（AudioEncoder への入力用）。
 * @returns {{data:Float32Array, frames:number, timestampUs:number}[]}
 */
export function toPlanarBlocks(buffer, blockFrames = 4096) {
  if (!buffer) return [];
  const channels = buffer.numberOfChannels;
  const planes = [];
  for (let c = 0; c < channels; c += 1) planes.push(buffer.getChannelData(c));
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockFrames) {
    const frames = Math.min(blockFrames, buffer.length - offset);
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c += 1) {
      data.set(planes[c].subarray(offset, offset + frames), c * frames);
    }
    blocks.push({
      data,
      frames,
      timestampUs: Math.round((offset / buffer.sampleRate) * 1e6),
    });
  }
  return blocks;
}
