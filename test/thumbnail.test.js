import test from 'node:test';
import assert from 'node:assert/strict';
import { THUMBNAIL_SIZE, layoutThumbnailText, rankThumbnailCandidates, suggestThumbnailTitle } from '../src/core/thumbnail.js';

function frame(t, quality) {
  return { t, sharp: quality, contrast: quality, colorful: quality, exposure: quality };
}

test('AC-07: 品質の高いフレームが上位に来る', () => {
  const frames = [frame(1, 0.2), frame(5, 0.9), frame(9, 0.5)];
  const ranked = rankThumbnailCandidates(frames, [], [], { limit: 3, minSpacingSec: 0.5, duration: 12 });
  assert.equal(ranked[0].t, 5);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked.every((c) => c.score >= 0 && c.score <= 1));
});

test('シーン切替の直後は減点される', () => {
  const frames = [frame(2, 0.8), frame(5, 0.8)];
  const ranked = rankThumbnailCandidates(frames, [{ start: 0, end: 2 }, { start: 2, end: 10 }], [], {
    limit: 2, minSpacingSec: 0.1, duration: 10,
  });
  const near = ranked.find((c) => c.t === 2);
  const far = ranked.find((c) => c.t === 5);
  assert.ok(far.score > near.score, 'シーン境界の候補が減点されていない');
});

test('発話中のフレームは加点される', () => {
  const frames = [frame(1, 0.5), frame(5, 0.5)];
  const ranked = rankThumbnailCandidates(frames, [], [{ start: 4, end: 6 }], { limit: 2, minSpacingSec: 0.1, duration: 10 });
  assert.equal(ranked[0].t, 5);
});

test('候補は指定間隔以上離れる', () => {
  const frames = Array.from({ length: 20 }, (_, i) => frame(i * 0.25, 0.8));
  const ranked = rankThumbnailCandidates(frames, [], [], { limit: 5, minSpacingSec: 1.5, duration: 5 });
  for (let i = 1; i < ranked.length; i += 1) {
    const distances = ranked.slice(0, i).map((c) => Math.abs(c.t - ranked[i].t));
    assert.ok(Math.min(...distances) >= 0.4, '候補が近すぎます');
  }
});

test('フレーム 0 件では空配列（例外を投げない）', () => {
  assert.deepEqual(rankThumbnailCandidates([], [], []), []);
  assert.deepEqual(rankThumbnailCandidates(null, null, null), []);
});

test('AC-07: テキストレイアウトはセーフエリア内に収まる', () => {
  const layout = layoutThumbnailText({
    title: '3分でわかる自動字幕の作り方',
    subtitle: '初心者向け完全ガイド',
    template: 'boldBottom',
    width: THUMBNAIL_SIZE.width,
    height: THUMBNAIL_SIZE.height,
  });
  assert.ok(layout.titleLines.length >= 1);
  assert.ok(layout.box.y >= layout.margin);
  assert.ok(layout.box.y + layout.box.height <= THUMBNAIL_SIZE.height + 1);
  assert.ok(layout.titleSize > 0 && layout.strokeWidth > 0);
});

test('長い見出しはフォントを縮めて 3 行以内に収める', () => {
  const layout = layoutThumbnailText({
    title: 'あ'.repeat(80),
    subtitle: '',
    template: 'centerImpact',
    width: 1280,
    height: 720,
  });
  assert.ok(layout.titleLines.length <= 3, `行数 ${layout.titleLines.length}`);
  assert.ok(layout.titleSize >= Math.round(720 * 0.055) - 1);
  assert.equal(layout.titleLines.join('').length, 80, '文字が欠落している');
});

test('空文字ではテキスト行を作らない', () => {
  const layout = layoutThumbnailText({ title: '', subtitle: '', template: 'leftPanel' });
  assert.deepEqual(layout.titleLines, []);
  assert.deepEqual(layout.subtitleLines, []);
  assert.equal(layout.box.height, 0);
});

test('未知のテンプレート・極小サイズでも既定値へフォールバックする', () => {
  const layout = layoutThumbnailText({ title: 'あ', template: '存在しない', width: 10, height: 10 });
  assert.equal(layout.align, 'bottom');
  assert.ok(layout.titleSize > 0);
});

test('AC-07: 字幕から見出しを提案する（テキストが無ければ空文字）', () => {
  const title = suggestThumbnailTitle([
    { text: 'えっと、あの' },
    { text: '動画編集の時短テクニックを紹介します。' },
  ], 18);
  assert.ok(title.length > 0);
  assert.ok([...title].length <= 18);
  assert.ok(!title.endsWith('。'));
  assert.equal(suggestThumbnailTitle([]), '');
  assert.equal(suggestThumbnailTitle([{ text: '' }]), '');
});
