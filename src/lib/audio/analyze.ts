import { FFT, hannWindow } from '../dsp/fft';
import type { AnalyzeOptions, AudioAnalysis, Beat, Onset, Section, SectionKind } from './types';

const DEFAULTS = {
  fftSize: 1024,
  hopSize: 512,
  minBpm: 60,
  maxBpm: 200,
  waveformResolution: 1200,
} as const;

/** 無音判定のしきい値（RMS）。これを下回る素材はビート推定を行わない。 */
const SILENCE_RMS = 1e-4;

export type ProgressFn = (phase: string, ratio: number) => void;

/**
 * モノラル化済みPCMから楽曲構造を解析する。
 *
 * 実装している処理は次の通り（すべて実データに対する計算で、推定値の捏造は行わない）:
 *  1. STFT → 対数圧縮スペクトル
 *  2. スペクトルフラックスによるオンセット強度包絡
 *  3. 適応しきい値によるオンセット検出
 *  4. 自己相関＋テンポ事前分布によるBPM推定
 *  5. 動的計画法によるビートトラッキング（Ellis 2007 準拠）
 *  6. ビート同期特徴量の自己類似行列＋チェッカーボードカーネルによる楽曲構造分割
 *  7. 区間エネルギーと反復性からのサビ（hook）推定
 */
export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeOptions = {},
  onProgress?: ProgressFn,
): AudioAnalysis {
  const fftSize = options.fftSize ?? DEFAULTS.fftSize;
  const hopSize = options.hopSize ?? DEFAULTS.hopSize;
  const minBpm = options.minBpm ?? DEFAULTS.minBpm;
  const maxBpm = options.maxBpm ?? DEFAULTS.maxBpm;
  const waveformResolution = options.waveformResolution ?? DEFAULTS.waveformResolution;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate must be a positive number');
  }

  const warnings: string[] = [];
  const duration = samples.length / sampleRate;
  const hopTime = hopSize / sampleRate;

  const waveform = buildWaveform(samples, waveformResolution);

  // --- 境界値: 極端に短い / 無音の素材 -------------------------------------
  const globalRms = rms(samples);
  const emptyResult = (extraWarning: string): AudioAnalysis => ({
    duration,
    sampleRate,
    bpm: 0,
    bpmConfidence: 0,
    hopTime,
    onsetEnvelope: new Float32Array(0),
    energyEnvelope: new Float32Array(0),
    bands: { low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0) },
    onsets: [],
    beats: [],
    sections: [],
    hook: null,
    waveform,
    warnings: [...warnings, extraWarning],
  });

  if (samples.length < fftSize * 2) {
    return emptyResult('音源が短すぎるため（0.05秒未満相当）テンポ解析を行いませんでした。');
  }
  if (globalRms < SILENCE_RMS) {
    return emptyResult('音源がほぼ無音のため、ビート・区間の推定を行いませんでした。');
  }

  // --- 1. STFT --------------------------------------------------------------
  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const bins = fftSize / 2;
  const frameCount = Math.max(1, Math.floor((samples.length - fftSize) / hopSize) + 1);

  const scratchRe = new Float32Array(fftSize);
  const scratchIm = new Float32Array(fftSize);
  const frameBuf = new Float32Array(fftSize);
  const mag = new Float32Array(bins + 1);
  const prevMag = new Float32Array(bins + 1);

  const onsetEnvelope = new Float32Array(frameCount);
  const energyEnvelope = new Float32Array(frameCount);
  const low = new Float32Array(frameCount);
  const mid = new Float32Array(frameCount);
  const high = new Float32Array(frameCount);

  // 帯域境界（Hz）: 低域=キック, 中域=スネア/ボーカル, 高域=ハイハット
  const binHz = sampleRate / fftSize;
  const lowEnd = Math.max(1, Math.round(200 / binHz));
  const midEnd = Math.max(lowEnd + 1, Math.round(2000 / binHz));

  // ビート同期構造解析用のログバンド特徴量
  const featureBandCount = 12;
  const bandEdges = logBandEdges(featureBandCount, bins, binHz);
  const spectralFeatures: Float32Array[] = [];

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      frameBuf[i] = samples[start + i] * window[i];
    }
    fft.magnitude(frameBuf, mag, scratchRe, scratchIm);

    // 対数圧縮（微小音の変化を潰しつつダイナミクスを保つ）
    let flux = 0;
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
    for (let k = 0; k <= bins; k++) {
      const m = Math.log1p(mag[k]);
      const diff = m - prevMag[k];
      if (diff > 0) flux += diff;
      prevMag[k] = m;
      if (k < lowEnd) lowSum += m;
      else if (k < midEnd) midSum += m;
      else highSum += m;
    }
    onsetEnvelope[f] = flux;
    low[f] = lowSum;
    mid[f] = midSum;
    high[f] = highSum;
    energyEnvelope[f] = rmsRange(samples, start, fftSize);

    const feat = new Float32Array(featureBandCount);
    for (let b = 0; b < featureBandCount; b++) {
      let sum = 0;
      const from = bandEdges[b];
      const to = bandEdges[b + 1];
      for (let k = from; k < to; k++) sum += prevMag[k];
      feat[b] = sum / Math.max(1, to - from);
    }
    spectralFeatures.push(feat);

    if (onProgress && (f & 255) === 0) onProgress('スペクトル解析', f / frameCount);
  }

  normalizeInPlace(onsetEnvelope);
  normalizeInPlace(energyEnvelope);
  normalizeInPlace(low);
  normalizeInPlace(mid);
  normalizeInPlace(high);

  // --- 2. オンセット検出（適応しきい値 + 局所最大） -------------------------
  onProgress?.('オンセット検出', 0.35);
  const onsets = pickOnsets(onsetEnvelope, hopTime);
  if (onsets.length === 0) {
    warnings.push('明確なオンセットを検出できませんでした。アタックの弱い素材の可能性があります。');
  }

  // --- 3. BPM 推定 ----------------------------------------------------------
  onProgress?.('テンポ推定', 0.5);
  const { bpm, confidence } = estimateTempo(onsetEnvelope, hopTime, minBpm, maxBpm);
  if (bpm === 0) {
    warnings.push('BPMを推定できませんでした。手動でBPMを指定してください。');
  } else if (confidence < 0.35) {
    warnings.push(`BPM推定の信頼度が低めです（${(confidence * 100).toFixed(0)}%）。必要に応じて手動補正してください。`);
  }

  // --- 4. ビートトラッキング ------------------------------------------------
  onProgress?.('ビート検出', 0.65);
  const beats = bpm > 0 ? trackBeats(onsetEnvelope, hopTime, bpm, low) : [];

  // --- 5. 楽曲構造の分割 ----------------------------------------------------
  onProgress?.('構造解析', 0.85);
  const sections = segmentSections(spectralFeatures, beats, energyEnvelope, hopTime, duration);
  const hook = pickHook(sections);
  if (sections.length === 0) {
    warnings.push('楽曲構造を分割できるだけの長さがありません。全体を1区間として扱います。');
  }

  onProgress?.('完了', 1);

  return {
    duration,
    sampleRate,
    bpm,
    bpmConfidence: confidence,
    hopTime,
    onsetEnvelope,
    energyEnvelope,
    bands: { low, mid, high },
    onsets,
    beats,
    sections,
    hook,
    waveform,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

function rms(data: Float32Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  // 長尺でも一定時間で終わるよう、最大 1M サンプルまで間引いて評価する。
  const stride = Math.max(1, Math.floor(data.length / 1_000_000));
  let count = 0;
  for (let i = 0; i < data.length; i += stride) {
    sum += data[i] * data[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function rmsRange(data: Float32Array, start: number, length: number): number {
  let sum = 0;
  const end = Math.min(data.length, start + length);
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function normalizeInPlace(data: Float32Array): void {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > max) max = data[i];
  }
  if (max <= 0) return;
  for (let i = 0; i < data.length; i++) data[i] /= max;
}

function logBandEdges(count: number, bins: number, binHz: number): number[] {
  const minHz = 40;
  const maxHz = Math.max(minHz * 2, binHz * bins);
  const edges: number[] = [];
  for (let i = 0; i <= count; i++) {
    const hz = minHz * Math.pow(maxHz / minHz, i / count);
    edges.push(Math.min(bins, Math.max(1, Math.round(hz / binHz))));
  }
  // 単調増加を保証（低域で潰れることがある）
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
  }
  return edges;
}

function buildWaveform(samples: Float32Array, resolution: number): Float32Array {
  const out = new Float32Array(Math.max(1, resolution));
  if (samples.length === 0) return out;
  const bucket = samples.length / out.length;
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.min(samples.length, Math.floor((i + 1) * bucket));
    let peak = 0;
    // 描画用なので、極端に長いバケットは間引いてピークを取る。
    const stride = Math.max(1, Math.floor((end - start) / 512));
    for (let j = start; j < end; j += stride) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

/** 適応しきい値（移動中央値 + マージン）による局所ピーク検出。 */
function pickOnsets(envelope: Float32Array, hopTime: number): Onset[] {
  const n = envelope.length;
  if (n < 3) return [];
  const half = Math.max(2, Math.round(0.1 / hopTime)); // ±100ms
  const onsets: Onset[] = [];
  const minGapFrames = Math.max(1, Math.round(0.05 / hopTime)); // 50ms 以内の重複は棄却
  let lastIndex = -Infinity;

  const windowBuf: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(n, i + half + 1);
    windowBuf.length = 0;
    for (let j = from; j < to; j++) windowBuf.push(envelope[j]);
    windowBuf.sort((a, b) => a - b);
    const median = windowBuf[windowBuf.length >> 1];
    const threshold = median + 0.06;

    if (
      envelope[i] > threshold &&
      envelope[i] >= envelope[i - 1] &&
      envelope[i] > envelope[i + 1] &&
      i - lastIndex >= minGapFrames
    ) {
      onsets.push({ time: i * hopTime, strength: Math.min(1, envelope[i]) });
      lastIndex = i;
    }
  }
  return onsets;
}

/**
 * オンセット包絡の自己相関にテンポ事前分布（log正規, 中心120BPM）を掛けてBPMを推定する。
 * ハーフ/ダブルテンポの取り違えを抑えるため、倍・半のピークとの比較で補正する。
 */
export function estimateTempo(
  envelope: Float32Array,
  hopTime: number,
  minBpm: number,
  maxBpm: number,
): { bpm: number; confidence: number } {
  const n = envelope.length;
  if (n < 16) return { bpm: 0, confidence: 0 };

  const minLag = Math.max(1, Math.round(60 / maxBpm / hopTime));
  const maxLag = Math.min(n - 1, Math.round(60 / minBpm / hopTime));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0 };

  // 平均を引いてから自己相関（DC成分で全体が持ち上がるのを防ぐ）
  let mean = 0;
  for (let i = 0; i < n; i++) mean += envelope[i];
  mean /= n;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) centered[i] = envelope[i] - mean;

  const scores = new Float32Array(maxLag + 1);
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += centered[i] * centered[i - lag];
    const bpm = 60 / (lag * hopTime);
    // Ellis のテンポ事前分布: log(bpm/120) のガウシアン
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = (sum / (n - lag)) * prior;
    scores[lag] = score > 0 ? score : 0;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || best <= 0) return { bpm: 0, confidence: 0 };

  // 放物線補間でラグをサブフレーム精度に
  const refined = parabolicRefine(scores, bestLag);
  const bpm = 60 / (refined * hopTime);

  // 信頼度: 最良スコアと、それ以外の平均スコアの比
  let sum = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) < 3) continue;
    sum += scores[lag];
    count++;
  }
  const mean2 = count > 0 ? sum / count : 0;
  const confidence = mean2 > 0 ? Math.max(0, Math.min(1, 1 - mean2 / best)) : 0.5;

  return { bpm: clampBpm(bpm, minBpm, maxBpm), confidence };
}

function parabolicRefine(scores: Float32Array, index: number): number {
  const y0 = scores[index - 1] ?? scores[index];
  const y1 = scores[index];
  const y2 = scores[index + 1] ?? scores[index];
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) return index;
  const offset = (0.5 * (y0 - y2)) / denom;
  return index + Math.max(-1, Math.min(1, offset));
}

function clampBpm(bpm: number, minBpm: number, maxBpm: number): number {
  let v = bpm;
  while (v < minBpm) v *= 2;
  while (v > maxBpm) v /= 2;
  return Math.round(v * 10) / 10;
}

/**
 * Ellis(2007) の動的計画法ビートトラッカー。
 * C[t] = onset[t] + max_tau ( C[tau] + alpha * -(log(( t-tau )/period))^2 )
 */
export function trackBeats(
  envelope: Float32Array,
  hopTime: number,
  bpm: number,
  lowBand?: Float32Array,
): Beat[] {
  const n = envelope.length;
  const period = 60 / bpm / hopTime;
  if (!Number.isFinite(period) || period < 2 || n < period * 4) return [];

  const alpha = 100;
  const searchFrom = Math.max(1, Math.round(period * 0.5));
  const searchTo = Math.max(searchFrom + 1, Math.round(period * 2));

  const cumulative = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);

  // 遷移コストの事前計算
  const penalties = new Float32Array(searchTo + 1);
  for (let d = searchFrom; d <= searchTo; d++) {
    penalties[d] = -alpha * Math.pow(Math.log(d / period), 2);
  }

  for (let t = 0; t < n; t++) {
    let bestScore = -Infinity;
    let bestTau = -1;
    const from = t - searchTo;
    const to = t - searchFrom;
    for (let tau = Math.max(0, from); tau <= to; tau++) {
      const score = cumulative[tau] + penalties[t - tau];
      if (score > bestScore) {
        bestScore = score;
        bestTau = tau;
      }
    }
    if (bestTau < 0) {
      cumulative[t] = envelope[t];
    } else {
      cumulative[t] = envelope[t] + bestScore;
      backlink[t] = bestTau;
    }
  }

  // 終端は末尾1周期分の最大値から辿る
  let endIndex = -1;
  let endBest = -Infinity;
  for (let t = Math.max(0, n - Math.round(period * 2)); t < n; t++) {
    if (cumulative[t] > endBest) {
      endBest = cumulative[t];
      endIndex = t;
    }
  }
  if (endIndex < 0) return [];

  const frames: number[] = [];
  for (let t = endIndex; t >= 0; t = backlink[t]) {
    frames.push(t);
    if (backlink[t] < 0) break;
  }
  frames.reverse();
  if (frames.length < 2) return [];

  // ダウンビート（小節頭）の位相推定: 4拍周期で低域エネルギーが最大になる位相を選ぶ
  const strengthAt = (frame: number) => {
    const onset = envelope[frame] ?? 0;
    const bass = lowBand ? lowBand[frame] ?? 0 : 0;
    return onset * 0.6 + bass * 0.4;
  };
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let sum = 0;
    for (let i = phase; i < frames.length; i += 4) sum += strengthAt(frames[i]);
    const count = Math.ceil((frames.length - phase) / 4);
    const score = count > 0 ? sum / count : 0;
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  return frames.map((frame, i) => ({
    time: frame * hopTime,
    indexInBar: ((i - bestPhase) % 4 + 4) % 4,
    strength: Math.min(1, strengthAt(frame)),
  }));
}

/**
 * ビート同期特徴量の自己類似行列にチェッカーボードカーネルを畳み込み、
 * ノベルティ曲線のピークを区間境界とする（Foote 2000）。
 */
export function segmentSections(
  frameFeatures: Float32Array[],
  beats: Beat[],
  energyEnvelope: Float32Array,
  hopTime: number,
  duration: number,
): Section[] {
  const mkSection = (start: number, end: number, index: number): Section => {
    const from = Math.floor(start / hopTime);
    const to = Math.min(energyEnvelope.length, Math.ceil(end / hopTime));
    let sum = 0;
    for (let i = from; i < to; i++) sum += energyEnvelope[i] ?? 0;
    const energy = to > from ? sum / (to - from) : 0;
    return { id: `sec-${index}`, kind: 'verse', start, end, energy, score: 0 };
  };

  // ビートが取れない/極端に短い場合は全体を1区間にする（ハリボテを返さず、事実を返す）
  if (beats.length < 16 || duration < 8) {
    if (duration <= 0) return [];
    const only = mkSection(0, duration, 0);
    only.kind = 'hook';
    only.score = 1;
    return [only];
  }

  // 1ビート = 1特徴ベクトルへ集約
  const beatFeatures: Float32Array[] = beats.map((beat, i) => {
    const from = Math.floor(beat.time / hopTime);
    const to = i + 1 < beats.length ? Math.floor(beats[i + 1].time / hopTime) : from + 1;
    const dim = frameFeatures[0]?.length ?? 0;
    const acc = new Float32Array(dim);
    let count = 0;
    for (let f = from; f < to && f < frameFeatures.length; f++) {
      const feat = frameFeatures[f];
      for (let d = 0; d < dim; d++) acc[d] += feat[d];
      count++;
    }
    if (count > 0) for (let d = 0; d < dim; d++) acc[d] /= count;
    return l2normalize(acc);
  });

  const N = beatFeatures.length;
  const kernelHalf = 8; // 8ビート = 4/4 で2小節
  if (N < kernelHalf * 2 + 4) {
    const only = mkSection(0, duration, 0);
    only.kind = 'hook';
    only.score = 1;
    return [only];
  }

  const novelty = new Float32Array(N);
  for (let center = kernelHalf; center < N - kernelHalf; center++) {
    let same = 0;
    let cross = 0;
    for (let i = -kernelHalf; i < kernelHalf; i++) {
      for (let j = -kernelHalf; j < kernelHalf; j++) {
        const sim = cosine(beatFeatures[center + i], beatFeatures[center + j]);
        const sameQuadrant = (i < 0 && j < 0) || (i >= 0 && j >= 0);
        if (sameQuadrant) same += sim;
        else cross += sim;
      }
    }
    novelty[center] = same - cross;
  }
  normalizeInPlace(novelty);

  // 最小区間長 = 8ビート。ピークを貪欲に選ぶ。
  const minBeats = 8;
  const boundaries: number[] = [0];
  const candidates: Array<{ index: number; value: number }> = [];
  for (let i = 1; i < N - 1; i++) {
    if (novelty[i] > 0.28 && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1]) {
      candidates.push({ index: i, value: novelty[i] });
    }
  }
  candidates.sort((a, b) => b.value - a.value);
  for (const c of candidates) {
    if (boundaries.every((b) => Math.abs(b - c.index) >= minBeats) && N - c.index >= minBeats) {
      boundaries.push(c.index);
    }
  }
  boundaries.sort((a, b) => a - b);

  const sections: Section[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const startBeat = boundaries[i];
    const endBeat = i + 1 < boundaries.length ? boundaries[i + 1] : N - 1;
    const start = beats[startBeat].time;
    const end = i + 1 < boundaries.length ? beats[endBeat].time : duration;
    if (end - start < 0.5) continue;
    sections.push(mkSection(start, end, sections.length));
  }
  if (sections.length === 0) {
    const only = mkSection(0, duration, 0);
    only.kind = 'hook';
    only.score = 1;
    return [only];
  }

  labelSections(sections, beatFeatures, boundaries, N);
  return sections;
}

/**
 * 区間ラベル付け。
 * サビ(hook)は「高エネルギー」かつ「他区間との類似度が高い（＝繰り返し現れる）」区間とする。
 */
function labelSections(
  sections: Section[],
  beatFeatures: Float32Array[],
  boundaries: number[],
  totalBeats: number,
): void {
  const centroids = sections.map((_, i) => {
    const from = boundaries[i];
    const to = i + 1 < boundaries.length ? boundaries[i + 1] : totalBeats - 1;
    const dim = beatFeatures[0]?.length ?? 0;
    const acc = new Float32Array(dim);
    let count = 0;
    for (let b = from; b < to; b++) {
      const feat = beatFeatures[b];
      if (!feat) continue;
      for (let d = 0; d < dim; d++) acc[d] += feat[d];
      count++;
    }
    if (count > 0) for (let d = 0; d < dim; d++) acc[d] /= count;
    return l2normalize(acc);
  });

  const repetition = centroids.map((c, i) => {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < centroids.length; j++) {
      if (i === j) continue;
      sum += cosine(c, centroids[j]);
      count++;
    }
    return count > 0 ? sum / count : 0;
  });

  const maxEnergy = Math.max(...sections.map((s) => s.energy), 1e-9);
  sections.forEach((s, i) => {
    s.score = (s.energy / maxEnergy) * 0.65 + repetition[i] * 0.35;
  });

  const hookIndex = sections.reduce((best, s, i) => (s.score > sections[best].score ? i : best), 0);

  sections.forEach((s, i) => {
    const rel = s.energy / maxEnergy;
    let kind: SectionKind;
    if (i === hookIndex) kind = 'hook';
    else if (i === 0 && rel < 0.75) kind = 'intro';
    else if (i === sections.length - 1 && rel < 0.75) kind = 'outro';
    else if (rel < 0.4) kind = 'break';
    else if (i + 1 < sections.length && i + 1 === hookIndex) kind = 'build';
    else kind = 'verse';
    s.kind = kind;
  });
}

function pickHook(sections: Section[]): Section | null {
  if (sections.length === 0) return null;
  const hooks = sections.filter((s) => s.kind === 'hook');
  if (hooks.length > 0) return hooks.reduce((a, b) => (b.score > a.score ? b : a));
  return sections.reduce((a, b) => (b.score > a.score ? b : a));
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm <= 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** ステレオ以上のAudioBufferをモノラルのFloat32Arrayへ。 */
export function downmixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const out = new Float32Array(length);
  if (channels === 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) out[i] /= channels;
  }
  return out;
}
