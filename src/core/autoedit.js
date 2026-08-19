/**
 * 自動編集とタイムラインモデル（純粋関数）。
 *
 * clip = { id, assetId, start, end, speed, enabled }
 *   start/end は **その素材（assetId）の中の秒**。
 * タイムライン時刻は enabled なクリップを順に連結し、speed で割った長さで積み上げる。
 *
 * 素材は動画とは限らず、画像（表示秒数ぶんの静止クリップ）も同じ形で並ぶ。
 */

import { clamp, normalizeSegments, toFinite, uid } from './util.js';

export const AUTOEDIT_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'cut', // 'cut' = 無音を削除 / 'speed' = 無音を倍速
  padStart: 0.15,
  padEnd: 0.35,
  minGap: 0.6, // これ未満の無音は詰めない（結合する）
  minClip: 0.4, // これ未満のクリップは前後へ吸収
  speedFactor: 2.5,
});

/**
 * 素材の長さを引く関数を作る。
 * @param {number|((assetId:string)=>number)|object[]} source 数値・関数・素材配列のいずれか
 */
export function durationLookup(source) {
  if (typeof source === 'function') return source;
  if (Array.isArray(source)) {
    const map = new Map(source.map((a) => [a.id, Math.max(0, toFinite(a.duration, 0))]));
    return (assetId) => map.get(assetId) ?? 0;
  }
  const value = Math.max(0, toFinite(source, 0));
  return () => value;
}

/** 素材全体を 1 クリップにしたもの */
export function fullClip(duration, assetId = null) {
  const end = Math.max(0, toFinite(duration, 0));
  return [{ id: uid('clip'), assetId, start: 0, end, speed: 1, enabled: true }];
}

/**
 * クリップ配列の健全化（範囲外・逆転・0 長・不正 speed を除去）。
 * @param {object[]} clips
 * @param {number|Function|object[]} durations 素材の長さ（数値／関数／素材配列）
 */
export function sanitizeClips(clips, durations) {
  const lookup = durationLookup(durations);
  const out = [];
  for (const clip of clips || []) {
    const total = Math.max(0, toFinite(lookup(clip?.assetId), 0));
    if (total <= 0) continue; // 参照先の素材が無い / 長さ 0 のクリップは捨てる
    const start = clamp(clip.start, 0, total);
    const end = clamp(clip.end, 0, total);
    if (end - start < 1e-3) continue;
    out.push({
      id: clip.id || uid('clip'),
      assetId: clip.assetId ?? null,
      start,
      end,
      speed: clamp(clip.speed ?? 1, 0.25, 8),
      enabled: clip.enabled !== false,
    });
  }
  return out;
}

/**
 * 1 つのクリップ範囲を、発話区間にもとづいて採用区間へ分解する。
 * 画像素材や発話の無い素材ではそのまま 1 クリップとして返す。
 *
 * @param {object} clip
 * @param {{start:number,end:number}[]} speech その素材の発話区間（素材内の時刻）
 * @param {typeof AUTOEDIT_DEFAULTS} cfg
 */
export function cutClipBySpeech(clip, speech, cfg) {
  const from = clip.start;
  const to = clip.end;
  const inRange = normalizeSegments(speech)
    .map((s) => ({ start: clamp(s.start, from, to), end: clamp(s.end, from, to) }))
    .filter((s) => s.end - s.start > 1e-3);

  if (!inRange.length) return [{ ...clip, id: uid('clip') }];

  const padded = normalizeSegments(
    inRange.map((s) => ({
      start: clamp(s.start - cfg.padStart, from, to),
      end: clamp(s.end + cfg.padEnd, from, to),
    })),
    { mergeGap: cfg.minGap },
  );

  if (cfg.mode === 'speed') {
    // 無音は削らず倍速クリップとして残す
    const out = [];
    let cursor = from;
    for (const seg of padded) {
      if (seg.start - cursor > 1e-3) {
        out.push({ ...clip, id: uid('clip'), start: cursor, end: seg.start, speed: clamp(cfg.speedFactor, 1, 8) });
      }
      out.push({ ...clip, id: uid('clip'), start: seg.start, end: seg.end, speed: 1 });
      cursor = seg.end;
    }
    if (to - cursor > 1e-3) {
      out.push({ ...clip, id: uid('clip'), start: cursor, end: to, speed: clamp(cfg.speedFactor, 1, 8) });
    }
    return out;
  }

  return padded.map((seg) => ({ ...clip, id: uid('clip'), start: seg.start, end: seg.end, speed: 1 }));
}

/**
 * タイムライン全体に自動カットを適用する。
 *
 * @param {object[]} clips 現在のクリップ
 * @param {{assets:object[], speechByAsset:Record<string,{start:number,end:number}[]>,
 *          options?:object}} context
 * @returns {object[]} 新しいクリップ配列（空にはならない）
 */
export function buildCutPlanForClips(clips, context) {
  const cfg = { ...AUTOEDIT_DEFAULTS, ...(context.options || {}) };
  const assets = context.assets || [];
  const speechByAsset = context.speechByAsset || {};
  const sanitized = sanitizeClips(clips, assets);
  if (!sanitized.length) return [];

  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = [];
  for (const clip of sanitized) {
    const asset = byId.get(clip.assetId);
    // 画像には発話が無いので、そのまま残す（表示秒数を勝手に削らない）
    if (!asset || asset.kind === 'image') {
      out.push({ ...clip, id: uid('clip') });
      continue;
    }
    out.push(...cutClipBySpeech(clip, speechByAsset[clip.assetId] || [], cfg));
  }
  return mergeTinyClips(out, cfg.minClip, assets);
}

/** minClip 未満のクリップを隣接クリップへ吸収する（同じ素材どうしのみ） */
export function mergeTinyClips(clips, minClip, durations) {
  const list = sanitizeClips(clips, durations);
  if (list.length <= 1) return list;
  const out = [];
  for (const clip of list) {
    const length = (clip.end - clip.start) / clip.speed;
    const prev = out[out.length - 1];
    const mergeable = prev && prev.assetId === clip.assetId && prev.speed === clip.speed && Math.abs(prev.end - clip.start) < 2;
    if (length < minClip && mergeable) {
      prev.end = Math.max(prev.end, clip.end);
    } else {
      out.push({ ...clip });
    }
  }
  // 先頭が短すぎる場合は次と結合（同じ素材のときだけ）
  if (out.length > 1 && (out[0].end - out[0].start) / out[0].speed < minClip && out[0].assetId === out[1].assetId) {
    out[1].start = Math.min(out[0].start, out[1].start);
    out.shift();
  }
  return out;
}

/** enabled なクリップのみ */
export function activeClips(clips) {
  return (clips || []).filter((c) => c && c.enabled !== false && c.end > c.start);
}

/** タイムラインの総尺（秒） */
export function timelineDuration(clips) {
  let total = 0;
  for (const clip of activeClips(clips)) total += (clip.end - clip.start) / (clip.speed || 1);
  return total;
}

/** 各クリップのタイムライン上の開始位置を付与した配列 */
export function layoutClips(clips) {
  let cursor = 0;
  return activeClips(clips).map((clip) => {
    const length = (clip.end - clip.start) / (clip.speed || 1);
    const entry = { ...clip, timelineStart: cursor, timelineEnd: cursor + length, length };
    cursor += length;
    return entry;
  });
}

/**
 * タイムライン時刻 → 素材内の時刻。
 * @returns {{clipIndex:number, assetId:string|null, sourceTime:number, clip:object}|null}
 */
export function timelineToSource(clips, timelineTime) {
  const laid = layoutClips(clips);
  if (!laid.length) return null;
  const t = toFinite(timelineTime, 0);
  if (t < 0) return { clipIndex: 0, assetId: laid[0].assetId, sourceTime: laid[0].start, clip: laid[0] };
  for (let i = 0; i < laid.length; i += 1) {
    const clip = laid[i];
    if (t < clip.timelineEnd || i === laid.length - 1) {
      const offset = clamp(t - clip.timelineStart, 0, clip.length);
      return {
        clipIndex: i,
        assetId: clip.assetId,
        sourceTime: clip.start + offset * (clip.speed || 1),
        clip,
      };
    }
  }
  return null;
}

/**
 * 素材内の時刻 → タイムライン時刻。
 * assetId を渡すとその素材のクリップだけを対象にする。
 * 削除された区間の時刻は「直後のクリップ先頭」に丸める。
 * @returns {{timelineTime:number, visible:boolean}}
 */
export function sourceToTimeline(clips, sourceTime, assetId = undefined) {
  const laid = layoutClips(clips).filter((c) => assetId === undefined || c.assetId === assetId);
  if (!laid.length) return { timelineTime: 0, visible: false };
  const t = toFinite(sourceTime, 0);
  for (const clip of laid) {
    if (t < clip.start) return { timelineTime: clip.timelineStart, visible: false };
    if (t <= clip.end) {
      return { timelineTime: clip.timelineStart + (t - clip.start) / (clip.speed || 1), visible: true };
    }
  }
  const last = laid[laid.length - 1];
  return { timelineTime: last.timelineEnd, visible: false };
}

/**
 * 指定した素材内時刻でクリップを分割する。
 * @param {string|null} assetId 対象素材（省略時はすべてのクリップが対象）
 */
export function splitAt(clips, sourceTime, assetId = undefined) {
  const t = toFinite(sourceTime, 0);
  const out = [];
  let changed = false;
  for (const clip of clips || []) {
    const matches = assetId === undefined || clip.assetId === assetId;
    if (matches && t > clip.start + 1e-3 && t < clip.end - 1e-3) {
      out.push({ ...clip, id: uid('clip'), end: t });
      out.push({ ...clip, id: uid('clip'), start: t });
      changed = true;
    } else {
      out.push(clip);
    }
  }
  return changed ? out : clips;
}

/**
 * 字幕（素材内の時刻）をタイムライン時刻へ写像する。
 * - 削除区間に完全に含まれるキューは除外する
 * - 跨るキューは可視部分だけに切り詰める（合計時間が縮む）
 * - タイムライン上で連続する断片は 1 本に戻し、つなぎ目でのちらつきを防ぐ
 * - assetId を持つキューは、その素材のクリップにだけ載る
 */
export function projectCuesToTimeline(cues, clips) {
  const laid = layoutClips(clips);
  if (!laid.length) return [];
  const out = [];
  for (const cue of cues || []) {
    const start = toFinite(cue.start, 0);
    const end = toFinite(cue.end, 0);
    if (end <= start) continue;
    for (const clip of laid) {
      if (cue.assetId && clip.assetId && cue.assetId !== clip.assetId) continue;
      const from = Math.max(start, clip.start);
      const to = Math.min(end, clip.end);
      if (to - from <= 1e-3) continue;
      const tlStart = clip.timelineStart + (from - clip.start) / (clip.speed || 1);
      const tlEnd = clip.timelineStart + (to - clip.start) / (clip.speed || 1);
      const last = out[out.length - 1];
      if (last && last.id === cue.id && Math.abs(last.end - tlStart) < 1e-3) {
        last.end = tlEnd;
      } else {
        out.push({ ...cue, start: tlStart, end: tlEnd });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 削除された合計秒数と削減率 */
export function editSummary(clips, sourceDuration) {
  const total = Math.max(0, toFinite(sourceDuration, 0));
  const kept = timelineDuration(clips);
  const removed = Math.max(0, total - kept);
  return {
    sourceDuration: total,
    timelineDuration: kept,
    removedDuration: removed,
    removedRatio: total > 0 ? removed / total : 0,
    clipCount: activeClips(clips).length,
  };
}
