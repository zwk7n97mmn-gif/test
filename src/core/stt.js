/**
 * 音声認識（STT）プロバイダの抽象化。
 *
 * - 'vad'    : 外部通信なし。発話区間の「タイムコードのみ」を自動生成し、テキストは未入力のまま返す。
 *              （架空のテキストを生成しないことを設計上の原則とする）
 * - 'remote' : OpenAI 互換の /v1/audio/transcriptions を呼び、テキストまで自動生成する。
 *              API キーはメモリ上のみで保持し、プロジェクトには保存しない。
 */

import { normalizeSegments, toFinite, uid } from './util.js';
import { cuesFromSegments } from './subtitles.js';

export const STT_PROVIDERS = Object.freeze({
  vad: {
    id: 'vad',
    label: '発話区間のみ（オフライン）',
    requiresNetwork: false,
    producesText: false,
    description: '通信せずに字幕の開始・終了時刻だけを自動生成します。テキストはご自身で入力してください。',
  },
  remote: {
    id: 'remote',
    label: '外部 STT（OpenAI 互換 API）',
    requiresNetwork: true,
    producesText: true,
    description: '設定したエンドポイントへ音声を送信し、テキストまで自動生成します。音声が外部へ送信される点にご注意ください。',
  },
});

export const STT_DEFAULTS = Object.freeze({
  providerId: 'vad',
  endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'whisper-1',
  language: 'ja',
});

/**
 * 発話区間だけから字幕キューを生成する（テキストは空 = needsText）。
 */
export function transcribeWithVad(speechSegments) {
  const segments = normalizeSegments(speechSegments);
  return {
    cues: cuesFromSegments(segments),
    providerId: 'vad',
    hasText: false,
    notice:
      segments.length === 0
        ? '発話区間を検出できませんでした。素材に音声が含まれているか確認してください。'
        : `${segments.length} 件の発話区間からタイムコードを生成しました。テキストを入力してください。`,
  };
}

/**
 * STT API のレスポンス（verbose_json / json のいずれか）を解析する。
 * @param {any} payload
 * @returns {{cues:object[], errors:string[]}}
 */
export function parseTranscriptionResponse(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { cues: [], errors: ['STT の応答を解釈できませんでした。'] };
  }
  if (payload.error) {
    const message = typeof payload.error === 'string' ? payload.error : payload.error.message || 'STT がエラーを返しました。';
    return { cues: [], errors: [message] };
  }
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : null;
  if (rawSegments && rawSegments.length) {
    const cues = rawSegments
      .map((seg) => ({
        id: uid('cue'),
        start: toFinite(seg.start, 0),
        end: toFinite(seg.end, 0),
        text: String(seg.text ?? '').trim(),
      }))
      .filter((c) => c.end > c.start)
      .map((c) => ({ ...c, needsText: c.text === '' }));
    if (!cues.length) errors.push('タイムコード付きの結果が含まれていませんでした。');
    return { cues, errors };
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    // タイムコードなし応答：単一キューとして返し、呼び出し側が VAD 区間へ割り当てる
    return { cues: [], errors: [], plainText: payload.text.trim() };
  }
  return { cues: [], errors: ['STT の応答に文字起こし結果が含まれていませんでした。'] };
}

/**
 * タイムコードなしのテキストを、VAD で得た発話区間へ文字数比で割り当てる。
 */
export function alignTextToSegments(text, speechSegments) {
  const segments = normalizeSegments(speechSegments);
  const source = String(text ?? '').trim();
  if (!segments.length || !source) return [];
  const sentences = source.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  const units = sentences.length ? sentences : [source];
  const totalChars = units.reduce((sum, s) => sum + [...s].length, 0) || 1;
  const totalTime = segments.reduce((sum, s) => sum + (s.end - s.start), 0) || 1;

  const cues = [];
  let unitIndex = 0;
  let charBudgetUsed = 0;
  for (const seg of segments) {
    const share = ((seg.end - seg.start) / totalTime) * totalChars;
    let taken = '';
    while (unitIndex < units.length && [...taken].length < share) {
      taken += units[unitIndex];
      unitIndex += 1;
    }
    charBudgetUsed += [...taken].length;
    cues.push({ id: uid('cue'), start: seg.start, end: seg.end, text: taken.trim(), needsText: taken.trim() === '' });
  }
  if (unitIndex < units.length && cues.length) {
    const rest = units.slice(unitIndex).join('');
    cues[cues.length - 1].text = `${cues[cues.length - 1].text}${rest}`.trim();
    cues[cues.length - 1].needsText = false;
  }
  void charBudgetUsed;
  return cues;
}

/**
 * リモート STT を実行する。
 * @param {{blob:Blob, filename?:string, endpoint:string, model:string, language:string, apiKey:string}} req
 * @param {{signal?:AbortSignal, fetchImpl?:Function}} [opt]
 * @returns {Promise<{cues:object[], plainText?:string, errors:string[]}>}
 */
export async function transcribeRemote(req, opt = {}) {
  const fetchImpl = opt.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('この環境では fetch が利用できません。');
  if (!req?.endpoint) throw new Error('STT エンドポイントが設定されていません。');
  if (!req?.blob) throw new Error('送信する音声データがありません。');

  const form = new FormData();
  form.append('file', req.blob, req.filename || 'audio.wav');
  form.append('model', req.model || STT_DEFAULTS.model);
  form.append('response_format', 'verbose_json');
  if (req.language) form.append('language', req.language);

  const headers = {};
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;

  const res = await fetchImpl(req.endpoint, { method: 'POST', body: form, headers, signal: opt.signal });
  const contentType = res.headers?.get?.('content-type') || '';
  let payload;
  if (contentType.includes('application/json')) {
    payload = await res.json();
  } else {
    const text = await res.text();
    payload = { error: { message: text.slice(0, 300) || `HTTP ${res.status}` } };
  }
  if (!res.ok) {
    const message =
      (payload && payload.error && (payload.error.message || payload.error)) || `STT サーバがエラーを返しました（HTTP ${res.status}）。`;
    return { cues: [], errors: [String(message)] };
  }
  return parseTranscriptionResponse(payload);
}
