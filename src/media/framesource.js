/**
 * 書き出し用のフレーム取得。
 *
 * 計測の結果、フレーム単位のシークが 1 枚あたり約 59ms かかり、
 * 描画 0.2ms・エンコード 2.6ms に対して圧倒的な支配要因だった。
 * シークは 1 つの video 要素では直列にしか進まないため、
 * 複数の要素へ先読みを振り分けて重ね合わせる（パイプライン化）。
 *
 * 再生して requestVideoFrameCallback で拾う方式も検討したが、
 * 表示リフレッシュに律速されて倍速再生でフレームが落ちるため採用しない。
 */

import { clamp } from '../core/util.js';

/**
 * 先読み数の既定値。
 *
 * 先読み 1 / 2 / 3 を実測したところ書き出し時間はほぼ変わらなかった
 * （3.62 秒の出力に対して 6.9 / 7.6 / 5.8 秒＝測定ノイズの範囲）。
 * video 要素を増やすとその分だけ素材を多重にバッファしてメモリを食い、
 * スマートフォンではタブ破棄の原因になるため、既定は 1 とする。
 */
export function defaultLookahead() {
  return 1;
}

/**
 * 指定した時刻列のフレームを順番に取り出す。
 *
 * @param {{sourceUrl:string, times:number[], lookahead?:number, signal?:AbortSignal}} opt
 * @returns {{next:()=>Promise<HTMLVideoElement|null>, dispose:()=>void, lookahead:number}}
 */
export function createFrameSource(opt) {
  const times = opt.times || [];
  const lookahead = clamp(opt.lookahead ?? defaultLookahead(), 1, 6);
  /** @type {{video:HTMLVideoElement, busy:boolean}[]} */
  const pool = [];
  /** @type {{index:number, promise:Promise<HTMLVideoElement|null>, slot:object}[]} */
  const queue = [];
  let nextToSchedule = 0;
  let nextToReturn = 0;
  let disposed = false;

  function makeVideo() {
    const video = document.createElement('video');
    video.src = opt.sourceUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    return video;
  }

  async function ready(video) {
    if (video.readyState >= 2) return;
    await new Promise((resolve, reject) => {
      const onError = () => reject(new Error('書き出し用に素材を読み込めませんでした。'));
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', onError, { once: true });
      setTimeout(resolve, 8000);
    });
  }

  function schedule() {
    while (queue.length < lookahead && nextToSchedule < times.length && !disposed) {
      const index = nextToSchedule;
      nextToSchedule += 1;
      const slot = pool.find((s) => !s.busy) || (pool.length < lookahead ? addSlot() : null);
      if (!slot) break;
      slot.busy = true;
      queue.push({ index, slot, promise: seekSlot(slot, times[index]) });
    }
  }

  function addSlot() {
    const slot = { video: makeVideo(), busy: false };
    pool.push(slot);
    return slot;
  }

  async function seekSlot(slot, time) {
    await ready(slot.video);
    await seekTo(slot.video, time);
    return slot.video;
  }

  return {
    lookahead,
    /**
     * 次のフレームが描画可能になった video 要素を返す。
     * 返した要素は release() を呼ぶまで再利用されない。
     */
    async next() {
      if (disposed || nextToReturn >= times.length) return null;
      schedule();
      const entry = queue.shift();
      if (!entry) return null;
      const video = await entry.promise;
      nextToReturn += 1;
      return {
        video,
        index: entry.index,
        release() {
          entry.slot.busy = false;
          schedule();
        },
      };
    },
    dispose() {
      disposed = true;
      for (const slot of pool) {
        slot.video.removeAttribute('src');
        slot.video.load();
      }
      pool.length = 0;
      queue.length = 0;
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
