import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeClips,
  buildCutPlanForClips,
  cutClipBySpeech,
  durationLookup,
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

/** テスト用の素材定義 */
const VIDEO = { id: 'v1', kind: 'video', duration: 12, width: 1920, height: 1080, fps: 30, hasAudio: true, name: 'v', size: 0, type: '' };
const VIDEO2 = { id: 'v2', kind: 'video', duration: 8, width: 1920, height: 1080, fps: 30, hasAudio: true, name: 'v2', size: 0, type: '' };
const IMAGE = { id: 'i1', kind: 'image', duration: 3, width: 1000, height: 1000, fps: 30, hasAudio: false, name: 'i', size: 0, type: '' };

const speech = [
  { start: 2, end: 5 },
  { start: 8, end: 10 },
];

function clip(assetId, start, end, extra = {}) {
  return { id: `c_${assetId}_${start}`, assetId, start, end, speed: 1, enabled: true, ...extra };
}

test('durationLookup は数値・関数・素材配列を受け付ける', () => {
  assert.equal(durationLookup(10)('any'), 10);
  assert.equal(durationLookup((id) => (id === 'x' ? 4 : 0))('x'), 4);
  assert.equal(durationLookup([VIDEO, IMAGE])('i1'), 3);
  assert.equal(durationLookup([VIDEO])('missing'), 0);
});

test('AC-05: 無音カットのクリッププランを生成する', () => {
  const clips = buildCutPlanForClips([clip('v1', 0, 12)], {
    assets: [VIDEO],
    speechByAsset: { v1: speech },
    options: { padStart: 0.2, padEnd: 0.3, minGap: 0.6, minClip: 0.4 },
  });
  assert.equal(clips.length, 2);
  assert.ok(Math.abs(clips[0].start - 1.8) < 1e-6);
  assert.ok(Math.abs(clips[0].end - 5.3) < 1e-6);
  assert.ok(Math.abs(clips[1].start - 7.8) < 1e-6);
  assert.ok(Math.abs(clips[1].end - 10.3) < 1e-6);
  assert.ok(clips.every((c) => c.assetId === 'v1'));
  assert.ok(timelineDuration(clips) < 12);
});

test('発話が 0 件の素材はそのまま 1 クリップとして残る', () => {
  const clips = buildCutPlanForClips([clip('v1', 0, 12)], { assets: [VIDEO], speechByAsset: {} });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].end, 12);
});

test('画像クリップは自動カットで削られない', () => {
  const clips = buildCutPlanForClips([clip('v1', 0, 12), clip('i1', 0, 3)], {
    assets: [VIDEO, IMAGE],
    speechByAsset: { v1: speech },
  });
  const imageClips = clips.filter((c) => c.assetId === 'i1');
  assert.equal(imageClips.length, 1);
  assert.equal(imageClips[0].end - imageClips[0].start, 3, '画像の表示秒数が保たれる');
  assert.ok(clips.filter((c) => c.assetId === 'v1').length >= 2, '動画側はカットされる');
});

test('複数の動画素材それぞれの発話でカットされる', () => {
  const clips = buildCutPlanForClips([clip('v1', 0, 12), clip('v2', 0, 8)], {
    assets: [VIDEO, VIDEO2],
    speechByAsset: { v1: [{ start: 1, end: 3 }], v2: [{ start: 5, end: 6 }] },
    options: { padStart: 0, padEnd: 0, minClip: 0.1 },
  });
  const v1 = clips.filter((c) => c.assetId === 'v1');
  const v2 = clips.filter((c) => c.assetId === 'v2');
  assert.equal(v1.length, 1);
  assert.deepEqual([v1[0].start, v1[0].end], [1, 3]);
  assert.equal(v2.length, 1);
  assert.deepEqual([v2[0].start, v2[0].end], [5, 6]);
  assert.equal(clips.indexOf(v1[0]) < clips.indexOf(v2[0]), true, '素材の順序が保たれる');
});

test('クリップ範囲の外にある発話は無視される', () => {
  const result = cutClipBySpeech(clip('v1', 4, 8), [{ start: 0, end: 2 }, { start: 5, end: 6 }], {
    padStart: 0, padEnd: 0, minGap: 0.6, mode: 'cut',
  });
  assert.equal(result.length, 1);
  assert.deepEqual([result[0].start, result[0].end], [5, 6]);
});

test('speed モードでは無音が倍速クリップとして残る', () => {
  const clips = buildCutPlanForClips([clip('v1', 0, 12)], {
    assets: [VIDEO],
    speechByAsset: { v1: speech },
    options: { mode: 'speed', padStart: 0, padEnd: 0, speedFactor: 2, minClip: 0.1 },
  });
  assert.equal(clips.filter((c) => c.speed > 1).length, 3); // 0-2, 5-8, 10-12
  const covered = clips.reduce((sum, c) => sum + (c.end - c.start), 0);
  assert.ok(Math.abs(covered - 12) < 1e-6, '全区間が残ること');
  assert.ok(timelineDuration(clips) < 12);
});

test('mergeTinyClips は同じ素材の極小クリップだけを吸収する', () => {
  const merged = mergeTinyClips(
    [clip('v1', 0, 0.1), clip('v1', 0.1, 3)],
    0.4,
    [VIDEO],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, 3);

  // 素材が違えば結合しない（別の映像がつながってしまうため）
  const across = mergeTinyClips([clip('v1', 0, 0.1), clip('v2', 0, 3)], 0.4, [VIDEO, VIDEO2]);
  assert.equal(across.length, 2);
});

test('sanitizeClips は範囲外・逆転・不正 speed・存在しない素材を除去する', () => {
  const clips = sanitizeClips(
    [
      { assetId: 'v1', start: -5, end: 3, speed: 0 },
      { assetId: 'v1', start: 4, end: 4 },
      { assetId: 'v1', start: 8, end: 20 },
      { assetId: 'v1', start: 5, end: 2 },
      { assetId: 'missing', start: 0, end: 5 },
    ],
    [VIDEO],
  );
  assert.equal(clips.length, 2);
  assert.equal(clips[0].start, 0);
  assert.equal(clips[0].speed, 0.25);
  assert.equal(clips[1].end, 12);
});

test('タイムライン尺と時刻変換が往復し、素材も分かる', () => {
  const clips = [clip('v1', 2, 5), clip('v2', 1, 3)];
  assert.equal(timelineDuration(clips), 5);
  const mapped = timelineToSource(clips, 3.5);
  assert.equal(mapped.clipIndex, 1);
  assert.equal(mapped.assetId, 'v2');
  assert.ok(Math.abs(mapped.sourceTime - 1.5) < 1e-9);
  assert.ok(Math.abs(sourceToTimeline(clips, 1.5, 'v2').timelineTime - 3.5) < 1e-9);
});

test('sourceToTimeline は素材を指定して曖昧さを避ける', () => {
  const clips = [clip('v1', 0, 4), clip('v2', 0, 4)];
  // 同じ「2 秒」でも素材が違えばタイムライン上の位置は違う
  assert.equal(sourceToTimeline(clips, 2, 'v1').timelineTime, 2);
  assert.equal(sourceToTimeline(clips, 2, 'v2').timelineTime, 6);
});

test('倍速クリップでも時刻変換が一致する', () => {
  const clips = [clip('v1', 0, 10, { speed: 2 })];
  assert.equal(timelineDuration(clips), 5);
  assert.equal(timelineToSource(clips, 2.5).sourceTime, 5);
  assert.equal(sourceToTimeline(clips, 5, 'v1').timelineTime, 2.5);
});

test('無効クリップは尺に含まれない', () => {
  const clips = [clip('v1', 0, 4, { enabled: false }), clip('v1', 4, 6)];
  assert.equal(activeClips(clips).length, 1);
  assert.equal(timelineDuration(clips), 2);
  assert.equal(timelineToSource(clips, 0).sourceTime, 4);
});

test('クリップが 0 件のときの境界値', () => {
  assert.equal(timelineDuration([]), 0);
  assert.equal(timelineToSource([], 1), null);
  assert.deepEqual(sourceToTimeline([], 1), { timelineTime: 0, visible: false });
  assert.deepEqual(layoutClips([]), []);
  assert.deepEqual(buildCutPlanForClips([], { assets: [], speechByAsset: {} }), []);
});

test('fullClip は素材 ID を保持する', () => {
  const clips = fullClip(10, 'v1');
  assert.equal(clips[0].assetId, 'v1');
  assert.equal(clips[0].end, 10);
});

test('splitAt はクリップを 2 分割する（端では分割しない）', () => {
  const clips = fullClip(10, 'v1');
  const split = splitAt(clips, 4);
  assert.equal(split.length, 2);
  assert.equal(split[0].end, 4);
  assert.equal(split[1].start, 4);
  assert.notEqual(split[0].id, split[1].id);
  assert.equal(splitAt(clips, 0).length, 1);
  assert.equal(splitAt(clips, 10).length, 1);
});

test('splitAt は素材を指定するとその素材のクリップだけを割る', () => {
  const clips = [clip('v1', 0, 4), clip('v2', 0, 4)];
  const split = splitAt(clips, 2, 'v2');
  assert.equal(split.length, 3);
  assert.equal(split.filter((c) => c.assetId === 'v1').length, 1);
  assert.equal(split.filter((c) => c.assetId === 'v2').length, 2);
});

test('AC-04/AC-05: 字幕はカット結果に合わせて写像される', () => {
  const clips = [clip('v1', 0, 5), clip('v1', 10, 15)];
  const cues = [
    { id: 'c1', assetId: 'v1', start: 1, end: 2, text: 'A' },
    { id: 'c2', assetId: 'v1', start: 6, end: 7, text: '削除区間' },
    { id: 'c3', assetId: 'v1', start: 11, end: 12, text: 'B' },
  ];
  const projected = projectCuesToTimeline(cues, clips);
  const ids = projected.map((c) => c.id);
  assert.ok(!ids.includes('c2'), '削除区間の字幕は除外される');
  const c3 = projected.find((c) => c.id === 'c3');
  assert.equal(c3.start, 6);
  assert.equal(c3.end, 7);
});

test('字幕は別素材のクリップには載らない', () => {
  const clips = [clip('v1', 0, 5), clip('v2', 0, 5)];
  const cues = [{ id: 'c1', assetId: 'v2', start: 1, end: 2, text: 'v2 の字幕' }];
  const projected = projectCuesToTimeline(cues, clips);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].start, 6, 'v2 クリップ側（5秒以降）に載る');
});

test('editSummary は削減率を返す', () => {
  const summary = editSummary([clip('v1', 0, 5)], 10);
  assert.equal(summary.removedDuration, 5);
  assert.equal(summary.removedRatio, 0.5);
  assert.equal(summary.clipCount, 1);
  assert.equal(editSummary([], 0).removedRatio, 0);
});
