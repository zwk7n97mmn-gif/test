#!/usr/bin/env node
/**
 * 姿勢推定に必要なアセットを public/ 配下へ配置する。
 *
 *  - MediaPipe Tasks Vision の WASM 一式 … node_modules からコピー（ネットワーク不要）
 *  - PoseLandmarker のモデル(.task)      … Google の公開ストレージから取得
 *
 * 実行後はオフラインでもアプリが動作する（CDN への実行時依存を残さない）。
 */
import { createWriteStream } from 'node:fs';
import { cp, mkdir, stat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');

const MODELS = [
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    minBytes: 1_000_000,
  },
  {
    name: 'pose_landmarker_full.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    minBytes: 1_000_000,
    optional: true,
  },
];

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function copyWasm() {
  const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const dest = join(publicDir, 'mediapipe', 'wasm');
  if (!(await exists(src))) {
    throw new Error(
      `MediaPipe の WASM が見つかりません: ${src}\n先に \`npm install\` を実行してください。`,
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`✓ WASM を配置しました → public/mediapipe/wasm`);
}

async function download(model) {
  const dest = join(publicDir, 'models', model.name);
  if (await exists(dest)) {
    console.log(`- ${model.name} は既に存在するためスキップします`);
    return true;
  }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    const res = await fetch(model.url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const s = await stat(tmp);
    if (s.size < model.minBytes) {
      throw new Error(`ダウンロードしたファイルが小さすぎます (${s.size} bytes)`);
    }
    await cp(tmp, dest);
    await rm(tmp, { force: true });
    console.log(`✓ ${model.name} (${(s.size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch (err) {
    await rm(tmp, { force: true });
    const message = err instanceof Error ? err.message : String(err);
    if (model.optional) {
      console.warn(`- ${model.name} は取得できませんでした（任意アセット）: ${message}`);
      return true;
    }
    console.error(`✗ ${model.name} の取得に失敗しました: ${message}`);
    console.error(`  手動で次のURLからダウンロードし、public/models/ に置いてください:\n  ${model.url}`);
    return false;
  }
}

async function main() {
  await copyWasm();
  let ok = true;
  for (const model of MODELS) {
    if (!(await download(model))) ok = false;
  }
  if (!ok) {
    process.exitCode = 1;
    return;
  }
  console.log('\nアセットの準備が完了しました。`npm run dev` で起動できます。');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
