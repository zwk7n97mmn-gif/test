import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_DEFAULT_DURATION,
  assetsFromLegacyMedia,
  clipsFromAssets,
  createImageAsset,
  createVideoAsset,
  findAsset,
  hasAnyAudio,
  moveAsset,
  primaryAsset,
  removeAsset,
  sanitizeAsset,
  sanitizeAssets,
  setImageDuration,
  totalAssetDuration,
} from '../src/core/assets.js';

test('動画素材を作れる', () => {
  const asset = createVideoAsset({ name: 'a.mp4', duration: 12.5, width: 1920, height: 1080, fps: 30, hasAudio: true });
  assert.equal(asset.kind, 'video');
  assert.equal(asset.duration, 12.5);
  assert.equal(asset.hasAudio, true);
  assert.ok(asset.id.startsWith('as_'));
});

test('画像素材は既定 3 秒で、音声を持たない', () => {
  const asset = createImageAsset({ name: 'p.png', width: 1000, height: 800 });
  assert.equal(asset.kind, 'image');
  assert.equal(asset.duration, IMAGE_DEFAULT_DURATION);
  assert.equal(asset.hasAudio, false);
});

test('画像の表示秒数は指定でき、範囲外はクランプされる', () => {
  assert.equal(createImageAsset({ name: 'p', width: 10, height: 10, duration: 8 }).duration, 8);
  assert.equal(createImageAsset({ name: 'p', width: 10, height: 10, duration: 0.1 }).duration, 0.5);
  assert.equal(createImageAsset({ name: 'p', width: 10, height: 10, duration: 999 }).duration, 30);
});

test('sanitizeAsset は不正な素材を弾く', () => {
  assert.equal(sanitizeAsset(null), null);
  assert.equal(sanitizeAsset({ kind: 'video', duration: 0, width: 100, height: 100 }), null, '長さ 0');
  assert.equal(sanitizeAsset({ kind: 'video', duration: 5, width: 0, height: 100 }), null, '幅 0');
  assert.equal(sanitizeAsset({ kind: 'video', duration: 5, width: 100, height: 100 }).fps, 30, '既定 fps');
});

test('sanitizeAssets は重複 ID を落とす', () => {
  const list = sanitizeAssets([
    { id: 'a', kind: 'video', duration: 5, width: 10, height: 10 },
    { id: 'a', kind: 'video', duration: 9, width: 10, height: 10 },
    { id: 'b', kind: 'image', duration: 3, width: 10, height: 10 },
    null,
  ]);
  assert.deepEqual(list.map((a) => a.id), ['a', 'b']);
  assert.equal(list[0].duration, 5, '最初のものが残る');
});

test('primaryAsset は最初の動画を返し、動画が無ければ先頭を返す', () => {
  const image = createImageAsset({ name: 'p', width: 10, height: 10 });
  const video = createVideoAsset({ name: 'v', duration: 5, width: 10, height: 10 });
  assert.equal(primaryAsset([image, video]).id, video.id);
  assert.equal(primaryAsset([image]).id, image.id);
  assert.equal(primaryAsset([]), null);
});

test('findAsset / hasAnyAudio / totalAssetDuration', () => {
  const video = createVideoAsset({ name: 'v', duration: 5, width: 10, height: 10, hasAudio: true });
  const image = createImageAsset({ name: 'p', width: 10, height: 10 });
  const assets = [video, image];
  assert.equal(findAsset(assets, video.id).name, 'v');
  assert.equal(findAsset(assets, 'なし'), null);
  assert.equal(hasAnyAudio(assets), true);
  assert.equal(hasAnyAudio([image]), false);
  assert.equal(totalAssetDuration(assets), 8);
});

test('clipsFromAssets は素材 1 件につき 1 クリップを作る', () => {
  const assets = [
    createVideoAsset({ name: 'v', duration: 6, width: 10, height: 10 }),
    createImageAsset({ name: 'p', width: 10, height: 10 }),
  ];
  const clips = clipsFromAssets(assets);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((c) => c.end), [6, 3]);
  assert.deepEqual(clips.map((c) => c.assetId), assets.map((a) => a.id));
  assert.ok(clips.every((c) => c.enabled && c.speed === 1));
});

test('setImageDuration は素材とクリップの両方を追従させる', () => {
  const image = createImageAsset({ name: 'p', width: 10, height: 10 });
  const assets = [image];
  const clips = clipsFromAssets(assets);
  const result = setImageDuration(assets, clips, image.id, 5);
  assert.equal(result.assets[0].duration, 5);
  assert.equal(result.clips[0].end, 5);

  // 動画には効かない（誤って尺を書き換えないこと）
  const video = createVideoAsset({ name: 'v', duration: 9, width: 10, height: 10 });
  const untouched = setImageDuration([video], clipsFromAssets([video]), video.id, 2);
  assert.equal(untouched.assets[0].duration, 9);
});

test('removeAsset は参照しているクリップも取り除く', () => {
  const a = createVideoAsset({ name: 'a', duration: 5, width: 10, height: 10 });
  const b = createImageAsset({ name: 'b', width: 10, height: 10 });
  const clips = clipsFromAssets([a, b]);
  const result = removeAsset([a, b], clips, a.id);
  assert.equal(result.assets.length, 1);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].assetId, b.id);
});

test('moveAsset は並び順を入れ替え、クリップも同じ順序に揃える', () => {
  const a = createVideoAsset({ name: 'a', duration: 5, width: 10, height: 10 });
  const b = createImageAsset({ name: 'b', width: 10, height: 10 });
  const c = createImageAsset({ name: 'c', width: 10, height: 10 });
  const assets = [a, b, c];
  const clips = clipsFromAssets(assets);

  const moved = moveAsset(assets, clips, 2, 0);
  assert.deepEqual(moved.assets.map((x) => x.name), ['c', 'a', 'b']);
  assert.deepEqual(moved.clips.map((x) => x.assetId), [c.id, a.id, b.id]);

  // 範囲外は何もしない
  const noop = moveAsset(assets, clips, 9, 0);
  assert.deepEqual(noop.assets.map((x) => x.name), ['a', 'b', 'c']);
});

test('同じ素材のクリップが複数あっても並べ替えで順序が壊れない', () => {
  const a = createVideoAsset({ name: 'a', duration: 10, width: 10, height: 10 });
  const b = createImageAsset({ name: 'b', width: 10, height: 10 });
  const clips = [
    { id: 'c1', assetId: a.id, start: 0, end: 4, speed: 1, enabled: true },
    { id: 'c2', assetId: a.id, start: 5, end: 8, speed: 1, enabled: true },
    { id: 'c3', assetId: b.id, start: 0, end: 3, speed: 1, enabled: true },
  ];
  const moved = moveAsset([a, b], clips, 1, 0);
  assert.deepEqual(moved.clips.map((c) => c.id), ['c3', 'c1', 'c2'], '同一素材内の順序は保たれる');
});

test('旧 media から素材へ移行できる', () => {
  const assets = assetsFromLegacyMedia({ name: 'old.mp4', duration: 20, width: 1280, height: 720, fps: 30, hasAudio: true });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].kind, 'video');
  assert.deepEqual(assetsFromLegacyMedia(null), []);
});
