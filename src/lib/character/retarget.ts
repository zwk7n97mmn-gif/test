import { getJoint, type JointName, type MotionFrame } from '../pose/types';
import type { CharacterRig } from './appearance';

export interface Vec2 {
  x: number;
  y: number;
}

export type PosedSkeleton = {
  points: Record<JointName, Vec2>;
  root: Vec2;
  facing: number;
  mirrored: boolean;
};

/**
 * モーション（関節の「向き」）とキャラクターリグ（骨の「長さ」）を合成して、
 * キャラクター固有のプロポーションで姿勢を再構成する。
 *
 * 元動画の人物の体格は長さ側に一切影響しない。これにより
 * 「モーションは元動画・容姿はこちらの設定」という分離が成立する。
 */
export function retarget(frame: MotionFrame, rig: CharacterRig): PosedSkeleton {
  const dir = (from: JointName, to: JointName, fallback: Vec2): Vec2 => {
    const a = getJoint(frame, from);
    const b = getJoint(frame, to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // 検出が潰れている場合は解剖学的な既定方向に落とす（破綻したポーズを出さない）
    if (!Number.isFinite(len) || len < 1e-5) return fallback;
    return { x: dx / len, y: dy / len };
  };

  const step = (origin: Vec2, d: Vec2, length: number): Vec2 => ({
    x: origin.x + d.x * length,
    y: origin.y + d.y * length,
  });

  const UP: Vec2 = { x: 0, y: -1 };
  const DOWN: Vec2 = { x: 0, y: 1 };
  const LEFT: Vec2 = { x: -1, y: 0 };
  const RIGHT: Vec2 = { x: 1, y: 0 };

  const hip: Vec2 = { x: 0, y: 0 };
  const spine = step(hip, dir('hip', 'spine', UP), rig.hipToSpine);
  const chest = step(spine, dir('spine', 'chest', UP), rig.spineToChest);
  const neck = step(chest, dir('chest', 'neck', UP), rig.chestToNeck);
  const head = step(neck, dir('neck', 'head', UP), rig.neckToHead);

  const shoulderL = step(chest, dir('chest', 'shoulderL', LEFT), rig.shoulderOffset);
  const elbowL = step(shoulderL, dir('shoulderL', 'elbowL', DOWN), rig.upperArm);
  const wristL = step(elbowL, dir('elbowL', 'wristL', DOWN), rig.foreArm);

  const shoulderR = step(chest, dir('chest', 'shoulderR', RIGHT), rig.shoulderOffset);
  const elbowR = step(shoulderR, dir('shoulderR', 'elbowR', DOWN), rig.upperArm);
  const wristR = step(elbowR, dir('elbowR', 'wristR', DOWN), rig.foreArm);

  const hipL = step(hip, dir('hip', 'hipL', LEFT), rig.hipOffset);
  const kneeL = step(hipL, dir('hipL', 'kneeL', DOWN), rig.thigh);
  const ankleL = step(kneeL, dir('kneeL', 'ankleL', DOWN), rig.shin);
  const footL = step(ankleL, dir('ankleL', 'footL', DOWN), rig.foot);

  const hipR = step(hip, dir('hip', 'hipR', RIGHT), rig.hipOffset);
  const kneeR = step(hipR, dir('hipR', 'kneeR', DOWN), rig.thigh);
  const ankleR = step(kneeR, dir('kneeR', 'ankleR', DOWN), rig.shin);
  const footR = step(ankleR, dir('ankleR', 'footR', DOWN), rig.foot);

  return {
    points: {
      hip,
      spine,
      chest,
      neck,
      head,
      shoulderL,
      elbowL,
      wristL,
      shoulderR,
      elbowR,
      wristR,
      hipL,
      kneeL,
      ankleL,
      footL,
      hipR,
      kneeR,
      ankleR,
      footR,
    },
    root: { ...frame.root },
    facing: frame.facing,
    mirrored: frame.mirrored,
  };
}

/** 骨格の上下端（描画スケール決定に使う）。 */
export function skeletonBounds(skeleton: PosedSkeleton, headRadius: number): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const p of Object.values(skeleton.points)) {
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
  }
  return {
    top: top - headRadius * 1.6,
    bottom: bottom + headRadius * 0.3,
    left: left - headRadius,
    right: right + headRadius,
  };
}
