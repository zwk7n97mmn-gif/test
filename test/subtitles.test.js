import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charsPerSecond,
  cueAt,
  cuesFromSegments,
  normalizeCues,
  parseSubtitles,
  plainText,
  shiftCues,
  splitTextEvenly,
  toSRT,
  toVTT,
  validateCues,
  wrapText,
} from '../src/core/subtitles.js';

test('AC-04: 行頭禁則 — 句読点が行頭に来ない', () => {
  const lines = wrapText('あいうえお、かきくけこ。', 5);
  for (const line of lines) {
    assert.ok(!'、。'.includes(line[0]), `行頭に禁則文字: ${JSON.stringify(lines)}`);
  }
  assert.equal(lines.join(''), 'あいうえお、かきくけこ。');
});

test('行末禁則 — 開き括弧が行末に来ない', () => {
  const lines = wrapText('あいうえ「かきくけこ」', 5);
  for (const line of lines) {
    assert.ok(!'「（'.includes(line[line.length - 1]), `行末に禁則文字: ${JSON.stringify(lines)}`);
  }
  assert.equal(lines.join(''), 'あいうえ「かきくけこ」');
});

test('wrapText は改行を尊重し、maxLines で末尾行にまとめる', () => {
  assert.deepEqual(wrapText('あい\nうえ', 10), ['あい', 'うえ']);
  const limited = wrapText('あいうえおかきくけこさしすせそ', 5, 2);
  assert.equal(limited.length, 2);
  assert.equal(limited.join(''), 'あいうえおかきくけこさしすせそ');
  assert.deepEqual(wrapText('', 5), []);
  assert.deepEqual(wrapText(null, 5), []);
});

test('境界値: 10,000 文字でも折返しが完了し内容を失わない', () => {
  const long = 'あ'.repeat(10000);
  const lines = wrapText(long, 20);
  assert.equal(lines.length, 500);
  assert.equal(lines.join('').length, 10000);
});

test('AC-03a: 発話区間から字幕キューを生成する（テキストは空のまま）', () => {
  const cues = cuesFromSegments([{ start: 0, end: 3 }, { start: 5, end: 6 }]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, '');
  assert.equal(cues[0].needsText, true);
  assert.equal(cues[1].start, 5);
});

test('長い発話は読める長さへ自動分割される', () => {
  const cues = cuesFromSegments([{ start: 0, end: 20 }], { maxDuration: 6 });
  assert.equal(cues.length, 4);
  assert.equal(cues.at(-1).end, 20);
  for (const cue of cues) assert.ok(cue.end - cue.start <= 6 + 1e-9);
});

test('splitTextEvenly は句読点を優先して分割する', () => {
  assert.deepEqual(splitTextEvenly('', 3), ['', '', '']);
  assert.deepEqual(splitTextEvenly('あいうえお', 1), ['あいうえお']);
  const parts = splitTextEvenly('こんにちは。今日はいい天気ですね。', 2);
  assert.equal(parts.join(''), 'こんにちは。今日はいい天気ですね。');
  assert.ok(parts[0].endsWith('。'));
});

test('normalizeCues は重なりを解消し範囲外を除去する', () => {
  const cues = normalizeCues(
    [
      { id: 'b', start: 3, end: 6, text: 'B' },
      { id: 'a', start: 0, end: 4, text: 'A' },
      { id: 'z', start: 9, end: 8, text: '逆転' },
    ],
    10,
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, 'a');
  assert.ok(cues[0].end <= cues[1].start + 1e-9, '重なりが残っている');
});

test('normalizeCues は素材長でクランプする', () => {
  const cues = normalizeCues([{ start: 8, end: 30, text: 'x' }], 10);
  assert.equal(cues[0].end, 10);
  assert.deepEqual(normalizeCues([], 10), []);
  assert.deepEqual(normalizeCues(null), []);
});

test('AC-04: SRT の書き出しと読み込みが往復する', () => {
  const cues = [
    { id: '1', start: 1.5, end: 3.25, text: 'こんにちは' },
    { id: '2', start: 4, end: 6, text: '二行目\nあります' },
  ];
  const srt = toSRT(cues);
  assert.match(srt, /00:00:01,500 --> 00:00:03,250/);
  const parsed = parseSubtitles(srt);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, 'こんにちは');
  assert.equal(parsed.cues[1].text, '二行目\nあります');
  assert.equal(parsed.cues[0].start, 1.5);
});

test('WebVTT の書き出しと読み込みが往復する', () => {
  const vtt = toVTT([{ id: '1', start: 0, end: 2, text: 'テスト' }]);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(vtt, /00:00:00\.000 --> 00:00:02\.000/);
  const parsed = parseSubtitles(vtt);
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, 'テスト');
});

test('parseSubtitles は壊れた入力でも例外を投げない', () => {
  assert.deepEqual(parseSubtitles('').cues, []);
  assert.equal(parseSubtitles('').errors.length, 1);
  const broken = parseSubtitles('1\nこれは時刻ではない\nテキスト');
  assert.equal(broken.cues.length, 0);
  assert.equal(broken.errors.length, 1);
  const partial = parseSubtitles('1\n00:00:05,000 --> 00:00:01,000\n逆転\n\n2\n00:00:01,000 --> 00:00:02,000\nOK');
  assert.equal(partial.cues.length, 1);
  assert.equal(partial.errors.length, 1);
});

test('parseSubtitles は BOM と CRLF を許容する', () => {
  const parsed = parseSubtitles('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nテスト\r\n');
  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, 'テスト');
});

test('toSRT は空リストで空文字を返す', () => {
  assert.equal(toSRT([]), '');
  assert.equal(toVTT([]).trim(), 'WEBVTT');
});

test('validateCues は問題を検出する', () => {
  const issues = validateCues([
    { id: 'a', start: 0, end: 0.3, text: 'あ' },
    { id: 'b', start: 0.2, end: 12, text: '' },
  ]);
  const codes = issues.map((i) => `${i.id}:${i.level}`);
  assert.ok(codes.includes('a:warn'));
  assert.ok(issues.some((i) => i.id === 'b' && /未入力/.test(i.message)));
  assert.ok(issues.some((i) => i.level === 'error' && /重なって/.test(i.message)));
  assert.deepEqual(validateCues([]), []);
});

test('charsPerSecond / cueAt / shiftCues / plainText', () => {
  assert.equal(charsPerSecond({ start: 0, end: 2, text: 'あいうえおかきくけこ' }), 5);
  const cues = [{ id: 'a', start: 1, end: 2, text: 'x' }];
  assert.equal(cueAt(cues, 1.5).id, 'a');
  assert.equal(cueAt(cues, 2), null);
  assert.equal(cueAt([], 0), null);
  assert.equal(shiftCues(cues, -5)[0].start, 0, '負にはならない');
  assert.equal(plainText([{ text: ' a ' }, { text: '' }, { text: 'b' }]), 'a\nb');
});

test('境界値: 5,000 件の字幕でも正規化が完了する', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({
    id: `c${i}`,
    start: i * 2,
    end: i * 2 + 1.5,
    text: `字幕${i}`,
  }));
  const start = Date.now();
  const normalized = normalizeCues(many, 10000);
  assert.equal(normalized.length, 5000);
  assert.ok(Date.now() - start < 3000, '5,000 件の処理が遅すぎます');
  assert.ok(toSRT(normalized).length > 0);
});
