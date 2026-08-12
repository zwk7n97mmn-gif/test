export const HAIR_STYLES = ['twintail', 'long', 'bob', 'ponytail', 'short'] as const;
export const EYE_STYLES = ['round', 'sharp', 'sleepy'] as const;
export const OUTFITS = ['seifuku', 'idol', 'hoodie', 'dress'] as const;
export const ACCESSORIES = ['none', 'ribbon', 'headphone', 'hairpin'] as const;
export const BODY_TYPES = ['slim', 'standard', 'soft'] as const;

export type HairStyle = (typeof HAIR_STYLES)[number];
export type EyeStyle = (typeof EYE_STYLES)[number];
export type Outfit = (typeof OUTFITS)[number];
export type Accessory = (typeof ACCESSORIES)[number];
export type BodyType = (typeof BODY_TYPES)[number];

export const HAIR_STYLE_LABELS: Record<HairStyle, string> = {
  twintail: 'ツインテール',
  long: 'ロング',
  bob: 'ボブ',
  ponytail: 'ポニーテール',
  short: 'ショート',
};
export const EYE_STYLE_LABELS: Record<EyeStyle, string> = {
  round: 'たれ目（丸）',
  sharp: 'つり目',
  sleepy: 'ジト目',
};
export const OUTFIT_LABELS: Record<Outfit, string> = {
  seifuku: 'セーラー服',
  idol: 'アイドル衣装',
  hoodie: 'パーカー',
  dress: 'ワンピース',
};
export const ACCESSORY_LABELS: Record<Accessory, string> = {
  none: 'なし',
  ribbon: 'リボン',
  headphone: 'ヘッドホン',
  hairpin: 'ヘアピン',
};
export const BODY_TYPE_LABELS: Record<BodyType, string> = {
  slim: 'スリム',
  standard: 'スタンダード',
  soft: 'ソフト',
};

/**
 * キャラクターの「容姿」を決める全パラメータ。
 * モーション側（MotionClip）とはデータが完全に分離されており、
 * ここを変えても動きは 1 フレームも変化しない。
 */
export interface CharacterAppearance {
  id: string;
  name: string;
  /** 頭の大きさ。1.0 で 7頭身相当、大きいほどデフォルメ寄り。0.7〜1.6 */
  headScale: number;
  /** 脚の長さ倍率。0.8〜1.25 */
  legLength: number;
  bodyType: BodyType;
  skinColor: string;
  hairStyle: HairStyle;
  hairColor: string;
  /** 毛先のグラデーション色 */
  hairTipColor: string;
  eyeStyle: EyeStyle;
  eyeColor: string;
  outfit: Outfit;
  outfitColor: string;
  outfitAccentColor: string;
  accessory: Accessory;
  accessoryColor: string;
  /** 輪郭線の色 */
  lineColor: string;
  /** 輪郭線の太さ倍率 0.5〜2.0 */
  lineWidth: number;
  blush: boolean;
}

export const APPEARANCE_LIMITS = {
  headScale: { min: 0.7, max: 1.6, step: 0.01 },
  legLength: { min: 0.8, max: 1.25, step: 0.01 },
  lineWidth: { min: 0.5, max: 2.0, step: 0.05 },
} as const;

export function createDefaultAppearance(overrides: Partial<CharacterAppearance> = {}): CharacterAppearance {
  return {
    id: crypto.randomUUID(),
    name: '新しいキャラクター',
    headScale: 1.0,
    legLength: 1.0,
    bodyType: 'standard',
    skinColor: '#ffe0d2',
    hairStyle: 'twintail',
    hairColor: '#5b4bd6',
    hairTipColor: '#9d8bff',
    eyeStyle: 'round',
    eyeColor: '#2f8fd8',
    outfit: 'seifuku',
    outfitColor: '#2c3552',
    outfitAccentColor: '#f2f4fb',
    accessory: 'ribbon',
    accessoryColor: '#e0537a',
    lineColor: '#3a2f4a',
    lineWidth: 1,
    blush: true,
    ...overrides,
  };
}

/** 初回起動時に入っているサンプル。ユーザーは自由に編集・削除できる。 */
export function createSampleAppearances(): CharacterAppearance[] {
  return [
    createDefaultAppearance({
      name: 'ミク風ツインテ',
      hairStyle: 'twintail',
      hairColor: '#2fb5a8',
      hairTipColor: '#7fe6dc',
      eyeColor: '#1c9c92',
      outfit: 'seifuku',
      outfitColor: '#26313f',
      outfitAccentColor: '#9fe8e0',
      accessory: 'ribbon',
      accessoryColor: '#37c2b4',
    }),
    createDefaultAppearance({
      name: 'ストリート系ボブ',
      hairStyle: 'bob',
      hairColor: '#d8536b',
      hairTipColor: '#ffa8ba',
      eyeStyle: 'sharp',
      eyeColor: '#8b3fd0',
      outfit: 'hoodie',
      outfitColor: '#33384a',
      outfitAccentColor: '#f5c542',
      accessory: 'headphone',
      accessoryColor: '#f5c542',
      headScale: 1.12,
    }),
    createDefaultAppearance({
      name: 'ステージ衣装',
      hairStyle: 'ponytail',
      hairColor: '#c9a227',
      hairTipColor: '#ffe7a3',
      eyeStyle: 'round',
      eyeColor: '#e0537a',
      outfit: 'idol',
      outfitColor: '#f2f4fb',
      outfitAccentColor: '#e0537a',
      accessory: 'hairpin',
      accessoryColor: '#e0537a',
      legLength: 1.08,
    }),
  ];
}

/** 入力値を安全な範囲に丸める（フォームからの異常値・破損データ対策）。 */
export function sanitizeAppearance(input: Partial<CharacterAppearance>): CharacterAppearance {
  const base = createDefaultAppearance();
  const pickEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const pickColor = (value: unknown, fallback: string): string =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  const pickNumber = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 60)
        : base.name,
    headScale: pickNumber(input.headScale, APPEARANCE_LIMITS.headScale.min, APPEARANCE_LIMITS.headScale.max, base.headScale),
    legLength: pickNumber(input.legLength, APPEARANCE_LIMITS.legLength.min, APPEARANCE_LIMITS.legLength.max, base.legLength),
    bodyType: pickEnum(input.bodyType, BODY_TYPES, base.bodyType),
    skinColor: pickColor(input.skinColor, base.skinColor),
    hairStyle: pickEnum(input.hairStyle, HAIR_STYLES, base.hairStyle),
    hairColor: pickColor(input.hairColor, base.hairColor),
    hairTipColor: pickColor(input.hairTipColor, base.hairTipColor),
    eyeStyle: pickEnum(input.eyeStyle, EYE_STYLES, base.eyeStyle),
    eyeColor: pickColor(input.eyeColor, base.eyeColor),
    outfit: pickEnum(input.outfit, OUTFITS, base.outfit),
    outfitColor: pickColor(input.outfitColor, base.outfitColor),
    outfitAccentColor: pickColor(input.outfitAccentColor, base.outfitAccentColor),
    accessory: pickEnum(input.accessory, ACCESSORIES, base.accessory),
    accessoryColor: pickColor(input.accessoryColor, base.accessoryColor),
    lineColor: pickColor(input.lineColor, base.lineColor),
    lineWidth: pickNumber(input.lineWidth, APPEARANCE_LIMITS.lineWidth.min, APPEARANCE_LIMITS.lineWidth.max, base.lineWidth),
    blush: typeof input.blush === 'boolean' ? input.blush : base.blush,
  };
}

/** 容姿から骨長（胴長=1 の単位）を導出する。ここが体格差を吸収する層。 */
export interface CharacterRig {
  hipToSpine: number;
  spineToChest: number;
  chestToNeck: number;
  neckToHead: number;
  headRadius: number;
  shoulderOffset: number;
  upperArm: number;
  foreArm: number;
  hipOffset: number;
  thigh: number;
  shin: number;
  foot: number;
  /** 胴の幅（描画用） */
  torsoWidth: number;
  limbWidth: number;
}

export function buildRig(appearance: CharacterAppearance): CharacterRig {
  const widthScale = appearance.bodyType === 'slim' ? 0.88 : appearance.bodyType === 'soft' ? 1.14 : 1;
  const leg = appearance.legLength;
  return {
    hipToSpine: 0.45,
    spineToChest: 0.55,
    chestToNeck: 0.2,
    neckToHead: 0.3 * appearance.headScale,
    headRadius: 0.42 * appearance.headScale,
    shoulderOffset: 0.33 * widthScale,
    upperArm: 0.58,
    foreArm: 0.54,
    hipOffset: 0.17 * widthScale,
    thigh: 0.92 * leg,
    shin: 0.88 * leg,
    foot: 0.2,
    torsoWidth: 0.62 * widthScale,
    limbWidth: 0.15 * widthScale,
  };
}
