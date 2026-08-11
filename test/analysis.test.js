import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEnvelope,
  detectScenes,
  detectSpeech,
  frameHistogram,
  frameQuality,
  histogramDistance,
  isInsideSegments,
  measureLoudness,
  mixToMono,
} from '../src/core/analysis.js';

const SR = 16000;

/** 無音 1 秒 → 発話 1 秒 → 無音 1 秒 の合成音声 */
function makeSignal() {
  const samples = new Float32Array(SR * 3);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / SR;
    const noise = (Math.random() - 0.5) * 0.002;
    samples[i] = t >= 1 && t < 2 ? Math.sin(2 * Math.PI * 220 * t) * 0.5 + noise : noise;
  }
  return samples;
}

test('mixToMono は空入力でも壊れない', () => {
  assert.equal(mixToMono([]).length, 0);
  assert.equal(mixToMono(null).length, 0);
  const mono = mixToMono([Float32Array.from([1, 1]), Float32Array.from([-1, 1])]);
  assert.deepEqual(Array.from(mono), [0, 1]);
});

test('computeEnvelope は 0 サンプルで空配列を返す', () => {
  const env = computeEnvelope(new Float32Array(0), SR);
  assert.equal(env.db.length, 0);
  assert.equal(env.peakDb, -100);
  assert.equal(computeEnvelope(Float32Array.from([1]), 0).db.length, 0);
});

test('AC-02/AC-03a: 発話区間を検出できる', () => {
  const env = computeEnvelope(makeSignal(), SR);
  assert.ok(env.db.length > 200);
  const { segments, thresholdDb, noiseFloorDb } = detectSpeech(env);
  assert.equal(segments.length, 1, `検出数が想定外: ${JSON.stringify(segments)}`);
  assert.ok(Math.abs(segments[0].start - 1) < 0.15, `開始 ${segments[0].start}`);
  assert.ok(Math.abs(segments[0].end - 2) < 0.35, `終了 ${segments[0].end}`);
  assert.ok(thresholdDb > noiseFloorDb);
});

test('無音のみの素材では発話 0 件（ダミーを作らない）', () => {
  const silence = new Float32Array(SR * 2);
  const env = computeEnvelope(silence, SR);
  assert.deepEqual(detectSpeech(env).segments, []);
});

test('包絡が空でも detectSpeech は例外を出さない', () => {
  const result = detectSpeech({ hopSec: 0.01, db: [] });
  assert.deepEqual(result.segments, []);
});

test('measureLoudness は発話区間のみを対象にする', () => {
  const env = computeEnvelope(makeSignal(), SR);
  const speech = detectSpeech(env).segments;
  const withSpeech = measureLoudness(env, speech);
  const whole = measureLoudness(env, []);
  assert.ok(withSpeech.integratedDb > whole.integratedDb, '発話区間限定の方が大きくなるはず');
  assert.ok(withSpeech.integratedDb > -20 && withSpeech.integratedDb < 0);
});

test('frameHistogram は総和 1 に正規化される', () => {
  const rgba = new Uint8ClampedArray(4 * 100);
  for (let i = 0; i < 100; i += 1) rgba[i * 4] = 255;
  const hist = frameHistogram(rgba);
  const sum = Array.from(hist).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('histogramDistance は同一で 0、完全相違で 1', () => {
  const a = frameHistogram(fill(64, [255, 0, 0]));
  const b = frameHistogram(fill(64, [255, 0, 0]));
  const c = frameHistogram(fill(64, [0, 255, 255]));
  assert.equal(histogramDistance(a, b), 0);
  assert.ok(histogramDistance(a, c) > 0.6);
  assert.equal(histogramDistance(null, a), 0);
});

test('AC-02: シーン境界を検出する', () => {
  const red = frameHistogram(fill(64, [220, 20, 20]));
  const blue = frameHistogram(fill(64, [20, 20, 220]));
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    frames.push({ t: i * 0.25, hist: i < 20 ? red : blue });
  }
  const scenes = detectScenes(frames, 10);
  assert.equal(scenes.length, 2);
  assert.ok(Math.abs(scenes[0].end - 5) < 0.3);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes[1].end, 10);
});

test('フレームが 0 件でも 1 シーンとして返す', () => {
  assert.deepEqual(detectScenes([], 8), [{ start: 0, end: 8, score: 0 }]);
  assert.deepEqual(detectScenes([], 0), []);
});

test('frameQuality はノイズ画像でシャープ、単色でフラットになる', () => {
  const flat = frameQuality(fill(64, [128, 128, 128]), 8, 8);
  const noisy = frameQuality(noise(8, 8), 8, 8);
  assert.ok(noisy.sharp > flat.sharp);
  assert.ok(flat.contrast < 0.05);
  assert.ok(flat.exposure > 0.9, `露出スコア ${flat.exposure}`);
  const invalid = frameQuality(new Uint8ClampedArray(4), 1, 1);
  assert.deepEqual(invalid, { sharp: 0, contrast: 0, colorful: 0, exposure: 0 });
});

test('isInsideSegments', () => {
  const segs = [{ start: 1, end: 2 }];
  assert.equal(isInsideSegments(1.5, segs), true);
  assert.equal(isInsideSegments(2, segs), false);
  assert.equal(isInsideSegments(0.5, null), false);
});

function fill(pixels, [r, g, b]) {
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function noise(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const v = (i % 2) * 255;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
