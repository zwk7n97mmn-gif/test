import type { AudioAnalysis } from '../audio/types';
import { sampleClip, type MotionClip, type MotionFrame } from '../pose/types';
import { canvasSize, type Project } from '../project/types';
import { withAlpha } from '../util/color';
import type { AvatarRig } from '../character/avatarRetarget';
import { getStage, isWebGLAvailable, recoverStageIfLost } from './stage';

export interface RenderInput {
  project: Project;
  clip: MotionClip | null;
  analysis: AudioAnalysis | null;
  /** 読み込み済みの外部アバター。未指定なら内蔵キャラクターを使う。 */
  avatar?: AvatarRig | null;
}

/** 「まだ素材が無い」ことを画面上で伝えるための状態。 */
export type EmptyReason = 'no-motion' | 'no-audio' | null;

export interface RenderResult {
  emptyReason: EmptyReason;
  /** 3D 描画に失敗した場合の理由（UI にそのまま出す） */
  error: string | null;
}

const BEAT_DECAY = 0.16;

/**
 * 1フレームを合成する。
 *
 * 3D ステージを描画してから 2D のテロップを重ねる。時刻 t のみに依存する
 * 純粋な処理（内部に蓄積状態を持たない）ため、プレビューのシークでも
 * 書き出しでも完全に同じ絵になる。
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  time: number,
  input: RenderInput,
): RenderResult {
  const { project, clip, analysis } = input;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  const beat = beatEnergyAt(analysis, time);
  const bass = bandValueAt(analysis, time, 'low');

  const sampled =
    clip && clip.frames.length > 0 ? sampleClip(clip, motionTimeAt(time, project, clip, analysis)) : null;
  const frame = sampled && project.timing.mirror ? mirrorFrame(sampled) : sampled;

  if (!isWebGLAvailable()) {
    drawFallback(ctx, width, height, project);
    drawPlaceholder(ctx, width, height, '3D描画（WebGL）を利用できません');
    return { emptyReason: null, error: 'この端末／ブラウザでは 3D 描画（WebGL）を利用できません。' };
  }

  let error: string | null = null;
  try {
    // コンテキストが失われていれば作り直す（モバイルではメモリ逼迫で起こりうる）
    if (!recoverStageIfLost()) {
      drawFallback(ctx, width, height, project);
      drawPlaceholder(ctx, width, height, '3D描画を復旧できませんでした');
      return {
        emptyReason: null,
        error: '3D描画のコンテキストを復旧できませんでした。他のタブやアプリを閉じて再読み込みしてください。',
      };
    }
    const stage = getStage();
    if (stage.lost) {
      drawFallback(ctx, width, height, project);
      drawPlaceholder(ctx, width, height, '3D描画を復旧しています…');
      return { emptyReason: null, error: null };
    }
    stage.setSize(width, height);
    stage.render({ project, frame, analysis, time, beat, bass, avatar: input.avatar ?? null });
    ctx.drawImage(stage.canvas, 0, 0, width, height);
  } catch (err) {
    drawFallback(ctx, width, height, project);
    error = err instanceof Error ? err.message : '3D描画でエラーが発生しました。';
    drawPlaceholder(ctx, width, height, '3D描画でエラーが発生しました');
    return { emptyReason: null, error };
  }

  if (!frame) {
    drawPlaceholder(ctx, width, height, 'モーションが未設定です');
    return { emptyReason: 'no-motion', error: null };
  }

  if (project.caption.enabled && project.caption.text.trim()) {
    drawCaption(ctx, width, height, project);
  }

  return { emptyReason: analysis ? null : 'no-audio', error: null };
}

/**
 * X 座標を反転して鏡像の振り付けにする。
 * 左右の手足のメッシュは同一形状なので、関節の入れ替えは不要（X 反転だけで正しい鏡像になる）。
 */
export function mirrorFrame(frame: MotionFrame): MotionFrame {
  const positions = Float32Array.from(frame.positions);
  for (let i = 0; i < positions.length; i += 3) positions[i] = -positions[i];
  return { ...frame, positions, root: { ...frame.root, x: -frame.root.x } };
}

// ---------------------------------------------------------------------------
// 時間マッピング
// ---------------------------------------------------------------------------

/** 楽曲時刻 → モーションクリップ内時刻。 */
export function motionTimeAt(
  time: number,
  project: Project,
  clip: MotionClip,
  analysis: AudioAnalysis | null,
): number {
  const duration = clip.duration || 1 / clip.fps;
  const { timing } = project;

  if (timing.mode === 'sync' && analysis && analysis.bpm > 0) {
    const beatDuration = 60 / analysis.bpm;
    const origin = beatOrigin(analysis);
    const elapsedBeats = (time - origin) / beatDuration + timing.offsetBeats;
    const loopBeats = Math.max(1, timing.loopBeats);
    if (!timing.loop) {
      const u = Math.min(1, Math.max(0, elapsedBeats / loopBeats));
      return u * duration;
    }
    const wrapped = ((elapsedBeats % loopBeats) + loopBeats) % loopBeats;
    return (wrapped / loopBeats) * duration;
  }

  const offsetSeconds = analysis && analysis.bpm > 0 ? timing.offsetBeats * (60 / analysis.bpm) : 0;
  const t = time + offsetSeconds;
  if (!timing.loop) return Math.min(duration, Math.max(0, t));
  return ((t % duration) + duration) % duration;
}

/** 最初のダウンビート（小節頭）。無ければ最初のビート、それも無ければ0。 */
export function beatOrigin(analysis: AudioAnalysis): number {
  const downbeat = analysis.beats.find((b) => b.indexInBar === 0);
  if (downbeat) return downbeat.time;
  return analysis.beats[0]?.time ?? 0;
}

/** 直近のビートからの減衰で 0..1 のビート強度を返す。 */
export function beatEnergyAt(analysis: AudioAnalysis | null, time: number): number {
  if (!analysis || analysis.beats.length === 0) return 0;
  let lo = 0;
  let hi = analysis.beats.length - 1;
  if (time < analysis.beats[0].time) return 0;
  while (lo < hi) {
    const midIndex = Math.ceil((lo + hi) / 2);
    if (analysis.beats[midIndex].time <= time) lo = midIndex;
    else hi = midIndex - 1;
  }
  const beat = analysis.beats[lo];
  const dt = time - beat.time;
  if (dt < 0) return 0;
  const accent = beat.indexInBar === 0 ? 1 : 0.72;
  return Math.exp(-dt / BEAT_DECAY) * Math.max(0.35, beat.strength) * accent;
}

function bandValueAt(analysis: AudioAnalysis | null, time: number, band: 'low' | 'mid' | 'high'): number {
  if (!analysis || analysis.hopTime <= 0) return 0;
  const arr = analysis.bands[band];
  if (arr.length === 0) return 0;
  const index = Math.min(arr.length - 1, Math.max(0, Math.round(time / analysis.hopTime)));
  return arr[index];
}

// ---------------------------------------------------------------------------
// 2D オーバーレイ
// ---------------------------------------------------------------------------

/** WebGL が使えない場合でも、背景だけは 2D で描いて画面を成立させる。 */
function drawFallback(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, project.background.colorA);
  gradient.addColorStop(1, project.background.colorB);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
): void {
  const { caption } = project;
  const scale = width / 1080;
  const fontSize = caption.fontSize * scale;
  ctx.save();
  ctx.font = `700 ${fontSize}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxWidth = width * 0.86;
  const lines = wrapText(ctx, caption.text, maxWidth).slice(0, 6);
  const lineHeight = fontSize * 1.32;
  const blockHeight = lines.length * lineHeight;
  const centerY = height * caption.position + blockHeight / 2;

  // 可読性のための帯
  ctx.fillStyle = withAlpha(caption.backgroundColor, 0.55);
  const padding = fontSize * 0.4;
  ctx.fillRect(
    width / 2 - maxWidth / 2 - padding,
    centerY - blockHeight / 2 - padding,
    maxWidth + padding * 2,
    blockHeight + padding * 2,
  );

  ctx.lineJoin = 'round';
  ctx.strokeStyle = withAlpha(caption.backgroundColor, 0.9);
  ctx.lineWidth = fontSize * 0.16;
  lines.forEach((lineText, i) => {
    const y = centerY - blockHeight / 2 + lineHeight * (i + 0.5);
    ctx.strokeText(lineText, width / 2, y);
    ctx.fillStyle = caption.color;
    ctx.fillText(lineText, width / 2, y);
  });
  ctx.restore();
}

/** 日本語（単語区切りが無い）にも対応するため1文字ずつ幅を測って折り返す。 */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const char of Array.from(paragraph)) {
      const candidate = current + char;
      if (ctx.measureText(candidate).width > maxWidth && current !== '') {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  message: string,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, height / 2 - height * 0.05, width, height * 0.1);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${width * 0.042}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  ctx.restore();
}

/** 書き出し・プレビューで共通に使う「実際に描画する秒数」。 */
export function effectiveRange(
  project: Project,
  analysis: AudioAnalysis | null,
  clip: MotionClip | null,
): { start: number; end: number } {
  if (project.range) return project.range;
  if (analysis && analysis.duration > 0) return { start: 0, end: analysis.duration };
  if (clip) return { start: 0, end: clip.duration };
  return { start: 0, end: 5 };
}

/** 出力解像度（書き出し用）。 */
export function outputSize(project: Project): { width: number; height: number } {
  return canvasSize(project.canvas.presetId);
}
