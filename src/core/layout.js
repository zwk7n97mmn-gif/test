/**
 * 出力フレームの寸法と、素材をそこへ収める矩形の計算（純粋関数）。
 *
 * 横素材から縦動画を作る／縦素材を正方形にする、といった変換のために
 * 「出力サイズ」と「素材をどう当てはめるか」を分離して扱う。
 */

import { clamp, toFinite } from './util.js';

/** 選べる出力の向き */
export const ASPECTS = Object.freeze({
  source: { id: 'source', label: '元のまま', ratio: null, hint: '素材と同じ縦横比' },
  '9:16': { id: '9:16', label: '縦 9:16', ratio: 9 / 16, hint: 'TikTok / リール / ショート' },
  '1:1': { id: '1:1', label: '正方形 1:1', ratio: 1, hint: 'Instagram フィード' },
  '4:5': { id: '4:5', label: '縦 4:5', ratio: 4 / 5, hint: 'Instagram フィード（縦長）' },
  '16:9': { id: '16:9', label: '横 16:9', ratio: 16 / 9, hint: 'YouTube / 一般的な横動画' },
});

/** 素材の当てはめ方 */
export const FITS = Object.freeze({
  contain: { id: 'contain', label: '全体を収める', hint: '見切れないが余白が出ます' },
  cover: { id: 'cover', label: '画面いっぱい', hint: '余白は出ませんが端が切れます' },
});

/**
 * 出力の長辺として許す最大値（4K）。
 * これ以上は端末のエンコーダが受け付けないことが多く、実用的な上限でもある。
 */
export const MAX_OUTPUT_SIZE = 3840;

/** 余白の埋め方 */
export const BACKGROUNDS = Object.freeze({
  blur: { id: 'blur', label: 'ぼかし', hint: '素材を引き伸ばしてぼかした背景' },
  black: { id: 'black', label: '黒', hint: '単色の黒' },
  white: { id: 'white', label: '白', hint: '単色の白' },
});

export const OUTPUT_DEFAULTS = Object.freeze({
  aspect: 'source',
  fit: 'contain',
  background: 'blur',
  /**
   * 長辺の上限。既定は「素材のまま」を意味する上限値。
   * 実際には拡大しないので、素材が小さければ出力も小さい。
   * 端末の負荷を下げたいときは書き出しパネルで 1080 などへ落とせる。
   */
  maxSize: MAX_OUTPUT_SIZE,
});

/** 偶数へ丸める（映像エンコーダは奇数サイズを嫌う） */
export function evenSize(value, min = 2) {
  return Math.max(min, Math.round(toFinite(value, min) / 2) * 2);
}

/**
 * 出力サイズを決める基準となる「素材の寸法」を求める。
 *
 * 動画があれば**動画だけ**を基準にする（無ければ画像で決める）。
 *
 * - **縦横比**は基準素材のうち先頭のもの。
 * - **解像度**は基準素材のうち長辺が最大のもの。
 *
 * 先頭素材だけで決めると、小さい画像を先頭に置いただけで後ろの高解像度動画まで
 * 縮んでしまう。かといって全素材の最大に合わせると、4K 写真を 1 枚混ぜただけで
 * 1080p の動画が 4K へ引き伸ばされ、ファイルサイズと書き出し時間だけが増える。
 * 実際の編集ソフトと同じく「出力は素材動画に従う」を採る。
 *
 * 縦横比と解像度で基準を変えないのも重要で、たとえば 2:3 の写真が先頭・
 * 9:16 の動画が 2 番目という並びで両者を混ぜると、どちらの素材とも一致しない
 * 1280×1920 のような出力ができてしまう。
 *
 * @param {object[]} assets
 * @param {{width:number, height:number}} fallback 素材が無いときの既定
 * @returns {{width:number, height:number}}
 */
export function sizingSource(assets, fallback = { width: 1280, height: 720 }) {
  const list = (assets || []).filter((a) => a && a.width > 0 && a.height > 0);
  if (!list.length) return { ...fallback };
  // 動画があれば動画だけを基準にする。1 本も無ければ画像で決める。
  const videos = list.filter((a) => a.kind !== 'image');
  const basis = videos.length ? videos : list;

  const reference = basis[0];
  const referenceLongest = Math.max(reference.width, reference.height);
  let longest = 0;
  for (const asset of basis) longest = Math.max(longest, asset.width, asset.height);

  const scale = longest / referenceLongest;
  return { width: reference.width * scale, height: reference.height * scale };
}

/**
 * 出力サイズを決める。
 *
 * @param {{aspect?:string, maxSize?:number}} output
 * @param {{width:number, height:number}} source 基準となる素材サイズ（`sizingSource()`）
 * @returns {{width:number, height:number, ratio:number}}
 */
export function resolveOutputSize(output, source) {
  const cfg = { ...OUTPUT_DEFAULTS, ...(output || {}) };
  const maxSize = clamp(cfg.maxSize, 240, MAX_OUTPUT_SIZE);
  const sw = Math.max(1, Math.round(toFinite(source?.width, 1280)));
  const sh = Math.max(1, Math.round(toFinite(source?.height, 720)));

  const aspect = ASPECTS[cfg.aspect] || ASPECTS.source;
  const ratio = aspect.ratio ?? sw / sh;

  // 長辺が maxSize に収まる範囲で、できるだけ素材の情報量を保つ
  let width;
  let height;
  if (ratio >= 1) {
    width = Math.min(maxSize, Math.max(sw, sh));
    height = width / ratio;
  } else {
    height = Math.min(maxSize, Math.max(sw, sh));
    width = height * ratio;
  }
  // 縮小はしても拡大はしない（素材より大きくしても画質は上がらない）
  const sourceLongest = Math.max(sw, sh);
  const outputLongest = Math.max(width, height);
  if (outputLongest > sourceLongest) {
    const scale = sourceLongest / outputLongest;
    width *= scale;
    height *= scale;
  }
  return { width: evenSize(width, 16), height: evenSize(height, 16), ratio };
}

/**
 * 素材を出力フレームへ当てはめる矩形を求める。
 *
 * @param {number} srcW 素材の幅
 * @param {number} srcH 素材の高さ
 * @param {number} dstW 出力の幅
 * @param {number} dstH 出力の高さ
 * @param {'contain'|'cover'} fit
 * @returns {{x:number, y:number, width:number, height:number, scale:number, cropped:boolean, letterboxed:boolean}}
 */
export function computeFitRect(srcW, srcH, dstW, dstH, fit = 'contain') {
  const sw = Math.max(1, toFinite(srcW, 1));
  const sh = Math.max(1, toFinite(srcH, 1));
  const dw = Math.max(1, toFinite(dstW, 1));
  const dh = Math.max(1, toFinite(dstH, 1));
  const scaleContain = Math.min(dw / sw, dh / sh);
  const scaleCover = Math.max(dw / sw, dh / sh);
  const scale = fit === 'cover' ? scaleCover : scaleContain;
  const width = sw * scale;
  const height = sh * scale;
  return {
    x: (dw - width) / 2,
    y: (dh - height) / 2,
    width,
    height,
    scale,
    // 1px 未満の差は丸め誤差として扱う
    cropped: width > dw + 1 || height > dh + 1,
    letterboxed: width < dw - 1 || height < dh - 1,
  };
}

/**
 * 当てはめの結果をユーザーへ説明する文言。
 */
export function describeFraming(srcW, srcH, output) {
  const size = resolveOutputSize(output, { width: srcW, height: srcH });
  const rect = computeFitRect(srcW, srcH, size.width, size.height, output?.fit);
  const label = `${size.width}×${size.height}`;
  if (rect.cropped) {
    const keptW = Math.round((size.width / rect.width) * 100);
    const keptH = Math.round((size.height / rect.height) * 100);
    const kept = Math.min(keptW, keptH);
    return `${label}（画面いっぱい・素材の約 ${kept}% が映ります）`;
  }
  if (rect.letterboxed) {
    return `${label}（全体を収める・余白あり）`;
  }
  return `${label}（ぴったり収まります）`;
}
