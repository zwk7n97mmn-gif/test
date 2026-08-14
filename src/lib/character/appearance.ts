export const HAIR_STYLES = [
  'short',
  'bob',
  'long',
  'ponytail',
  'bun',
  'twintail',
  'sidetail',
  'hime',
] as const;
export const OUTFITS = ['tshirt', 'hoodie', 'tanktop', 'dress', 'jacket', 'idol'] as const;
export const BUILDS = ['slim', 'average', 'athletic', 'curvy'] as const;
/** 顔の造形。アニメ調は目を大きく、鼻と口を小さくする。 */
export const FACE_STYLES = ['natural', 'anime'] as const;
/** 瞳のハイライト。星形はアイドル系イラストでよく使われる。 */
export const EYE_SPARKLES = ['none', 'round', 'star'] as const;
export const HAIR_ACCESSORIES = ['none', 'star', 'ribbon', 'flower'] as const;

export type HairStyle = (typeof HAIR_STYLES)[number];
export type Outfit = (typeof OUTFITS)[number];
export type Build = (typeof BUILDS)[number];
export type FaceStyle = (typeof FACE_STYLES)[number];
export type EyeSparkle = (typeof EYE_SPARKLES)[number];
export type HairAccessory = (typeof HAIR_ACCESSORIES)[number];

export const HAIR_STYLE_LABELS: Record<HairStyle, string> = {
  short: 'ショート',
  bob: 'ボブ',
  long: 'ロング',
  ponytail: 'ポニーテール',
  bun: 'お団子',
  twintail: 'ツインテール',
  sidetail: 'サイドテール',
  hime: '姫カット（ロング）',
};
export const OUTFIT_LABELS: Record<Outfit, string> = {
  tshirt: 'Tシャツ + パンツ',
  hoodie: 'パーカー + パンツ',
  tanktop: 'タンクトップ + ショーツ',
  dress: 'ワンピース',
  jacket: 'ジャケット + スカート',
  idol: 'アイドル衣装（プリーツ + 手袋 + ブーツ）',
};
export const BUILD_LABELS: Record<Build, string> = {
  slim: 'スリム',
  average: 'ふつう',
  athletic: 'アスリート',
  curvy: 'グラマー',
};
export const FACE_STYLE_LABELS: Record<FaceStyle, string> = {
  natural: 'ナチュラル',
  anime: 'アニメ調（目を大きく）',
};
export const EYE_SPARKLE_LABELS: Record<EyeSparkle, string> = {
  none: 'なし',
  round: '丸ハイライト',
  star: '星ハイライト',
};
export const HAIR_ACCESSORY_LABELS: Record<HairAccessory, string> = {
  none: 'なし',
  star: '星',
  ribbon: 'リボン',
  flower: '花',
};

/**
 * キャラクターの「容姿」を決める全パラメータ。
 * モーション側（MotionClip）とはデータが完全に分離されており、
 * ここを変えても動きは 1 フレームも変化しない。
 */
export interface CharacterAppearance {
  id: string;
  name: string;
  /** 頭の大きさ。1.0 で約7頭身。0.8〜1.3 */
  headScale: number;
  /** 脚の長さ倍率。0.85〜1.2 */
  legLength: number;
  /** 肩幅倍率。0.8〜1.25 */
  shoulderWidth: number;
  /** 手足の太さ倍率。0.8〜1.3 */
  limbThickness: number;
  build: Build;
  skinTone: string;
  hairStyle: HairStyle;
  hairColor: string;
  eyeColor: string;
  outfit: Outfit;
  topColor: string;
  bottomColor: string;
  shoeColor: string;
  /** 肌の質感（0=マット, 1=ツヤあり） */
  skinGloss: number;
  faceStyle: FaceStyle;
  eyeSparkle: EyeSparkle;
  hairAccessory: HairAccessory;
  /** 手袋・リボン・髪飾りなどの差し色。毛先のグラデーションにも使う。 */
  accentColor: string;
  /** インナー（アイドル衣装の下に着るトップスなど）の色。 */
  innerColor: string;
  /** 毛先を accentColor へどれだけ寄せるか。0 で単色。 */
  hairGradient: number;
}

export const APPEARANCE_LIMITS = {
  headScale: { min: 0.8, max: 1.3, step: 0.01 },
  legLength: { min: 0.85, max: 1.2, step: 0.01 },
  shoulderWidth: { min: 0.8, max: 1.25, step: 0.01 },
  limbThickness: { min: 0.8, max: 1.3, step: 0.01 },
  skinGloss: { min: 0, max: 1, step: 0.01 },
  hairGradient: { min: 0, max: 1, step: 0.01 },
} as const;

export function createDefaultAppearance(overrides: Partial<CharacterAppearance> = {}): CharacterAppearance {
  return {
    id: crypto.randomUUID(),
    name: '新しいキャラクター',
    headScale: 1,
    legLength: 1,
    shoulderWidth: 1,
    limbThickness: 1,
    build: 'average',
    skinTone: '#e8b89b',
    hairStyle: 'long',
    hairColor: '#2e2118',
    eyeColor: '#4a3428',
    outfit: 'tshirt',
    topColor: '#e8e6ef',
    bottomColor: '#3a4356',
    shoeColor: '#26262c',
    skinGloss: 0.25,
    faceStyle: 'natural',
    eyeSparkle: 'round',
    hairAccessory: 'none',
    accentColor: '#e0457b',
    innerColor: '#f2d24b',
    hairGradient: 0,
    ...overrides,
  };
}

/** 初回起動時に入っているサンプル。ユーザーは自由に編集・削除できる。 */
export function createSampleAppearances(): CharacterAppearance[] {
  return [
    createDefaultAppearance({
      name: 'ストリート',
      hairStyle: 'ponytail',
      hairColor: '#3a2a20',
      outfit: 'hoodie',
      topColor: '#d8dae2',
      bottomColor: '#2b2f3a',
      shoeColor: '#f0f0f2',
      build: 'slim',
    }),
    createDefaultAppearance({
      name: 'ダンサー',
      hairStyle: 'bun',
      hairColor: '#1c1512',
      skinTone: '#8d5a3c',
      outfit: 'tanktop',
      topColor: '#1f2430',
      bottomColor: '#1f2430',
      shoeColor: '#e05a70',
      build: 'athletic',
      limbThickness: 1.06,
    }),
    createDefaultAppearance({
      name: 'ステージ',
      hairStyle: 'long',
      hairColor: '#6b4a2a',
      skinTone: '#f0c9ad',
      outfit: 'dress',
      topColor: '#c93b6b',
      bottomColor: '#c93b6b',
      shoeColor: '#2b2b30',
      build: 'curvy',
      legLength: 1.08,
    }),
    createIdolAppearance(),
  ];
}

/**
 * アニメ調のアイドル衣装プリセット。
 *
 * 特定の作品のキャラクターを複製するものではなく、
 * 「大きな瞳・星のハイライト・ツインテール・プリーツ衣装」という
 * ジャンルとして一般的な要素の組み合わせ。色も髪型も後から自由に変えられる。
 */
export function createIdolAppearance(overrides: Partial<CharacterAppearance> = {}): CharacterAppearance {
  return createDefaultAppearance({
    name: 'アイドル',
    build: 'slim',
    headScale: 1.14,
    legLength: 1.1,
    shoulderWidth: 0.92,
    limbThickness: 1.02,
    skinTone: '#f7ddca',
    skinGloss: 0.45,
    faceStyle: 'anime',
    eyeSparkle: 'star',
    eyeColor: '#7b4fd0',
    hairStyle: 'twintail',
    hairColor: '#33245c',
    hairGradient: 0.32,
    hairAccessory: 'star',
    outfit: 'idol',
    topColor: '#e0457b',
    innerColor: '#f2d24b',
    bottomColor: '#f4f1f8',
    accentColor: '#e8437f',
    shoeColor: '#d63a72',
    ...overrides,
  });
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
  const L = APPEARANCE_LIMITS;

  return {
    id: typeof input.id === 'string' && input.id ? input.id : base.id,
    name:
      typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : base.name,
    headScale: pickNumber(input.headScale, L.headScale.min, L.headScale.max, base.headScale),
    legLength: pickNumber(input.legLength, L.legLength.min, L.legLength.max, base.legLength),
    shoulderWidth: pickNumber(input.shoulderWidth, L.shoulderWidth.min, L.shoulderWidth.max, base.shoulderWidth),
    limbThickness: pickNumber(input.limbThickness, L.limbThickness.min, L.limbThickness.max, base.limbThickness),
    build: pickEnum(input.build, BUILDS, base.build),
    skinTone: pickColor(input.skinTone, base.skinTone),
    hairStyle: pickEnum(input.hairStyle, HAIR_STYLES, base.hairStyle),
    hairColor: pickColor(input.hairColor, base.hairColor),
    eyeColor: pickColor(input.eyeColor, base.eyeColor),
    outfit: pickEnum(input.outfit, OUTFITS, base.outfit),
    topColor: pickColor(input.topColor, base.topColor),
    bottomColor: pickColor(input.bottomColor, base.bottomColor),
    shoeColor: pickColor(input.shoeColor, base.shoeColor),
    skinGloss: pickNumber(input.skinGloss, L.skinGloss.min, L.skinGloss.max, base.skinGloss),
    faceStyle: pickEnum(input.faceStyle, FACE_STYLES, base.faceStyle),
    eyeSparkle: pickEnum(input.eyeSparkle, EYE_SPARKLES, base.eyeSparkle),
    hairAccessory: pickEnum(input.hairAccessory, HAIR_ACCESSORIES, base.hairAccessory),
    accentColor: pickColor(input.accentColor, base.accentColor),
    innerColor: pickColor(input.innerColor, base.innerColor),
    hairGradient: pickNumber(input.hairGradient, L.hairGradient.min, L.hairGradient.max, base.hairGradient),
  };
}

/**
 * 容姿から骨長（胴長=1 の単位）を導出する。ここが体格差を吸収する層。
 * 実際の人体比率に近づけてあり、既定値でおよそ 7 頭身になる。
 */
export interface CharacterRig {
  hipToSpine: number;
  spineToChest: number;
  chestToNeck: number;
  neckToHead: number;
  headRadius: number;
  shoulderOffset: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  hipOffset: number;
  thigh: number;
  shin: number;
  foot: number;
  /** 胴の半径（前後は torsoDepth 倍） */
  torsoRadius: number;
  torsoDepth: number;
  /** 腕・脚の半径 */
  armRadius: number;
  legRadius: number;
  /** 全身の高さ（足裏から頭頂まで、胴長単位）。カメラ配置に使う。 */
  totalHeight: number;
}

const BUILD_FACTORS: Record<Build, { torso: number; limb: number; hip: number; shoulder: number }> = {
  slim: { torso: 0.9, limb: 0.88, hip: 0.94, shoulder: 0.95 },
  average: { torso: 1, limb: 1, hip: 1, shoulder: 1 },
  athletic: { torso: 1.04, limb: 1.1, hip: 0.98, shoulder: 1.08 },
  curvy: { torso: 1.12, limb: 1.05, hip: 1.14, shoulder: 0.98 },
};

export function buildRig(appearance: CharacterAppearance): CharacterRig {
  const f = BUILD_FACTORS[appearance.build];
  const leg = appearance.legLength;
  const thigh = 1.02 * leg;
  const shin = 0.96 * leg;
  const foot = 0.26;
  const headRadius = 0.24 * appearance.headScale;
  const neckToHead = 0.3 * appearance.headScale;

  return {
    hipToSpine: 0.42,
    spineToChest: 0.58,
    chestToNeck: 0.16,
    neckToHead,
    headRadius,
    shoulderOffset: 0.4 * appearance.shoulderWidth * f.shoulder,
    upperArm: 0.7,
    foreArm: 0.62,
    hand: 0.2,
    hipOffset: 0.17 * f.hip,
    thigh,
    shin,
    foot,
    torsoRadius: 0.3 * f.torso,
    torsoDepth: 0.72,
    armRadius: 0.082 * appearance.limbThickness * f.limb,
    legRadius: 0.105 * appearance.limbThickness * f.limb,
    // 足首の高さ + 脚 + 胴 + 首 + 頭（頭頂まで）
    totalHeight: 0.1 + thigh + shin + 1 + 0.16 + neckToHead + headRadius,
  };
}
