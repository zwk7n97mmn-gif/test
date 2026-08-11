/**
 * サムネイル：候補フレームのランキングとテキストレイアウト（純粋関数）。
 */

import { clamp, toFinite } from './util.js';
import { isInsideSegments } from './analysis.js';
import { wrapText } from './subtitles.js';

export const THUMBNAIL_SIZE = Object.freeze({ width: 1280, height: 720 });

export const THUMBNAIL_TEMPLATES = Object.freeze({
  boldBottom: {
    id: 'boldBottom',
    label: '太字ボトム（王道）',
    align: 'bottom',
    titleRatio: 0.13,
    subtitleRatio: 0.055,
    scrim: 0.55,
    stroke: 0.14,
  },
  leftPanel: {
    id: 'leftPanel',
    label: '左パネル（解説向け）',
    align: 'left',
    titleRatio: 0.11,
    subtitleRatio: 0.05,
    scrim: 0.62,
    stroke: 0.1,
  },
  centerImpact: {
    id: 'centerImpact',
    label: 'センターインパクト',
    align: 'center',
    titleRatio: 0.16,
    subtitleRatio: 0.06,
    scrim: 0.45,
    stroke: 0.16,
  },
});

export const THUMBNAIL_WEIGHTS = Object.freeze({
  sharp: 0.4,
  contrast: 0.2,
  colorful: 0.2,
  exposure: 0.2,
  cutPenalty: 0.25,
  speechBonus: 0.1,
});

/**
 * フレーム品質からサムネイル候補を採点・並べ替えする。
 * @param {{t:number, sharp:number, contrast:number, colorful:number, exposure:number}[]} frames
 * @param {{start:number,end:number}[]} scenes
 * @param {{start:number,end:number}[]} speech
 * @param {{limit?:number, minSpacingSec?:number, duration?:number}} [opt]
 * @returns {{t:number, score:number, sceneIndex:number}[]}
 */
export function rankThumbnailCandidates(frames, scenes = [], speech = [], opt = {}) {
  const limit = Math.max(1, Math.floor(opt.limit ?? 8));
  const minSpacing = toFinite(opt.minSpacingSec, 1.5);
  const list = frames || [];
  if (!list.length) return [];

  const cutTimes = [];
  for (const scene of scenes) {
    cutTimes.push(toFinite(scene.start, 0));
    cutTimes.push(toFinite(scene.end, 0));
  }

  const scored = list.map((frame) => {
    const t = toFinite(frame.t, 0);
    const nearCut = cutTimes.some((c) => Math.abs(c - t) < 0.3);
    // 冒頭・末尾はロゴや暗転になりやすいので軽く減点する
    const duration = toFinite(opt.duration, 0);
    const edgePenalty = duration > 4 && (t < 0.5 || t > duration - 0.5) ? 0.15 : 0;
    const base =
      THUMBNAIL_WEIGHTS.sharp * clamp(frame.sharp, 0, 1) +
      THUMBNAIL_WEIGHTS.contrast * clamp(frame.contrast, 0, 1) +
      THUMBNAIL_WEIGHTS.colorful * clamp(frame.colorful, 0, 1) +
      THUMBNAIL_WEIGHTS.exposure * clamp(frame.exposure, 0, 1);
    const bonus = isInsideSegments(t, speech) ? THUMBNAIL_WEIGHTS.speechBonus : 0;
    const penalty = (nearCut ? THUMBNAIL_WEIGHTS.cutPenalty : 0) + edgePenalty;
    const sceneIndex = scenes.findIndex((s) => t >= s.start && t < s.end);
    return { t, score: clamp(base + bonus - penalty, 0, 1), sceneIndex: sceneIndex < 0 ? 0 : sceneIndex };
  });

  scored.sort((a, b) => b.score - a.score || a.t - b.t);

  // 近すぎる候補・同一シーンの重複を間引いて多様性を確保する
  const picked = [];
  const usedScenes = new Set();
  for (const cand of scored) {
    if (picked.length >= limit) break;
    if (picked.some((p) => Math.abs(p.t - cand.t) < minSpacing)) continue;
    if (usedScenes.has(cand.sceneIndex) && usedScenes.size < Math.min(limit, scenes.length || limit)) continue;
    usedScenes.add(cand.sceneIndex);
    picked.push(cand);
  }
  // 多様性フィルタで足りない場合は素点順に補充する
  for (const cand of scored) {
    if (picked.length >= limit) break;
    if (picked.some((p) => Math.abs(p.t - cand.t) < 0.4)) continue;
    picked.push(cand);
  }
  return picked.slice(0, limit).sort((a, b) => b.score - a.score);
}

/**
 * サムネイルのテキストレイアウトを計算する（描画は canvas 側）。
 * 文字数に応じてフォントサイズを縮め、セーフエリアからはみ出さないようにする。
 *
 * @param {{title:string, subtitle:string, template:string, width?:number, height?:number, safeRatio?:number}} input
 * @returns {{titleLines:string[], subtitleLines:string[], titleSize:number, subtitleSize:number,
 *            box:{x:number,y:number,width:number,height:number}, align:string, strokeWidth:number, scrim:number}}
 */
export function layoutThumbnailText(input) {
  const width = Math.max(320, Math.floor(toFinite(input?.width, THUMBNAIL_SIZE.width)));
  const height = Math.max(180, Math.floor(toFinite(input?.height, THUMBNAIL_SIZE.height)));
  const template = THUMBNAIL_TEMPLATES[input?.template] || THUMBNAIL_TEMPLATES.boldBottom;
  const safeRatio = clamp(toFinite(input?.safeRatio, 0.06), 0.02, 0.15);
  const margin = Math.round(Math.min(width, height) * safeRatio);
  const boxWidth = template.align === 'left' ? Math.round(width * 0.55) : width - margin * 2;

  const title = String(input?.title ?? '').trim();
  const subtitle = String(input?.subtitle ?? '').trim();

  let titleSize = Math.round(height * template.titleRatio);
  const minTitleSize = Math.round(height * 0.055);
  // 日本語全角は概ね 1em 幅として概算し、3 行以内に収まるまで縮小する
  let titleLines = [];
  for (;;) {
    const perLine = Math.max(4, Math.floor(boxWidth / (titleSize * 0.95)));
    titleLines = title ? wrapText(title, perLine, 3) : [];
    if (titleLines.length <= 2 || titleSize <= minTitleSize) break;
    titleSize -= Math.max(2, Math.round(titleSize * 0.06));
  }
  const subtitleSize = Math.max(Math.round(height * 0.032), Math.round(height * template.subtitleRatio));
  const subPerLine = Math.max(6, Math.floor(boxWidth / (subtitleSize * 0.95)));
  const subtitleLines = subtitle ? wrapText(subtitle, subPerLine, 2) : [];

  const lineHeight = titleSize * 1.2;
  const subLineHeight = subtitleSize * 1.3;
  const blockHeight = titleLines.length * lineHeight + (subtitleLines.length ? subtitleLines.length * subLineHeight + titleSize * 0.35 : 0);

  let x = margin;
  let y = margin;
  if (template.align === 'bottom') y = height - margin - blockHeight;
  else if (template.align === 'center') y = Math.round((height - blockHeight) / 2);
  else y = Math.round((height - blockHeight) / 2);

  return {
    titleLines,
    subtitleLines,
    titleSize,
    subtitleSize,
    lineHeight,
    subLineHeight,
    box: { x, y: Math.max(margin, y), width: boxWidth, height: blockHeight },
    align: template.align,
    strokeWidth: Math.max(2, Math.round(titleSize * template.stroke)),
    scrim: template.scrim,
    margin,
  };
}

/**
 * 字幕から自動でサムネ用の見出し候補を作る（最も情報量の多い短文を採用）。
 * テキストが無い場合は空文字を返し、UI が「入力してください」を表示する。
 */
export function suggestThumbnailTitle(cues, maxChars = 18) {
  const texts = (cues || [])
    .map((c) => String(c.text ?? '').trim())
    .filter((t) => t.length > 0);
  if (!texts.length) return '';
  const scored = texts.map((text) => {
    const chars = [...text];
    const lengthScore = 1 - Math.abs(chars.length - maxChars) / (maxChars * 2);
    const punctuationPenalty = /[、。]/.test(text.slice(-1)) ? 0.05 : 0;
    const kanjiRatio = (text.match(/[一-龯]/g) || []).length / Math.max(1, chars.length);
    return { text, score: lengthScore + kanjiRatio * 0.5 - punctuationPenalty };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].text.replace(/[。、]$/u, '');
  return [...best].slice(0, maxChars).join('');
}
