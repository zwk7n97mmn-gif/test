/**
 * プロジェクトのデータモデル・検証・状態ストア（Undo/Redo・永続化）。
 * DOM に依存しないため Node 上で完全にテストできる。
 */

import { clamp, toFinite, uid } from './util.js';
import { AUTOEDIT_DEFAULTS, sanitizeClips } from './autoedit.js';
import { AUDIO_DEFAULTS } from './audio.js';
import { SUBTITLE_LIMITS, normalizeCues } from './subtitles.js';
import { STT_DEFAULTS } from './stt.js';

export const PROJECT_VERSION = 1;
export const UNDO_LIMIT = 50;
export const STORAGE_KEY = 'kirinuki-studio:project:v1';

export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  fontSize: 0.055, // 動画高さに対する比率
  family: 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif',
  weight: 700,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0.16, // フォントサイズに対する比率
  background: 'rgba(0,0,0,0.55)',
  position: 'bottom', // 'bottom' | 'top' | 'center'
  maxCharsPerLine: SUBTITLE_LIMITS.maxCharsPerLine,
  maxLines: SUBTITLE_LIMITS.maxLines,
  safeMargin: 0.06,
});

export const THUMBNAIL_DEFAULTS = Object.freeze({
  sourceTime: 0,
  template: 'boldBottom',
  title: '',
  subtitle: '',
  accent: '#4da3ff',
  scrim: true,
  badge: '',
});

export const CAPTION_DEFAULTS = Object.freeze({
  platform: 'youtube',
  tone: 'neutral',
  includeChapters: true,
  includeHashtags: true,
  text: '',
});

/** 空プロジェクト */
export function createProject(name = '無題のプロジェクト') {
  const now = Date.now();
  return {
    id: uid('prj'),
    version: PROJECT_VERSION,
    name: String(name || '無題のプロジェクト'),
    createdAt: now,
    updatedAt: now,
    media: null,
    analysis: emptyAnalysis(),
    clips: [],
    subtitles: [],
    subtitleStyle: { ...SUBTITLE_STYLE_DEFAULTS },
    audio: { ...AUDIO_DEFAULTS },
    autoEdit: { ...AUTOEDIT_DEFAULTS },
    thumbnail: { ...THUMBNAIL_DEFAULTS },
    caption: { ...CAPTION_DEFAULTS },
    stt: { ...STT_DEFAULTS },
  };
}

export function emptyAnalysis() {
  return {
    done: false,
    envelope: { hopSec: 0.01, db: [] },
    speech: [],
    scenes: [],
    frames: [],
    loudness: { integratedDb: -70, peakDb: -100, noiseFloorDb: -100 },
    warnings: [],
  };
}

/**
 * 任意の入力（復元データ・外部 JSON）を安全なプロジェクトへ正規化する。
 * 欠損・型不一致・範囲外は既定値で埋め、例外は投げない。
 *
 * @param {any} input
 * @param {{deepAnalysis?:boolean}} [opt]
 *   deepAnalysis:false は「解析結果は既に検証済み」と分かっている経路（store.commit）専用。
 *   長尺素材では包絡が数十万要素になるため、毎回の再検証を避けて入力遅延を防ぐ。
 *   外部由来のデータ（JSON 取り込み・復元）では必ず既定の true を使うこと。
 */
export function sanitizeProject(input, opt = {}) {
  const base = createProject();
  if (!input || typeof input !== 'object') return base;

  const media = sanitizeMedia(input.media);
  const duration = media?.duration ?? 0;
  const analysis = opt.deepAnalysis === false ? shallowAnalysis(input.analysis) : sanitizeAnalysis(input.analysis, duration);

  return {
    ...base,
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    version: PROJECT_VERSION,
    name: String(input.name ?? base.name).slice(0, 120) || base.name,
    createdAt: toFinite(input.createdAt, base.createdAt),
    updatedAt: toFinite(input.updatedAt, base.updatedAt),
    media,
    analysis,
    clips: sanitizeClips(Array.isArray(input.clips) ? input.clips : [], duration),
    subtitles: normalizeCues(Array.isArray(input.subtitles) ? input.subtitles : [], duration),
    subtitleStyle: mergeShape(SUBTITLE_STYLE_DEFAULTS, input.subtitleStyle, {
      fontSize: (v) => clamp(v, 0.02, 0.2),
      strokeWidth: (v) => clamp(v, 0, 0.5),
      maxCharsPerLine: (v) => Math.round(clamp(v, 6, 60)),
      maxLines: (v) => Math.round(clamp(v, 1, 4)),
      safeMargin: (v) => clamp(v, 0, 0.2),
      weight: (v) => Math.round(clamp(v, 100, 900)),
      position: (v) => (['bottom', 'top', 'center'].includes(v) ? v : 'bottom'),
    }),
    audio: mergeShape(AUDIO_DEFAULTS, input.audio, {
      targetDb: (v) => clamp(v, -36, -6),
      duckDb: (v) => clamp(v, -30, 0),
      fadeIn: (v) => clamp(v, 0, 10),
      fadeOut: (v) => clamp(v, 0, 10),
      bgmGainDb: (v) => clamp(v, -40, 6),
      bgmName: (v) => String(v ?? '').slice(0, 200),
    }),
    autoEdit: mergeShape(AUTOEDIT_DEFAULTS, input.autoEdit, {
      mode: (v) => (v === 'speed' ? 'speed' : 'cut'),
      padStart: (v) => clamp(v, 0, 2),
      padEnd: (v) => clamp(v, 0, 2),
      minGap: (v) => clamp(v, 0.1, 5),
      minClip: (v) => clamp(v, 0.1, 5),
      speedFactor: (v) => clamp(v, 1, 8),
    }),
    thumbnail: mergeShape(THUMBNAIL_DEFAULTS, input.thumbnail, {
      sourceTime: (v) => clamp(v, 0, Math.max(0, duration)),
      title: (v) => String(v ?? '').slice(0, 120),
      subtitle: (v) => String(v ?? '').slice(0, 160),
      badge: (v) => String(v ?? '').slice(0, 24),
      template: (v) => (['boldBottom', 'leftPanel', 'centerImpact'].includes(v) ? v : 'boldBottom'),
      accent: (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : THUMBNAIL_DEFAULTS.accent),
      scrim: (v) => v !== false,
    }),
    caption: mergeShape(CAPTION_DEFAULTS, input.caption, {
      platform: (v) => (['x', 'instagram', 'youtube', 'tiktok'].includes(v) ? v : 'youtube'),
      tone: (v) => (['neutral', 'casual', 'formal'].includes(v) ? v : 'neutral'),
      text: (v) => String(v ?? '').slice(0, 20000),
    }),
    stt: mergeShape(STT_DEFAULTS, input.stt, {
      providerId: (v) => (v === 'remote' ? 'remote' : 'vad'),
      endpoint: (v) => String(v ?? '').slice(0, 500),
      model: (v) => String(v ?? '').slice(0, 100),
      language: (v) => String(v ?? '').slice(0, 20),
    }),
  };
}

function mergeShape(defaults, input, coercions = {}) {
  const out = { ...defaults };
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(defaults)) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (coercions[key]) {
      out[key] = coercions[key](raw);
    } else if (typeof defaults[key] === 'number') {
      out[key] = toFinite(raw, defaults[key]);
    } else if (typeof defaults[key] === 'boolean') {
      out[key] = raw === true;
    } else if (typeof defaults[key] === 'string') {
      out[key] = String(raw ?? defaults[key]);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function sanitizeMedia(media) {
  if (!media || typeof media !== 'object') return null;
  const duration = Math.max(0, toFinite(media.duration, 0));
  return {
    name: String(media.name ?? '素材').slice(0, 200),
    size: Math.max(0, toFinite(media.size, 0)),
    type: String(media.type ?? '').slice(0, 100),
    duration,
    width: Math.max(0, Math.round(toFinite(media.width, 0))),
    height: Math.max(0, Math.round(toFinite(media.height, 0))),
    fps: clamp(toFinite(media.fps, 30), 1, 240),
    hasAudio: media.hasAudio === true,
  };
}

/** 形だけを保証する軽量版（既に検証済みの解析結果を通すため） */
function shallowAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return emptyAnalysis();
  const base = emptyAnalysis();
  return {
    done: analysis.done === true,
    envelope: analysis.envelope && Array.isArray(analysis.envelope.db) ? analysis.envelope : base.envelope,
    speech: Array.isArray(analysis.speech) ? analysis.speech : base.speech,
    scenes: Array.isArray(analysis.scenes) ? analysis.scenes : base.scenes,
    frames: Array.isArray(analysis.frames) ? analysis.frames : base.frames,
    loudness: analysis.loudness && typeof analysis.loudness === 'object' ? analysis.loudness : base.loudness,
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings : base.warnings,
  };
}

function sanitizeAnalysis(analysis, duration) {
  const base = emptyAnalysis();
  if (!analysis || typeof analysis !== 'object') return base;
  const total = Math.max(0, toFinite(duration, 0));
  const clampSeg = (s) => ({
    start: clamp(s?.start, 0, total || Infinity),
    end: clamp(s?.end, 0, total || Infinity),
    score: toFinite(s?.score, 0),
  });
  return {
    done: analysis.done === true,
    envelope: {
      hopSec: clamp(toFinite(analysis.envelope?.hopSec, 0.01), 0.001, 1),
      db: Array.isArray(analysis.envelope?.db) ? analysis.envelope.db.map((v) => toFinite(v, -100)) : [],
    },
    speech: (Array.isArray(analysis.speech) ? analysis.speech : []).map(clampSeg).filter((s) => s.end > s.start),
    scenes: (Array.isArray(analysis.scenes) ? analysis.scenes : []).map(clampSeg).filter((s) => s.end > s.start),
    frames: (Array.isArray(analysis.frames) ? analysis.frames : []).map((f) => ({
      t: clamp(f?.t, 0, total || Infinity),
      score: clamp(f?.score, 0, 1),
      sharp: clamp(f?.sharp, 0, 1),
      contrast: clamp(f?.contrast, 0, 1),
      colorful: clamp(f?.colorful, 0, 1),
      exposure: clamp(f?.exposure, 0, 1),
    })),
    loudness: {
      integratedDb: toFinite(analysis.loudness?.integratedDb, -70),
      peakDb: toFinite(analysis.loudness?.peakDb, -100),
      noiseFloorDb: toFinite(analysis.loudness?.noiseFloorDb, -100),
    },
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings.map(String).slice(0, 20) : [],
  };
}

/**
 * 永続化用に軽量化する。
 * - 動画本体は保存しない（File は永続化不可）
 * - RMS 包絡は間引いて容量を抑える（表示用途のため 4 分の 1 で十分）
 */
export function serializeProject(project) {
  const p = sanitizeProject(project);
  const db = p.analysis.envelope.db;
  const step = db.length > 20000 ? Math.ceil(db.length / 20000) : 1;
  const thinned = [];
  for (let i = 0; i < db.length; i += step) thinned.push(Math.round(db[i] * 10) / 10);
  return {
    ...p,
    analysis: {
      ...p.analysis,
      envelope: { hopSec: p.analysis.envelope.hopSec * step, db: thinned },
      frames: p.analysis.frames.slice(0, 4000).map((f) => ({
        t: Math.round(f.t * 1000) / 1000,
        score: round3(f.score),
        sharp: round3(f.sharp),
        contrast: round3(f.contrast),
        colorful: round3(f.colorful),
        exposure: round3(f.exposure),
      })),
    },
  };
}

function round3(value) {
  return Math.round(toFinite(value, 0) * 1000) / 1000;
}

/**
 * 状態ストア。すべての変更は commit() を通し、履歴が自動で積まれる。
 */
export function createStore(initial = createProject()) {
  let state = sanitizeProject(initial);
  const past = [];
  const future = [];
  const listeners = new Set();

  const notify = (meta) => {
    for (const listener of [...listeners]) {
      try {
        listener(state, meta);
      } catch (error) {
        // 1 つの購読者の失敗が他へ波及しないようにする
        console.error('[store] listener error', error);
      }
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * @param {(draft:object)=>object|void} mutator 新しい state を返すか、draft を書き換える
     * @param {{label?:string, history?:boolean}} [meta] history:false で履歴に積まない（再生位置など）
     */
    commit(mutator, meta = {}) {
      const draft = cloneForDraft(state);
      const result = typeof mutator === 'function' ? mutator(draft) : mutator;
      const next = sanitizeProject(result === undefined ? draft : result, { deepAnalysis: false });
      next.updatedAt = Date.now();
      if (meta.history !== false) {
        past.push(state);
        if (past.length > UNDO_LIMIT) past.shift();
        future.length = 0;
      }
      state = next;
      notify({ ...meta, canUndo: past.length > 0, canRedo: future.length > 0 });
      return state;
    },
    undo() {
      if (!past.length) return false;
      future.push(state);
      state = past.pop();
      notify({ label: '元に戻す', canUndo: past.length > 0, canRedo: future.length > 0 });
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(state);
      state = future.pop();
      notify({ label: 'やり直す', canUndo: past.length > 0, canRedo: future.length > 0 });
      return true;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    replace(project, meta = {}) {
      past.length = 0;
      future.length = 0;
      state = sanitizeProject(project);
      notify({ ...meta, canUndo: false, canRedo: false });
      return state;
    },
  };
}

/**
 * 編集用の複製を作る。
 * 解析結果（最長で数十万要素）は「丸ごと差し替え」でしか変更しない不変データとして扱い、
 * 参照を共有してコピーコストを避ける。mutator 内で draft.analysis の中身を書き換えないこと。
 */
function cloneForDraft(state) {
  const { analysis, ...rest } = state;
  const draft = structuredCloneSafe(rest);
  draft.analysis = analysis;
  return draft;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* JSON へフォールバック */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * 永続化アダプタ。storage は localStorage 互換（テストではモックを注入）。
 */
export function createPersistence(storage, key = STORAGE_KEY) {
  const available = Boolean(storage);
  return {
    available,
    save(project) {
      if (!available) return { ok: false, error: new Error('この環境では保存できません。') };
      try {
        storage.setItem(key, JSON.stringify(serializeProject(project)));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    load() {
      if (!available) return { ok: false, error: new Error('この環境では復元できません。') };
      try {
        const raw = storage.getItem(key);
        if (!raw) return { ok: true, value: null };
        return { ok: true, value: sanitizeProject(JSON.parse(raw)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    clear() {
      if (!available) return;
      try {
        storage.removeItem(key);
      } catch {
        /* 失敗しても致命的ではない */
      }
    },
  };
}
