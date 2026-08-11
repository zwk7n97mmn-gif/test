/**
 * 素材解析（純粋関数）。
 * 音声 PCM / 縮小フレーム画素という「生データ」だけを受け取り、
 * 発話区間・シーン境界・フレーム品質を導出する。DOM/WebAudio には依存しない。
 */

import { amplitudeToDb, clamp, mean, normalizeSegments, percentile, stdDev, toFinite } from './util.js';

export const VAD_DEFAULTS = Object.freeze({
  windowSec: 0.025,
  hopSec: 0.01,
  /** ノイズフロアからの上乗せ dB */
  marginDb: 9,
  /** 立ち下がり側のヒステリシス dB */
  hysteresisDb: 3,
  /** 発話確定に必要な連続時間 */
  attackSec: 0.06,
  /** 無音確定に必要な連続時間 */
  releaseSec: 0.25,
  /** これより短い発話は棄却 */
  minSpeechSec: 0.15,
  absoluteMinDb: -55,
  absoluteMaxDb: -20,
});

/**
 * 複数チャンネル PCM をモノラル合成する。
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  const list = (channels || []).filter((c) => c && c.length);
  if (!list.length) return new Float32Array(0);
  if (list.length === 1) return list[0];
  const len = Math.min(...list.map((c) => c.length));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (const ch of list) sum += ch[i];
    out[i] = sum / list.length;
  }
  return out;
}

/**
 * RMS 包絡（dBFS）を計算する。
 * @param {Float32Array} samples モノラル PCM
 * @param {number} sampleRate
 * @param {{windowSec?:number, hopSec?:number}} [opt]
 * @returns {{hopSec:number, db:number[], peakDb:number}}
 */
export function computeEnvelope(samples, sampleRate, opt = {}) {
  const hopSec = opt.hopSec ?? VAD_DEFAULTS.hopSec;
  const windowSec = opt.windowSec ?? VAD_DEFAULTS.windowSec;
  const sr = toFinite(sampleRate, 0);
  if (!samples || !samples.length || sr <= 0) {
    return { hopSec, db: [], peakDb: -100 };
  }
  const hop = Math.max(1, Math.round(hopSec * sr));
  const win = Math.max(hop, Math.round(windowSec * sr));
  const frames = Math.max(1, Math.floor((samples.length - win) / hop) + 1);
  const db = new Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    const start = f * hop;
    const end = Math.min(samples.length, start + win);
    let acc = 0;
    for (let i = start; i < end; i += 1) {
      const v = samples[i];
      acc += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(acc / Math.max(1, end - start));
    db[f] = amplitudeToDb(rms);
  }
  return { hopSec: hop / sr, db, peakDb: amplitudeToDb(peak) };
}

/**
 * 包絡から発話区間を検出する（ヒステリシス付き VAD）。
 * @param {{hopSec:number, db:number[]}} envelope
 * @param {object} [options]
 * @returns {{segments:{start:number,end:number}[], thresholdDb:number, noiseFloorDb:number}}
 */
export function detectSpeech(envelope, options = {}) {
  const cfg = { ...VAD_DEFAULTS, ...options };
  const db = envelope?.db ?? [];
  const hop = toFinite(envelope?.hopSec, VAD_DEFAULTS.hopSec) || VAD_DEFAULTS.hopSec;
  if (!db.length) return { segments: [], thresholdDb: cfg.absoluteMinDb, noiseFloorDb: -100 };

  const noiseFloorDb = percentile(db, 0.1);
  const loudRef = percentile(db, 0.95);
  // 全体がほぼ無音（ダイナミックレンジが極小）なら発話なしと判断する
  const thresholdDb = clamp(noiseFloorDb + cfg.marginDb, cfg.absoluteMinDb, cfg.absoluteMaxDb);
  if (loudRef - noiseFloorDb < 3) {
    return { segments: [], thresholdDb, noiseFloorDb };
  }
  const releaseDb = thresholdDb - cfg.hysteresisDb;
  const attackFrames = Math.max(1, Math.round(cfg.attackSec / hop));
  const releaseFrames = Math.max(1, Math.round(cfg.releaseSec / hop));

  const segments = [];
  let inSpeech = false;
  let candidateStart = -1;
  let aboveRun = 0;
  let belowRun = 0;
  let speechStart = 0;

  for (let i = 0; i < db.length; i += 1) {
    const value = db[i];
    if (!inSpeech) {
      if (value >= thresholdDb) {
        if (aboveRun === 0) candidateStart = i;
        aboveRun += 1;
        if (aboveRun >= attackFrames) {
          inSpeech = true;
          speechStart = candidateStart;
          belowRun = 0;
        }
      } else {
        aboveRun = 0;
      }
    } else if (value < releaseDb) {
      belowRun += 1;
      if (belowRun >= releaseFrames) {
        segments.push({ start: speechStart * hop, end: (i - belowRun + 1) * hop });
        inSpeech = false;
        aboveRun = 0;
        belowRun = 0;
      }
    } else {
      belowRun = 0;
    }
  }
  if (inSpeech) segments.push({ start: speechStart * hop, end: db.length * hop });

  const filtered = segments.filter((s) => s.end - s.start >= cfg.minSpeechSec);
  return { segments: normalizeSegments(filtered), thresholdDb, noiseFloorDb };
}

/**
 * 簡易ラウドネス（LUFS 近似）。発話区間があればその区間のみを対象にする。
 * @returns {{integratedDb:number, peakDb:number, noiseFloorDb:number}}
 */
export function measureLoudness(envelope, speechSegments = []) {
  const db = envelope?.db ?? [];
  const hop = toFinite(envelope?.hopSec, 0.01) || 0.01;
  if (!db.length) return { integratedDb: -70, peakDb: -100, noiseFloorDb: -100 };

  let indices = [];
  for (const seg of speechSegments) {
    const from = Math.max(0, Math.floor(seg.start / hop));
    const to = Math.min(db.length, Math.ceil(seg.end / hop));
    for (let i = from; i < to; i += 1) indices.push(i);
  }
  if (indices.length < 5) indices = db.map((_, i) => i);

  // dB → パワー平均 → dB（区間の平均二乗）
  let power = 0;
  for (const i of indices) power += Math.pow(10, db[i] / 10);
  const integratedDb = 10 * Math.log10(Math.max(power / indices.length, 1e-12));
  return {
    integratedDb,
    peakDb: toFinite(envelope.peakDb, -100),
    noiseFloorDb: percentile(db, 0.1),
  };
}

/**
 * 縮小フレームの RGB から 24 次元ヒストグラム（各チャンネル 8 ビン, L1 正規化）を作る。
 * @param {Uint8ClampedArray} rgba
 */
export function frameHistogram(rgba) {
  const hist = new Float64Array(24);
  if (!rgba || rgba.length < 4) return hist;
  const pixels = Math.floor(rgba.length / 4);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    hist[(rgba[o] >> 5)] += 1;
    hist[8 + (rgba[o + 1] >> 5)] += 1;
    hist[16 + (rgba[o + 2] >> 5)] += 1;
  }
  const total = pixels * 3 || 1;
  for (let i = 0; i < 24; i += 1) hist[i] /= total;
  return hist;
}

/**
 * 2 ヒストグラムの距離（0..1）。
 * 各ヒストグラムは総和 1 に正規化されているため L1 距離の最大値は 2。
 */
export function histogramDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return clamp(sum / 2, 0, 1);
}

/**
 * フレーム列（時刻＋ヒストグラム）からシーン区間を求める。
 * @param {{t:number, hist:Float64Array}[]} frames 時刻昇順
 * @param {number} duration
 * @param {{minSceneSec?:number, minDistance?:number, k?:number}} [opt]
 */
export function detectScenes(frames, duration, opt = {}) {
  const total = Math.max(0, toFinite(duration, 0));
  const minSceneSec = opt.minSceneSec ?? 0.8;
  const minDistance = opt.minDistance ?? 0.22;
  const k = opt.k ?? 2.2;
  if (!frames || frames.length < 2 || total <= 0) {
    return total > 0 ? [{ start: 0, end: total, score: 0 }] : [];
  }
  const distances = [];
  for (let i = 1; i < frames.length; i += 1) {
    distances.push(histogramDistance(frames[i - 1].hist, frames[i].hist));
  }
  const threshold = Math.max(minDistance, mean(distances) + k * stdDev(distances));
  const cuts = [];
  for (let i = 0; i < distances.length; i += 1) {
    if (distances[i] >= threshold) cuts.push({ t: frames[i + 1].t, score: distances[i] });
  }
  const scenes = [];
  let start = 0;
  let score = 0;
  for (const cut of cuts) {
    if (cut.t - start < minSceneSec) continue;
    if (total - cut.t < minSceneSec) break;
    scenes.push({ start, end: cut.t, score });
    start = cut.t;
    score = cut.score;
  }
  scenes.push({ start, end: total, score });
  return scenes;
}

/**
 * フレーム品質指標を計算する。
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {{sharp:number, contrast:number, colorful:number, exposure:number}}
 */
export function frameQuality(rgba, width, height) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!rgba || w < 3 || h < 3 || rgba.length < w * h * 4) {
    return { sharp: 0, contrast: 0, colorful: 0, exposure: 0 };
  }
  const luma = new Float64Array(w * h);
  const rg = [];
  const yb = [];
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    rg.push(r - g);
    yb.push(0.5 * (r + g) - b);
  }
  // Laplacian 分散（シャープネス）
  let lapAcc = 0;
  let lapCount = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w];
      lapAcc += v * v;
      lapCount += 1;
    }
  }
  const lapVar = lapCount ? lapAcc / lapCount : 0;
  const sharp = clamp(Math.log1p(lapVar * 400) / Math.log1p(400), 0, 1);

  const lumaArr = Array.from(luma);
  const contrast = clamp(stdDev(lumaArr) / 0.3, 0, 1);
  const avgLuma = mean(lumaArr);
  const exposure = clamp(1 - Math.abs(avgLuma - 0.5) / 0.5, 0, 1);
  const colorfulness = Math.sqrt(stdDev(rg) ** 2 + stdDev(yb) ** 2) + 0.3 * Math.sqrt(mean(rg) ** 2 + mean(yb) ** 2);
  const colorful = clamp(colorfulness / 110, 0, 1);
  return { sharp, contrast, colorful, exposure };
}

/** 時刻がいずれかの区間に含まれるか */
export function isInsideSegments(t, segments) {
  for (const seg of segments || []) {
    if (t >= seg.start && t < seg.end) return true;
  }
  return false;
}
