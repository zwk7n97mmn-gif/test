/**
 * SNS キャプション生成（純粋関数・決定的）。
 * 字幕テキスト・尺・シーン情報のみから組み立てる。LLM も乱数も使わない。
 */

import { formatTime, toFinite } from './util.js';

export const PLATFORMS = Object.freeze({
  x: { id: 'x', label: 'X (Twitter)', maxChars: 280, maxHashtags: 3, chapters: false },
  instagram: { id: 'instagram', label: 'Instagram', maxChars: 2200, maxHashtags: 10, chapters: false },
  youtube: { id: 'youtube', label: 'YouTube', maxChars: 5000, maxHashtags: 5, chapters: true },
  tiktok: { id: 'tiktok', label: 'TikTok', maxChars: 2200, maxHashtags: 5, chapters: false },
});

export const TONES = Object.freeze({
  neutral: { id: 'neutral', label: '標準', hook: (kw) => `${kw}について解説します。`, close: '最後までご覧ください。' },
  casual: { id: 'casual', label: 'カジュアル', hook: (kw) => `${kw}、やってみました！`, close: '感想はコメントで教えてください🙌' },
  formal: { id: 'formal', label: 'フォーマル', hook: (kw) => `本動画では${kw}について詳述いたします。`, close: 'ご視聴ありがとうございます。' },
});

/** 除外する一般語 */
const STOPWORDS = new Set([
  'これ', 'それ', 'あれ', 'こちら', 'そこ', 'ここ', 'ため', 'とき', 'こと', 'もの', 'よう', 'ところ',
  'です', 'ます', 'でした', 'ました', 'ですが', 'しかし', 'そして', 'それで', 'あと', 'ちょっと',
  'すごく', 'とても', 'かなり', 'たぶん', 'やっぱり', 'ほんと', 'みたい', '感じ', 'あの', 'その',
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'have', 'are', 'was',
]);

/**
 * キーワード抽出。カタカナ語・漢字語・英数語を候補にし、頻度×長さで重み付けする。
 * @param {string} text
 * @param {number} limit
 * @returns {{word:string, score:number, count:number}[]}
 */
export function extractKeywords(text, limit = 8) {
  const src = String(text ?? '');
  if (!src.trim()) return [];
  const patterns = [
    /[ァ-ヴー]{2,}/g, // カタカナ
    /[一-龯]{2,}/g, // 漢字連続
    /[A-Za-z][A-Za-z0-9+#.-]{1,}/g, // 英数
    /[一-龯][ぁ-ん]{1,2}[一-龯]?/g, // 漢字＋送り仮名
  ];
  const counts = new Map();
  for (const re of patterns) {
    const matches = src.match(re) || [];
    for (const raw of matches) {
      const word = raw.trim();
      const lower = word.toLowerCase();
      if (word.length < 2 || STOPWORDS.has(word) || STOPWORDS.has(lower)) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const total = Math.max(1, [...counts.values()].reduce((a, b) => a + b, 0));
  const scored = [...counts.entries()].map(([word, count]) => ({
    word,
    count,
    score: (count / total) * (1 + Math.min([...word].length, 8) / 8),
  }));
  // 部分文字列の重複（「動画編集」と「編集」）は長い方を残す
  scored.sort((a, b) => b.score - a.score || [...b.word].length - [...a.word].length);
  const picked = [];
  for (const entry of scored) {
    if (picked.some((p) => p.word.includes(entry.word))) continue;
    picked.push(entry);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** キーワードからハッシュタグを作る（記号除去・重複排除） */
export function buildHashtags(keywords, max = 5) {
  const tags = [];
  for (const kw of keywords || []) {
    const word = String(kw.word ?? kw).replace(/[^\p{L}\p{N}_]/gu, '');
    if (!word || word.length < 2) continue;
    const tag = `#${word}`;
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length >= max) break;
  }
  return tags;
}

/** シーンからチャプター行を作る（YouTube 用。先頭は必ず 0:00） */
export function buildChapters(scenes, cues = [], maxChapters = 8) {
  const list = (scenes || []).filter((s) => toFinite(s.end, 0) > toFinite(s.start, 0));
  if (!list.length) return [];
  const step = Math.max(1, Math.ceil(list.length / maxChapters));
  const chapters = [];
  for (let i = 0; i < list.length; i += step) {
    const scene = list[i];
    const start = i === 0 ? 0 : toFinite(scene.start, 0);
    const label = labelForTime(cues, scene) || `チャプター${chapters.length + 1}`;
    chapters.push({ time: start, label });
    if (chapters.length >= maxChapters) break;
  }
  return chapters;
}

function labelForTime(cues, scene) {
  for (const cue of cues || []) {
    if (cue.start >= scene.start && cue.start < scene.end) {
      const text = String(cue.text ?? '').trim().replace(/[。、]$/u, '');
      if (text) return [...text].slice(0, 24).join('');
    }
  }
  return '';
}

/**
 * キャプションを生成する。
 * @param {{cues:object[], scenes:object[], duration:number, platform:string, tone:string,
 *          includeChapters:boolean, includeHashtags:boolean, title?:string}} input
 * @returns {{text:string, hashtags:string[], keywords:object[], truncated:boolean, limit:number, length:number}}
 */
export function generateCaption(input) {
  const platform = PLATFORMS[input?.platform] || PLATFORMS.youtube;
  const tone = TONES[input?.tone] || TONES.neutral;
  const cues = input?.cues || [];
  const duration = Math.max(0, toFinite(input?.duration, 0));
  const body = cues.map((c) => String(c.text ?? '').trim()).filter(Boolean).join(' ');
  const keywords = extractKeywords(body, 10);
  const topic = input?.title?.trim() || keywords[0]?.word || 'この動画';

  const lines = [];
  lines.push(tone.hook(topic));

  if (keywords.length > 1) {
    const points = keywords.slice(0, platform.id === 'x' ? 2 : 4).map((k) => k.word);
    lines.push('', ...points.map((p) => `・${p}`));
  }

  const summary = summarize(cues, platform.id === 'x' ? 1 : 3);
  if (summary) lines.push('', summary);

  if (duration > 0) lines.push('', `⏱ 尺: ${formatTime(duration, { hours: 'auto' })}`);

  if (platform.chapters && input?.includeChapters) {
    const chapters = buildChapters(input?.scenes || [], cues);
    if (chapters.length) {
      lines.push('', '― チャプター ―');
      for (const ch of chapters) lines.push(`${formatTime(ch.time, { hours: 'auto' })} ${ch.label}`);
    }
  }

  lines.push('', tone.close);

  const hashtags = input?.includeHashtags === false ? [] : buildHashtags(keywords, platform.maxHashtags);
  if (hashtags.length) lines.push('', hashtags.join(' '));

  const raw = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const { text, truncated } = fitToLimit(raw, platform.maxChars, hashtags);
  return {
    text,
    hashtags,
    keywords,
    truncated,
    limit: platform.maxChars,
    length: [...text].length,
  };
}

/** 字幕から代表文を選ぶ（長すぎず、内容語を含む文） */
export function summarize(cues, maxSentences = 3) {
  const sentences = [];
  for (const cue of cues || []) {
    const text = String(cue.text ?? '').trim();
    if (!text) continue;
    for (const part of text.split(/(?<=[。！？!?])/)) {
      const s = part.trim();
      if ([...s].length >= 8) sentences.push(s);
    }
  }
  if (!sentences.length) return '';
  const scored = sentences.map((s) => {
    const chars = [...s].length;
    const contentRatio = (s.match(/[一-龯ァ-ヴA-Za-z0-9]/g) || []).length / Math.max(1, chars);
    return { s, score: contentRatio - Math.abs(chars - 40) / 200 };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const entry of scored) {
    if (picked.includes(entry.s)) continue;
    picked.push(entry.s);
    if (picked.length >= maxSentences) break;
  }
  // 元の登場順に戻す
  picked.sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b));
  return picked.join('');
}

/**
 * 文字数上限に収める。ハッシュタグ行は必ず残し、本文側を段落単位で削る。
 */
export function fitToLimit(text, limit, hashtags = []) {
  const max = Math.max(1, Math.floor(limit));
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return { text: String(text ?? ''), truncated: false };

  const tagLine = hashtags.length ? hashtags.join(' ') : '';
  const reserve = tagLine ? [...tagLine].length + 2 : 0;
  const bodyLimit = Math.max(1, max - reserve - 1);

  const paragraphs = String(text).split('\n\n').filter((p) => p.trim() !== tagLine);
  let body = '';
  for (const para of paragraphs) {
    const next = body ? `${body}\n\n${para}` : para;
    if ([...next].length > bodyLimit) break;
    body = next;
  }
  if (!body) body = chars.slice(0, bodyLimit - 1).join('');
  let result = body;
  if ([...result].length > bodyLimit) result = [...result].slice(0, bodyLimit - 1).join('');
  if ([...String(text)].length > [...result].length) result = `${result.replace(/\s+$/, '')}…`;
  if (tagLine) result = `${result}\n\n${tagLine}`;
  const out = [...result].length > max ? [...result].slice(0, max).join('') : result;
  return { text: out, truncated: true };
}
