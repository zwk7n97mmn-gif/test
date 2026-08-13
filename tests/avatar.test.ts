import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyPoseToAvatar,
  buildAvatarRig,
  guessBonesByName,
  normalizeBoneName,
  type HumanBoneName,
} from '../src/lib/character/avatarRetarget';
import { JOINT_COUNT, JOINT_INDEX, type JointName, type MotionFrame } from '../src/lib/pose/types';

/**
 * テスト用のヒューマノイド骨格を組み立てる。
 * T ポーズ・+Z 正面・Y 上向きの、ごく普通の人型リグ。
 * @param mirrored true にすると左右が入れ替わった（＝背面を向いた）リグになる
 */
function makeSkeleton(mirrored = false): {
  model: THREE.Object3D;
  bones: Record<HumanBoneName, THREE.Object3D>;
} {
  const s = mirrored ? -1 : 1;
  const make = (name: string, x: number, y: number, z: number, parent: THREE.Object3D) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    return bone;
  };

  const model = new THREE.Group();
  model.name = 'Armature';

  const hips = make('Hips', 0, 0.95, 0, model);
  const spine = make('Spine', 0, 0.14, 0, hips);
  const chest = make('Chest', 0, 0.21, 0, spine);
  const neck = make('Neck', 0, 0.16, 0, chest);
  make('Head', 0, 0.11, 0, neck);

  const bones = {} as Record<HumanBoneName, THREE.Object3D>;
  bones.hips = hips;
  bones.spine = spine;
  bones.chest = chest;
  bones.neck = neck;
  bones.head = neck.children[0] as THREE.Object3D;

  for (const side of ['left', 'right'] as const) {
    const dir = (side === 'left' ? 1 : -1) * s;
    const upper = make(`${side === 'left' ? 'Left' : 'Right'}Arm`, dir * 0.17, 0.09, 0, chest);
    const lower = make(`${side === 'left' ? 'Left' : 'Right'}ForeArm`, dir * 0.26, 0, 0, upper);
    const hand = make(`${side === 'left' ? 'Left' : 'Right'}Hand`, dir * 0.24, 0, 0, lower);
    bones[`${side}UpperArm` as HumanBoneName] = upper;
    bones[`${side}LowerArm` as HumanBoneName] = lower;
    bones[`${side}Hand` as HumanBoneName] = hand;

    const thigh = make(`${side === 'left' ? 'Left' : 'Right'}UpLeg`, dir * 0.09, -0.06, 0, hips);
    const calf = make(`${side === 'left' ? 'Left' : 'Right'}Leg`, 0, -0.42, 0, thigh);
    const foot = make(`${side === 'left' ? 'Left' : 'Right'}Foot`, 0, -0.4, 0, calf);
    bones[`${side}UpperLeg` as HumanBoneName] = thigh;
    bones[`${side}LowerLeg` as HumanBoneName] = calf;
    bones[`${side}Foot` as HumanBoneName] = foot;
  }

  model.updateMatrixWorld(true);
  return { model, bones };
}

/** テスト用のモーションフレームを作る（指定しない関節は原点）。 */
function makeFrame(joints: Partial<Record<JointName, [number, number, number]>>): MotionFrame {
  const positions = new Float32Array(JOINT_COUNT * 3);
  for (const [name, value] of Object.entries(joints)) {
    const i = JOINT_INDEX[name as JointName];
    positions[i * 3] = value![0];
    positions[i * 3 + 1] = value![1];
    positions[i * 3 + 2] = value![2];
  }
  return {
    t: 0,
    positions,
    confidence: new Float32Array(JOINT_COUNT).fill(1),
    root: { x: 0, y: 0, z: 0 },
    facing: 1,
  };
}

/** 直立に近い基本フレーム。腕は下ろし、脚はまっすぐ。 */
function standingFrame(): MotionFrame {
  return makeFrame({
    hip: [0, 0, 0],
    spine: [0, 0.45, 0],
    chest: [0, 1, 0],
    neck: [0, 1.18, 0],
    head: [0, 1.5, 0],
    shoulderL: [0.4, 0.98, 0],
    elbowL: [0.5, 0.35, 0.05],
    wristL: [0.55, -0.25, 0.1],
    shoulderR: [-0.4, 0.98, 0],
    elbowR: [-0.5, 0.35, 0.05],
    wristR: [-0.55, -0.25, 0.1],
    hipL: [0.17, 0, 0],
    kneeL: [0.2, -0.95, 0.02],
    ankleL: [0.22, -1.85, 0],
    footL: [0.22, -1.98, 0.16],
    hipR: [-0.17, 0, 0],
    kneeR: [-0.2, -0.95, 0.02],
    ankleR: [-0.22, -1.85, 0],
    footR: [-0.22, -1.98, 0.16],
  });
}

const worldPos = (object: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);

const worldDir = (from: THREE.Object3D, to: THREE.Object3D) =>
  worldPos(to).sub(worldPos(from)).normalize();

describe('ボーン名の推定', () => {
  it('区切り文字や大文字小文字を無視して正規化する', () => {
    expect(normalizeBoneName('mixamorig:LeftForeArm')).toBe('mixamorigleftforearm');
    expect(normalizeBoneName('Upper_Arm.L')).toBe('upperarml');
  });

  it('Mixamo 形式のボーン名から humanoid ボーンを推定できる', () => {
    const { model } = makeSkeleton();
    const bones = guessBonesByName(model);
    expect(bones.hips?.name).toBe('Hips');
    expect(bones.leftUpperArm?.name).toBe('LeftArm');
    expect(bones.leftLowerArm?.name).toBe('LeftForeArm');
    expect(bones.rightLowerLeg?.name).toBe('RightLeg');
    expect(bones.head?.name).toBe('Head');
  });

  it('同じボーンを2つの役割に割り当てない', () => {
    const { model } = makeSkeleton();
    const bones = guessBonesByName(model);
    const objects = Object.values(bones);
    expect(new Set(objects).size).toBe(objects.length);
  });
});

describe('アバターリグの構築', () => {
  it('胴長が 1 になるようスケールされる', () => {
    const { model, bones } = makeSkeleton();
    const rig = buildAvatarRig(model, bones);
    rig.root.updateMatrixWorld(true);
    const torso = worldPos(bones.hips).distanceTo(worldPos(bones.chest));
    expect(torso).toBeCloseTo(1, 5);
  });

  it('全身の高さと腰の高さを算出する', () => {
    const { model, bones } = makeSkeleton();
    const rig = buildAvatarRig(model, bones);
    expect(rig.totalHeight).toBeGreaterThan(3);
    expect(rig.totalHeight).toBeLessThan(6);
    expect(rig.hipsHeight).toBeGreaterThan(0);
    expect(rig.hipsHeight).toBeLessThan(rig.totalHeight);
  });

  it('正面を向いたモデルは反転不要と判定される', () => {
    const { model, bones } = makeSkeleton(false);
    expect(buildAvatarRig(model, bones).facesBackward).toBe(false);
  });

  it('左右が逆のモデルは反転が必要と判定される', () => {
    const { model, bones } = makeSkeleton(true);
    expect(buildAvatarRig(model, bones).facesBackward).toBe(true);
  });

  it('必須ボーンが欠けていると分かりやすい例外になる', () => {
    const { model, bones } = makeSkeleton();
    const broken = { ...bones };
    delete (broken as Partial<Record<HumanBoneName, THREE.Object3D>>).leftUpperLeg;
    expect(() => buildAvatarRig(model, broken)).toThrow(/ボーンが不足/);
  });
});

describe('アバターへのモーション適用', () => {
  const setup = () => {
    const { model, bones } = makeSkeleton();
    const rig = buildAvatarRig(model, bones);
    return { rig, bones };
  };

  it('各ボーンがモーションの向きに一致する', () => {
    const { rig, bones } = setup();
    const frame = standingFrame();
    applyPoseToAvatar(rig, frame, { flipFacing: false });
    rig.root.updateMatrixWorld(true);

    const expectDirection = (
      boneFrom: THREE.Object3D,
      boneTo: THREE.Object3D,
      from: JointName,
      to: JointName,
    ) => {
      const i = JOINT_INDEX[from];
      const j = JOINT_INDEX[to];
      const target = new THREE.Vector3(
        frame.positions[j * 3] - frame.positions[i * 3],
        frame.positions[j * 3 + 1] - frame.positions[i * 3 + 1],
        frame.positions[j * 3 + 2] - frame.positions[i * 3 + 2],
      ).normalize();
      const actual = worldDir(boneFrom, boneTo);
      expect(actual.x).toBeCloseTo(target.x, 4);
      expect(actual.y).toBeCloseTo(target.y, 4);
      expect(actual.z).toBeCloseTo(target.z, 4);
    };

    expectDirection(bones.leftUpperArm, bones.leftLowerArm, 'shoulderL', 'elbowL');
    expectDirection(bones.leftLowerArm, bones.leftHand, 'elbowL', 'wristL');
    expectDirection(bones.rightUpperArm, bones.rightLowerArm, 'shoulderR', 'elbowR');
    expectDirection(bones.leftUpperLeg, bones.leftLowerLeg, 'hipL', 'kneeL');
    expectDirection(bones.leftLowerLeg, bones.leftFoot, 'kneeL', 'ankleL');
    expectDirection(bones.rightLowerLeg, bones.rightFoot, 'kneeR', 'ankleR');
    expectDirection(bones.spine, bones.chest, 'spine', 'chest');
    expectDirection(bones.neck, bones.head, 'neck', 'head');
  });

  it('アバターの体型（骨の長さ）は変化しない', () => {
    const { rig, bones } = setup();
    rig.root.updateMatrixWorld(true);
    const pairs: Array<[THREE.Object3D, THREE.Object3D]> = [
      [bones.leftUpperArm, bones.leftLowerArm],
      [bones.leftLowerArm, bones.leftHand],
      [bones.leftUpperLeg, bones.leftLowerLeg],
      [bones.leftLowerLeg, bones.leftFoot],
      [bones.hips, bones.spine],
      [bones.chest, bones.neck],
    ];
    const before = pairs.map(([a, b]) => worldPos(a).distanceTo(worldPos(b)));

    applyPoseToAvatar(rig, standingFrame(), { flipFacing: false });
    rig.root.updateMatrixWorld(true);
    const after = pairs.map(([a, b]) => worldPos(a).distanceTo(worldPos(b)));

    after.forEach((value, i) => expect(value).toBeCloseTo(before[i], 6));
  });

  it('体の正面がカメラ側（+Z）を向く', () => {
    const { rig, bones } = setup();
    applyPoseToAvatar(rig, standingFrame(), { flipFacing: false });
    rig.root.updateMatrixWorld(true);
    // 左肩が +X 側にあれば、モデルはカメラを向いている
    expect(worldPos(bones.leftUpperArm).x).toBeGreaterThan(worldPos(bones.rightUpperArm).x);
  });

  it('反転指定で正面が逆になる', () => {
    const { rig, bones } = setup();
    applyPoseToAvatar(rig, standingFrame(), { flipFacing: true });
    rig.root.updateMatrixWorld(true);
    expect(worldPos(bones.leftUpperArm).x).toBeLessThan(worldPos(bones.rightUpperArm).x);
  });

  it('体をひねると胴の向きが追従する', () => {
    const { rig, bones } = setup();
    const frame = standingFrame();
    // 肩を Z 方向にずらして 90° ひねる
    const l = JOINT_INDEX.shoulderL;
    const r = JOINT_INDEX.shoulderR;
    frame.positions[l * 3] = 0;
    frame.positions[l * 3 + 2] = 0.4;
    frame.positions[r * 3] = 0;
    frame.positions[r * 3 + 2] = -0.4;
    const hl = JOINT_INDEX.hipL;
    const hr = JOINT_INDEX.hipR;
    frame.positions[hl * 3] = 0;
    frame.positions[hl * 3 + 2] = 0.17;
    frame.positions[hr * 3] = 0;
    frame.positions[hr * 3 + 2] = -0.17;

    applyPoseToAvatar(rig, frame, { flipFacing: false });
    rig.root.updateMatrixWorld(true);
    // 左肩が手前(+Z)、右肩が奥(-Z)に来る
    expect(worldPos(bones.leftUpperArm).z).toBeGreaterThan(worldPos(bones.rightUpperArm).z);
  });

  it('連続して適用してもポーズが蓄積しない（同じ入力なら同じ結果）', () => {
    const { rig, bones } = setup();
    const frame = standingFrame();
    applyPoseToAvatar(rig, frame, { flipFacing: false });
    rig.root.updateMatrixWorld(true);
    const first = worldPos(bones.leftHand);
    for (let i = 0; i < 5; i++) {
      applyPoseToAvatar(rig, frame, { flipFacing: false });
      rig.root.updateMatrixWorld(true);
    }
    const last = worldPos(bones.leftHand);
    expect(last.distanceTo(first)).toBeLessThan(1e-6);
  });

  it('関節が退化していても NaN を出さない', () => {
    const { rig, bones } = setup();
    const frame = makeFrame({});
    applyPoseToAvatar(rig, frame, { flipFacing: false });
    rig.root.updateMatrixWorld(true);
    for (const bone of Object.values(bones)) {
      const p = worldPos(bone);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });
});
