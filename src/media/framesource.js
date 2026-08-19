/**
 * 書き出し用のフレーム取得。
 *
 * 計測の結果、動画のフレーム単位シークが 1 枚あたり約 59ms かかり、
 * 描画 0.2ms・エンコード 2.6ms に対して圧倒的な支配要因だった。
 * 先読み数 1 / 2 / 3 を実測したが書き出し時間はほぼ変わらず（測定ノイズの範囲）、
 * video 要素を増やすほど素材を多重にバッファしてメモリを食うため、既定は逐次シークとする。
 * 再生 + requestVideoFrameCallback 方式は表示リフレッシュに律速されフレームが落ちるため不採用。
 *
 * 画像素材はシークが不要なので、そのまま要素を返す。
 */

import { clamp } from '../core/util.js';

/**
 * 先読み数の既定値。上記の実測より、増やす利点がないため 1。
 */
export function defaultLookahead() {
  return 1;
}

/**
 * 出力フレーム列に対応する素材の絵を順番に取り出す。
 *
 * @param {{frames:{assetId:string, time:number, kind:'video'|'image'}[],
 *          getUrl:(assetId:string)=>string|null,
 *          getImage:(assetId:string)=>HTMLImageElement|null,
 *          lookahead?:number, signal?:AbortSignal}} opt
 */
export function createFrameSource(opt) {
  const frames = opt.frames || [];
  const lookahead = clamp(opt.lookahead ?? defaultLookahead(), 1, 6);
  /** 素材ごとの書き出し専用 video 要素（プレビュー用と競合させない） */
  const videos = new Map();
  let index = 0;
  let disposed = false;

  function videoFor(assetId) {
    if (videos.has(assetId)) return videos.get(assetId);
    const url = opt.getUrl?.(assetId);
    if (!url) return null;
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    videos.set(assetId, video);
    return video;
  }

  async function ready(video) {
    if (video.readyState >= 2) return;
    await new Promise((resolve) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 8000);
    });
  }

  return {
    lookahead,
    total: frames.length,

    /**
     * 次のフレームの描画元を返す。
     * @returns {Promise<{element:object, index:number, release:Function}|null>}
     */
    async next() {
      if (disposed || index >= frames.length) return null;
      const current = index;
      index += 1;
      const frame = frames[current];

      if (frame.kind === 'image') {
        return { element: opt.getImage?.(frame.assetId) || null, index: current, release() {} };
      }
      const video = videoFor(frame.assetId);
      if (!video) return { element: null, index: current, release() {} };
      await ready(video);
      await seekTo(video, frame.time);
      return { element: video, index: current, release() {} };
    },

    dispose() {
      disposed = true;
      for (const video of videos.values()) {
        try {
          video.removeAttribute('src');
          video.load();
        } catch {
          /* 後片付けの失敗は無視 */
        }
      }
      videos.clear();
    },
  };
}

export function seekTo(video, time, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('seeked', done, { once: true });
    try {
      video.currentTime = time;
    } catch {
      done();
    }
  });
}
