import test from 'node:test';
import assert from 'node:assert/strict';
import { ASPECTS, FITS, MAX_OUTPUT_SIZE, computeFitRect, describeFraming, evenSize, resolveOutputSize, sizingSource } from '../src/core/layout.js';

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

test('evenSize は偶数へ丸める（エンコーダが奇数を嫌うため）', () => {
  assert.equal(evenSize(101), 102);
  assert.equal(evenSize(100), 100);
  assert.equal(evenSize(-5), 2);
  assert.equal(evenSize(17, 16), 18);
});

test('元のままの出力は素材の縦横比を保つ', () => {
  const size = resolveOutputSize({ aspect: 'source' }, LANDSCAPE);
  assert.equal(size.width / size.height > 1.7, true);
  assert.equal(size.width, 1920);
  assert.equal(size.height, 1080);
});

test('AC-19: 横素材から縦 9:16 の出力サイズを作れる', () => {
  const size = resolveOutputSize({ aspect: '9:16' }, LANDSCAPE);
  assert.ok(size.height > size.width, '縦長になる');
  assert.ok(Math.abs(size.width / size.height - 9 / 16) < 0.01);
  assert.equal(size.height, 1920);
  assert.equal(size.width, 1080);
});

test('縦素材から横 16:9 の出力サイズを作れる', () => {
  const size = resolveOutputSize({ aspect: '16:9' }, PORTRAIT);
  assert.ok(size.width > size.height);
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.01);
});

test('正方形・4:5 も作れる', () => {
  const square = resolveOutputSize({ aspect: '1:1' }, LANDSCAPE);
  assert.equal(square.width, square.height);
  const portrait45 = resolveOutputSize({ aspect: '4:5' }, LANDSCAPE);
  assert.ok(Math.abs(portrait45.width / portrait45.height - 0.8) < 0.01);
});

test('出力は素材より大きくならない（引き伸ばしても画質は上がらない）', () => {
  const size = resolveOutputSize({ aspect: '9:16' }, { width: 640, height: 360 });
  assert.ok(Math.max(size.width, size.height) <= 640);
});

test('maxSize で長辺の上限を抑えられる', () => {
  const size = resolveOutputSize({ aspect: 'source', maxSize: 720 }, { width: 3840, height: 2160 });
  assert.equal(Math.max(size.width, size.height), 720);
});

test('不正な指定でも既定値で成立する', () => {
  const size = resolveOutputSize({ aspect: '存在しない' }, { width: 0, height: 0 });
  assert.ok(size.width >= 16 && size.height >= 16);
  assert.ok(Number.isFinite(size.ratio));
});

test('contain は全体が収まり、余白が出る', () => {
  const rect = computeFitRect(1920, 1080, 1080, 1920, 'contain');
  assert.ok(rect.width <= 1080 + 1 && rect.height <= 1920 + 1);
  assert.equal(rect.letterboxed, true);
  assert.equal(rect.cropped, false);
  assert.ok(Math.abs(rect.x) < 1, '横は端まで使う');
  assert.ok(rect.y > 0, '上下に余白');
});

test('cover は画面を埋め、はみ出す', () => {
  const rect = computeFitRect(1920, 1080, 1080, 1920, 'cover');
  assert.ok(rect.width >= 1080 - 1 && rect.height >= 1920 - 1);
  assert.equal(rect.cropped, true);
  assert.equal(rect.letterboxed, false);
  assert.ok(rect.x < 0, '左右がはみ出す（＝切り取られる）');
});

test('縦横比が同じなら余白も切り取りも起きない', () => {
  const rect = computeFitRect(1920, 1080, 1280, 720, 'contain');
  assert.equal(rect.cropped, false);
  assert.equal(rect.letterboxed, false);
  assert.ok(Math.abs(rect.width - 1280) < 1);
});

test('中央に配置される', () => {
  const rect = computeFitRect(100, 100, 300, 500, 'contain');
  assert.ok(Math.abs(rect.x + rect.width / 2 - 150) < 1e-6);
  assert.ok(Math.abs(rect.y + rect.height / 2 - 250) < 1e-6);
});

test('0 や負の寸法でも壊れない', () => {
  const rect = computeFitRect(0, 0, 0, 0, 'cover');
  assert.ok(Number.isFinite(rect.width) && rect.width > 0);
  assert.ok(Number.isFinite(rect.scale));
});

test('describeFraming は状況を日本語で説明する', () => {
  assert.match(describeFraming(1920, 1080, { aspect: '9:16', fit: 'contain' }), /余白/);
  assert.match(describeFraming(1920, 1080, { aspect: '9:16', fit: 'cover' }), /% が映ります/);
  assert.match(describeFraming(1920, 1080, { aspect: 'source', fit: 'contain' }), /ぴったり/);
});

test('選択肢の定義が揃っている', () => {
  assert.deepEqual(Object.keys(ASPECTS), ['source', '9:16', '1:1', '4:5', '16:9']);
  assert.deepEqual(Object.keys(FITS), ['contain', 'cover']);
  for (const aspect of Object.values(ASPECTS)) {
    assert.ok(aspect.label && aspect.hint, 'ラベルと説明がある');
  }
});


/* ------------------------------------------------------------------ */
/* 基準サイズ（画質の担保）                                            */
/* ------------------------------------------------------------------ */

const asset = (width, height, kind = 'video') => ({ id: `a${width}x${height}`, kind, width, height, duration: 3 });

test('sizingSource は縦横比を先頭素材、解像度を最大の動画素材に合わせる', () => {
  // 先頭が小さい画像でも、後ろの 1080x1920 動画の解像度まで引き上げる
  const src = sizingSource([asset(720, 1280, 'image'), asset(1080, 1920)]);
  assert.equal(Math.round(src.width), 1080);
  assert.equal(Math.round(src.height), 1920);
});

test('sizingSource は動画があれば縦横比も動画に合わせる', () => {
  // 2:3 の写真が先頭・9:16 の動画が 2 番目でも、どちらとも一致しない
  // 中途半端な出力（1280x1920 など）を作らない
  const src = sizingSource([asset(1280, 1920, 'image'), asset(1080, 1920)]);
  assert.equal(Math.round(src.width), 1080);
  assert.equal(Math.round(src.height), 1920);
});

test('sizingSource は先頭の動画の縦横比を、最大の動画の解像度で返す', () => {
  // 先頭 16:9 の 1280x720、2 番目に長辺 3840 の動画 → 3840x2160
  const src = sizingSource([asset(1280, 720), asset(3840, 1600)]);
  assert.equal(Math.round(src.width), 3840);
  assert.equal(Math.round(src.height), 2160);
});

test('sizingSource は画像だけを理由に動画を引き伸ばさない', () => {
  // 1080p 動画 + 4K 写真 → 出力は動画に合わせた 1080x1920
  const src = sizingSource([asset(1080, 1920), asset(2160, 3840, 'image')]);
  assert.equal(Math.round(src.width), 1080);
  assert.equal(Math.round(src.height), 1920);
});

test('sizingSource は動画が無ければ画像の解像度で決める', () => {
  const src = sizingSource([asset(1080, 1920, 'image'), asset(2160, 3840, 'image')]);
  assert.equal(Math.round(src.width), 2160);
  assert.equal(Math.round(src.height), 3840);
});

test('sizingSource は素材が無ければ既定を返す', () => {
  assert.deepEqual(sizingSource([]), { width: 1280, height: 720 });
  assert.deepEqual(sizingSource(null), { width: 1280, height: 720 });
  // 寸法が壊れている素材は無視する
  assert.deepEqual(sizingSource([{ id: 'x', width: 0, height: 0 }]), { width: 1280, height: 720 });
});

test('縦素材のみなら既定設定で解像度がそのまま保たれる', () => {
  for (const [w, h] of [[1080, 1920], [720, 1280], [1440, 2560]]) {
    const src = sizingSource([asset(w, h)]);
    const out = resolveOutputSize({ aspect: 'source' }, src);
    assert.equal(out.width, w, `${w}x${h} の幅が保たれる`);
    assert.equal(out.height, h, `${w}x${h} の高さが保たれる`);
  }
});

test('4K 縦素材も既定では縮小されない', () => {
  const out = resolveOutputSize({ aspect: 'source' }, sizingSource([asset(2160, 3840)]));
  assert.equal(out.width, 2160);
  assert.equal(out.height, 3840);
});

test('画質を指定したときだけ長辺が絞られる', () => {
  const src = sizingSource([asset(2160, 3840)]);
  assert.equal(resolveOutputSize({ aspect: 'source', maxSize: 1080 }, src).height, 1080);
  assert.equal(resolveOutputSize({ aspect: 'source', maxSize: 1920 }, src).height, 1920);
});

test('出力の長辺は 4K を超えない', () => {
  const out = resolveOutputSize({ aspect: 'source', maxSize: 99999 }, sizingSource([asset(8000, 6000)]));
  assert.equal(Math.max(out.width, out.height), MAX_OUTPUT_SIZE);
});

test('縦素材を 9:16 にしても等倍のまま（余白も切り取りも起きない）', () => {
  const src = sizingSource([asset(1080, 1920)]);
  const out = resolveOutputSize({ aspect: '9:16' }, src);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  const rect = computeFitRect(1080, 1920, out.width, out.height, 'contain');
  assert.equal(rect.scale, 1, '拡大も縮小もしない');
  assert.equal(rect.cropped, false);
  assert.equal(rect.letterboxed, false);
});
