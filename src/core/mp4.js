/**
 * MP4 (ISO Base Media File Format) の多重化。依存ゼロ・DOM 非依存の純粋実装。
 *
 * WebCodecs の VideoEncoder / AudioEncoder が出す EncodedChunk を受け取り、
 * ブラウザと一般的なプレイヤーが再生できる MP4 を組み立てる。
 *
 * 構造:
 *   ftyp
 *   mdat  … 映像サンプル → 音声サンプルの順（各トラックが連続 = 1 チャンク）
 *   moov  … mdat を書き終えてから作るため、チャンクオフセットが確定している
 *
 * 制限:
 *   - 4GB を超えるファイルは非対応（32bit オフセット）。超える場合は例外を投げる。
 *   - 映像 1 トラック + 音声 1 トラックのみ。
 */

const MAX_UINT32 = 4294967295;
/** 1904-01-01 から 1970-01-01 までの秒数（MP4 の時刻基準） */
const EPOCH_OFFSET = 2082844800;
const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90000;
const MICROS = 1000000;

/** 伸長するバイト列ライタ */
export class ByteWriter {
  constructor(initial = 1024) {
    this.buffer = new ArrayBuffer(Math.max(16, initial));
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.length = 0;
  }

  ensure(extra) {
    const needed = this.length + extra;
    if (needed <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength;
    while (size < needed) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(value) {
    this.ensure(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
    return this;
  }

  u16(value) {
    this.ensure(2);
    this.view.setUint16(this.length, value);
    this.length += 2;
    return this;
  }

  u24(value) {
    return this.u8((value >> 16) & 0xff).u8((value >> 8) & 0xff).u8(value & 0xff);
  }

  u32(value) {
    this.ensure(4);
    this.view.setUint32(this.length, value >>> 0);
    this.length += 4;
    return this;
  }

  i16(value) {
    this.ensure(2);
    this.view.setInt16(this.length, value);
    this.length += 2;
    return this;
  }

  /** 16.16 固定小数 */
  fixed32(value) {
    return this.u32(Math.round(value * 65536));
  }

  /** 8.8 固定小数 */
  fixed16(value) {
    return this.u16(Math.round(value * 256));
  }

  ascii(text) {
    for (let i = 0; i < text.length; i += 1) this.u8(text.charCodeAt(i) & 0xff);
    return this;
  }

  raw(data) {
    if (!data || !data.length) return this;
    this.ensure(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
    return this;
  }

  zeros(count) {
    this.ensure(count);
    this.length += count; // ArrayBuffer は 0 初期化されている
    return this;
  }

  build() {
    return this.bytes.slice(0, this.length);
  }
}

/** size + type + payload の箱を作る */
export function box(type, ...payloads) {
  const parts = payloads.flat().filter(Boolean);
  let size = 8;
  for (const part of parts) size += part.length;
  const writer = new ByteWriter(size);
  writer.u32(size).ascii(type);
  for (const part of parts) writer.raw(part);
  return writer.build();
}

/** version + flags を先頭に持つ箱 */
export function fullBox(type, version, flags, ...payloads) {
  const head = new ByteWriter(4);
  head.u8(version).u24(flags);
  return box(type, head.build(), ...payloads.flat());
}

/** マイクロ秒 → 指定タイムスケール（丸め誤差が累積しないよう絶対時刻で変換する） */
export function toTimescale(micros, timescale) {
  return Math.round((micros * timescale) / MICROS);
}

/**
 * 連続する同一値をランレングスにまとめる。
 * @returns {{count:number, value:number}[]}
 */
export function runLength(values) {
  const runs = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.count += 1;
    else runs.push({ count: 1, value });
  }
  return runs;
}

/**
 * サンプルの表示時刻（pts）から復号時刻（dts）と composition offset を求める。
 * B フレームで順序が入れ替わっている場合にのみ ctts が必要になる。
 */
export function computeDecodeTimes(presentationTimes) {
  const sorted = [...presentationTimes].sort((a, b) => a - b);
  let reordered = false;
  for (let i = 0; i < presentationTimes.length; i += 1) {
    if (presentationTimes[i] !== sorted[i]) {
      reordered = true;
      break;
    }
  }
  return {
    decodeTimes: sorted,
    offsets: presentationTimes.map((pts, i) => pts - sorted[i]),
    reordered,
  };
}

/** MPEG-4 記述子の可変長サイズ（7bit ずつ、継続ビット付き） */
export function descriptorLength(size) {
  const writer = new ByteWriter(8);
  const bytes = [];
  let value = size;
  do {
    bytes.unshift(value & 0x7f);
    value >>= 7;
  } while (value > 0);
  for (let i = 0; i < bytes.length; i += 1) {
    writer.u8(i === bytes.length - 1 ? bytes[i] : bytes[i] | 0x80);
  }
  return writer.build();
}

function descriptor(tag, payload) {
  const writer = new ByteWriter(payload.length + 8);
  writer.u8(tag).raw(descriptorLength(payload.length)).raw(payload);
  return writer.build();
}

/**
 * MP4 多重化器。
 *
 * @example
 *   const muxer = new Mp4Muxer({ width: 1280, height: 720, audio: { sampleRate: 48000, channels: 2 } });
 *   muxer.setVideoDescription(avccBytes);
 *   muxer.addVideoChunk({ data, timestampUs, durationUs, isKey });
 *   const { parts } = muxer.finalize();
 */
export class Mp4Muxer {
  /**
   * @param {{width:number, height:number,
   *          videoCodec?:'avc'|'vp9', videoCodecString?:string,
   *          audio?:{sampleRate:number, channels:number}|null,
   *          audioCodec?:'aac'|'opus'}} opt
   */
  constructor(opt) {
    this.width = Math.round(opt.width);
    this.height = Math.round(opt.height);
    this.videoCodec = opt.videoCodec === 'vp9' ? 'vp9' : 'avc';
    this.videoCodecString = opt.videoCodecString || '';
    this.audioConfig = opt.audio || null;
    this.audioCodec = opt.audioCodec === 'opus' ? 'opus' : 'aac';
    this.videoDescription = null;
    this.audioDescription = null;
    this.videoSamples = [];
    this.audioSamples = [];
    this.videoBytes = 0;
    this.audioBytes = 0;
    if (!(this.width > 0 && this.height > 0)) {
      throw new Error('映像サイズが不正です。');
    }
  }

  setVideoDescription(description) {
    this.videoDescription = description ? new Uint8Array(description) : null;
  }

  setAudioDescription(description) {
    this.audioDescription = description ? new Uint8Array(description) : null;
  }

  /** @param {{data:Uint8Array, timestampUs:number, durationUs?:number, isKey:boolean}} chunk */
  addVideoChunk(chunk) {
    const data = new Uint8Array(chunk.data);
    this.videoSamples.push({
      data,
      timestampUs: Math.max(0, Math.round(chunk.timestampUs)),
      durationUs: Math.max(0, Math.round(chunk.durationUs || 0)),
      isKey: chunk.isKey === true,
    });
    this.videoBytes += data.length;
  }

  /** @param {{data:Uint8Array, timestampUs:number, durationUs?:number}} chunk */
  addAudioChunk(chunk) {
    if (!this.audioConfig) return;
    const data = new Uint8Array(chunk.data);
    this.audioSamples.push({
      data,
      timestampUs: Math.max(0, Math.round(chunk.timestampUs)),
      durationUs: Math.max(0, Math.round(chunk.durationUs || 0)),
      isKey: true,
    });
    this.audioBytes += data.length;
  }

  get hasAudio() {
    if (!this.audioConfig || !this.audioSamples.length) return false;
    // AAC は esds に AudioSpecificConfig が必須。Opus は無ければ既定値で dOps を組める。
    return this.audioCodec === 'opus' ? true : Boolean(this.audioDescription);
  }

  /**
   * ファイルを組み立てる。
   * @returns {{parts:Uint8Array[], size:number, durationSec:number}}
   */
  finalize() {
    if (!this.videoSamples.length) throw new Error('映像サンプルがありません。');
    if (this.videoCodec === 'avc' && !this.videoDescription) {
      throw new Error('映像のデコーダ設定（avcC）がありません。');
    }

    const mdatPayloadSize = this.videoBytes + (this.hasAudio ? this.audioBytes : 0);
    const totalMdat = mdatPayloadSize + 8;
    if (totalMdat > MAX_UINT32) {
      throw new Error('ファイルが 4GB を超えるため書き出せません。解像度か長さを下げてください。');
    }

    const ftyp = box('ftyp', asciiBytes('isom'), u32Bytes(512), asciiBytes('isomiso2avc1mp41'));
    const mdatHeader = new ByteWriter(8).u32(totalMdat).ascii('mdat').build();

    const videoOffset = ftyp.length + mdatHeader.length;
    const audioOffset = videoOffset + this.videoBytes;

    const videoTrack = this.buildVideoTrack(videoOffset);
    const audioTrack = this.hasAudio ? this.buildAudioTrack(audioOffset) : null;

    const durationSec = Math.max(videoTrack.durationSec, audioTrack ? audioTrack.durationSec : 0);
    const moov = box(
      'moov',
      this.buildMvhd(durationSec, audioTrack ? 3 : 2),
      videoTrack.trak,
      audioTrack ? audioTrack.trak : null,
    );

    const parts = [ftyp, mdatHeader];
    for (const sample of this.videoSamples) parts.push(sample.data);
    if (this.hasAudio) for (const sample of this.audioSamples) parts.push(sample.data);
    parts.push(moov);

    let size = 0;
    for (const part of parts) size += part.length;
    return { parts, size, durationSec };
  }

  buildMvhd(durationSec, nextTrackId) {
    const now = Math.floor(Date.now() / 1000) + EPOCH_OFFSET;
    const writer = new ByteWriter(96);
    writer.u32(now).u32(now).u32(MOVIE_TIMESCALE).u32(Math.round(durationSec * MOVIE_TIMESCALE));
    writer.fixed32(1); // rate
    writer.fixed16(1); // volume
    writer.zeros(2 + 8); // reserved
    writeMatrix(writer);
    writer.zeros(24); // pre_defined
    writer.u32(nextTrackId);
    return fullBox('mvhd', 0, 0, writer.build());
  }

  buildVideoTrack(chunkOffset) {
    const timescale = VIDEO_TIMESCALE;
    const samples = this.videoSamples;
    const times = samples.map((s) => toTimescale(s.timestampUs, timescale));
    const { decodeTimes, offsets, reordered } = computeDecodeTimes(times);

    const lastDuration = samples[samples.length - 1].durationUs > 0
      ? toTimescale(samples[samples.length - 1].durationUs, timescale)
      : estimateLastDelta(decodeTimes);
    const deltas = [];
    for (let i = 0; i < decodeTimes.length; i += 1) {
      deltas.push(i < decodeTimes.length - 1 ? decodeTimes[i + 1] - decodeTimes[i] : lastDuration);
    }
    const mediaDuration = deltas.reduce((sum, d) => sum + d, 0);
    const durationSec = mediaDuration / timescale;

    const stbl = box(
      'stbl',
      fullBox('stsd', 0, 0, u32Bytes(1), this.buildVideoSampleEntry()),
      buildStts(deltas),
      buildStss(samples),
      reordered ? buildCtts(offsets) : null,
      buildStsc(samples.length),
      buildStsz(samples),
      buildStco(chunkOffset),
    );

    const minf = box('minf', fullBox('vmhd', 0, 1, new Uint8Array(8)), buildDinf(), stbl);
    const mdia = box(
      'mdia',
      buildMdhd(timescale, mediaDuration),
      buildHdlr('vide', 'VideoHandler'),
      minf,
    );
    const trak = box('trak', buildTkhd(1, durationSec, this.width, this.height, false), mdia);
    return { trak, durationSec };
  }

  buildAudioTrack(chunkOffset) {
    const timescale = this.audioConfig.sampleRate;
    const samples = this.audioSamples;
    const times = samples.map((s) => toTimescale(s.timestampUs, timescale));
    const lastDuration = samples[samples.length - 1].durationUs > 0
      ? toTimescale(samples[samples.length - 1].durationUs, timescale)
      : estimateLastDelta(times);
    const deltas = [];
    for (let i = 0; i < times.length; i += 1) {
      deltas.push(i < times.length - 1 ? times[i + 1] - times[i] : lastDuration);
    }
    const mediaDuration = deltas.reduce((sum, d) => sum + d, 0);
    const durationSec = mediaDuration / timescale;

    const stbl = box(
      'stbl',
      fullBox('stsd', 0, 0, u32Bytes(1), this.buildAudioSampleEntry()),
      buildStts(deltas),
      buildStsc(samples.length),
      buildStsz(samples),
      buildStco(chunkOffset),
    );
    const minf = box('minf', fullBox('smhd', 0, 0, new Uint8Array(4)), buildDinf(), stbl);
    const mdia = box('mdia', buildMdhd(timescale, mediaDuration), buildHdlr('soun', 'SoundHandler'), minf);
    const trak = box('trak', buildTkhd(2, durationSec, 0, 0, true), mdia);
    return { trak, durationSec };
  }

  /** 映像の sample entry（avc1 + avcC / vp09 + vpcC） */
  buildVideoSampleEntry() {
    const writer = new ByteWriter(86);
    writer.zeros(6).u16(1); // reserved + data_reference_index
    writer.zeros(2 + 2 + 12); // pre_defined / reserved
    writer.u16(this.width).u16(this.height);
    writer.u32(0x00480000).u32(0x00480000); // 72dpi
    writer.u32(0); // reserved
    writer.u16(1); // frame_count
    writer.zeros(32); // compressorname
    writer.u16(0x0018); // depth
    writer.i16(-1); // pre_defined
    const visual = writer.build();
    if (this.videoCodec === 'vp9') {
      return box('vp09', visual, buildVpcC(this.videoCodecString));
    }
    return box('avc1', visual, box('avcC', this.videoDescription));
  }

  /** 音声の sample entry（mp4a + esds / Opus + dOps） */
  buildAudioSampleEntry() {
    const { sampleRate, channels } = this.audioConfig;
    const writer = new ByteWriter(36);
    writer.zeros(6).u16(1); // reserved + data_reference_index
    writer.u16(0).u16(0).u32(0); // version, revision, vendor
    writer.u16(channels).u16(16); // channelcount, samplesize
    writer.u16(0).u16(0); // pre_defined, reserved
    writer.fixed32(Math.min(sampleRate, 65535)); // 16.16 固定小数
    const audio = writer.build();
    if (this.audioCodec === 'opus') {
      return box('Opus', audio, buildDOps(channels, sampleRate, this.audioDescription));
    }
    return box('mp4a', audio, this.buildEsds());
  }

  buildEsds() {
    const asc = this.audioDescription;
    const decoderSpecific = descriptor(0x05, asc);
    const config = new ByteWriter(20);
    config.u8(0x40); // objectTypeIndication: MPEG-4 AAC
    config.u8(0x15); // streamType: audio(5) << 2 | upStream(0) << 1 | reserved(1)
    config.u24(0); // bufferSizeDB
    config.u32(0); // maxBitrate
    config.u32(0); // avgBitrate
    const decoderConfig = descriptor(0x04, concat([config.build(), decoderSpecific]));

    const slConfig = descriptor(0x06, new Uint8Array([0x02]));
    const esHeader = new ByteWriter(4);
    esHeader.u16(1).u8(0); // ES_ID, flags
    const es = descriptor(0x03, concat([esHeader.build(), decoderConfig, slConfig]));
    return fullBox('esds', 0, 0, es);
  }
}

/* ---------- 箱の組み立て（トラック共通） ---------- */

function buildTkhd(trackId, durationSec, width, height, isAudio) {
  const now = Math.floor(Date.now() / 1000) + EPOCH_OFFSET;
  const writer = new ByteWriter(80);
  writer.u32(now).u32(now).u32(trackId).u32(0);
  writer.u32(Math.round(durationSec * MOVIE_TIMESCALE));
  writer.zeros(8); // reserved
  writer.u16(0); // layer
  writer.u16(0); // alternate_group
  writer.fixed16(isAudio ? 1 : 0); // volume
  writer.u16(0); // reserved
  writeMatrix(writer);
  writer.fixed32(width).fixed32(height);
  // flags: enabled | in movie | in preview
  return fullBox('tkhd', 0, 0x000007, writer.build());
}

function buildMdhd(timescale, duration) {
  const now = Math.floor(Date.now() / 1000) + EPOCH_OFFSET;
  const writer = new ByteWriter(20);
  writer.u32(now).u32(now).u32(timescale).u32(duration);
  writer.u16(0x55c4); // language 'und'
  writer.u16(0);
  return fullBox('mdhd', 0, 0, writer.build());
}

function buildHdlr(handlerType, name) {
  const writer = new ByteWriter(32);
  writer.u32(0); // pre_defined
  writer.ascii(handlerType);
  writer.zeros(12); // reserved
  writer.ascii(name).u8(0);
  return fullBox('hdlr', 0, 0, writer.build());
}

function buildDinf() {
  const url = fullBox('url ', 0, 1); // flags=1: 同一ファイル内
  return box('dinf', fullBox('dref', 0, 0, u32Bytes(1), url));
}

function buildStts(deltas) {
  const runs = runLength(deltas);
  const writer = new ByteWriter(8 + runs.length * 8);
  writer.u32(runs.length);
  for (const run of runs) writer.u32(run.count).u32(run.value);
  return fullBox('stts', 0, 0, writer.build());
}

function buildStss(samples) {
  const keys = [];
  for (let i = 0; i < samples.length; i += 1) if (samples[i].isKey) keys.push(i + 1);
  if (keys.length === samples.length) return null; // 全てが同期サンプルなら省略できる
  const writer = new ByteWriter(4 + keys.length * 4);
  writer.u32(keys.length);
  for (const index of keys) writer.u32(index);
  return fullBox('stss', 0, 0, writer.build());
}

function buildCtts(offsets) {
  const runs = runLength(offsets);
  const writer = new ByteWriter(4 + runs.length * 8);
  writer.u32(runs.length);
  for (const run of runs) writer.u32(run.count).u32(Math.max(0, run.value));
  return fullBox('ctts', 0, 0, writer.build());
}

function buildStsc(sampleCount) {
  const writer = new ByteWriter(16);
  writer.u32(1); // entry_count
  writer.u32(1).u32(sampleCount).u32(1); // first_chunk, samples_per_chunk, sample_description_index
  return fullBox('stsc', 0, 0, writer.build());
}

function buildStsz(samples) {
  const writer = new ByteWriter(8 + samples.length * 4);
  writer.u32(0); // sample_size = 0 → 個別に列挙
  writer.u32(samples.length);
  for (const sample of samples) writer.u32(sample.data.length);
  return fullBox('stsz', 0, 0, writer.build());
}

function buildStco(offset) {
  const writer = new ByteWriter(8);
  writer.u32(1).u32(offset);
  return fullBox('stco', 0, 0, writer.build());
}

/**
 * VP9 の設定ボックス（vpcC）。
 * VP9 は自己記述的で WebCodecs が description を返さないため、
 * コーデック文字列 'vp09.PP.LL.DD' から profile / level / bitDepth を組み立てる。
 */
export function buildVpcC(codecString) {
  const parts = String(codecString || '').split('.');
  const profile = clampByte(parseInt(parts[1], 10), 0);
  const level = clampByte(parseInt(parts[2], 10), 10);
  const bitDepth = clampByte(parseInt(parts[3], 10), 8);
  const writer = new ByteWriter(12);
  writer.u8(profile);
  writer.u8(level);
  // bitDepth(4bit) | chromaSubsampling(3bit: 1 = 4:2:0 colocated) | videoFullRangeFlag(1bit)
  writer.u8(((bitDepth & 0x0f) << 4) | (1 << 1) | 0);
  writer.u8(1); // colourPrimaries: BT.709
  writer.u8(1); // transferCharacteristics: BT.709
  writer.u8(1); // matrixCoefficients: BT.709
  writer.u16(0); // codecInitializationDataSize
  return fullBox('vpcC', 1, 0, writer.build());
}

/**
 * Opus の設定ボックス（dOps）。
 * WebCodecs の description は OpusHead（リトルエンディアン）なので、
 * ビッグエンディアンの dOps へ並べ替える。無い場合は既定値で組む。
 */
export function buildDOps(channels, sampleRate, opusHead) {
  let outputChannels = Math.max(1, Math.min(255, channels));
  let preSkip = 3840;
  let inputSampleRate = sampleRate;
  let outputGain = 0;

  if (opusHead && opusHead.length >= 19) {
    const view = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
    outputChannels = opusHead[9] || outputChannels;
    preSkip = view.getUint16(10, true);
    inputSampleRate = view.getUint32(12, true) || sampleRate;
    outputGain = view.getInt16(16, true);
  }

  const writer = new ByteWriter(11);
  writer.u8(0); // Version
  writer.u8(outputChannels);
  writer.u16(preSkip);
  writer.u32(inputSampleRate);
  writer.u16(outputGain & 0xffff);
  writer.u8(0); // ChannelMappingFamily
  return box('dOps', writer.build());
}

function clampByte(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : fallback;
}

function writeMatrix(writer) {
  // 単位行列（回転なし）
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  for (const value of matrix) writer.u32(value);
}

function estimateLastDelta(times) {
  if (times.length < 2) return 1;
  return Math.max(1, times[times.length - 1] - times[times.length - 2]);
}

function asciiBytes(text) {
  const writer = new ByteWriter(text.length);
  writer.ascii(text);
  return writer.build();
}

function u32Bytes(value) {
  return new ByteWriter(4).u32(value).build();
}

function concat(arrays) {
  let size = 0;
  for (const array of arrays) size += array.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

/* ---------- 検証用の簡易パーサ（テストとデバッグに使う） ---------- */

/**
 * トップレベル〜指定深さの箱を列挙する。
 * @returns {{type:string, size:number, offset:number, children?:Array}[]}
 */
export function parseBoxes(bytes, start = 0, end = bytes.length, depth = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    let type = '';
    for (let i = 0; i < 4; i += 1) type += String.fromCharCode(view.getUint8(offset + 4 + i));
    if (size < 8 || offset + size > end) break;
    const entry = { type, size, offset };
    if (depth < 6 && CONTAINERS.has(type)) {
      entry.children = parseBoxes(bytes, offset + 8, offset + size, depth + 1);
    }
    boxes.push(entry);
    offset += size;
  }
  return boxes;
}

/** 箱の木から type を辿って探す（例: findBox(boxes, ['moov','trak','mdia'])） */
export function findBox(boxes, path) {
  let current = boxes;
  let found = null;
  for (const type of path) {
    found = (current || []).find((b) => b.type === type);
    if (!found) return null;
    current = found.children;
  }
  return found;
}
