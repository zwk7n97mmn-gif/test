/**
 * 字幕（キュー）の生成・整形・入出力（純粋関数）。
 * Cue = { id, start, end, text, needsText }  // 時刻はソース素材の秒
 */

import { clamp, formatTime, normalizeSegments, parseTime, toFinite, uid } from './util.js';

export const SUBTITLE_LIMITS = Object.freeze({
  minDuration: 0.7,
  maxDuration: 7,
  maxCharsPerLine: 20,
  maxLines: 2,
  /** 読める速さの上限（1 秒あたりの文字数）。超過は警告表示に使う */
  maxCharsPerSecond: 12,
  /** 表示上の 1 キュー最大文字数（超過分はデータとしては保持する） */
  softMaxChars: 200,
});

/** 行頭に置けない文字（行末に追い出す） */
const NO_LINE_START = '、。，．・：；？！゛゜ヽヾゝゞ々ー」』）］｝〉》〕”’)]}」,.!?…';
/** 行末に置けない文字（次行へ送る） */
const NO_LINE_END = '「『（［｛〈《〔“‘([{「';

/**
 * 日本語の禁則処理つき行折返し。
 * @param {string} text
 * @param {number} maxCharsPerLine
 * @param {number} [maxLines] 指定時は超過分を最終行にまとめる
 * @returns {string[]}
 */
export function wrapText(text, maxCharsPerLine, maxLines = Infinity) {
  const chars = [...String(text ?? '').replace(/\r\n?/g, '\n')];
  const limit = Math.max(1, Math.floor(maxCharsPerLine));
  if (!chars.length) return [];
  const lines = [];
  let current = '';

  const pushLine = () => {
    if (current.length) lines.push(current);
    current = '';
  };

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\n') {
      pushLine();
      continue;
    }
    current += ch;
    if ([...current].length < limit) continue;

    // 行末禁則: 行末が開き括弧なら 1 文字次行へ送る
    let carry = '';
    let arr = [...current];
    if (arr.length > 1 && NO_LINE_END.includes(arr[arr.length - 1])) {
      carry = arr.pop();
      current = arr.join('');
    }
    // 行頭禁則: 次の文字が行頭禁止なら現在行に押し込む（ぶら下げ）
    const next = chars[i + 1];
    if (!carry && next && NO_LINE_START.includes(next)) {
      current += next;
      i += 1;
    }
    pushLine();
    current = carry;
  }
  pushLine();

  if (!Number.isFinite(maxLines) || lines.length <= maxLines) return lines;
  const head = lines.slice(0, maxLines - 1);
  head.push(lines.slice(maxLines - 1).join(''));
  return head;
}

/**
 * 発話区間から字幕キューを生成する。
 * テキストは STT が無い場合 空文字 + needsText=true（ダミー文言は入れない）。
 * @param {{start:number,end:number,text?:string}[]} segments
 * @param {{maxDuration?:number, minDuration?:number}} [opt]
 */
export function cuesFromSegments(segments, opt = {}) {
  const maxDuration = opt.maxDuration ?? SUBTITLE_LIMITS.maxDuration;
  const minDuration = opt.minDuration ?? SUBTITLE_LIMITS.minDuration;
  const out = [];
  for (const seg of normalizeSegments(segments)) {
    const length = seg.end - seg.start;
    // 長すぎる発話は等分割して読みやすい長さに落とす
    const parts = Math.max(1, Math.ceil(length / maxDuration));
    const step = length / parts;
    const texts = splitTextEvenly(seg.text ?? '', parts);
    for (let i = 0; i < parts; i += 1) {
      const start = seg.start + step * i;
      const end = i === parts - 1 ? seg.end : start + step;
      if (end - start < Math.min(minDuration, length)) continue;
      const text = texts[i] ?? '';
      out.push({ id: uid('cue'), start, end, text, needsText: text.trim().length === 0 });
    }
  }
  return out;
}

const SENTENCE_END = '、。！？!?';

/** テキストを句読点優先で n 分割（テキストが無ければ空文字配列） */
export function splitTextEvenly(text, parts) {
  const s = String(text ?? '');
  const n = Math.max(1, Math.floor(parts));
  if (n === 1) return [s];
  if (!s) return new Array(n).fill('');
  const chars = [...s];
  const per = Math.ceil(chars.length / n);
  const out = [];
  let index = 0;
  for (let i = 0; i < n; i += 1) {
    const ideal = Math.min(chars.length, index + per);
    const end = findBreak(chars, index, ideal, per);
    out.push(chars.slice(index, end).join(''));
    index = end;
  }
  if (index < chars.length) out[out.length - 1] += chars.slice(index).join('');
  return out;
}

/**
 * 理想位置の前後を探索し、句読点の直後を切れ目として選ぶ。
 * 見つからなければ理想位置をそのまま返す。
 */
function findBreak(chars, from, ideal, per) {
  if (ideal >= chars.length) return chars.length;
  const window = Math.max(1, Math.min(4, Math.floor(per / 2)));
  for (let k = 0; k <= window; k += 1) {
    for (const candidate of k === 0 ? [ideal] : [ideal + k, ideal - k]) {
      if (candidate <= from || candidate > chars.length) continue;
      if (SENTENCE_END.includes(chars[candidate - 1])) return candidate;
    }
  }
  return ideal;
}

/**
 * キュー列を正規化する：時刻順・重なり解消・最小長確保・範囲クランプ。
 * @param {object[]} cues
 * @param {number} duration 0 の場合は上限クランプを行わない
 */
export function normalizeCues(cues, duration = 0) {
  const total = Math.max(0, toFinite(duration, 0));
  const list = (cues || [])
    .map((c) => ({
      id: c.id || uid('cue'),
      start: Math.max(0, toFinite(c.start, 0)),
      end: Math.max(0, toFinite(c.end, 0)),
      text: String(c.text ?? ''),
      needsText: c.needsText === true || String(c.text ?? '').trim() === '',
    }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  for (const cue of list) {
    if (total > 0) {
      cue.start = clamp(cue.start, 0, total);
      cue.end = clamp(cue.end, 0, total);
      if (cue.end - cue.start < 1e-3) continue;
    }
    const prev = out[out.length - 1];
    if (prev && cue.start < prev.end) {
      // 重なりは中点で分割する
      const mid = (prev.end + cue.start) / 2;
      if (mid > prev.start + 0.1 && mid < cue.end - 0.1) {
        prev.end = mid;
        cue.start = mid;
      } else {
        cue.start = prev.end;
      }
      if (cue.end - cue.start < 1e-3) continue;
    }
    out.push(cue);
  }
  return out;
}

/** 読み速度（文字/秒） */
export function charsPerSecond(cue) {
  const len = [...String(cue?.text ?? '')].length;
  const dur = Math.max(0.001, toFinite(cue?.end, 0) - toFinite(cue?.start, 0));
  return len / dur;
}

/**
 * キューの品質検査。UI の警告表示に使う。
 * @returns {{id:string, level:'error'|'warn', message:string}[]}
 */
export function validateCues(cues, limits = SUBTITLE_LIMITS) {
  const issues = [];
  const list = cues || [];
  for (let i = 0; i < list.length; i += 1) {
    const cue = list[i];
    const dur = toFinite(cue.end, 0) - toFinite(cue.start, 0);
    if (dur <= 0) {
      issues.push({ id: cue.id, level: 'error', message: '終了時刻が開始時刻以前です。' });
      continue;
    }
    if (cue.needsText || !String(cue.text).trim()) {
      issues.push({ id: cue.id, level: 'warn', message: 'テキストが未入力です。' });
    }
    if (dur < limits.minDuration) {
      issues.push({ id: cue.id, level: 'warn', message: `表示時間が短すぎます（${dur.toFixed(2)}秒）。` });
    }
    if (dur > limits.maxDuration) {
      issues.push({ id: cue.id, level: 'warn', message: `表示時間が長すぎます（${dur.toFixed(1)}秒）。分割を検討してください。` });
    }
    if (charsPerSecond(cue) > limits.maxCharsPerSecond) {
      issues.push({ id: cue.id, level: 'warn', message: '文字数に対して表示時間が不足しています。' });
    }
    const prev = list[i - 1];
    if (prev && cue.start < prev.end - 1e-3) {
      issues.push({ id: cue.id, level: 'error', message: '直前のキューと時間が重なっています。' });
    }
  }
  return issues;
}

/** SRT 文字列へ変換 */
export function toSRT(cues, opt = {}) {
  const wrap = opt.maxCharsPerLine ?? 0;
  const list = normalizeCues(cues);
  if (!list.length) return '';
  return `${list
    .map((cue, index) => {
      const text = wrap > 0 ? wrapText(cue.text, wrap, opt.maxLines ?? Infinity).join('\n') : String(cue.text ?? '');
      const from = formatTime(cue.start, { ms: true, comma: true, hours: 'always' });
      const to = formatTime(cue.end, { ms: true, comma: true, hours: 'always' });
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join('\n\n')}\n`;
}

/** WebVTT 文字列へ変換 */
export function toVTT(cues, opt = {}) {
  const wrap = opt.maxCharsPerLine ?? 0;
  const list = normalizeCues(cues);
  const body = list
    .map((cue) => {
      const text = wrap > 0 ? wrapText(cue.text, wrap, opt.maxLines ?? Infinity).join('\n') : String(cue.text ?? '');
      const from = formatTime(cue.start, { ms: true, comma: false, hours: 'always' });
      const to = formatTime(cue.end, { ms: true, comma: false, hours: 'always' });
      return `${from} --> ${to}\n${text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

/**
 * SRT / WebVTT を解析する。行番号・BOM・CRLF・VTT の設定行に耐性あり。
 * @returns {{cues:object[], errors:string[]}}
 */
export function parseSubtitles(input) {
  const errors = [];
  const text = String(input ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return { cues: [], errors: ['ファイルが空です。'] };

  const blocks = text.split(/\n{2,}/);
  const cues = [];
  const timeLine = /(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}/;

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) && lines.length === 1) continue;
    const timeIndex = lines.findIndex((l) => timeLine.test(l));
    if (timeIndex === -1) continue;
    const [fromRaw, toRaw] = lines[timeIndex].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTime(fromRaw);
    const end = parseTime(toRaw);
    if (start === null || end === null || end <= start) {
      errors.push(`時刻を解釈できない字幕をスキップしました: ${lines[timeIndex]}`);
      continue;
    }
    const body = lines.slice(timeIndex + 1).join('\n').trim();
    cues.push({ id: uid('cue'), start, end, text: body, needsText: body === '' });
  }
  if (!cues.length && !errors.length) errors.push('字幕を 1 件も検出できませんでした。SRT / VTT 形式か確認してください。');
  return { cues: normalizeCues(cues), errors };
}

/** 全キューを一定秒ずらす（負値可、0 未満にはならない） */
export function shiftCues(cues, deltaSec) {
  const d = toFinite(deltaSec, 0);
  return (cues || []).map((c) => ({
    ...c,
    start: Math.max(0, toFinite(c.start, 0) + d),
    end: Math.max(0.001, toFinite(c.end, 0) + d),
  }));
}

/** 指定時刻に表示すべきキュー（タイムライン時刻で渡すこと） */
export function cueAt(cues, time) {
  const t = toFinite(time, 0);
  for (const cue of cues || []) {
    if (t >= cue.start && t < cue.end) return cue;
  }
  return null;
}

/** 字幕全文（キャプション生成の入力） */
export function plainText(cues) {
  return (cues || [])
    .map((c) => String(c.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
}
