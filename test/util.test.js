import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amplitudeToDb,
  clamp,
  describeError,
  ellipsize,
  formatBytes,
  formatTime,
  invertSegments,
  normalizeSegments,
  parseTime,
  percentile,
  speakableTime,
} from '../src/core/util.js';

test('clamp は NaN を最小値へ落とす', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 3, 10), 3);
  assert.equal(clamp(undefined, 3, 10), 3);
});

test('formatTime は境界値でも壊れない', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(61.5), '01:01');
  assert.equal(formatTime(61.5, { ms: true }), '01:01.500');
  assert.equal(formatTime(3661, { hours: 'always' }), '01:01:01');
  assert.equal(formatTime(3661.25, { ms: true, comma: true }), '01:01:01,250');
  assert.equal(formatTime(-5), '00:00');
  assert.equal(formatTime(Number.NaN), '00:00');
  assert.equal(formatTime(Infinity), '00:00');
});

test('parseTime は各種書式を解釈し、不正値は null', () => {
  assert.equal(parseTime('00:00:01,500'), 1.5);
  assert.equal(parseTime('01:02.250'), 62.25);
  assert.equal(parseTime('62'), 62);
  assert.equal(parseTime(12.5), 12.5);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('1:2:3:4'), null);
  assert.equal(parseTime(null), null);
});

test('formatTime と parseTime は往復する', () => {
  for (const sec of [0, 0.5, 1.234, 59.999, 60, 3599.5, 7322.125]) {
    const text = formatTime(sec, { ms: true, hours: 'always' });
    assert.ok(Math.abs(parseTime(text) - sec) < 0.001, `${sec} の往復に失敗: ${text}`);
  }
});

test('percentile は空配列でも 0 を返す', () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});

test('normalizeSegments は重なりと逆転を解消する', () => {
  const input = [
    { start: 3, end: 4 },
    { start: 0, end: 2 },
    { start: 1.5, end: 2.5 },
    { start: 9, end: 9 },
    { start: 5, end: 4 },
  ];
  assert.deepEqual(normalizeSegments(input), [
    { start: 0, end: 2.5 },
    { start: 3, end: 4 },
  ]);
});

test('normalizeSegments は mergeGap で近接区間を結合する', () => {
  const result = normalizeSegments([{ start: 0, end: 1 }, { start: 1.4, end: 2 }], { mergeGap: 0.5 });
  assert.deepEqual(result, [{ start: 0, end: 2 }]);
});

test('invertSegments は補集合を返す（0件・全域を含む）', () => {
  assert.deepEqual(invertSegments([], 10), [{ start: 0, end: 10 }]);
  assert.deepEqual(invertSegments([{ start: 0, end: 10 }], 10), []);
  assert.deepEqual(invertSegments([{ start: 2, end: 4 }], 10), [
    { start: 0, end: 2 },
    { start: 4, end: 10 },
  ]);
  assert.deepEqual(invertSegments([{ start: 2, end: 4 }], 0), []);
});

test('amplitudeToDb は 0 でも -Infinity にならない', () => {
  assert.equal(amplitudeToDb(0), -100);
  assert.equal(Math.round(amplitudeToDb(1)), 0);
  assert.equal(Math.round(amplitudeToDb(0.5)), -6);
});

test('formatBytes / speakableTime / ellipsize', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(speakableTime(0), '0秒');
  assert.equal(speakableTime(65), '1分5秒');
  assert.equal(ellipsize('あいうえお', 3), 'あい…');
  assert.equal(ellipsize('あい', 5), 'あい');
});

test('describeError は日本語の説明に変換する', () => {
  const abort = new Error('x');
  abort.name = 'AbortError';
  assert.match(describeError(abort), /キャンセル/);
  assert.match(describeError(new Error('codec not supported')), /コーデック/);
  assert.match(describeError(null), /不明なエラー/);
});
