import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COLORS, CONTRAST_PAIRS, contrastRatio, parseHex, relativeLuminance } from '../src/core/tokens.js';

test('AC-11: すべての前景/背景ペアがコントラスト比 4.5:1 以上', () => {
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const ratio = contrastRatio(COLORS[fg], COLORS[bg]);
    assert.ok(
      ratio >= 4.5,
      `${fg} (${COLORS[fg]}) on ${bg} (${COLORS[bg]}) のコントラスト比が ${ratio.toFixed(2)}:1 で不足しています`,
    );
  }
});

test('相対輝度の基準値（白・黒）', () => {
  assert.equal(Math.round(relativeLuminance('#ffffff') * 1000) / 1000, 1);
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
});

test('不正な色指定は例外になる', () => {
  assert.throws(() => parseHex('red'), TypeError);
  assert.throws(() => parseHex('#fff'), TypeError);
});

test('CSS のトークン定義が tokens.js と一致している', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const map = {
    '--bg': COLORS.bg,
    '--surface': COLORS.surface,
    '--surface-raised': COLORS.surfaceRaised,
    '--border': COLORS.border,
    '--text': COLORS.text,
    '--text-muted': COLORS.textMuted,
    '--accent': COLORS.accent,
    '--accent-ink': COLORS.accentInk,
    '--danger': COLORS.danger,
    '--success': COLORS.success,
    '--warning': COLORS.warning,
    '--focus': COLORS.focus,
  };
  for (const [name, value] of Object.entries(map)) {
    assert.ok(
      new RegExp(`${name}:\\s*${value};`, 'i').test(css),
      `styles.css の ${name} が ${value} と一致していません`,
    );
  }
});
