import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_DEFAULTS,
  buildAudioPlan,
  buildDuckingAutomation,
  describeAudioPlan,
  evaluateAutomation,
  fadeGainAt,
  normalizationGainDb,
  resolveFades,
} from '../src/core/audio.js';

test('AC-06: 目標ラウドネスに合わせたゲインを返す', () => {
  const result = normalizationGainDb({ integratedDb: -26, peakDb: -12 }, -16);
  assert.equal(result.gainDb, 10);
  assert.equal(result.limitedByPeak, false);
});

test('ピークが高い場合はクリップ回避を優先する', () => {
  const result = normalizationGainDb({ integratedDb: -26, peakDb: -3 }, -16);
  assert.equal(result.gainDb, 2, 'ヘッドルーム -1dB を守る');
  assert.equal(result.limitedByPeak, true);
  assert.match(result.reason, /クリップ/);
});

test('ゲインは上下限でクランプされる', () => {
  assert.equal(normalizationGainDb({ integratedDb: -50, peakDb: -60 }, -16).gainDb, 18);
  assert.equal(normalizationGainDb({ integratedDb: -2, peakDb: -30 }, -16).gainDb, -12);
});

test('ほぼ無音の素材では正規化しない', () => {
  const result = normalizationGainDb({ integratedDb: -70, peakDb: -80 }, -16);
  assert.equal(result.gainDb, 0);
  assert.match(result.reason, /見送り/);
});

test('AC-06: ダッキング自動化点列を生成する', () => {
  const points = buildDuckingAutomation([{ start: 2, end: 4 }], 10, { duckDb: -12, attack: 0.15, release: 0.4 });
  assert.equal(points[0].time, 0);
  assert.equal(points[0].gain, 1);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].time >= points[i - 1].time, '時刻が単調増加でない');
  }
  const ducked = evaluateAutomation(points, 3);
  assert.ok(Math.abs(ducked - Math.pow(10, -12 / 20)) < 1e-6, `発話中のゲイン ${ducked}`);
  assert.ok(evaluateAutomation(points, 0.5) > 0.99, '発話外は等倍');
  assert.ok(evaluateAutomation(points, 9) > 0.99);
});

test('発話 0 件・尺 0 でもダッキングは壊れない', () => {
  assert.deepEqual(buildDuckingAutomation([], 10).slice(0, 1), [{ time: 0, gain: 1 }]);
  assert.deepEqual(buildDuckingAutomation([{ start: 0, end: 1 }], 0), [{ time: 0, gain: 1 }]);
  assert.equal(evaluateAutomation([], 5), 1);
});

test('近接する発話はまとめてダッキングされる（ポンピング防止）', () => {
  const points = buildDuckingAutomation([{ start: 1, end: 2 }, { start: 2.2, end: 3 }], 10, { attack: 0.2, release: 0.5 });
  const between = evaluateAutomation(points, 2.1);
  assert.ok(between < 0.5, `隙間で戻ってしまっている: ${between}`);
});

test('AC-06: フェードは尺に応じて安全な値へ丸められる', () => {
  assert.deepEqual(resolveFades(10, 10, 3), { fadeIn: 1, fadeOut: 1 });
  assert.deepEqual(resolveFades(0.5, 1, 30), { fadeIn: 0.5, fadeOut: 1 });
  assert.deepEqual(resolveFades(1, 1, 0), { fadeIn: 0, fadeOut: 0 });
});

test('fadeGainAt は 0→1→0 を描く', () => {
  assert.equal(fadeGainAt(0, 10, 2, 2), 0);
  assert.equal(fadeGainAt(1, 10, 2, 2), 0.5);
  assert.equal(fadeGainAt(5, 10, 2, 2), 1);
  assert.equal(fadeGainAt(10, 10, 2, 2), 0);
  assert.equal(fadeGainAt(5, 0, 2, 2), 1, '尺 0 では常に 1');
});

test('buildAudioPlan は設定と解析結果から一貫したプランを返す', () => {
  const plan = buildAudioPlan(
    { ...AUDIO_DEFAULTS, targetDb: -16, duck: true, duckDb: -10, fadeIn: 1, fadeOut: 1 },
    { integratedDb: -24, peakDb: -6 },
    [{ start: 1, end: 3 }],
    10,
  );
  assert.equal(plan.normalizeGainDb, 5);
  assert.equal(plan.duck, true);
  assert.ok(plan.duckAutomation.length > 2);
  assert.match(describeAudioPlan(plan), /BGM/);
});

test('正規化を無効にするとゲイン 0', () => {
  const plan = buildAudioPlan({ ...AUDIO_DEFAULTS, normalize: false }, { integratedDb: -30, peakDb: -20 }, [], 5);
  assert.equal(plan.normalizeGainDb, 0);
  assert.match(describeAudioPlan(plan), /音量調整なし/);
});
