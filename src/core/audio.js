/**
 * 音声自動処理のパラメータ計算（純粋関数）。
 * ここで求めたゲイン/自動化点列を player.js と exporter.js が同一に適用する。
 */

import { clamp, normalizeSegments, toFinite } from './util.js';

export const AUDIO_DEFAULTS = Object.freeze({
  normalize: true,
  targetDb: -16, // 配信向けの一般的な目標値（LUFS 近似）
  duck: true,
  duckDb: -12, // 発話中に BGM を下げる量
  duckAttack: 0.15,
  duckRelease: 0.4,
  fadeIn: 0.4,
  fadeOut: 0.8,
  bgmGainDb: -18,
  bgmName: '',
});

export const GAIN_LIMITS = Object.freeze({ min: -12, max: 18, headroomDb: -1 });

/**
 * 正規化ゲイン（dB）を求める。クリップしないようピーク基準で頭打ちする。
 * @param {{integratedDb:number, peakDb:number}} loudness
 * @param {number} targetDb
 * @returns {{gainDb:number, limitedByPeak:boolean, reason:string}}
 */
export function normalizationGainDb(loudness, targetDb = AUDIO_DEFAULTS.targetDb) {
  const integrated = toFinite(loudness?.integratedDb, -70);
  const peak = toFinite(loudness?.peakDb, -100);
  if (integrated <= -60) {
    return { gainDb: 0, limitedByPeak: false, reason: '音声レベルが極端に低いため正規化を見送りました。' };
  }
  const desired = toFinite(targetDb, AUDIO_DEFAULTS.targetDb) - integrated;
  const clamped = clamp(desired, GAIN_LIMITS.min, GAIN_LIMITS.max);
  const peakCeiling = GAIN_LIMITS.headroomDb - peak;
  const gainDb = Math.min(clamped, peakCeiling);
  return {
    gainDb: Number(gainDb.toFixed(2)),
    limitedByPeak: gainDb < clamped - 1e-6,
    reason:
      gainDb < clamped - 1e-6
        ? 'ピークが高いため、クリップ回避を優先してゲインを抑えました。'
        : '目標ラウドネスに合わせて調整しました。',
  };
}

/**
 * BGM ダッキングの自動化点列を生成する。
 * @param {{start:number,end:number}[]} speechSegments タイムライン時刻
 * @param {number} timelineDuration
 * @param {{duckDb?:number, attack?:number, release?:number}} [opt]
 * @returns {{time:number, gain:number}[]} 時刻昇順・線形ランプ用
 */
export function buildDuckingAutomation(speechSegments, timelineDuration, opt = {}) {
  const duckDb = toFinite(opt.duckDb, AUDIO_DEFAULTS.duckDb);
  const attack = Math.max(0.01, toFinite(opt.attack, AUDIO_DEFAULTS.duckAttack));
  const release = Math.max(0.01, toFinite(opt.release, AUDIO_DEFAULTS.duckRelease));
  const total = Math.max(0, toFinite(timelineDuration, 0));
  const ducked = Math.pow(10, Math.min(0, duckDb) / 20);
  const points = [{ time: 0, gain: 1 }];
  if (total <= 0) return points;

  // 近接する発話は 1 つのダッキング区間にまとめる（ポンピング防止）
  const segments = normalizeSegments(speechSegments, { mergeGap: attack + release }).filter((s) => s.start < total);
  for (const seg of segments) {
    const start = clamp(seg.start, 0, total);
    const end = clamp(seg.end, 0, total);
    if (end <= start) continue;
    const attackStart = Math.max(0, start - attack);
    const releaseEnd = Math.min(total, end + release);
    pushPoint(points, attackStart, 1);
    pushPoint(points, start, ducked);
    pushPoint(points, end, ducked);
    pushPoint(points, releaseEnd, 1);
  }
  pushPoint(points, total, points[points.length - 1].gain);
  return points;
}

function pushPoint(points, time, gain) {
  const last = points[points.length - 1];
  if (last && time <= last.time + 1e-4) {
    last.gain = gain;
    return;
  }
  points.push({ time, gain });
}

/**
 * フェード時間を尺に合わせて安全な値へ丸める（合計が尺の 2/3 を超えない）。
 */
export function resolveFades(fadeIn, fadeOut, duration) {
  const total = Math.max(0, toFinite(duration, 0));
  if (total <= 0) return { fadeIn: 0, fadeOut: 0 };
  const maxEach = total / 3;
  return {
    fadeIn: clamp(toFinite(fadeIn, 0), 0, maxEach),
    fadeOut: clamp(toFinite(fadeOut, 0), 0, maxEach),
  };
}

/**
 * 指定時刻のフェード係数（0..1）。
 */
export function fadeGainAt(time, duration, fadeIn, fadeOut) {
  const total = Math.max(0, toFinite(duration, 0));
  const t = clamp(time, 0, total);
  const { fadeIn: fi, fadeOut: fo } = resolveFades(fadeIn, fadeOut, total);
  let gain = 1;
  if (fi > 0 && t < fi) gain = Math.min(gain, t / fi);
  if (fo > 0 && t > total - fo) gain = Math.min(gain, Math.max(0, (total - t) / fo));
  return clamp(gain, 0, 1);
}

/**
 * 自動化点列を任意時刻で評価する（線形補間）。プレビューの視覚化に使用。
 */
export function evaluateAutomation(points, time) {
  const list = points || [];
  if (!list.length) return 1;
  const t = toFinite(time, 0);
  if (t <= list[0].time) return list[0].gain;
  for (let i = 1; i < list.length; i += 1) {
    if (t <= list[i].time) {
      const a = list[i - 1];
      const b = list[i];
      const span = b.time - a.time;
      if (span <= 0) return b.gain;
      return a.gain + ((t - a.time) / span) * (b.gain - a.gain);
    }
  }
  return list[list.length - 1].gain;
}

/**
 * 音声処理の要約テキスト（UI とスクリーンリーダー向け）。
 */
export function describeAudioPlan(plan) {
  const parts = [];
  if (plan.normalizeGainDb !== 0) {
    parts.push(`音量を ${plan.normalizeGainDb > 0 ? '+' : ''}${plan.normalizeGainDb.toFixed(1)} dB 調整`);
  } else {
    parts.push('音量調整なし');
  }
  if (plan.duck) parts.push(`発話中に BGM を ${Math.abs(plan.duckDb)} dB 下げる`);
  if (plan.fadeIn > 0) parts.push(`冒頭 ${plan.fadeIn.toFixed(1)} 秒フェードイン`);
  if (plan.fadeOut > 0) parts.push(`末尾 ${plan.fadeOut.toFixed(1)} 秒フェードアウト`);
  return parts.join(' / ');
}

/**
 * プロジェクト設定 + 解析結果から音声処理プランを組み立てる。
 */
export function buildAudioPlan(audioSettings, loudness, speechTimeline, timelineDurationSec) {
  const cfg = { ...AUDIO_DEFAULTS, ...(audioSettings || {}) };
  const norm = cfg.normalize
    ? normalizationGainDb(loudness, cfg.targetDb)
    : { gainDb: 0, limitedByPeak: false, reason: '正規化は無効です。' };
  const fades = resolveFades(cfg.fadeIn, cfg.fadeOut, timelineDurationSec);
  return {
    normalizeGainDb: norm.gainDb,
    normalizeReason: norm.reason,
    limitedByPeak: norm.limitedByPeak,
    duck: cfg.duck === true,
    duckDb: cfg.duckDb,
    bgmGainDb: cfg.bgmGainDb,
    fadeIn: fades.fadeIn,
    fadeOut: fades.fadeOut,
    duckAutomation: cfg.duck ? buildDuckingAutomation(speechTimeline, timelineDurationSec, { duckDb: cfg.duckDb }) : [{ time: 0, gain: 1 }],
  };
}
