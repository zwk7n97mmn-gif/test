import test from 'node:test';
import assert from 'node:assert/strict';
import { alignTextToSegments, parseTranscriptionResponse, transcribeRemote, transcribeWithVad } from '../src/core/stt.js';
import { encodeWav, resample } from '../src/core/wav.js';

test('AC-03b: VAD のみの場合はテキストを捏造しない', () => {
  const result = transcribeWithVad([{ start: 1, end: 3 }, { start: 5, end: 6 }]);
  assert.equal(result.cues.length, 2);
  assert.equal(result.hasText, false);
  for (const cue of result.cues) {
    assert.equal(cue.text, '');
    assert.equal(cue.needsText, true);
  }
  assert.match(result.notice, /テキストを入力/);
});

test('発話 0 件のときは案内文を返す', () => {
  const result = transcribeWithVad([]);
  assert.deepEqual(result.cues, []);
  assert.match(result.notice, /検出できませんでした/);
});

test('verbose_json のセグメントを解析する', () => {
  const { cues, errors } = parseTranscriptionResponse({
    segments: [
      { start: 0, end: 2.5, text: ' こんにちは ' },
      { start: 2.5, end: 4, text: '本日は晴天なり' },
      { start: 9, end: 9, text: '長さ 0 は捨てる' },
    ],
  });
  assert.equal(errors.length, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'こんにちは');
  assert.equal(cues[0].needsText, false);
});

test('タイムコードなし応答は plainText として返る', () => {
  const result = parseTranscriptionResponse({ text: '全文テキスト' });
  assert.deepEqual(result.cues, []);
  assert.equal(result.plainText, '全文テキスト');
});

test('エラー応答・不正応答を検出する', () => {
  assert.match(parseTranscriptionResponse({ error: { message: '認証エラー' } }).errors[0], /認証エラー/);
  assert.match(parseTranscriptionResponse({ error: '文字列エラー' }).errors[0], /文字列エラー/);
  assert.match(parseTranscriptionResponse(null).errors[0], /解釈できません/);
  assert.match(parseTranscriptionResponse({}).errors[0], /含まれていません/);
});

test('全文テキストを発話区間へ割り当てる', () => {
  const cues = alignTextToSegments('こんにちは。今日はいい天気ですね。散歩に行きます。', [
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues.map((c) => c.text).join(''), 'こんにちは。今日はいい天気ですね。散歩に行きます。');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].end, 5);
});

test('割り当ては空入力で空配列', () => {
  assert.deepEqual(alignTextToSegments('', [{ start: 0, end: 1 }]), []);
  assert.deepEqual(alignTextToSegments('テキスト', []), []);
});

test('transcribeRemote は成功応答を解析する', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ segments: [{ start: 0, end: 1, text: 'やあ' }] }),
    };
  };
  const result = await transcribeRemote(
    { blob: new Blob(['x']), endpoint: 'https://example.test/v1/audio/transcriptions', model: 'whisper-1', language: 'ja', apiKey: 'k' },
    { fetchImpl },
  );
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].text, 'やあ');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer k');
});

test('transcribeRemote は HTTP エラーを日本語で返す', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: { message: 'Invalid API key' } }),
  });
  const result = await transcribeRemote(
    { blob: new Blob(['x']), endpoint: 'https://example.test', apiKey: 'bad' },
    { fetchImpl },
  );
  assert.equal(result.cues.length, 0);
  assert.match(result.errors[0], /Invalid API key/);
});

test('transcribeRemote は JSON でない応答も処理する', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    headers: { get: () => 'text/html' },
    text: async () => '<html>Internal Server Error</html>',
  });
  const result = await transcribeRemote({ blob: new Blob(['x']), endpoint: 'https://example.test' }, { fetchImpl });
  assert.equal(result.errors.length, 1);
});

test('必須項目が欠けていれば例外', async () => {
  await assert.rejects(() => transcribeRemote({ blob: new Blob(['x']) }, { fetchImpl: async () => ({}) }), /エンドポイント/);
  await assert.rejects(() => transcribeRemote({ endpoint: 'https://x.test' }, { fetchImpl: async () => ({}) }), /音声データ/);
});

test('WAV ヘッダが正しく生成される', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const buffer = encodeWav(samples, 16000);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 44 + samples.length * 2);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1, 'モノラル');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16, 'ビット深度');
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(44 + 6, true), 32767, 'クリップ上限');
  assert.equal(view.getInt16(44 + 8, true), -32768, 'クリップ下限');
});

test('空サンプルの WAV も生成できる', () => {
  const buffer = encodeWav(new Float32Array(0), 0);
  assert.equal(buffer.byteLength, 44);
});

test('resample は長さを比率どおりに変える', () => {
  const src = Float32Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(resample(src, 48000, 16000).length, 33);
  assert.equal(resample(src, 16000, 16000), src);
  assert.equal(resample(new Float32Array(0), 48000, 16000).length, 0);
});
