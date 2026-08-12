import type { AudioAnalysis } from '../audio/types';
import { buildRig, type CharacterAppearance } from '../character/appearance';
import { drawCharacter, type CharacterDynamics } from '../character/draw';
import { retarget } from '../character/retarget';
import { sampleClip, type MotionClip, type MotionFrame } from '../pose/types';
import { canvasSize, type Project } from '../project/types';
import { mix, shade, withAlpha } from '../util/color';

export interface RenderInput {
  project: Project;
  clip: MotionClip | null;
  analysis: AudioAnalysis | null;
}

/** 「まだ素材が無い」ことを画面上で伝えるための状態。 */
export type EmptyReason = 'no-motion' | 'no-audio' | null;

const BEAT_DECAY = 0.16;

/**
 * 1フレームを合成する。時刻 t のみに依存する純関数的な描画（内部に蓄積状態を持たない）ため、
 * プレビューのシークでも書き出しでも完全に同じ絵になる。
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  time: number,
  input: RenderInput,
): { emptyReason: EmptyReason } {
  const { project, clip, analysis } = input;
  const { width, height } = canvasSize(project.canvas.presetId);

  const beat = beatEnergyAt(analysis, time);
  const bass = bandValueAt(analysis, time, 'low');

  drawBackground(ctx, width, height, project, beat, bass, time);

  if (!clip || clip.frames.length === 0) {
    drawPlaceholder(ctx, width, height, 'モーションが未設定です');
    return { emptyReason: 'no-motion' };
  }

  const motionTime = motionTimeAt(time, project, clip, analysis);
  const frame = sampleClip(clip, motionTime);
  if (!frame) {
    drawPlaceholder(ctx, width, height, 'このフレームには姿勢データがありません');
    return { emptyReason: 'no-motion' };
  }

  const rig = buildRig(project.appearance);
  const nominalHeight =
    rig.headRadius * 1.6 +
    rig.neckToHead +
    rig.chestToNeck +
    rig.spineToChest +
    rig.hipToSpine +
    rig.thigh +
    rig.shin +
    rig.foot;
  const legHeight = rig.thigh + rig.shin + rig.foot;

  const zoom = 1 + beat * project.effects.zoomPunch * 0.06;
  const pixelsPerUnit = ((height * 0.8 * project.timing.scale) / nominalHeight) * zoom;

  const originX = width / 2 + frame.root.x * project.timing.rootMotion * pixelsPerUnit;
  const originY =
    height * project.timing.anchorY -
    legHeight * pixelsPerUnit +
    frame.root.y * project.timing.rootMotion * pixelsPerUnit * 0.5;

  // 残像（過去フレームを薄く重ねる）。時刻依存のみなので再現性がある。
  if (project.effects.afterimage > 0.01) {
    for (const [lag, alpha] of [
      [0.07, 0.22],
      [0.14, 0.11],
    ] as const) {
      const past = sampleClip(clip, motionTimeAt(time - lag, project, clip, analysis));
      if (!past) continue;
      ctx.save();
      ctx.globalAlpha = alpha * project.effects.afterimage;
      ctx.translate(originX, originY);
      ctx.scale(pixelsPerUnit, pixelsPerUnit);
      if (project.timing.mirror) ctx.scale(-1, 1);
      drawCharacter(ctx, retarget(past, rig), project.appearance, rig, dynamicsFor(clip, past, time, beat, project));
      ctx.restore();
    }
  }

  ctx.save();
  ctx.translate(originX, originY);
  ctx.scale(pixelsPerUnit, pixelsPerUnit);
  if (project.timing.mirror) ctx.scale(-1, 1);
  drawCharacter(
    ctx,
    retarget(frame, rig),
    project.appearance,
    rig,
    dynamicsFor(clip, frame, time, beat, project),
  );
  ctx.restore();

  if (project.effects.particles > 0.01) {
    drawParticles(ctx, width, height, project, analysis, time);
  }

  if (project.caption.enabled && project.caption.text.trim()) {
    drawCaption(ctx, width, height, project);
  }

  return { emptyReason: analysis ? null : 'no-audio' };
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
  // 二分探索で直前のビートを求める
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

function dynamicsFor(
  clip: MotionClip,
  frame: MotionFrame,
  time: number,
  beat: number,
  project: Project,
): CharacterDynamics {
  // 髪・スカートの慣性: 直前フレームとのルート＆頭部の水平速度から求める
  const prev = sampleClip(clip, Math.max(0, frame.t - 0.08));
  const dx = prev ? frame.root.x - prev.root.x + (frame.positions[8] - prev.positions[8]) : 0;
  const sway = Math.max(-1, Math.min(1, -dx * 6));
  const bob = prev ? Math.max(-1, Math.min(1, (frame.root.y - prev.root.y) * 6)) : 0;
  // 3.1秒周期の瞬き（0.12秒だけ閉じる）。時刻の関数なので再現性がある。
  const cycle = (time % 3.1) / 3.1;
  const blink = cycle > 0.96 ? Math.sin(((cycle - 0.96) / 0.04) * Math.PI) : 0;
  return { sway, bob, blink, beat: beat * project.effects.zoomPunch };
}

// ---------------------------------------------------------------------------
// 背景・演出
// ---------------------------------------------------------------------------

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
  beat: number,
  bass: number,
  time: number,
): void {
  const { background } = project;
  const pulse = beat * background.beatReactivity;
  const colorA = shade(background.colorA, pulse * 0.25);
  const colorB = shade(background.colorB, pulse * 0.15);

  ctx.save();
  switch (background.kind) {
    case 'solid': {
      ctx.fillStyle = colorA;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'gradient': {
      const g = ctx.createLinearGradient(0, 0, width * 0.4, height);
      g.addColorStop(0, colorA);
      g.addColorStop(1, colorB);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'stage': {
      ctx.fillStyle = shade(colorB, -0.5);
      ctx.fillRect(0, 0, width, height);
      const spot = ctx.createRadialGradient(
        width / 2,
        height * 0.4,
        width * 0.05,
        width / 2,
        height * 0.55,
        width * (0.75 + pulse * 0.1),
      );
      spot.addColorStop(0, withAlpha(colorA, 0.95));
      spot.addColorStop(1, withAlpha(shade(colorB, -0.6), 0));
      ctx.fillStyle = spot;
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'grid': {
      ctx.fillStyle = colorA;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = withAlpha(colorB, 0.55);
      ctx.lineWidth = Math.max(1, width / 540);
      const step = width / 12;
      const drift = (time * step * 0.25) % step;
      ctx.beginPath();
      for (let x = -step + drift; x <= width + step; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = -step + drift; y <= height + step; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
      break;
    }
  }

  // 低域に反応する床の波紋
  if (project.effects.bassPulse > 0.01) {
    const radius = width * (0.35 + bass * 0.35);
    const floorY = height * project.timing.anchorY;
    const glow = ctx.createRadialGradient(width / 2, floorY, 0, width / 2, floorY, radius);
    glow.addColorStop(0, withAlpha(mix(colorA, '#ffffff', 0.6), 0.35 * project.effects.bassPulse * (0.4 + bass)));
    glow.addColorStop(1, withAlpha(colorA, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(width / 2, floorY, radius, radius * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * ビートごとに決定的な擬似乱数で粒子を生成する。
 * 時刻 t から一意に決まるので、シーク・再エクスポートしても同じ絵になる。
 */
function drawParticles(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
  analysis: AudioAnalysis | null,
  time: number,
): void {
  if (!analysis || analysis.beats.length === 0) return;
  const life = 1.1;
  const perBeat = Math.round(4 + project.effects.particles * 14);
  const accent = mix(project.background.colorA, '#ffffff', 0.75);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = analysis.beats.length - 1; i >= 0; i--) {
    const beat = analysis.beats[i];
    const age = time - beat.time;
    if (age < 0) continue;
    if (age > life) break;

    const fade = 1 - age / life;
    for (let k = 0; k < perBeat; k++) {
      const rand = hash2(i, k);
      const angle = rand * Math.PI * 2;
      const speed = 0.25 + hash2(i, k + 97) * 0.7;
      const distance = age * speed * height * 0.35;
      const x = width / 2 + Math.cos(angle) * distance * 1.4;
      const y = height * project.timing.anchorY - Math.sin(angle) * distance - age * height * 0.05;
      const size = (2 + hash2(i, k + 311) * 6) * (width / 1080) * fade;
      if (size <= 0) continue;
      ctx.globalAlpha = fade * 0.6 * project.effects.particles;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 整数2つから 0..1 の決定的な擬似乱数を作る。 */
function hash2(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
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

  // 可読性のための帯（背景色に対して十分なコントラストを確保する）
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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(0, height / 2 - height * 0.06, width, height * 0.12);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${width * 0.04}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
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

export type { CharacterAppearance };
