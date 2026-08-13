import { getJoint, type JointName, type MotionFrame, type Vec3 } from '../pose/types';
import type { CharacterRig } from './appearance';

export type PosedSkeleton = {
  points: Record<JointName, Vec3>;
  root: Vec3;
  facing: number;
};

/**
 * モーション（関節の「向き」）とキャラクターリグ（骨の「長さ」）を合成して、
 * キャラクター固有のプロポーションで 3D 姿勢を再構成する。
 *
 * 元動画の人物の体格は長さ側に一切影響しない。これにより
 * 「モーションは元動画・容姿はこちらの設定」という分離が成立する。
 */
export function retarget(frame: MotionFrame, rig: CharacterRig): PosedSkeleton {
  const dir = (from: JointName, to: JointName, fallback: Vec3): Vec3 => {
    const a = getJoint(frame, from);
    const b = getJoint(frame, to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    // 検出が潰れている場合は解剖学的な既定方向に落とす（破綻したポーズを出さない）
    if (!Number.isFinite(len) || len < 1e-5) return fallback;
    return { x: dx / len, y: dy / len, z: dz / len };
  };

  const step = (origin: Vec3, d: Vec3, length: number): Vec3 => ({
    x: origin.x + d.x * length,
    y: origin.y + d.y * length,
    z: origin.z + d.z * length,
  });

  const UP: Vec3 = { x: 0, y: 1, z: 0 };
  const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
  const LEFT: Vec3 = { x: -1, y: 0, z: 0 };
  const RIGHT: Vec3 = { x: 1, y: 0, z: 0 };

  const hip: Vec3 = { x: 0, y: 0, z: 0 };
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
  };
}

/** 骨格の最下点（足裏を地面に置くためのオフセット算出に使う）。 */
export function lowestPoint(skeleton: PosedSkeleton): number {
  let lowest = Infinity;
  for (const p of Object.values(skeleton.points)) {
    if (p.y < lowest) lowest = p.y;
  }
  return Number.isFinite(lowest) ? lowest : 0;
}
