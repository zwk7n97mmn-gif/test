#!/usr/bin/env node
/**
 * PWA 用のアイコン PNG を生成する。
 *
 * 画像ライブラリを増やさずに済むよう、ラスタを自前で描いて Node 標準の zlib で
 * PNG にエンコードする（依存は node:zlib のみ）。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

// ---------------------------------------------------------------------------
// PNG エンコーダ（RGBA / フィルタなし）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // フィルタタイプ: None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 描画（アンチエイリアス付きの簡易ラスタライザ）
// ---------------------------------------------------------------------------
function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4);
  const blend = (x, y, [r, g, b], alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = Math.min(1, alpha);
    data[i] = data[i] * (1 - a) + r * a;
    data[i + 1] = data[i + 1] * (1 - a) + g * a;
    data[i + 2] = data[i + 2] * (1 - a) + b * a;
    data[i + 3] = Math.min(255, data[i + 3] + 255 * a);
  };

  /** 符号付き距離関数を渡して塗る。境界 1px でアンチエイリアスする。 */
  const fill = (sdf, color) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        if (d < 1) blend(x, y, color, Math.min(1, 1 - d));
      }
    }
  };

  return { data, fill };
}

const roundedRect = (x0, y0, x1, y1, radius) => (x, y) => {
  const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
  const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
  return Math.hypot(dx, dy) - radius;
};

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

const capsule = (x0, y0, x1, y1, r) => (x, y) => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lengthSq));
  return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t)) - r;
};

const hex = (value) => {
  const v = value.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};

/**
 * 人型シルエット + ビートの弧。
 * @param maskable true ならセーフゾーン（中央80%）に収める
 */
function drawIcon(size, maskable) {
  const canvas = createCanvas(size);
  const s = (v) => v * size;
  const inset = maskable ? 0.1 : 0;
  const k = 1 - inset * 2;
  const px = (v) => s(inset + v * k);

  // 背景
  canvas.fill(roundedRect(0, 0, size, size, maskable ? 0 : s(0.22)), hex('#1f1c2b'));
  canvas.fill(circle(s(0.5), s(0.52), s(maskable ? 0.42 : 0.38)), hex('#2b2739'));

  const accent = hex('#ff8fc0');
  const light = hex('#8ac7ff');

  // 人型（頭・胴・腕・脚）
  canvas.fill(circle(px(0.5), px(0.27), px(0.085)), accent);
  canvas.fill(capsule(px(0.5), px(0.37), px(0.5), px(0.58), px(0.07)), accent);
  canvas.fill(capsule(px(0.5), px(0.4), px(0.31), px(0.3), px(0.042)), accent);
  canvas.fill(capsule(px(0.5), px(0.4), px(0.7), px(0.28), px(0.042)), accent);
  canvas.fill(capsule(px(0.46), px(0.58), px(0.4), px(0.8), px(0.048)), accent);
  canvas.fill(capsule(px(0.54), px(0.58), px(0.62), px(0.79), px(0.048)), accent);

  // ビートを表す弧
  for (let i = 0; i < 3; i++) {
    const radius = px(0.3 + i * 0.055);
    canvas.fill((x, y) => {
      const dx = x - px(0.5);
      const dy = y - px(0.56);
      const d = Math.abs(Math.hypot(dx, dy) - radius) - px(0.008);
      // 下側の弧だけ描く
      return dy > 0 && Math.abs(dx) > Math.abs(dy) * 0.4 ? d : 1e9;
    }, light);
  }

  return encodePng(size, size, canvas.data);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const targets = [
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-512.png', size: 512, maskable: false },
    { name: 'icon-maskable-512.png', size: 512, maskable: true },
    { name: 'apple-touch-icon.png', size: 180, maskable: false },
  ];
  for (const target of targets) {
    const png = drawIcon(target.size, target.maskable);
    await writeFile(join(outDir, target.name), png);
    console.log(`✓ ${target.name} (${(png.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`\nアイコンを public/icons/ に生成しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
