/**
 * 素材の実体（File / URL / 要素）を保持するランタイム。
 *
 * プロジェクト（core 側）は素材のメタ情報だけを持ち、
 * 実際の video / img 要素と Blob URL はここで管理する。
 * 永続化できないため、復帰時は OPFS から読み直してここへ再登録する。
 */

import { loadVideo, resolveDuration } from './decoder.js';
import { createImageAsset, createVideoAsset } from '../core/assets.js';

/** 画像として扱える形式 */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'];

export function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name || '');
}

export function isVideoFile(file) {
  if (!file) return false;
  if (file.type?.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|mkv|ogv|m4v)$/i.test(file.name || '');
}

/**
 * 画像ファイルを読み込んで素材メタと要素を得る。
 * @returns {Promise<{asset:object, element:HTMLImageElement, url:string}>}
 */
export async function loadImage(file, durationSec) {
  const url = URL.createObjectURL(file);
  const element = new Image();
  element.decoding = 'async';
  element.src = url;
  try {
    // decode() は描画可能になるまで待てる（drawImage の空振りを防ぐ）
    if (typeof element.decode === 'function') await element.decode();
    else await new Promise((resolve, reject) => {
      element.addEventListener('load', resolve, { once: true });
      element.addEventListener('error', () => reject(new Error('画像を読み込めませんでした。')), { once: true });
    });
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`画像を読み込めませんでした：${file.name}（対応していない形式の可能性があります）`);
  }
  const width = element.naturalWidth;
  const height = element.naturalHeight;
  if (!(width > 0 && height > 0)) {
    URL.revokeObjectURL(url);
    throw new Error(`画像のサイズを取得できませんでした：${file.name}`);
  }
  const asset = createImageAsset({
    name: file.name,
    size: file.size,
    type: file.type || 'image',
    width,
    height,
    duration: durationSec,
  });
  return { asset, element, url };
}

/**
 * 動画ファイルを読み込んで素材メタと要素を得る。
 * @returns {Promise<{asset:object, element:HTMLVideoElement, url:string}>}
 */
export async function loadVideoAsset(file) {
  const { video, url, meta } = await loadVideo(file);
  const asset = createVideoAsset({
    name: meta.name,
    size: meta.size,
    type: meta.type,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    hasAudio: false, // 解析で判明したら更新する
  });
  return { asset, element: video, url };
}

/**
 * 素材 ID → 実体 の対応を保持する。
 */
export function createAssetRuntime() {
  /** @type {Map<string, {asset:object, file:File, url:string, element:HTMLVideoElement|HTMLImageElement, thumb:HTMLVideoElement|HTMLImageElement|null}>} */
  const entries = new Map();

  async function makeThumbElement(asset, url) {
    // 画像は同じ要素を使い回せる。動画はプレビュー再生とサムネイル用で位置が競合するため分ける。
    if (asset.kind === 'image') return null;
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 8000);
    });
    await resolveDuration(video).catch(() => 0);
    return video;
  }

  return {
    /** 登録済みの素材 ID */
    ids() {
      return [...entries.keys()];
    },

    has(assetId) {
      return entries.has(assetId);
    },

    get(assetId) {
      return entries.get(assetId) || null;
    },

    /** 描画に使う要素（video なら現在のフレーム、image ならその画像） */
    element(assetId) {
      return entries.get(assetId)?.element || null;
    },

    url(assetId) {
      return entries.get(assetId)?.url || null;
    },

    file(assetId) {
      return entries.get(assetId)?.file || null;
    },

    /** サムネイル抽出用の要素（動画は専用、画像は本体） */
    thumbElement(assetId) {
      const entry = entries.get(assetId);
      if (!entry) return null;
      return entry.thumb || entry.element;
    },

    /**
     * 実体を登録する。
     * @param {{asset:object, element:object, url:string, file:File}} input
     */
    async add({ asset, element, url, file }) {
      const thumb = await makeThumbElement(asset, url);
      entries.set(asset.id, { asset, element, url, file, thumb });
      return asset;
    },

    remove(assetId) {
      const entry = entries.get(assetId);
      if (!entry) return;
      try {
        if (entry.element instanceof HTMLVideoElement) {
          entry.element.removeAttribute('src');
          entry.element.load();
        }
        if (entry.thumb instanceof HTMLVideoElement) {
          entry.thumb.removeAttribute('src');
          entry.thumb.load();
        }
        URL.revokeObjectURL(entry.url);
      } catch {
        /* 後片付けの失敗は無視 */
      }
      entries.delete(assetId);
    },

    /** プロジェクトに無い素材の実体を解放する */
    prune(validIds) {
      const keep = new Set(validIds);
      for (const id of [...entries.keys()]) {
        if (!keep.has(id)) this.remove(id);
      }
    },

    clear() {
      for (const id of [...entries.keys()]) this.remove(id);
    },
  };
}

/**
 * 書き出し専用の、プレビューとは独立した要素一式を作る。
 *
 * プレビュー用の video 要素は既に音声グラフへ接続済みで、
 * 同じ要素から 2 つ目の MediaElementSource は作れない。
 * そのため MediaRecorder 経路では新しい要素を用意する。
 *
 * @param {object[]} assets
 * @param {(assetId:string)=>string|null} getUrl
 */
export async function createDetachedRuntime(assets, getUrl) {
  const map = new Map();
  for (const asset of assets || []) {
    const url = getUrl(asset.id);
    if (!url) continue;
    if (asset.kind === 'image') {
      const image = new Image();
      image.src = url;
      try {
        if (typeof image.decode === 'function') await image.decode();
      } catch {
        /* 読み込めない画像は空のまま扱う */
      }
      map.set(asset.id, { element: image, url });
    } else {
      const video = document.createElement('video');
      video.src = url;
      video.playsInline = true;
      video.preload = 'auto';
      await new Promise((resolve) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 8000);
      });
      map.set(asset.id, { element: video, url });
    }
  }
  return {
    ids: () => [...map.keys()],
    element: (assetId) => map.get(assetId)?.element || null,
    url: (assetId) => map.get(assetId)?.url || null,
    thumbElement: (assetId) => map.get(assetId)?.element || null,
    file: () => null,
    has: (assetId) => map.has(assetId),
    get: (assetId) => map.get(assetId) || null,
    dispose() {
      for (const entry of map.values()) {
        if (entry.element instanceof HTMLVideoElement) {
          try {
            entry.element.removeAttribute('src');
            entry.element.load();
          } catch {
            /* 無視 */
          }
        }
      }
      map.clear();
    },
  };
}
