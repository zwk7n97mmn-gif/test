/**
 * 素材（アセット）モデル。
 *
 * v2 までは「1 本の動画」を前提にしていたが、画像を並べたスライドショーや
 * 複数クリップの連結を扱えるよう、素材を配列で持つ形へ拡張した。
 * clips は assetId でここを参照し、start/end は**その素材の中の時刻**を表す。
 */

import { clamp, toFinite, uid } from './util.js';

/** 画像 1 枚あたりの既定の表示秒数 */
export const IMAGE_DEFAULT_DURATION = 3;
export const IMAGE_DURATION_RANGE = Object.freeze({ min: 0.5, max: 30 });
/** 画像素材に与える擬似 fps（書き出し時のフレーム生成に使う） */
export const IMAGE_FPS = 30;

export const ASSET_KINDS = Object.freeze({
  video: { id: 'video', label: '動画' },
  image: { id: 'image', label: '画像' },
});

/**
 * 動画素材を作る。
 * @param {{name:string, size?:number, type?:string, duration:number,
 *          width:number, height:number, fps?:number, hasAudio?:boolean}} meta
 */
export function createVideoAsset(meta) {
  return sanitizeAsset({ ...meta, id: meta.id || uid('as'), kind: 'video' });
}

/**
 * 画像素材を作る。表示秒数は duration として保持する。
 * @param {{name:string, size?:number, type?:string, width:number, height:number, duration?:number}} meta
 */
export function createImageAsset(meta) {
  return sanitizeAsset({
    ...meta,
    id: meta.id || uid('as'),
    kind: 'image',
    duration: meta.duration ?? IMAGE_DEFAULT_DURATION,
    hasAudio: false,
    fps: IMAGE_FPS,
  });
}

/** 1 件の素材を安全な形へ正規化する */
export function sanitizeAsset(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = input.kind === 'image' ? 'image' : 'video';
  const duration = kind === 'image'
    ? clamp(toFinite(input.duration, IMAGE_DEFAULT_DURATION), IMAGE_DURATION_RANGE.min, IMAGE_DURATION_RANGE.max)
    : Math.max(0, toFinite(input.duration, 0));
  const width = Math.max(0, Math.round(toFinite(input.width, 0)));
  const height = Math.max(0, Math.round(toFinite(input.height, 0)));
  if (duration <= 0 || width <= 0 || height <= 0) return null;
  return {
    id: typeof input.id === 'string' && input.id ? input.id : uid('as'),
    kind,
    name: String(input.name ?? (kind === 'image' ? '画像' : '動画')).slice(0, 200),
    size: Math.max(0, toFinite(input.size, 0)),
    type: String(input.type ?? '').slice(0, 100),
    duration,
    width,
    height,
    fps: kind === 'image' ? IMAGE_FPS : clamp(toFinite(input.fps, 30), 1, 240),
    hasAudio: kind === 'image' ? false : input.hasAudio === true,
  };
}

/** 素材配列を正規化する（不正な要素は落とす） */
export function sanitizeAssets(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const asset = sanitizeAsset(item);
    if (!asset || seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push(asset);
  }
  return out;
}

export function findAsset(assets, assetId) {
  return (assets || []).find((a) => a.id === assetId) || null;
}

/**
 * 代表素材。出力サイズの既定値やサムネイルの初期値に使う。
 * 動画があればその最初の 1 本、無ければ最初の素材。
 */
export function primaryAsset(assets) {
  const list = assets || [];
  return list.find((a) => a.kind === 'video') || list[0] || null;
}

export function hasAnyAudio(assets) {
  return (assets || []).some((a) => a.kind === 'video' && a.hasAudio);
}

/** 素材の合計時間（タイムラインの長さではなく素材そのものの総尺） */
export function totalAssetDuration(assets) {
  return (assets || []).reduce((sum, a) => sum + a.duration, 0);
}

/**
 * 素材 1 件につき 1 クリップの初期タイムラインを作る。
 * @param {object[]} assets
 */
export function clipsFromAssets(assets) {
  return (assets || []).map((asset) => ({
    id: uid('clip'),
    assetId: asset.id,
    start: 0,
    end: asset.duration,
    speed: 1,
    enabled: true,
  }));
}

/**
 * 画像素材の表示秒数を変更し、その素材を使うクリップの範囲も追従させる。
 * @returns {{assets:object[], clips:object[]}}
 */
export function setImageDuration(assets, clips, assetId, seconds) {
  const duration = clamp(toFinite(seconds, IMAGE_DEFAULT_DURATION), IMAGE_DURATION_RANGE.min, IMAGE_DURATION_RANGE.max);
  const nextAssets = (assets || []).map((a) => (a.id === assetId && a.kind === 'image' ? { ...a, duration } : a));
  const target = findAsset(nextAssets, assetId);
  if (!target || target.kind !== 'image') return { assets: nextAssets, clips: clips || [] };
  const nextClips = (clips || []).map((clip) => (clip.assetId === assetId ? { ...clip, start: 0, end: duration } : clip));
  return { assets: nextAssets, clips: nextClips };
}

/**
 * 素材を削除し、その素材を参照するクリップも取り除く。
 */
export function removeAsset(assets, clips, assetId) {
  return {
    assets: (assets || []).filter((a) => a.id !== assetId),
    clips: (clips || []).filter((c) => c.assetId !== assetId),
  };
}

/**
 * 素材の並び順を入れ替え、クリップの並びも同じ順序に揃える。
 * クリップは「素材の順序 → 元の並び」で安定ソートする。
 * @param {number} from 移動元の位置
 * @param {number} to 移動先の位置
 */
export function moveAsset(assets, clips, from, to) {
  const list = [...(assets || [])];
  if (from < 0 || from >= list.length) return { assets: list, clips: clips || [] };
  const target = clamp(Math.round(to), 0, list.length - 1);
  const [moved] = list.splice(from, 1);
  list.splice(target, 0, moved);

  const order = new Map(list.map((a, i) => [a.id, i]));
  const decorated = (clips || []).map((clip, index) => ({ clip, index }));
  decorated.sort((a, b) => {
    const oa = order.has(a.clip.assetId) ? order.get(a.clip.assetId) : Number.MAX_SAFE_INTEGER;
    const ob = order.has(b.clip.assetId) ? order.get(b.clip.assetId) : Number.MAX_SAFE_INTEGER;
    return oa - ob || a.index - b.index;
  });
  return { assets: list, clips: decorated.map((d) => d.clip) };
}

/**
 * 旧形式（media 単体）から素材配列へ移行する。
 * @param {object|null} media
 * @returns {object[]}
 */
export function assetsFromLegacyMedia(media) {
  const asset = sanitizeAsset({ ...(media || {}), kind: 'video' });
  return asset ? [asset] : [];
}
