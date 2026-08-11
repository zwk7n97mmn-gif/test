import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, buildChapters, buildHashtags, extractKeywords, fitToLimit, generateCaption, summarize } from '../src/core/captions.js';

const cues = [
  { start: 0, end: 3, text: '今日は動画編集の自動字幕について解説します。' },
  { start: 3, end: 7, text: '動画編集で一番time がかかるのは字幕付けですよね。' },
  { start: 7, end: 12, text: '自動字幕を使えば作業時間を大幅に短縮できます。' },
  { start: 12, end: 18, text: 'サムネイル作成のコツも紹介します。' },
];

test('AC-09: キーワードを抽出する', () => {
  const keywords = extractKeywords(cues.map((c) => c.text).join(''));
  assert.ok(keywords.length > 0);
  const words = keywords.map((k) => k.word);
  assert.ok(words.some((w) => w.includes('動画編集') || w.includes('字幕')), `抽出結果: ${words.join(',')}`);
  assert.ok(keywords.every((k) => k.score > 0));
});

test('キーワード抽出は空文字で空配列', () => {
  assert.deepEqual(extractKeywords(''), []);
  assert.deepEqual(extractKeywords(null), []);
  assert.deepEqual(extractKeywords('   '), []);
});

test('ハッシュタグは記号を除去し重複しない', () => {
  const tags = buildHashtags([{ word: '動画編集' }, { word: '動画編集' }, { word: 'A/B テスト' }], 5);
  assert.ok(tags.includes('#動画編集'));
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(tags.every((t) => !/[/\s]/.test(t)));
  assert.deepEqual(buildHashtags([], 5), []);
});

test('AC-09: プラットフォームの文字数上限を必ず守る', () => {
  const longCues = Array.from({ length: 300 }, (_, i) => ({
    start: i,
    end: i + 1,
    text: `これは非常に長い字幕テキストのサンプルです。番号は${i}番です。動画編集の解説をしています。`,
  }));
  for (const platform of Object.keys(PLATFORMS)) {
    const result = generateCaption({
      cues: longCues,
      scenes: [{ start: 0, end: 300 }],
      duration: 300,
      platform,
      tone: 'neutral',
      includeChapters: true,
      includeHashtags: true,
    });
    assert.ok(
      [...result.text].length <= PLATFORMS[platform].maxChars,
      `${platform}: ${[...result.text].length} > ${PLATFORMS[platform].maxChars}`,
    );
    assert.equal(result.length, [...result.text].length);
  }
});

test('AC-09/AC-10: 字幕 0 件でも尺情報からキャプションを生成する', () => {
  const result = generateCaption({ cues: [], scenes: [], duration: 95, platform: 'x', tone: 'casual' });
  assert.ok(result.text.length > 0);
  assert.match(result.text, /01:35/);
  assert.ok([...result.text].length <= PLATFORMS.x.maxChars);
});

test('YouTube ではチャプターを含む', () => {
  const result = generateCaption({
    cues,
    scenes: [{ start: 0, end: 7 }, { start: 7, end: 18 }],
    duration: 18,
    platform: 'youtube',
    tone: 'neutral',
    includeChapters: true,
    includeHashtags: true,
  });
  assert.match(result.text, /チャプター/);
  assert.match(result.text, /00:00/);
});

test('X ではチャプターを含めない', () => {
  const result = generateCaption({
    cues,
    scenes: [{ start: 0, end: 7 }, { start: 7, end: 18 }],
    duration: 18,
    platform: 'x',
    includeChapters: true,
  });
  assert.ok(!/チャプター/.test(result.text));
});

test('ハッシュタグを無効にできる', () => {
  const result = generateCaption({ cues, scenes: [], duration: 18, platform: 'instagram', includeHashtags: false });
  assert.deepEqual(result.hashtags, []);
  assert.ok(!/#/.test(result.text));
});

test('buildChapters は先頭を 0:00 にし、最大件数を守る', () => {
  const scenes = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 10 }));
  const chapters = buildChapters(scenes, cues, 5);
  assert.equal(chapters.length, 5);
  assert.equal(chapters[0].time, 0);
  assert.deepEqual(buildChapters([], []), []);
});

test('summarize は代表文を登場順で返す', () => {
  const summary = summarize(cues, 2);
  assert.ok(summary.length > 0);
  assert.ok(!summary.includes('undefined'));
  assert.equal(summarize([], 2), '');
  assert.equal(summarize([{ text: '短い' }], 2), '', '短すぎる文は採用しない');
});

test('fitToLimit はハッシュタグ行を残して本文を削る', () => {
  const text = `${'あ'.repeat(500)}\n\n#タグ1 #タグ2`;
  const result = fitToLimit(text, 100, ['#タグ1', '#タグ2']);
  assert.ok([...result.text].length <= 100);
  assert.ok(result.text.endsWith('#タグ1 #タグ2'));
  assert.equal(result.truncated, true);
  assert.equal(fitToLimit('短い', 100).truncated, false);
});

test('決定的に同じ結果を返す', () => {
  const input = { cues, scenes: [], duration: 18, platform: 'youtube', tone: 'neutral', includeHashtags: true };
  assert.equal(generateCaption(input).text, generateCaption(input).text);
});
