/**
 * デザイントークン。
 * ここに定義した前景/背景の組合せは test/a11y-tokens.test.js が
 * WCAG 2.1 のコントラスト比 4.5:1 以上であることを機械検証する。
 */

export const COLORS = {
  bg: '#101418',
  surface: '#171c22',
  surfaceRaised: '#1f262e',
  border: '#2f3a45',
  text: '#e6edf3',
  textMuted: '#a7b4c2',
  accent: '#4da3ff',
  accentInk: '#08111b',
  danger: '#ff7b7b',
  success: '#5ce08d',
  warning: '#fbbf24',
  focus: '#ffd54a',
};

/** 前景 → 背景の検証対象ペア（AC-11） */
export const CONTRAST_PAIRS = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'surfaceRaised'],
  ['textMuted', 'bg'],
  ['textMuted', 'surface'],
  ['textMuted', 'surfaceRaised'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'surfaceRaised'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['success', 'bg'],
  ['success', 'surface'],
  ['warning', 'bg'],
  ['warning', 'surface'],
  ['focus', 'bg'],
  ['focus', 'surface'],
  ['accentInk', 'accent'],
];

/** #rrggbb → {r,g,b} (0-255) */
export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new TypeError(`不正な色指定です: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG 2.1 相対輝度 */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  const f = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** コントラスト比 (1..21) */
export function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
