/**
 * PCM → WAV(16bit LE) エンコード（純粋関数）。
 * STT へ送るための可搬フォーマットとして使用する。
 */

import { clamp } from './util.js';

/**
 * @param {Float32Array} samples モノラル PCM (-1..1)
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  const data = samples || new Float32Array(0);
  const rate = Math.max(1, Math.floor(sampleRate) || 16000);
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = data.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM チャンクサイズ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < data.length; i += 1) {
    const s = clamp(data[i], -1, 1);
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 単純な線形補間リサンプル（STT 向けに 16kHz へ落とす用途）。
 */
export function resample(samples, fromRate, toRate) {
  const src = samples || new Float32Array(0);
  const from = Math.max(1, fromRate);
  const to = Math.max(1, toRate);
  if (!src.length || from === to) return src;
  const ratio = from / to;
  const length = Math.floor(src.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = src[idx] ?? 0;
    const b = src[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
