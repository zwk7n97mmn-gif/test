import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteWriter,
  Mp4Muxer,
  box,
  computeDecodeTimes,
  descriptorLength,
  findBox,
  fullBox,
  parseBoxes,
  runLength,
  toTimescale,
} from '../src/core/mp4.js';

/** テスト用のダミー avcC（実際の SPS/PPS ではないが構造検証には十分） */
const AVCC = new Uint8Array([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x27, 0x42, 0xc0, 0x1e, 0x01, 0x00, 0x04, 0x28, 0xce, 0x3c, 0x80]);
/** AudioSpecificConfig: AAC-LC, 48kHz, stereo */
const ASC = new Uint8Array([0x11, 0x90]);

function frames(count, { fps = 30, size = 100, keyEvery = 30 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    data: new Uint8Array(size).fill(i % 251),
    timestampUs: Math.round((i * 1e6) / fps),
    durationUs: Math.round(1e6 / fps),
    isKey: i % keyEvery === 0,
  }));
}

function concatParts(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test('ByteWriter は自動的に伸長し、値を正しく書く', () => {
  const w = new ByteWriter(1);
  w.u8(0xff).u16(0x1234).u24(0xabcdef).u32(0xdeadbeef);
  const bytes = w.build();
  assert.equal(bytes.length, 10);
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0xff, 0x12, 0x34, 0xab]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(6), 0xdeadbeef);
});

test('box はサイズと型を先頭に書く', () => {
  const b = box('test', new Uint8Array([1, 2, 3]));
  assert.equal(b.length, 11);
  const view = new DataView(b.buffer, b.byteOffset);
  assert.equal(view.getUint32(0), 11);
  assert.equal(String.fromCharCode(...b.slice(4, 8)), 'test');
});

test('fullBox は version と flags を持つ', () => {
  const b = fullBox('mvhd', 0, 7);
  assert.equal(b.length, 12);
  assert.equal(b[8], 0); // version
  assert.equal(b[11], 7); // flags 下位バイト
});

test('descriptorLength は 7bit 継続方式で符号化する', () => {
  assert.deepEqual(Array.from(descriptorLength(5)), [5]);
  assert.deepEqual(Array.from(descriptorLength(127)), [127]);
  assert.deepEqual(Array.from(descriptorLength(128)), [0x81, 0x00]);
  assert.deepEqual(Array.from(descriptorLength(300)), [0x82, 0x2c]);
});

test('runLength は連続値をまとめる', () => {
  assert.deepEqual(runLength([3, 3, 3, 4, 4]), [{ count: 3, value: 3 }, { count: 2, value: 4 }]);
  assert.deepEqual(runLength([]), []);
});

test('toTimescale は絶対時刻で変換する（誤差が累積しない）', () => {
  assert.equal(toTimescale(1000000, 90000), 90000);
  assert.equal(toTimescale(33333, 90000), 3000);
  assert.equal(toTimescale(0, 48000), 0);
});

test('computeDecodeTimes は並べ替えが無ければ reordered=false', () => {
  const result = computeDecodeTimes([0, 100, 200, 300]);
  assert.equal(result.reordered, false);
  assert.deepEqual(result.offsets, [0, 0, 0, 0]);
});

test('computeDecodeTimes は B フレームの並べ替えを検出し composition offset を出す', () => {
  // 表示順が入れ替わっている（復号順 0, 300, 100, 200）
  const result = computeDecodeTimes([0, 300, 100, 200]);
  assert.equal(result.reordered, true);
  assert.deepEqual(result.decodeTimes, [0, 100, 200, 300]);
  assert.deepEqual(result.offsets, [0, 200, -100, -100].map((v, i) => [0, 300, 100, 200][i] - [0, 100, 200, 300][i]));
});

test('映像のみの MP4 を組み立てられる', () => {
  const muxer = new Mp4Muxer({ width: 640, height: 360 });
  muxer.setVideoDescription(AVCC);
  for (const frame of frames(30)) muxer.addVideoChunk(frame);
  const { parts, size, durationSec } = muxer.finalize();

  const file = concatParts(parts);
  assert.equal(file.length, size);
  assert.ok(Math.abs(durationSec - 1) < 0.01, `尺 ${durationSec}`);

  const boxes = parseBoxes(file);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'mdat', 'moov']);

  const moov = boxes.find((b) => b.type === 'moov');
  const traks = moov.children.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 1);
  assert.ok(findBox(moov.children, ['trak', 'mdia', 'minf', 'stbl']), 'stbl が見つからない');
  const stbl = findBox(moov.children, ['trak', 'mdia', 'minf', 'stbl']);
  const types = stbl.children.map((b) => b.type);
  for (const required of ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco']) {
    assert.ok(types.includes(required), `${required} が無い`);
  }
});

test('mdat のサイズとチャンクオフセットが実データと一致する', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240 });
  muxer.setVideoDescription(AVCC);
  const samples = frames(10, { size: 77 });
  for (const frame of samples) muxer.addVideoChunk(frame);
  const file = concatParts(muxer.finalize().parts);

  const boxes = parseBoxes(file);
  const mdat = boxes.find((b) => b.type === 'mdat');
  assert.equal(mdat.size, 8 + 10 * 77);

  // stco の値が mdat の中身の先頭を指していること
  const stbl = findBox(boxes.find((b) => b.type === 'moov').children, ['trak', 'mdia', 'minf', 'stbl']);
  const stco = stbl.children.find((b) => b.type === 'stco');
  const view = new DataView(file.buffer, file.byteOffset);
  const offset = view.getUint32(stco.offset + 16); // size+type+version/flags+entry_count
  assert.equal(offset, mdat.offset + 8);
  assert.equal(file[offset], samples[0].data[0]);
});

test('stsz は各サンプルのサイズを列挙する', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240 });
  muxer.setVideoDescription(AVCC);
  muxer.addVideoChunk({ data: new Uint8Array(11), timestampUs: 0, durationUs: 33333, isKey: true });
  muxer.addVideoChunk({ data: new Uint8Array(22), timestampUs: 33333, durationUs: 33333, isKey: false });
  const file = concatParts(muxer.finalize().parts);
  const stbl = findBox(parseBoxes(file).find((b) => b.type === 'moov').children, ['trak', 'mdia', 'minf', 'stbl']);
  const stsz = stbl.children.find((b) => b.type === 'stsz');
  const view = new DataView(file.buffer, file.byteOffset);
  assert.equal(view.getUint32(stsz.offset + 12), 0, 'sample_size は 0（個別列挙）');
  assert.equal(view.getUint32(stsz.offset + 16), 2, 'sample_count');
  assert.equal(view.getUint32(stsz.offset + 20), 11);
  assert.equal(view.getUint32(stsz.offset + 24), 22);
});

test('全フレームがキーフレームなら stss を省略する', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240 });
  muxer.setVideoDescription(AVCC);
  for (const frame of frames(5, { keyEvery: 1 })) muxer.addVideoChunk(frame);
  const file = concatParts(muxer.finalize().parts);
  const stbl = findBox(parseBoxes(file).find((b) => b.type === 'moov').children, ['trak', 'mdia', 'minf', 'stbl']);
  assert.ok(!stbl.children.some((b) => b.type === 'stss'));
});

test('音声トラック付きの MP4 を組み立てられる', () => {
  const muxer = new Mp4Muxer({ width: 640, height: 360, audio: { sampleRate: 48000, channels: 2 } });
  muxer.setVideoDescription(AVCC);
  muxer.setAudioDescription(ASC);
  for (const frame of frames(30)) muxer.addVideoChunk(frame);
  for (let i = 0; i < 46; i += 1) {
    muxer.addAudioChunk({
      data: new Uint8Array(200),
      timestampUs: Math.round((i * 1024 * 1e6) / 48000),
      durationUs: Math.round((1024 * 1e6) / 48000),
    });
  }
  const file = concatParts(muxer.finalize().parts);
  const moov = parseBoxes(file).find((b) => b.type === 'moov');
  const traks = moov.children.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2);

  const handlers = traks.map((trak) => {
    const hdlr = findBox(trak.children, ['mdia']).children.find((b) => b.type === 'hdlr');
    return String.fromCharCode(...file.slice(hdlr.offset + 16, hdlr.offset + 20));
  });
  assert.deepEqual(handlers, ['vide', 'soun']);

  // 音声トラックに esds があること
  const audioStbl = findBox(traks[1].children, ['mdia', 'minf', 'stbl']);
  assert.ok(audioStbl.children.some((b) => b.type === 'stsd'));
});

test('音声の記述子が無ければ音声トラックを作らない（映像だけ出力する）', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240, audio: { sampleRate: 48000, channels: 2 } });
  muxer.setVideoDescription(AVCC);
  for (const frame of frames(3)) muxer.addVideoChunk(frame);
  muxer.addAudioChunk({ data: new Uint8Array(10), timestampUs: 0, durationUs: 21333 });
  // setAudioDescription を呼ばない
  const file = concatParts(muxer.finalize().parts);
  const moov = parseBoxes(file).find((b) => b.type === 'moov');
  assert.equal(moov.children.filter((b) => b.type === 'trak').length, 1);
});

test('サンプルや設定が無い場合は理由の分かる例外を投げる', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240 });
  assert.throws(() => muxer.finalize(), /映像サンプルがありません/);
  muxer.addVideoChunk({ data: new Uint8Array(4), timestampUs: 0, durationUs: 33333, isKey: true });
  assert.throws(() => muxer.finalize(), /avcC/);
  assert.throws(() => new Mp4Muxer({ width: 0, height: 100 }), /映像サイズ/);
});

test('可変フレーム間隔でも stts のランレングスが正しい', () => {
  const muxer = new Mp4Muxer({ width: 320, height: 240 });
  muxer.setVideoDescription(AVCC);
  const times = [0, 33333, 66666, 200000, 233333];
  times.forEach((t, i) => muxer.addVideoChunk({
    data: new Uint8Array(10),
    timestampUs: t,
    durationUs: i === times.length - 1 ? 33333 : times[i + 1] - t,
    isKey: i === 0,
  }));
  const file = concatParts(muxer.finalize().parts);
  const stbl = findBox(parseBoxes(file).find((b) => b.type === 'moov').children, ['trak', 'mdia', 'minf', 'stbl']);
  const stts = stbl.children.find((b) => b.type === 'stts');
  const view = new DataView(file.buffer, file.byteOffset);
  const entryCount = view.getUint32(stts.offset + 12);
  assert.ok(entryCount >= 2, '間隔が変わる箇所で分かれるはず');
  let total = 0;
  for (let i = 0; i < entryCount; i += 1) {
    total += view.getUint32(stts.offset + 16 + i * 8) * view.getUint32(stts.offset + 20 + i * 8);
  }
  assert.equal(total, toTimescale(233333 + 33333, 90000), 'stts の合計が尺と一致する');
});
