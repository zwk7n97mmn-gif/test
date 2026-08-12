import { mix, shade, withAlpha } from '../util/color';
import type { CharacterAppearance, CharacterRig } from './appearance';
import type { PosedSkeleton, Vec2 } from './retarget';

export interface CharacterDynamics {
  /** 髪・スカートの慣性による横揺れ（-1..1）。ルート速度から算出。 */
  sway: number;
  /** 上下の揺れ（-1..1） */
  bob: number;
  /** 0=開眼, 1=閉眼 */
  blink: number;
  /** ビートに同期した拡大パルス 0..1（演出レイヤーが与える） */
  beat: number;
}

export const NEUTRAL_DYNAMICS: CharacterDynamics = { sway: 0, bob: 0, blink: 0, beat: 0 };

type Ctx = CanvasRenderingContext2D;

/**
 * キャラクターを 1 フレーム描画する。
 * ctx は「胴長 = 1 単位、腰 = 原点、+Y = 下」の座標系になるよう
 * 呼び出し側で translate / scale 済みであることを前提にする。
 */
export function drawCharacter(
  ctx: Ctx,
  skeleton: PosedSkeleton,
  appearance: CharacterAppearance,
  rig: CharacterRig,
  dynamics: CharacterDynamics = NEUTRAL_DYNAMICS,
): void {
  const p = skeleton.points;
  const line = 0.032 * appearance.lineWidth;
  const skinShadow = shade(appearance.skinColor, -0.12);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;

  // 頭の傾き（首→頭ベクトル）。顔・髪はこの回転で描く。
  const headAngle = Math.atan2(p.head.y - p.neck.y, p.head.x - p.neck.x) + Math.PI / 2;

  // 手前/奥の腕脚を決める。体の向きが反転したら重なり順も入れ替える。
  const farSuffix = skeleton.mirrored ? 'R' : 'L';
  const nearSuffix = skeleton.mirrored ? 'L' : 'R';

  drawBackHair(ctx, p.head, rig, appearance, dynamics, headAngle, line);

  // --- 奥側の腕・脚 ---------------------------------------------------------
  const farTint = 0.16;
  drawLeg(ctx, p, rig, appearance, farSuffix, line, farTint);
  drawArm(ctx, p, rig, appearance, farSuffix, line, farTint);

  // --- 脚（手前）と胴 -------------------------------------------------------
  drawLeg(ctx, p, rig, appearance, nearSuffix, line, 0);
  drawLower(ctx, p, rig, appearance, dynamics, line);
  drawTorso(ctx, p, rig, appearance, line);
  drawArm(ctx, p, rig, appearance, nearSuffix, line, 0);

  // --- 首と頭 ---------------------------------------------------------------
  drawPolyLimb(ctx, [p.chest, p.head], rig.limbWidth * 0.66, skinShadow, appearance.lineColor, line * 0.7);

  ctx.save();
  ctx.translate(p.head.x, p.head.y);
  ctx.rotate(headAngle);
  drawHead(ctx, rig.headRadius, appearance, dynamics, line, skeleton.facing);
  ctx.restore();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// パーツ描画
// ---------------------------------------------------------------------------

function drawHead(
  ctx: Ctx,
  r: number,
  a: CharacterAppearance,
  d: CharacterDynamics,
  line: number,
  facing: number,
): void {
  const w = r * 0.86;

  // 輪郭
  headPath(ctx, r, w);
  ctx.fillStyle = a.skinColor;
  ctx.fill();
  ctx.strokeStyle = a.lineColor;
  ctx.lineWidth = line;
  ctx.stroke();

  // 顔の向きに応じて目の位置を横へずらす（真横に近いほど寄る）
  const turn = (1 - clamp01(facing)) * 0.45 * w;
  const eyeY = r * 0.16;
  const eyeSpacing = w * 0.44;
  const eyeW = w * 0.4;
  const eyeH = r * 0.44 * eyeStyleHeight(a.eyeStyle);

  drawEye(ctx, -eyeSpacing + turn, eyeY, eyeW, eyeH, a, d.blink, -1);
  drawEye(ctx, eyeSpacing + turn, eyeY, eyeW, eyeH, a, d.blink, 1);

  // 眉
  ctx.strokeStyle = mix(a.hairColor, a.lineColor, 0.35);
  ctx.lineWidth = line * 0.9;
  for (const side of [-1, 1]) {
    const cx = side * eyeSpacing + turn;
    ctx.beginPath();
    ctx.moveTo(cx - eyeW * 0.5, eyeY - eyeH * 0.85);
    ctx.quadraticCurveTo(cx, eyeY - eyeH * 1.15, cx + eyeW * 0.5, eyeY - eyeH * 0.7);
    ctx.stroke();
  }

  // 口
  ctx.strokeStyle = mix(a.lineColor, '#d0596a', 0.5);
  ctx.lineWidth = line * 0.85;
  ctx.beginPath();
  const mouthY = r * 0.6;
  ctx.moveTo(turn - w * 0.1, mouthY);
  ctx.quadraticCurveTo(turn, mouthY + r * 0.1, turn + w * 0.1, mouthY);
  ctx.stroke();

  // 頬
  if (a.blush) {
    ctx.fillStyle = withAlpha('#f28ba0', 0.5);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * w * 0.62 + turn, r * 0.42, w * 0.2, r * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFrontHair(ctx, r, w, a, d, line);
  drawAccessory(ctx, r, w, a, line);
}

function headPath(ctx: Ctx, r: number, w: number): void {
  ctx.beginPath();
  ctx.moveTo(-w, -r * 0.1);
  ctx.bezierCurveTo(-w, -r * 1.08, w, -r * 1.08, w, -r * 0.1);
  ctx.bezierCurveTo(w * 0.98, r * 0.55, w * 0.4, r, 0, r);
  ctx.bezierCurveTo(-w * 0.4, r, -w * 0.98, r * 0.55, -w, -r * 0.1);
  ctx.closePath();
}

function eyeStyleHeight(style: CharacterAppearance['eyeStyle']): number {
  switch (style) {
    case 'round':
      return 1;
    case 'sharp':
      return 0.86;
    case 'sleepy':
      return 0.62;
  }
}

function drawEye(
  ctx: Ctx,
  cx: number,
  cy: number,
  w: number,
  h: number,
  a: CharacterAppearance,
  blink: number,
  side: -1 | 1,
): void {
  const openness = Math.max(0.06, 1 - clamp01(blink));
  const hh = h * openness;

  ctx.save();
  ctx.translate(cx, cy);
  if (a.eyeStyle === 'sharp') ctx.rotate(side * 0.12);

  // 白目
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, hh / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#fdfdff';
  ctx.fill();

  ctx.save();
  ctx.clip();

  // 虹彩（上が明るいグラデーション）
  const gradient = ctx.createLinearGradient(0, -hh / 2, 0, hh / 2);
  gradient.addColorStop(0, shade(a.eyeColor, 0.35));
  gradient.addColorStop(0.55, a.eyeColor);
  gradient.addColorStop(1, shade(a.eyeColor, -0.4));
  ctx.beginPath();
  ctx.ellipse(0, hh * 0.06, w * 0.38, hh * 0.44, 0, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // 瞳孔
  ctx.beginPath();
  ctx.ellipse(0, hh * 0.1, w * 0.16, hh * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = shade(a.eyeColor, -0.72);
  ctx.fill();

  // ハイライト
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(-w * 0.14, -hh * 0.2, w * 0.12, hh * 0.16, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w * 0.16, hh * 0.22, w * 0.06, hh * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // まつ毛（上まぶた）
  ctx.strokeStyle = a.lineColor;
  ctx.lineWidth = Math.max(hh * 0.14, 0.012);
  ctx.beginPath();
  if (a.eyeStyle === 'sleepy') {
    ctx.moveTo(-w / 2, -hh * 0.28);
    ctx.lineTo(w / 2, -hh * 0.28);
  } else {
    ctx.ellipse(0, 0, w / 2, hh / 2, 0, Math.PI * 1.05, Math.PI * 1.95);
  }
  ctx.stroke();

  ctx.restore();
}

function drawFrontHair(
  ctx: Ctx,
  r: number,
  w: number,
  a: CharacterAppearance,
  d: CharacterDynamics,
  line: number,
): void {
  const sway = d.sway * 0.06 * r;
  const gradient = ctx.createLinearGradient(0, -r, 0, r * 0.6);
  gradient.addColorStop(0, shade(a.hairColor, 0.12));
  gradient.addColorStop(1, a.hairColor);

  // 前髪の土台
  ctx.beginPath();
  ctx.moveTo(-w * 1.04, r * 0.05);
  ctx.bezierCurveTo(-w * 1.08, -r * 1.1, w * 1.08, -r * 1.1, w * 1.04, r * 0.05);
  // 毛先（3本の房）
  ctx.lineTo(w * 0.86 + sway, -r * 0.02);
  ctx.quadraticCurveTo(w * 0.6 + sway, r * 0.2, w * 0.42 + sway, -r * 0.12);
  ctx.quadraticCurveTo(w * 0.18 + sway, r * 0.3, w * 0.02 + sway, -r * 0.16);
  ctx.quadraticCurveTo(-w * 0.24 + sway, r * 0.26, -w * 0.46 + sway, -r * 0.14);
  ctx.quadraticCurveTo(-w * 0.72 + sway, r * 0.2, -w * 0.88 + sway, -r * 0.02);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = shade(a.hairColor, -0.35);
  ctx.lineWidth = line * 0.8;
  ctx.stroke();

  // 艶（ハイライト）
  ctx.beginPath();
  ctx.ellipse(-w * 0.2, -r * 0.55, w * 0.5, r * 0.09, -0.1, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(shade(a.hairColor, 0.65), 0.55);
  ctx.fill();

  // アホ毛
  ctx.strokeStyle = a.hairColor;
  ctx.lineWidth = line * 1.1;
  ctx.beginPath();
  ctx.moveTo(w * 0.05, -r * 0.98);
  ctx.quadraticCurveTo(w * 0.35 + sway * 3, -r * 1.5, w * 0.02 + sway * 4, -r * 1.62);
  ctx.stroke();
}

function drawBackHair(
  ctx: Ctx,
  head: Vec2,
  rig: CharacterRig,
  a: CharacterAppearance,
  d: CharacterDynamics,
  headAngle: number,
  line: number,
): void {
  const r = rig.headRadius;
  const w = r * 0.86;
  const sway = d.sway;

  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(headAngle);

  const gradient = ctx.createLinearGradient(0, -r, 0, r * 3);
  gradient.addColorStop(0, a.hairColor);
  gradient.addColorStop(1, a.hairTipColor);
  ctx.fillStyle = gradient;
  ctx.strokeStyle = shade(a.hairColor, -0.4);
  ctx.lineWidth = line * 0.8;

  const backLength = { long: 2.6, twintail: 1.0, ponytail: 0.85, bob: 1.05, short: 0.62 }[a.hairStyle] * r;

  // 後ろ髪のシルエット
  ctx.beginPath();
  ctx.moveTo(-w * 1.1, -r * 0.2);
  ctx.bezierCurveTo(-w * 1.15, -r * 1.15, w * 1.15, -r * 1.15, w * 1.1, -r * 0.2);
  ctx.quadraticCurveTo(w * 1.25 + sway * r * 0.5, backLength * 0.6, w * 0.7 + sway * r * 0.8, backLength);
  ctx.quadraticCurveTo(0 + sway * r * 0.9, backLength * 1.12, -w * 0.7 + sway * r * 0.8, backLength);
  ctx.quadraticCurveTo(-w * 1.25 + sway * r * 0.5, backLength * 0.6, -w * 1.1, -r * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (a.hairStyle === 'twintail') {
    for (const side of [-1, 1] as const) {
      drawTail(ctx, side * w * 1.05, -r * 0.25, side, r * 2.5, r * 0.42, sway, gradient, ctx.strokeStyle, line);
    }
  } else if (a.hairStyle === 'ponytail') {
    drawTail(ctx, w * 0.15, -r * 0.55, 1, r * 3.1, r * 0.5, sway, gradient, ctx.strokeStyle, line);
  }

  ctx.restore();
}

function drawTail(
  ctx: Ctx,
  x: number,
  y: number,
  side: -1 | 1,
  length: number,
  width: number,
  sway: number,
  fill: CanvasGradient | string,
  stroke: string,
  line: number,
): void {
  // 付け根から毛先に向かうにつれ、慣性で遅れて振れるように制御点をずらす
  const drift = sway * length * 0.28;
  const tipX = x + side * length * 0.42 + drift;
  const tipY = y + length;

  ctx.beginPath();
  ctx.moveTo(x - width * side, y);
  ctx.bezierCurveTo(
    x + side * width * 1.6,
    y + length * 0.35,
    tipX + side * width * 0.4 + drift * 0.4,
    y + length * 0.72,
    tipX,
    tipY,
  );
  ctx.bezierCurveTo(
    tipX - side * width * 1.5 + drift * 0.3,
    y + length * 0.7,
    x - side * width * 0.4,
    y + length * 0.34,
    x + width * side,
    y - width * 0.2,
  );
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = line * 0.8;
  ctx.stroke();
}

function drawAccessory(ctx: Ctx, r: number, w: number, a: CharacterAppearance, line: number): void {
  ctx.strokeStyle = shade(a.accessoryColor, -0.35);
  ctx.lineWidth = line * 0.8;
  ctx.fillStyle = a.accessoryColor;

  switch (a.accessory) {
    case 'none':
      return;
    case 'ribbon': {
      const cx = -w * 0.72;
      const cy = -r * 0.62;
      const s = r * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx - s * 1.5, cy - s * 0.9, cx - s * 1.4, cy + s * 0.15);
      ctx.quadraticCurveTo(cx - s * 1.3, cy + s * 0.85, cx, cy);
      ctx.quadraticCurveTo(cx + s * 1.3, cy + s * 0.85, cx + s * 1.4, cy + s * 0.15);
      ctx.quadraticCurveTo(cx + s * 1.5, cy - s * 0.9, cx, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = shade(a.accessoryColor, 0.3);
      ctx.fill();
      ctx.stroke();
      return;
    }
    case 'headphone': {
      ctx.beginPath();
      ctx.arc(0, -r * 0.15, w * 1.24, Math.PI * 1.12, Math.PI * 1.88);
      ctx.lineWidth = line * 2.4;
      ctx.strokeStyle = a.accessoryColor;
      ctx.stroke();
      ctx.lineWidth = line * 0.8;
      ctx.strokeStyle = shade(a.accessoryColor, -0.35);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(side * w * 1.1, -r * 0.05, w * 0.2, r * 0.26, 0, 0, Math.PI * 2);
        ctx.fillStyle = a.accessoryColor;
        ctx.fill();
        ctx.stroke();
      }
      return;
    }
    case 'hairpin': {
      ctx.lineWidth = line * 1.6;
      ctx.strokeStyle = a.accessoryColor;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(w * 0.42, -r * (0.62 - i * 0.16));
        ctx.lineTo(w * 0.86, -r * (0.5 - i * 0.16));
        ctx.stroke();
      }
      return;
    }
  }
}

function drawTorso(
  ctx: Ctx,
  p: PosedSkeleton['points'],
  rig: CharacterRig,
  a: CharacterAppearance,
  line: number,
): void {
  const halfChest = rig.torsoWidth / 2;
  const halfWaist = rig.torsoWidth * 0.36;
  const chestDir = normalize({ x: p.chest.x - p.hip.x, y: p.chest.y - p.hip.y });
  const perp = { x: -chestDir.y, y: chestDir.x };

  // 肩を丸め、腰をくびれさせたシルエット
  const c1 = add(p.chest, scale(perp, -halfChest));
  const c2 = add(p.chest, scale(perp, halfChest));
  const h2 = add(p.hip, scale(perp, halfWaist));
  const h1 = add(p.hip, scale(perp, -halfWaist));
  const shoulderTop = add(p.chest, scale(chestDir, 0.1));
  const hipBottom = add(p.hip, scale(chestDir, -0.08));
  const waistPinch = 0.055;

  const sideControl = (from: Vec2, to: Vec2, at: number, offset: number): Vec2 => ({
    x: from.x + (to.x - from.x) * at + perp.x * offset,
    y: from.y + (to.y - from.y) * at + perp.y * offset,
  });

  ctx.beginPath();
  ctx.moveTo(c1.x, c1.y);
  ctx.quadraticCurveTo(shoulderTop.x, shoulderTop.y, c2.x, c2.y);
  ctx.bezierCurveTo(
    sideControl(c2, h2, 0.34, -waistPinch).x,
    sideControl(c2, h2, 0.34, -waistPinch).y,
    sideControl(c2, h2, 0.72, 0.01).x,
    sideControl(c2, h2, 0.72, 0.01).y,
    h2.x,
    h2.y,
  );
  ctx.quadraticCurveTo(hipBottom.x, hipBottom.y, h1.x, h1.y);
  ctx.bezierCurveTo(
    sideControl(h1, c1, 0.28, -0.01).x,
    sideControl(h1, c1, 0.28, -0.01).y,
    sideControl(h1, c1, 0.66, waistPinch).x,
    sideControl(h1, c1, 0.66, waistPinch).y,
    c1.x,
    c1.y,
  );
  ctx.closePath();

  ctx.fillStyle = a.outfit === 'idol' ? shade(a.outfitColor, 0.05) : a.outfitColor;
  ctx.fill();
  ctx.strokeStyle = a.lineColor;
  ctx.lineWidth = line;
  ctx.stroke();

  // 衣装ごとのディテール
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(c1.x, c1.y);
  ctx.lineTo(h1.x, h1.y);
  ctx.lineTo(h2.x, h2.y);
  ctx.lineTo(c2.x, c2.y);
  ctx.closePath();
  ctx.clip();

  if (a.outfit === 'seifuku') {
    // セーラー襟
    ctx.fillStyle = a.outfitAccentColor;
    ctx.beginPath();
    ctx.moveTo(c1.x, c1.y);
    ctx.lineTo(p.chest.x, p.chest.y + rig.torsoWidth * 0.6);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c2.x - perp.x * 0.06, c2.y - perp.y * 0.06);
    ctx.lineTo(p.chest.x, p.chest.y + rig.torsoWidth * 0.42);
    ctx.lineTo(c1.x + perp.x * 0.06, c1.y + perp.y * 0.06);
    ctx.closePath();
    ctx.fill();
  } else if (a.outfit === 'hoodie') {
    ctx.strokeStyle = a.outfitAccentColor;
    ctx.lineWidth = line * 1.2;
    ctx.beginPath();
    ctx.moveTo(p.chest.x - 0.05, p.chest.y + 0.02);
    ctx.lineTo(p.chest.x - 0.03, p.chest.y + 0.3);
    ctx.moveTo(p.chest.x + 0.05, p.chest.y + 0.02);
    ctx.lineTo(p.chest.x + 0.03, p.chest.y + 0.3);
    ctx.stroke();
    ctx.fillStyle = withAlpha(shade(a.outfitColor, -0.2), 0.9);
    ctx.fillRect(p.hip.x - halfWaist, p.hip.y - 0.28, halfWaist * 2, 0.2);
  } else if (a.outfit === 'idol') {
    ctx.fillStyle = a.outfitAccentColor;
    ctx.fillRect(p.spine.x - halfChest, p.spine.y - 0.05, halfChest * 2, 0.09);
    ctx.beginPath();
    ctx.arc(p.spine.x, p.spine.y - 0.005, 0.07, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = withAlpha(a.outfitAccentColor, 0.85);
    ctx.fillRect(p.hip.x - halfWaist, p.hip.y - 0.1, halfWaist * 2, 0.08);
  }
  ctx.restore();
}

function drawLower(
  ctx: Ctx,
  p: PosedSkeleton['points'],
  rig: CharacterRig,
  a: CharacterAppearance,
  d: CharacterDynamics,
  line: number,
): void {
  if (a.outfit === 'hoodie') {
    // ショートパンツ
    const w = rig.torsoWidth * 0.5;
    ctx.beginPath();
    ctx.moveTo(p.hip.x - w, p.hip.y - 0.06);
    ctx.lineTo(p.hip.x + w, p.hip.y - 0.06);
    ctx.lineTo(p.hip.x + w * 0.95, p.hip.y + 0.34);
    ctx.lineTo(p.hip.x, p.hip.y + 0.2);
    ctx.lineTo(p.hip.x - w * 0.95, p.hip.y + 0.34);
    ctx.closePath();
    ctx.fillStyle = shade(a.outfitColor, -0.18);
    ctx.fill();
    ctx.strokeStyle = a.lineColor;
    ctx.lineWidth = line;
    ctx.stroke();
    return;
  }

  const length = a.outfit === 'dress' ? 0.78 : 0.56;
  const flare = a.outfit === 'idol' ? 1.5 : 1.25;
  const halfWaist = rig.torsoWidth * 0.4;
  const halfHem = rig.torsoWidth * flare;
  const swayX = d.sway * 0.14;

  ctx.beginPath();
  ctx.moveTo(p.hip.x - halfWaist, p.hip.y - 0.1);
  ctx.lineTo(p.hip.x + halfWaist, p.hip.y - 0.1);
  ctx.quadraticCurveTo(
    p.hip.x + halfHem * 0.9 + swayX,
    p.hip.y + length * 0.7,
    p.hip.x + halfHem + swayX,
    p.hip.y + length,
  );
  ctx.quadraticCurveTo(p.hip.x + swayX, p.hip.y + length * 1.16, p.hip.x - halfHem + swayX, p.hip.y + length);
  ctx.quadraticCurveTo(
    p.hip.x - halfHem * 0.9 + swayX,
    p.hip.y + length * 0.7,
    p.hip.x - halfWaist,
    p.hip.y - 0.1,
  );
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, p.hip.y - 0.1, 0, p.hip.y + length);
  const skirtBase = a.outfit === 'idol' ? a.outfitAccentColor : shade(a.outfitColor, -0.1);
  gradient.addColorStop(0, skirtBase);
  gradient.addColorStop(1, shade(skirtBase, -0.22));
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = a.lineColor;
  ctx.lineWidth = line;
  ctx.stroke();

  // プリーツ
  ctx.strokeStyle = withAlpha(shade(skirtBase, -0.5), 0.55);
  ctx.lineWidth = line * 0.6;
  for (let i = -2; i <= 2; i++) {
    const topX = p.hip.x + (halfWaist * i) / 2.6;
    const bottomX = p.hip.x + (halfHem * i) / 2.6 + swayX;
    ctx.beginPath();
    ctx.moveTo(topX, p.hip.y - 0.02);
    ctx.lineTo(bottomX, p.hip.y + length * 0.98);
    ctx.stroke();
  }
}

/**
 * 折れ線をひと続きの手足として描く。
 *
 * 関節ごとに独立したカプセルを fill+stroke すると、内側の丸キャップの輪郭が
 * 露出して関節に黒い円が浮いてしまう。同じパスを「太い線＝輪郭」「細い線＝塗り」の
 * 順に2回ストロークすることで、丸い継ぎ目が自動的に生成され、内部に線が残らない。
 */
function drawPolyLimb(
  ctx: Ctx,
  points: Vec2[],
  width: number,
  fill: string,
  lineColor: string,
  lineWidth: number,
): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = width * 2 + lineWidth * 2;
  ctx.stroke();
  ctx.strokeStyle = fill;
  ctx.lineWidth = width * 2;
  ctx.stroke();
  ctx.restore();
}

function drawArm(
  ctx: Ctx,
  p: PosedSkeleton['points'],
  rig: CharacterRig,
  a: CharacterAppearance,
  suffix: 'L' | 'R',
  line: number,
  tint: number,
): void {
  const shoulder = suffix === 'L' ? p.shoulderL : p.shoulderR;
  const elbow = suffix === 'L' ? p.elbowL : p.elbowR;
  const wrist = suffix === 'L' ? p.wristL : p.wristR;

  const sleeveLong = a.outfit === 'hoodie' || a.outfit === 'dress';
  const skin = tint > 0 ? shade(a.skinColor, -tint) : a.skinColor;
  const sleeve = tint > 0 ? shade(a.outfitColor, -tint) : a.outfitColor;
  const lineColor = tint > 0 ? shade(a.lineColor, tint * 0.4) : a.lineColor;
  const w = rig.limbWidth;
  const outline = line * 0.85;

  // 腕全体をひと続きに描いてから、袖を上に重ねる（袖口の線が意図した位置に出る）
  drawPolyLimb(ctx, [shoulder, elbow, wrist], w * 0.72, skin, lineColor, outline);
  drawPolyLimb(
    ctx,
    sleeveLong ? [shoulder, elbow, wrist] : [shoulder, elbow],
    w * 0.82,
    sleeve,
    lineColor,
    outline,
  );

  // 手
  ctx.beginPath();
  ctx.arc(wrist.x, wrist.y, w * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = skin;
  ctx.fill();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = outline;
  ctx.stroke();
}

function drawLeg(
  ctx: Ctx,
  p: PosedSkeleton['points'],
  rig: CharacterRig,
  a: CharacterAppearance,
  suffix: 'L' | 'R',
  line: number,
  tint: number,
): void {
  const hip = suffix === 'L' ? p.hipL : p.hipR;
  const knee = suffix === 'L' ? p.kneeL : p.kneeR;
  const ankle = suffix === 'L' ? p.ankleL : p.ankleR;
  const foot = suffix === 'L' ? p.footL : p.footR;

  const skin = tint > 0 ? shade(a.skinColor, -tint) : a.skinColor;
  const shoeColor = tint > 0 ? shade(a.outfitAccentColor, -tint) : a.outfitAccentColor;
  const lineColor = tint > 0 ? shade(a.lineColor, tint * 0.4) : a.lineColor;
  const w = rig.limbWidth;
  const outline = line * 0.85;

  drawPolyLimb(ctx, [hip, knee, ankle], w * 0.82, skin, lineColor, outline);
  drawPolyLimb(ctx, [ankle, foot], w * 0.7, shoeColor, lineColor, outline);
}

// ---------------------------------------------------------------------------
// 幾何ヘルパ
// ---------------------------------------------------------------------------

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-6 ? { x: 0, y: -1 } : { x: v.x / len, y: v.y / len };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
