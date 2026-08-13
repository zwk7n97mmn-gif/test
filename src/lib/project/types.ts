import { createDefaultAppearance, sanitizeAppearance, type CharacterAppearance } from '../character/appearance';

export const CANVAS_PRESETS = [
  { id: 'vertical', label: '縦型 9:16（TikTok / Reels）', width: 1080, height: 1920 },
  { id: 'square', label: '正方形 1:1', width: 1080, height: 1080 },
  { id: 'horizontal', label: '横型 16:9', width: 1920, height: 1080 },
] as const;

export type CanvasPresetId = (typeof CANVAS_PRESETS)[number]['id'];

export const BACKGROUND_KINDS = ['gradient', 'solid', 'stage', 'grid'] as const;
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number];
export const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  gradient: 'グラデーション',
  solid: '単色',
  stage: 'ステージ（スポットライト）',
  grid: 'グリッド',
};

export interface BackgroundSettings {
  kind: BackgroundKind;
  colorA: string;
  colorB: string;
  /** ビートに合わせて背景を明滅させる強さ 0..1 */
  beatReactivity: number;
}

export interface EffectSettings {
  /** ビートに合わせたズームパンチ 0..1 */
  zoomPunch: number;
  /** ビートで飛ぶパーティクル 0..1 */
  particles: number;
  /** 低域に反応するフロアの発光 0..1 */
  bassPulse: number;
}

export type MotionTimingMode = 'original' | 'sync';

export interface MotionTiming {
  mode: MotionTimingMode;
  /** sync時: クリップ全体を何拍に割り当てるか（1〜64） */
  loopBeats: number;
  /** 開始オフセット（拍） */
  offsetBeats: number;
  loop: boolean;
  mirror: boolean;
  /** 足元を画面のどの高さに置くか 0（上端）〜1（下端）。 */
  anchorY: number;
  /** 表示倍率 0.5〜1.5 */
  scale: number;
  /** 元動画のルート移動をどれだけ反映するか 0..1 */
  rootMotion: number;
}

export interface CaptionSettings {
  enabled: boolean;
  text: string;
  /** 0..1 の縦位置 */
  position: number;
  color: string;
  backgroundColor: string;
  fontSize: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  appearance: CharacterAppearance;
  /** 参照するモーションクリップのID（未選択なら null） */
  motionClipId: string | null;
  /** 参照するオーディオ資産のID（未選択なら null） */
  audioAssetId: string | null;
  canvas: { presetId: CanvasPresetId; fps: number };
  /** 書き出し区間（秒）。null の場合は音源全体。 */
  range: { start: number; end: number } | null;
  timing: MotionTiming;
  background: BackgroundSettings;
  effects: EffectSettings;
  caption: CaptionSettings;
}

export function createProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: '新規プロジェクト',
    createdAt: now,
    updatedAt: now,
    appearance: createDefaultAppearance(),
    motionClipId: null,
    audioAssetId: null,
    canvas: { presetId: 'vertical', fps: 30 },
    range: null,
    timing: {
      mode: 'sync',
      loopBeats: 8,
      offsetBeats: 0,
      loop: true,
      mirror: false,
      anchorY: 0.88,
      scale: 1,
      rootMotion: 0.35,
    },
    background: {
      kind: 'gradient',
      colorA: '#2b1c4a',
      colorB: '#12303f',
      beatReactivity: 0.4,
    },
    effects: { zoomPunch: 0.35, particles: 0.4, bassPulse: 0.4 },
    caption: {
      enabled: false,
      text: '',
      position: 0.12,
      color: '#ffffff',
      backgroundColor: '#000000',
      fontSize: 56,
    },
    ...overrides,
  };
}

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const pickColor = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;

/** 永続化データやインポートJSONを安全なプロジェクトに正規化する。 */
export function sanitizeProject(input: unknown): Project {
  const base = createProject();
  if (typeof input !== 'object' || input === null) return base;
  const raw = input as Partial<Project>;

  const presetId = CANVAS_PRESETS.some((p) => p.id === raw.canvas?.presetId)
    ? (raw.canvas!.presetId as CanvasPresetId)
    : base.canvas.presetId;

  let range: Project['range'] = null;
  if (raw.range && typeof raw.range === 'object') {
    const start = clamp(raw.range.start, 0, 86_400, 0);
    const end = clamp(raw.range.end, 0, 86_400, 0);
    range = end > start ? { start, end } : null;
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : base.name,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : base.updatedAt,
    appearance: sanitizeAppearance((raw.appearance ?? {}) as Partial<CharacterAppearance>),
    motionClipId: typeof raw.motionClipId === 'string' ? raw.motionClipId : null,
    audioAssetId: typeof raw.audioAssetId === 'string' ? raw.audioAssetId : null,
    canvas: { presetId, fps: [24, 30, 60].includes(Number(raw.canvas?.fps)) ? Number(raw.canvas?.fps) : 30 },
    range,
    timing: {
      mode: raw.timing?.mode === 'original' ? 'original' : 'sync',
      loopBeats: Math.round(clamp(raw.timing?.loopBeats, 1, 64, base.timing.loopBeats)),
      offsetBeats: clamp(raw.timing?.offsetBeats, -32, 32, base.timing.offsetBeats),
      loop: raw.timing?.loop !== false,
      mirror: Boolean(raw.timing?.mirror),
      anchorY: clamp(raw.timing?.anchorY, 0.4, 0.98, base.timing.anchorY),
      scale: clamp(raw.timing?.scale, 0.5, 1.5, base.timing.scale),
      rootMotion: clamp(raw.timing?.rootMotion, 0, 1, base.timing.rootMotion),
    },
    background: {
      kind: BACKGROUND_KINDS.includes(raw.background?.kind as BackgroundKind)
        ? (raw.background!.kind as BackgroundKind)
        : base.background.kind,
      colorA: pickColor(raw.background?.colorA, base.background.colorA),
      colorB: pickColor(raw.background?.colorB, base.background.colorB),
      beatReactivity: clamp(raw.background?.beatReactivity, 0, 1, base.background.beatReactivity),
    },
    effects: {
      zoomPunch: clamp(raw.effects?.zoomPunch, 0, 1, base.effects.zoomPunch),
      particles: clamp(raw.effects?.particles, 0, 1, base.effects.particles),
      bassPulse: clamp(raw.effects?.bassPulse, 0, 1, base.effects.bassPulse),
    },
    caption: {
      enabled: Boolean(raw.caption?.enabled),
      text: typeof raw.caption?.text === 'string' ? raw.caption.text.slice(0, 500) : '',
      position: clamp(raw.caption?.position, 0.02, 0.95, base.caption.position),
      color: pickColor(raw.caption?.color, base.caption.color),
      backgroundColor: pickColor(raw.caption?.backgroundColor, base.caption.backgroundColor),
      fontSize: clamp(raw.caption?.fontSize, 20, 140, base.caption.fontSize),
    },
  };
}

export function canvasSize(presetId: CanvasPresetId): { width: number; height: number } {
  const preset = CANVAS_PRESETS.find((p) => p.id === presetId) ?? CANVAS_PRESETS[0];
  return { width: preset.width, height: preset.height };
}
