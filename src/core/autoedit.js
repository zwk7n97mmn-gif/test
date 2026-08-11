/**
 * 自動編集とタイムラインモデル（純粋関数）。
 *
 * clip = { id, start, end, speed, enabled }  // start/end はソース素材の秒
 * タイムライン時刻は enabled なクリップを順に連結し、speed で割った長さで積み上げる。
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

/** 素材全体を 1 クリップにした初期タイムライン */
export function fullClip(duration) {
  const end = Math.max(0, toFinite(duration, 0));
  return [{ id: uid('clip'), start: 0, end, speed: 1, enabled: true }];
}

/** クリップ配列の健全化（範囲外・逆転・0 長・不正 speed を除去） */
export function sanitizeClips(clips, duration) {
  const total = Math.max(0, toFinite(duration, 0));
  const out = [];
  for (const clip of clips || []) {
    const start = clamp(clip.start, 0, total);
    const end = clamp(clip.end, 0, total);
    if (end - start < 1e-3) continue;
    out.push({
      id: clip.id || uid('clip'),
      start,
      end,
      speed: clamp(clip.speed ?? 1, 0.25, 8),
      enabled: clip.enabled !== false,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 発話区間から自動カットプランを生成する。
 * 発話が 0 件、または素材長 0 の場合は素材全体を 1 クリップとして返す（タイムラインを空にしない）。
 * @param {{start:number,end:number}[]} speechSegments
 * @param {number} duration
 * @param {typeof AUTOEDIT_DEFAULTS} [options]
 */
export function buildCutPlan(speechSegments, duration, options = {}) {
  const cfg = { ...AUTOEDIT_DEFAULTS, ...options };
  const total = Math.max(0, toFinite(duration, 0));
  if (total <= 0) return [];
  const speech = normalizeSegments(speechSegments).filter((s) => s.start < total);
  if (!speech.length) return fullClip(total);

  // 1. パディング付与 → 2. 近接区間の結合
  const padded = normalizeSegments(
    speech.map((s) => ({
      start: clamp(s.start - cfg.padStart, 0, total),
      end: clamp(s.end + cfg.padEnd, 0, total),
    })),
    { mergeGap: cfg.minGap },
  );

  if (cfg.mode === 'speed') {
    // 無音を削らず倍速クリップとして残す
    const clips = [];
    let cursor = 0;
    for (const seg of padded) {
      if (seg.start - cursor > 1e-3) {
        clips.push({ id: uid('clip'), start: cursor, end: seg.start, speed: clamp(cfg.speedFactor, 1, 8), enabled: true });
      }
      clips.push({ id: uid('clip'), start: seg.start, end: seg.end, speed: 1, enabled: true });
      cursor = seg.end;
    }
    if (total - cursor > 1e-3) {
      clips.push({ id: uid('clip'), start: cursor, end: total, speed: clamp(cfg.speedFactor, 1, 8), enabled: true });
    }
    return mergeTinyClips(clips, cfg.minClip, total);
  }

  const clips = padded.map((seg) => ({
    id: uid('clip'),
    start: seg.start,
    end: seg.end,
    speed: 1,
    enabled: true,
  }));
  return mergeTinyClips(clips, cfg.minClip, total);
}

/** minClip 未満のクリップを隣接クリップへ吸収する（結果が空にならないことを保証） */
export function mergeTinyClips(clips, minClip, duration) {
  const list = sanitizeClips(clips, duration);
  if (list.length <= 1) return list.length ? list : fullClip(duration);
  const out = [];
  for (const clip of list) {
    const len = (clip.end - clip.start) / clip.speed;
    const prev = out[out.length - 1];
    if (len < minClip && prev && prev.speed === clip.speed) {
      prev.end = Math.max(prev.end, clip.end);
    } else {
      out.push({ ...clip });
    }
  }
  // 先頭が短すぎる場合は次と結合
  if (out.length > 1 && (out[0].end - out[0].start) / out[0].speed < minClip) {
    out[1].start = Math.min(out[0].start, out[1].start);
    out.shift();
  }
  return out.length ? out : fullClip(duration);
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
 * タイムライン時刻 → ソース時刻。
 * @returns {{clipIndex:number, sourceTime:number, clip:object}|null} 範囲外は null
 */
export function timelineToSource(clips, timelineTime) {
  const laid = layoutClips(clips);
  if (!laid.length) return null;
  const t = toFinite(timelineTime, 0);
  if (t < 0) return { clipIndex: 0, sourceTime: laid[0].start, clip: laid[0] };
  for (let i = 0; i < laid.length; i += 1) {
    const clip = laid[i];
    if (t < clip.timelineEnd || i === laid.length - 1) {
      const offset = clamp(t - clip.timelineStart, 0, clip.length);
      return { clipIndex: i, sourceTime: clip.start + offset * (clip.speed || 1), clip };
    }
  }
  return null;
}

/**
 * ソース時刻 → タイムライン時刻。削除された区間の時刻は「直後のクリップ先頭」に丸める。
 * @returns {{timelineTime:number, visible:boolean}}
 */
export function sourceToTimeline(clips, sourceTime) {
  const laid = layoutClips(clips);
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
 * 指定ソース時刻でクリップを分割する。
 * @returns {object[]} 新しいクリップ配列（分割不能ならそのまま）
 */
export function splitAt(clips, sourceTime) {
  const t = toFinite(sourceTime, 0);
  const out = [];
  let changed = false;
  for (const clip of clips || []) {
    if (t > clip.start + 1e-3 && t < clip.end - 1e-3) {
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
 * 字幕（ソース時刻）をタイムライン時刻へ写像する。
 * - 削除区間に完全に含まれるキューは除外する
 * - 跨るキューは可視部分だけに切り詰める（合計時間が縮む）
 * - タイムライン上で連続する断片は 1 本に戻し、つなぎ目でのちらつきを防ぐ
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
      const from = Math.max(start, clip.start);
      const to = Math.min(end, clip.end);
      if (to - from <= 1e-3) continue;
      const tlStart = clip.timelineStart + (from - clip.start) / (clip.speed || 1);
      const tlEnd = clip.timelineStart + (to - clip.start) / (clip.speed || 1);
      const last = out[out.length - 1];
      if (last && last.id === cue.id && Math.abs(last.end - tlStart) < 1e-3) {
        last.end = tlEnd; // 連続クリップに跨る場合は 1 本に戻す
      } else {
        out.push({ ...cue, start: tlStart, end: tlEnd });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 削除された合計秒数と削減率 */
export function editSummary(clips, duration) {
  const total = Math.max(0, toFinite(duration, 0));
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
