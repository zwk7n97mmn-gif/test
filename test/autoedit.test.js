import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeClips,
  buildCutPlan,
  editSummary,
  fullClip,
  layoutClips,
  mergeTinyClips,
  projectCuesToTimeline,
  sanitizeClips,
  sourceToTimeline,
  splitAt,
  timelineDuration,
  timelineToSource,
} from '../src/core/autoedit.js';

const speech = [
  { start: 2, end: 5 },
  { start: 8, end: 10 },
];

test('AC-05: 無音カットのクリッププランを生成する', () => {
  const clips = buildCutPlan(speech, 12, { padStart: 0.2, padEnd: 0.3, minGap: 0.6, minClip: 0.4 });
  assert.equal(clips.length, 2);
  assert.ok(Math.abs(clips[0].start - 1.8) < 1e-6);
  assert.ok(Math.abs(clips[0].end - 5.3) < 1e-6);
  assert.ok(Math.abs(clips[1].start - 7.8) < 1e-6);
  assert.ok(Math.abs(clips[1].end - 10.3) < 1e-6);
  assert.ok(timelineDuration(clips) < 12);
});

test('発話が 0 件でも素材全体を 1 クリップとして返す（空にしない）', () => {
  const clips = buildCutPlan([], 30);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].end, 30);
});

test('素材長 0 では空配列', () => {
  assert.deepEqual(buildCutPlan(speech, 0), []);
});

test('パディングは素材の範囲を超えない', () => {
  const clips = buildCutPlan([{ start: 0, end: 10 }], 10, { padStart: 5, padEnd: 5 });
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].end, 10);
});

test('近接した発話は結合される', () => {
  const clips = buildCutPlan([{ start: 1, end: 2 }, { start: 2.3, end: 3 }], 10, {
    padStart: 0, padEnd: 0, minGap: 0.5,
  });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 1);
  assert.equal(clips[0].end, 3);
});

test('speed モードでは無音が倍速クリップとして残る', () => {
  const clips = buildCutPlan(speech, 12, { mode: 'speed', padStart: 0, padEnd: 0, speedFactor: 2, minClip: 0.1 });
  assert.equal(clips.filter((c) => c.speed > 1).length, 3); // 0-2, 5-8, 10-12
  const covered = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
  assert.ok(Math.abs(covered - 12) < 1e-6, '全区間が残ること');
  assert.ok(timelineDuration(clips) < 12);
});

test('mergeTinyClips は極小クリップを吸収し、空にならない', () => {
  const clips = mergeTinyClips(
    [
      { id: 'a', start: 0, end: 0.1, speed: 1, enabled: true },
      { id: 'b', start: 0.1, end: 3, speed: 1, enabled: true },
    ],
    0.4,
    3,
  );
  assert.equal(clips.length, 1);
  assert.equal(clips[0].end, 3);
  assert.equal(mergeTinyClips([], 0.4, 5).length, 1);
});

test('sanitizeClips は範囲外・逆転・不正 speed を正す', () => {
  const clips = sanitizeClips(
    [
      { start: -5, end: 3, speed: 0 },
      { start: 4, end: 4 },
      { start: 8, end: 20 },
      { start: 5, end: 2 },
    ],
    10,
  );
  assert.equal(clips.length, 2);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].speed, 0.25);
  assert.equal(clips[1].end, 10);
});

test('タイムライン尺と時刻変換が往復する', () => {
  const clips = [
    { id: 'a', start: 2, end: 5, speed: 1, enabled: true },
    { id: 'b', start: 8, end: 10, speed: 1, enabled: true },
  ];
  assert.equal(timelineDuration(clips), 5);
  const mapped = timelineToSource(clips, 3.5);
  assert.equal(mapped.clipIndex, 1);
  assert.ok(Math.abs(mapped.sourceTime - 8.5) < 1e-9);
  assert.ok(Math.abs(sourceToTimeline(clips, 8.5).timelineTime - 3.5) < 1e-9);
  assert.equal(sourceToTimeline(clips, 6).visible, false, '削除区間は不可視');
  assert.ok(Math.abs(sourceToTimeline(clips, 6).timelineTime - 3) < 1e-9, '直後のクリップ先頭へ丸める');
});

test('倍速クリップでも時刻変換が一致する', () => {
  const clips = [{ id: 'a', start: 0, end: 10, speed: 2, enabled: true }];
  assert.equal(timelineDuration(clips), 5);
  assert.equal(timelineToSource(clips, 2.5).sourceTime, 5);
  assert.equal(sourceToTimeline(clips, 5).timelineTime, 2.5);
});

test('無効クリップは尺に含まれない', () => {
  const clips = [
    { id: 'a', start: 0, end: 4, speed: 1, enabled: false },
    { id: 'b', start: 4, end: 6, speed: 1, enabled: true },
  ];
  assert.equal(activeClips(clips).length, 1);
  assert.equal(timelineDuration(clips), 2);
  assert.equal(timelineToSource(clips, 0).sourceTime, 4);
});

test('クリップが 0 件のときの境界値', () => {
  assert.equal(timelineDuration([]), 0);
  assert.equal(timelineToSource([], 1), null);
  assert.deepEqual(sourceToTimeline([], 1), { timelineTime: 0, visible: false });
  assert.deepEqual(layoutClips([]), []);
});

test('splitAt はクリップを 2 分割する（端では分割しない）', () => {
  const clips = fullClip(10);
  const split = splitAt(clips, 4);
  assert.equal(split.length, 2);
  assert.equal(split[0].end, 4);
  assert.equal(split[1].start, 4);
  assert.notEqual(split[0].id, split[1].id);
  assert.equal(splitAt(clips, 0).length, 1);
  assert.equal(splitAt(clips, 10).length, 1);
});

test('AC-04/AC-05: 字幕はカット結果に合わせて写像される', () => {
  const clips = [
    { id: 'a', start: 0, end: 5, speed: 1, enabled: true },
    { id: 'b', start: 10, end: 15, speed: 1, enabled: true },
  ];
  const cues = [
    { id: 'c1', start: 1, end: 2, text: 'A' },
    { id: 'c2', start: 6, end: 7, text: '削除区間' },
    { id: 'c3', start: 11, end: 12, text: 'B' },
    { id: 'c4', start: 4, end: 11, text: 'またがり' },
  ];
  const projected = projectCuesToTimeline(cues, clips);
  const ids = projected.map((c) => c.id);
  assert.ok(!ids.includes('c2'), '削除区間の字幕は除外される');
  const c3 = projected.find((c) => c.id === 'c3');
  assert.equal(c3.start, 6);
  assert.equal(c3.end, 7);
  // 削除区間をまたぐ字幕は、可視部分の合計時間だけ連続表示される（つなぎ目でちらつかせない）
  const spans = projected.filter((c) => c.id === 'c4');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 4);
  assert.equal(spans[0].end, 6, '可視部分 1 秒 + 1 秒 = 2 秒');
});

test('タイムライン上で連続しないクリップをまたぐ字幕は分割される', () => {
  const clips = [
    { id: 'a', start: 0, end: 5, speed: 1, enabled: true },
    { id: 'b', start: 5, end: 10, speed: 2, enabled: true },
  ];
  // 速度が変わるため、またがる字幕は速度ごとに別の区間として写像される
  const projected = projectCuesToTimeline([{ id: 'c', start: 4, end: 7, text: 'x' }], clips);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].start, 4);
  assert.equal(projected[0].end, 6, '後半 2 秒は 2 倍速で 1 秒になる');
});

test('editSummary は削減率を返す', () => {
  const summary = editSummary([{ id: 'a', start: 0, end: 5, speed: 1, enabled: true }], 10);
  assert.equal(summary.removedDuration, 5);
  assert.equal(summary.removedRatio, 0.5);
  assert.equal(summary.clipCount, 1);
  assert.equal(editSummary([], 0).removedRatio, 0);
});
