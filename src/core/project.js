/**
 * プロジェクトのデータモデル・検証・状態ストア（Undo/Redo・永続化）。
 * DOM に依存しないため Node 上で完全にテストできる。
 */

import { clamp, toFinite, uid } from './util.js';
import { AUTOEDIT_DEFAULTS, sanitizeClips } from './autoedit.js';
import { AUDIO_DEFAULTS } from './audio.js';
import { SUBTITLE_LIMITS, normalizeCues } from './subtitles.js';
import { STT_DEFAULTS } from './stt.js';
import { IMAGE_DEFAULT_DURATION, assetsFromLegacyMedia, clipsFromAssets, findAsset, primaryAsset, sanitizeAssets } from './assets.js';
import { ASPECTS, BACKGROUNDS, FITS, OUTPUT_DEFAULTS } from './layout.js';

/** 3 = 複数素材（動画＋画像）と出力アスペクトに対応した版 */
export const PROJECT_VERSION = 3;
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
  sourceAssetId: null,
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
    assets: [],
    /** 代表素材のミラー（表示用。実体は assets[0] 相当） */
    media: null,
    analysis: emptyAnalysis(),
    clips: [],
    subtitles: [],
    output: { ...OUTPUT_DEFAULTS },
    imageDefaults: { durationSec: IMAGE_DEFAULT_DURATION },
    subtitleStyle: { ...SUBTITLE_STYLE_DEFAULTS },
    audio: { ...AUDIO_DEFAULTS },
    autoEdit: { ...AUTOEDIT_DEFAULTS },
    thumbnail: { ...THUMBNAIL_DEFAULTS },
    caption: { ...CAPTION_DEFAULTS },
    stt: { ...STT_DEFAULTS },
  };
}

/** 素材 1 件ぶんの解析結果 */
export function emptyAssetAnalysis() {
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

/** プロジェクト全体の解析結果（素材ごとに保持する） */
export function emptyAnalysis() {
  return { done: false, byAsset: {} };
}

/* ---------- 素材と解析の参照ヘルパ ---------- */

/** 指定素材の解析結果（無ければ空） */
export function assetAnalysis(project, assetId) {
  return project?.analysis?.byAsset?.[assetId] || emptyAssetAnalysis();
}

/** assetId → 発話区間 の対応表（自動カットへ渡す） */
export function speechByAsset(project) {
  const out = {};
  for (const [id, analysis] of Object.entries(project?.analysis?.byAsset || {})) {
    out[id] = analysis.speech || [];
  }
  return out;
}

/** 解析が必要な素材（動画）がすべて解析済みか */
export function isAnalysisDone(project) {
  const videos = (project?.assets || []).filter((a) => a.kind === 'video');
  if (!videos.length) return (project?.assets || []).length > 0;
  return videos.every((a) => assetAnalysis(project, a.id).done);
}

/** まだ解析していない動画素材 */
export function pendingAnalysisAssets(project) {
  return (project?.assets || []).filter((a) => a.kind === 'video' && !assetAnalysis(project, a.id).done);
}

/** 全素材の警告をまとめる */
export function analysisWarnings(project) {
  const out = [];
  for (const asset of project?.assets || []) {
    for (const warning of assetAnalysis(project, asset.id).warnings || []) {
      out.push(`${asset.name}: ${warning}`);
    }
  }
  return out;
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

  // v2 以前は素材が 1 本の動画だけだったので、assets へ移行する。
  // 移行は「assets というキーがそもそも無い」ときだけ行う。
  // 空配列でも移行してしまうと、最後の素材を削除した直後に
  // 古い media ミラーから素材が復活してしまう。
  const assets = Array.isArray(input.assets)
    ? sanitizeAssets(input.assets)
    : assetsFromLegacyMedia(input.media);
  const fallbackAssetId = assets[0]?.id ?? null;
  const media = primaryAsset(assets);

  const rawClips = Array.isArray(input.clips) ? input.clips : [];
  // 旧形式のクリップには assetId が無いので代表素材へ結び付ける
  const clips = sanitizeClips(
    rawClips.map((c) => (c && c.assetId ? c : { ...c, assetId: fallbackAssetId })),
    assets,
  );

  const analysis = opt.deepAnalysis === false
    ? shallowAnalysis(input.analysis)
    : sanitizeAnalysis(input.analysis, assets, fallbackAssetId);

  const durationOf = (assetId) => findAsset(assets, assetId)?.duration ?? 0;
  const rawCues = Array.isArray(input.subtitles) ? input.subtitles : [];
  const subtitles = sanitizeCuesForAssets(rawCues, assets, fallbackAssetId, durationOf);

  return {
    ...base,
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    version: PROJECT_VERSION,
    name: String(input.name ?? base.name).slice(0, 120) || base.name,
    createdAt: toFinite(input.createdAt, base.createdAt),
    updatedAt: toFinite(input.updatedAt, base.updatedAt),
    assets,
    media,
    analysis,
    clips: clips.length || !assets.length ? clips : clipsFromAssets(assets),
    subtitles,
    output: mergeShape(OUTPUT_DEFAULTS, input.output, {
      aspect: (v) => (ASPECTS[v] ? v : OUTPUT_DEFAULTS.aspect),
      fit: (v) => (FITS[v] ? v : OUTPUT_DEFAULTS.fit),
      background: (v) => (BACKGROUNDS[v] ? v : OUTPUT_DEFAULTS.background),
      maxSize: (v) => clamp(v, 240, 3840),
    }),
    imageDefaults: mergeShape({ durationSec: IMAGE_DEFAULT_DURATION }, input.imageDefaults, {
      durationSec: (v) => clamp(v, 0.5, 30),
    }),
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
      sourceAssetId: (v) => (findAsset(assets, v) ? v : fallbackAssetId),
      sourceTime: (v) => clamp(v, 0, Math.max(0, durationOf(input.thumbnail?.sourceAssetId ?? fallbackAssetId))),
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

/**
 * 字幕を素材へ結び付けて正規化する。
 * 旧形式（assetId 無し）は代表素材のものとして扱う。
 */
function sanitizeCuesForAssets(cues, assets, fallbackAssetId, durationOf) {
  const valid = new Set(assets.map((a) => a.id));
  const grouped = new Map();
  for (const cue of cues) {
    if (!cue || typeof cue !== 'object') continue;
    const assetId = valid.has(cue.assetId) ? cue.assetId : fallbackAssetId;
    if (!assetId) continue;
    if (!grouped.has(assetId)) grouped.set(assetId, []);
    grouped.get(assetId).push({ ...cue, assetId });
  }
  const out = [];
  for (const [assetId, list] of grouped) {
    // 重なりの解消は素材ごとに行う（別素材どうしは重なってよい）
    for (const cue of normalizeCues(list, durationOf(assetId))) {
      out.push({ ...cue, assetId });
    }
  }
  return out;
}

/** 形だけを保証する軽量版（既に検証済みの解析結果を通すため） */
function shallowAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') return emptyAnalysis();
  const byAsset = {};
  for (const [id, value] of Object.entries(analysis.byAsset || {})) {
    if (!value || typeof value !== 'object') continue;
    const base = emptyAssetAnalysis();
    byAsset[id] = {
      done: value.done === true,
      envelope: value.envelope && Array.isArray(value.envelope.db) ? value.envelope : base.envelope,
      speech: Array.isArray(value.speech) ? value.speech : base.speech,
      scenes: Array.isArray(value.scenes) ? value.scenes : base.scenes,
      frames: Array.isArray(value.frames) ? value.frames : base.frames,
      loudness: value.loudness && typeof value.loudness === 'object' ? value.loudness : base.loudness,
      warnings: Array.isArray(value.warnings) ? value.warnings : base.warnings,
    };
  }
  return { done: analysis.done === true, byAsset };
}

/**
 * 解析結果を素材ごとの形へ正規化する。
 * v2 以前はプロジェクト直下に 1 件だけ置かれていたため、代表素材のものとして移行する。
 */
function sanitizeAnalysis(analysis, assets, fallbackAssetId) {
  const out = emptyAnalysis();
  if (!analysis || typeof analysis !== 'object') return out;

  const source = analysis.byAsset && typeof analysis.byAsset === 'object'
    ? analysis.byAsset
    : (fallbackAssetId ? { [fallbackAssetId]: analysis } : {});

  for (const asset of assets) {
    const raw = source[asset.id];
    if (!raw || typeof raw !== 'object') continue;
    out.byAsset[asset.id] = sanitizeAssetAnalysis(raw, asset.duration);
  }
  const videos = assets.filter((a) => a.kind === 'video');
  out.done = videos.length > 0 && videos.every((a) => out.byAsset[a.id]?.done === true);
  return out;
}

function sanitizeAssetAnalysis(analysis, duration) {
  const base = emptyAssetAnalysis();
  const total = Math.max(0, toFinite(duration, 0));
  const clampSeg = (seg) => ({
    start: clamp(seg?.start, 0, total || Infinity),
    end: clamp(seg?.end, 0, total || Infinity),
    score: toFinite(seg?.score, 0),
  });
  return {
    done: analysis.done === true,
    envelope: {
      hopSec: clamp(toFinite(analysis.envelope?.hopSec, 0.01), 0.001, 1),
      db: Array.isArray(analysis.envelope?.db) ? analysis.envelope.db.map((v) => toFinite(v, -100)) : [],
    },
    speech: (Array.isArray(analysis.speech) ? analysis.speech : []).map(clampSeg).filter((x) => x.end > x.start),
    scenes: (Array.isArray(analysis.scenes) ? analysis.scenes : []).map(clampSeg).filter((x) => x.end > x.start),
    frames: (Array.isArray(analysis.frames) ? analysis.frames : []).map((f) => ({
      t: clamp(f?.t, 0, total || Infinity),
      score: clamp(f?.score, 0, 1),
      sharp: clamp(f?.sharp, 0, 1),
      contrast: clamp(f?.contrast, 0, 1),
      colorful: clamp(f?.colorful, 0, 1),
      exposure: clamp(f?.exposure, 0, 1),
    })),
    loudness: {
      integratedDb: toFinite(analysis.loudness?.integratedDb, base.loudness.integratedDb),
      peakDb: toFinite(analysis.loudness?.peakDb, base.loudness.peakDb),
      noiseFloorDb: toFinite(analysis.loudness?.noiseFloorDb, base.loudness.noiseFloorDb),
    },
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings.map(String).slice(0, 20) : [],
  };
}

/**
 * 永続化用に軽量化する。
 * - 動画・画像そのものは JSON に含めない（実体は OPFS 側に保存する）
 * - RMS 包絡は間引いて容量を抑える（表示用途のためこれで足りる）
 */
export function serializeProject(project) {
  const p = sanitizeProject(project);
  const byAsset = {};
  for (const [assetId, analysis] of Object.entries(p.analysis.byAsset)) {
    byAsset[assetId] = thinAssetAnalysis(analysis);
  }
  return { ...p, analysis: { ...p.analysis, byAsset } };
}

function thinAssetAnalysis(analysis) {
  const db = analysis.envelope.db;
  const step = db.length > 20000 ? Math.ceil(db.length / 20000) : 1;
  const thinned = [];
  for (let i = 0; i < db.length; i += step) thinned.push(Math.round(db[i] * 10) / 10);
  return {
    ...analysis,
    envelope: { hopSec: analysis.envelope.hopSec * step, db: thinned },
    frames: analysis.frames.slice(0, 4000).map((f) => ({
      t: Math.round(f.t * 1000) / 1000,
      score: round3(f.score),
      sharp: round3(f.sharp),
      contrast: round3(f.contrast),
      colorful: round3(f.colorful),
      exposure: round3(f.exposure),
    })),
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
