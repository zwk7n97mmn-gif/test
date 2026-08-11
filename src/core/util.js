/** 汎用ユーティリティ（DOM 非依存 / 副作用なし） */

/** 数値を [min,max] に収める。NaN は min に落とす。 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

/** 有限数でなければ fallback を返す */
export function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 衝突しにくい短い ID */
let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/**
 * 秒 → タイムコード文字列。
 * @param {number} sec
 * @param {{ms?:boolean, comma?:boolean, hours?:'auto'|'always'}} [opt]
 */
export function formatTime(sec, opt = {}) {
  const { ms = false, comma = false, hours = 'auto' } = opt;
  let s = toFinite(sec, 0);
  const negative = s < 0;
  if (negative) s = 0;
  const totalMs = Math.round(s * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const milli = totalMs % 1000;
  const p2 = (n) => String(n).padStart(2, '0');
  const head = hours === 'always' || h > 0 ? `${p2(h)}:` : '';
  const body = `${p2(m)}:${p2(ss)}`;
  if (!ms) return `${head}${body}`;
  return `${head}${body}${comma ? ',' : '.'}${String(milli).padStart(3, '0')}`;
}

/** "00:01:02,500" / "1:02.5" / "62" → 秒。解釈不能なら null */
export function parseTime(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const raw = text.trim().replace(',', '.');
  if (!raw) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(raw)) return null;
  const parts = raw.split(':');
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) ? seconds : null;
}

/** 秒 → "1分23秒" 等の読み上げ向け表現 */
export function speakableTime(sec) {
  const s = Math.max(0, Math.round(toFinite(sec, 0)));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest}秒`;
  return `${m}分${rest}秒`;
}

/** バイト数を人間可読に */
export function formatBytes(bytes) {
  const b = Math.max(0, toFinite(bytes, 0));
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** 昇順ソート済み配列から p 分位（0..1）を線形補間で取得 */
export function percentileSorted(sortedValues, p) {
  const n = sortedValues.length;
  if (n === 0) return 0;
  if (n === 1) return sortedValues[0];
  const pos = clamp(p, 0, 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/** 未ソート配列の分位（元配列は破壊しない） */
export function percentile(values, p) {
  return percentileSorted(Array.from(values).sort((a, b) => a - b), p);
}

export function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

/** 線形振幅 → dBFS（0 以下は floorDb） */
export function amplitudeToDb(amp, floorDb = -100) {
  const a = toFinite(amp, 0);
  if (a <= 1e-10) return floorDb;
  return Math.max(floorDb, 20 * Math.log10(a));
}

export function dbToGain(db) {
  return Math.pow(10, toFinite(db, 0) / 20);
}

/** 区間 [start,end) の配列を正規化（負の長さ除去・時刻順ソート・重なり結合） */
export function normalizeSegments(segments, { mergeGap = 0 } = {}) {
  const list = (segments || [])
    .map((s) => ({ ...s, start: toFinite(s.start, 0), end: toFinite(s.end, 0) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const seg of list) {
    const last = out[out.length - 1];
    if (last && seg.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, seg.end);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** 区間の補集合を [0,duration] の範囲で得る */
export function invertSegments(segments, duration) {
  const total = Math.max(0, toFinite(duration, 0));
  const src = normalizeSegments(segments).filter((s) => s.start < total);
  const out = [];
  let cursor = 0;
  for (const seg of src) {
    const start = clamp(seg.start, 0, total);
    if (start > cursor) out.push({ start: cursor, end: start });
    cursor = Math.max(cursor, clamp(seg.end, 0, total));
  }
  if (cursor < total) out.push({ start: cursor, end: total });
  return out;
}

/** 末尾のみ実行する debounce */
export function debounce(fn, waitMs) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** 例外を投げない実行ラッパ。{ok:true,value} / {ok:false,error} */
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** ユーザー向けエラーメッセージへ変換 */
export function describeError(error) {
  if (!error) return '不明なエラーが発生しました。';
  const name = error.name || '';
  const msg = error.message || String(error);
  if (name === 'AbortError') return '処理をキャンセルしました。';
  if (name === 'NotSupportedError' || /decode|codec/i.test(msg)) {
    return 'このファイルのコーデックにブラウザが対応していません。MP4(H.264/AAC) か WebM への変換をお試しください。';
  }
  if (name === 'QuotaExceededError') return 'ブラウザの保存容量が不足しています。不要なプロジェクトを削除してください。';
  if (name === 'SecurityError') return 'セキュリティ制限により処理できませんでした。ローカルファイルを直接指定してください。';
  if (/NetworkError|Failed to fetch/i.test(msg)) return 'ネットワークに接続できませんでした。接続と設定を確認してください。';
  return msg;
}

/** 長文の安全な省略（表示専用。データは切り詰めない） */
export function ellipsize(text, maxChars) {
  const s = String(text ?? '');
  const max = Math.max(1, Math.floor(maxChars));
  return [...s].length <= max ? s : `${[...s].slice(0, max - 1).join('')}…`;
}
