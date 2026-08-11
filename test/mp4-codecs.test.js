/**
 * VP9 / Opus フォールバック経路のテスト。
 * H.264 エンコーダを持たない環境（一部の Linux 版 Chromium など）でも
 * 書き出せるようにするための分岐を検証する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Muxer, buildDOps, buildVpcC, findBox, parseBoxes } from '../src/core/mp4.js';

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

function boxType(bytes, offset) {
  return String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
}

/** 箱の範囲内に指定の 4CC が含まれるか（入れ子の細かい位置に依存しない検証） */
function containsFourCC(bytes, box, fourCC) {
  const text = String.fromCharCode(...bytes.slice(box.offset, box.offset + box.size));
  return text.includes(fourCC);
}

test('vpcC はコーデック文字列から profile / level / bitDepth を組み立てる', () => {
  const bytes = buildVpcC('vp09.00.41.08');
  assert.equal(boxType(bytes, 0), 'vpcC');
  assert.equal(bytes[8], 1, 'version は 1');
  const payload = bytes.subarray(12);
  assert.equal(payload[0], 0, 'profile');
  assert.equal(payload[1], 41, 'level 4.1');
  assert.equal(payload[2] >> 4, 8, 'bitDepth');
});

test('vpcC は不正なコーデック文字列でも既定値で組む', () => {
  const payload = buildVpcC('vp09').subarray(12);
  assert.equal(payload[0], 0);
  assert.equal(payload[1], 10);
  assert.equal(payload[2] >> 4, 8);
});

test('dOps は OpusHead（リトルエンディアン）をビッグエンディアンへ並べ替える', () => {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  for (let i = 0; i < 8; i += 1) head[i] = 'OpusHead'.charCodeAt(i);
  head[8] = 1; // version
  head[9] = 2; // channels
  view.setUint16(10, 312, true); // preSkip
  view.setUint32(12, 48000, true); // inputSampleRate
  view.setInt16(16, -3, true); // outputGain
  head[18] = 0;

  const bytes = buildDOps(2, 48000, head);
  assert.equal(boxType(bytes, 0), 'dOps');
  const payload = new DataView(bytes.buffer, bytes.byteOffset + 8);
  assert.equal(payload.getUint8(0), 0, 'Version');
  assert.equal(payload.getUint8(1), 2, 'OutputChannelCount');
  assert.equal(payload.getUint16(2), 312, 'PreSkip（ビッグエンディアン）');
  assert.equal(payload.getUint32(4), 48000, 'InputSampleRate');
  assert.equal(payload.getInt16(8), -3, 'OutputGain');
});

test('dOps は OpusHead が無くても既定値で組める', () => {
  const bytes = buildDOps(1, 24000, null);
  const payload = new DataView(bytes.buffer, bytes.byteOffset + 8);
  assert.equal(payload.getUint8(1), 1);
  assert.equal(payload.getUint16(2), 3840, '既定の PreSkip');
  assert.equal(payload.getUint32(4), 24000);
});

test('VP9 + Opus の MP4 を組み立てられる（avcC なしでも成立する）', () => {
  const muxer = new Mp4Muxer({
    width: 640,
    height: 360,
    videoCodec: 'vp9',
    videoCodecString: 'vp09.00.41.08',
    audio: { sampleRate: 48000, channels: 2 },
    audioCodec: 'opus',
  });
  for (let i = 0; i < 10; i += 1) {
    muxer.addVideoChunk({
      data: new Uint8Array(64).fill(i),
      timestampUs: Math.round((i * 1e6) / 30),
      durationUs: Math.round(1e6 / 30),
      isKey: i === 0,
    });
  }
  for (let i = 0; i < 15; i += 1) {
    muxer.addAudioChunk({
      data: new Uint8Array(80),
      timestampUs: Math.round((i * 960 * 1e6) / 48000),
      durationUs: Math.round((960 * 1e6) / 48000),
    });
  }

  const file = concatParts(muxer.finalize().parts);
  const boxes = parseBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  const traks = moov.children.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 2, '映像と音声の 2 トラック');

  // 映像の sample entry が vp09 で、その中に vpcC があること
  const videoStsd = findBox(traks[0].children, ['mdia', 'minf', 'stbl']).children.find((b) => b.type === 'stsd');
  assert.equal(boxType(file, videoStsd.offset + 16), 'vp09');
  assert.ok(containsFourCC(file, videoStsd, 'vpcC'), 'vpcC が見つからない');

  // 音声の sample entry が Opus で、その中に dOps があること
  const audioStsd = findBox(traks[1].children, ['mdia', 'minf', 'stbl']).children.find((b) => b.type === 'stsd');
  assert.equal(boxType(file, audioStsd.offset + 16), 'Opus');
  assert.ok(containsFourCC(file, audioStsd, 'dOps'), 'dOps が見つからない');
});

test('AAC では AudioSpecificConfig が無いと音声トラックを作らない', () => {
  const make = (audioCodec) => {
    const muxer = new Mp4Muxer({
      width: 320,
      height: 240,
      videoCodec: 'vp9',
      videoCodecString: 'vp09.00.10.08',
      audio: { sampleRate: 48000, channels: 2 },
      audioCodec,
    });
    muxer.addVideoChunk({ data: new Uint8Array(8), timestampUs: 0, durationUs: 33333, isKey: true });
    muxer.addAudioChunk({ data: new Uint8Array(8), timestampUs: 0, durationUs: 20000 });
    const file = concatParts(muxer.finalize().parts);
    return parseBoxes(file).find((b) => b.type === 'moov').children.filter((b) => b.type === 'trak').length;
  };
  assert.equal(make('aac'), 1, 'AAC は description 必須');
  assert.equal(make('opus'), 2, 'Opus は既定値で組める');
});
