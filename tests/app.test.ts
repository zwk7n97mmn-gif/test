import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb, mix, readableTextColor, shade } from '../src/lib/util/color';
import { sanitizeProject, canvasSize, createProject } from '../src/lib/project/types';
import { sanitizeAppearance, createDefaultAppearance } from '../src/lib/character/appearance';
import { beatEnergyAt, beatOrigin, motionTimeAt } from '../src/lib/render/composer';
import { formatMetric, parseCsv, parseMetric, parseTrendList, TrendImportError } from '../src/lib/trend/import';
import type { AudioAnalysis } from '../src/lib/audio/types';
import type { MotionClip } from '../src/lib/pose/types';

// ---------------------------------------------------------------------------
// アクセシビリティ: 実際に UI で使う配色の組み合わせを検証する
// ---------------------------------------------------------------------------
const TOKENS = {
  bg: '#14121c',
  surface: '#1f1c2b',
  surface2: '#2b2739',
  surfaceHover: '#362f47',
  border: '#7a7098',
  text: '#f4f1fa',
  textMuted: '#c6bfd8',
  accent: '#ff8fc0',
  onAccent: '#1a0d16',
  accentHover: '#ffa9d0',
  focus: '#8ac7ff',
  onFocus: '#08121c',
  danger: '#ff9b9b',
  dangerStrong: '#8c1d18',
  dangerHover: '#a72a24',
  onDanger: '#ffffff',
  success: '#7ef0b2',
  warning: '#ffd479',
  info: '#c9d8ff',
};

describe('コントラスト比（WCAG 2.1 AA）', () => {
  const textPairs: Array<[string, string, string]> = [
    ['本文 / 背景', TOKENS.text, TOKENS.bg],
    ['本文 / パネル', TOKENS.text, TOKENS.surface],
    ['本文 / 入力欄', TOKENS.text, TOKENS.surface2],
    ['本文 / ボタンhover', TOKENS.text, TOKENS.surfaceHover],
    ['補助文 / 背景', TOKENS.textMuted, TOKENS.bg],
    ['補助文 / パネル', TOKENS.textMuted, TOKENS.surface],
    ['補助文 / 入力欄', TOKENS.textMuted, TOKENS.surface2],
    ['主ボタン文字 / 主ボタン', TOKENS.onAccent, TOKENS.accent],
    ['主ボタン文字 / hover', TOKENS.onAccent, TOKENS.accentHover],
    ['削除ボタン文字 / 削除ボタン', TOKENS.onDanger, TOKENS.dangerStrong],
    ['削除ボタン文字 / hover', TOKENS.onDanger, TOKENS.dangerHover],
    ['スキップリンク', TOKENS.onFocus, TOKENS.focus],
    ['エラー文 / パネル', TOKENS.danger, TOKENS.surface],
    ['警告文 / パネル', TOKENS.warning, TOKENS.surface],
    ['成功文 / パネル', TOKENS.success, TOKENS.surface],
    ['情報文 / パネル', TOKENS.info, TOKENS.surface],
    ['アクセント文字 / パネル', TOKENS.accent, TOKENS.surface],
  ];

  it.each(textPairs)('%s は 4.5:1 以上', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  const uiPairs: Array<[string, string, string]> = [
    ['枠線 / パネル', TOKENS.border, TOKENS.surface],
    ['枠線 / 入力欄', TOKENS.border, TOKENS.surface2],
    ['枠線 / 背景', TOKENS.border, TOKENS.bg],
    ['フォーカスリング / パネル', TOKENS.focus, TOKENS.surface],
  ];

  it.each(uiPairs)('%s は 3:1 以上（非テキストUI）', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('色ユーティリティ', () => {
  it('3桁・6桁・#なしの HEX を解釈する', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('102030')).toEqual({ r: 16, g: 32, b: 48 });
  });

  it('不正な HEX は例外を投げる', () => {
    expect(() => hexToRgb('#12')).toThrow(/Invalid hex/);
  });

  it('白黒のコントラスト比は 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });

  it('shade / mix が範囲内に収まる', () => {
    expect(shade('#808080', 1)).toBe('#ffffff');
    expect(shade('#808080', -1)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('背景に応じて読みやすい文字色を選ぶ', () => {
    expect(contrastRatio(readableTextColor('#ffffff'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readableTextColor('#101010'), '#101010')).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// 入力値の境界処理
// ---------------------------------------------------------------------------
describe('プロジェクトの正規化', () => {
  it('壊れたデータでも既定値のプロジェクトになる', () => {
    const project = sanitizeProject({ name: 123, canvas: { presetId: 'evil' }, timing: { loopBeats: 9999 } });
    expect(project.name).toBe('新規プロジェクト');
    expect(project.canvas.presetId).toBe('vertical');
    expect(project.timing.loopBeats).toBe(64);
  });

  it('null / 文字列を渡しても例外にならない', () => {
    expect(sanitizeProject(null).id).toBeTruthy();
    expect(sanitizeProject('x').id).toBeTruthy();
  });

  it('終了時刻が開始以下の範囲は無効化される', () => {
    expect(sanitizeProject({ range: { start: 10, end: 5 } }).range).toBeNull();
    expect(sanitizeProject({ range: { start: 1, end: 5 } }).range).toEqual({ start: 1, end: 5 });
  });

  it('極端に長い名前は切り詰められる', () => {
    expect(sanitizeProject({ name: 'あ'.repeat(500) }).name.length).toBe(120);
    expect(sanitizeProject({ caption: { text: 'x'.repeat(5000) } as never }).caption.text.length).toBe(500);
  });

  it('プリセットIDから解像度を引ける', () => {
    expect(canvasSize('vertical')).toEqual({ width: 1080, height: 1920 });
    expect(canvasSize('square')).toEqual({ width: 1080, height: 1080 });
  });
});

describe('容姿パラメータの正規化', () => {
  it('範囲外の数値はクランプされる', () => {
    const appearance = sanitizeAppearance({ headScale: 99, legLength: -3, lineWidth: 0 });
    expect(appearance.headScale).toBe(1.6);
    expect(appearance.legLength).toBe(0.8);
    expect(appearance.lineWidth).toBe(0.5);
  });

  it('不正な色・列挙値は既定値に戻る', () => {
    const base = createDefaultAppearance();
    const appearance = sanitizeAppearance({ hairColor: 'red', hairStyle: 'mohawk' as never });
    expect(appearance.hairColor).toBe(base.hairColor);
    expect(appearance.hairStyle).toBe(base.hairStyle);
  });

  it('空白のみの名前は既定値になる', () => {
    expect(sanitizeAppearance({ name: '   ' }).name).toBe('新しいキャラクター');
  });
});

// ---------------------------------------------------------------------------
// 時間マッピング
// ---------------------------------------------------------------------------
function fakeAnalysis(bpm: number, beatCount = 32): AudioAnalysis {
  const beatDuration = 60 / bpm;
  return {
    duration: beatCount * beatDuration,
    sampleRate: 44100,
    bpm,
    bpmConfidence: 0.9,
    hopTime: 512 / 44100,
    onsetEnvelope: new Float32Array(0),
    energyEnvelope: new Float32Array(0),
    bands: { low: new Float32Array(0), mid: new Float32Array(0), high: new Float32Array(0) },
    onsets: [],
    beats: Array.from({ length: beatCount }, (_, i) => ({
      time: i * beatDuration,
      indexInBar: i % 4,
      strength: 1,
    })),
    sections: [],
    hook: null,
    waveform: new Float32Array(0),
    warnings: [],
  };
}

const fakeClip = (duration: number): MotionClip => ({
  id: 'c',
  name: 'c',
  fps: 30,
  duration,
  frames: [],
  source: { kind: 'video', fileName: '', backend: '', width: 0, height: 0 },
  quality: { detectionRate: 1, meanConfidence: 1, warnings: [] },
});

describe('モーションの時間マッピング', () => {
  it('ビート同期では loopBeats 拍でクリップが1周する', () => {
    const analysis = fakeAnalysis(120);
    const project = createProject();
    project.timing = { ...project.timing, mode: 'sync', loopBeats: 8, offsetBeats: 0, loop: true };
    const clip = fakeClip(2);

    expect(motionTimeAt(0, project, clip, analysis)).toBeCloseTo(0, 6);
    // 8拍 = 4秒でちょうど1周し、先頭に戻る
    expect(motionTimeAt(4, project, clip, analysis)).toBeCloseTo(0, 6);
    // 2拍 = 1秒 → クリップの 1/4 地点
    expect(motionTimeAt(1, project, clip, analysis)).toBeCloseTo(0.5, 6);
  });

  it('ループ無効なら末尾で停止する', () => {
    const analysis = fakeAnalysis(120);
    const project = createProject();
    project.timing = { ...project.timing, mode: 'sync', loopBeats: 4, loop: false, offsetBeats: 0 };
    const clip = fakeClip(2);
    expect(motionTimeAt(100, project, clip, analysis)).toBeCloseTo(2, 6);
    expect(motionTimeAt(-100, project, clip, analysis)).toBeCloseTo(0, 6);
  });

  it('BPM未検出ならビート同期を選んでも元の速度で再生する', () => {
    const analysis = fakeAnalysis(0, 0);
    analysis.bpm = 0;
    const project = createProject();
    const clip = fakeClip(3);
    expect(motionTimeAt(4, project, clip, analysis)).toBeCloseTo(1, 6);
  });

  it('負の時刻でもクリップ範囲内に収まる', () => {
    const project = createProject();
    project.timing = { ...project.timing, mode: 'original', loop: true };
    const clip = fakeClip(3);
    const t = motionTimeAt(-1, project, clip, null);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(3);
  });

  it('最初のダウンビートを基準時刻にする', () => {
    const analysis = fakeAnalysis(120);
    expect(beatOrigin(analysis)).toBeCloseTo(0, 6);
    analysis.beats = analysis.beats.slice(1);
    expect(beatOrigin(analysis)).toBeCloseTo(2, 6); // 次の小節頭
  });
});

describe('ビート強度', () => {
  it('ビート直後が最大で、時間とともに減衰する', () => {
    const analysis = fakeAnalysis(120);
    const onBeat = beatEnergyAt(analysis, 0.001);
    const later = beatEnergyAt(analysis, 0.3);
    expect(onBeat).toBeGreaterThan(later);
    expect(onBeat).toBeLessThanOrEqual(1);
  });

  it('小節頭は他の拍より強い', () => {
    const analysis = fakeAnalysis(120);
    expect(beatEnergyAt(analysis, 0.001)).toBeGreaterThan(beatEnergyAt(analysis, 0.501));
  });

  it('解析結果が無い / ビート前の時刻では 0', () => {
    expect(beatEnergyAt(null, 1)).toBe(0);
    const analysis = fakeAnalysis(120);
    analysis.beats = analysis.beats.map((b) => ({ ...b, time: b.time + 10 }));
    expect(beatEnergyAt(analysis, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// トレンド一覧の取り込み
// ---------------------------------------------------------------------------
describe('CSV パーサ', () => {
  it('引用符・カンマ・改行を含むセルを扱える', () => {
    const rows = parseCsv('a,b\n"x,1","y\nz"');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', 'y\nz'],
    ]);
  });

  it('エスケープされた引用符を復元する', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('BOM 付きファイルを扱える', () => {
    expect(parseCsv('﻿a,b\n1,2')[0]).toEqual(['a', 'b']);
  });
});

describe('トレンド一覧', () => {
  it('日本語ヘッダの CSV を取り込める', () => {
    const entries = parseTrendList('タイトル,アーティスト,再生数\n夜に駆ける,YOASOBI,1.2M\n', 'trend.csv');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: '夜に駆ける', artist: 'YOASOBI', metric: 1_200_000, rank: 1 });
  });

  it('英語ヘッダの JSON を取り込める', () => {
    const entries = parseTrendList('[{"title":"Song A","artist":"X","views":"34,567"}]', 'trend.json');
    expect(entries[0].metric).toBe(34567);
  });

  it('空ファイル・タイトル列なしは分かりやすいエラーになる', () => {
    expect(() => parseTrendList('   ', 's')).toThrow(TrendImportError);
    expect(() => parseTrendList('foo,bar\n1,2', 's')).toThrow(/タイトル列/);
    expect(() => parseTrendList('{bad json', 's')).toThrow(/JSON/);
  });

  it('大量件数でも取り込める', () => {
    const rows = ['title', ...Array.from({ length: 5000 }, (_, i) => `song ${i}`)].join('\n');
    expect(parseTrendList(rows, 's')).toHaveLength(5000);
  });

  it('単位付きの指標を数値化する', () => {
    expect(parseMetric('8.9万')).toBeCloseTo(89000, 5);
    expect(parseMetric('2.5B')).toBeCloseTo(2.5e9, 5);
    expect(Number.isNaN(parseMetric('—'))).toBe(true);
  });

  it('指標を日本語表記に整形する', () => {
    expect(formatMetric(undefined)).toBe('—');
    expect(formatMetric(12_000)).toBe('1.2万');
    expect(formatMetric(250_000_000)).toBe('2.5億');
    expect(formatMetric(842)).toBe('842');
  });
});
