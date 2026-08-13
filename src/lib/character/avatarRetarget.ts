import * as THREE from 'three';
import { getJoint, type JointName, type MotionFrame } from '../pose/types';

/**
 * ヒューマノイドの標準ボーン名（VRM の humanBones に準拠した部分集合）。
 * 外部アバター（VRM / glTF）を動かすときは、まずこの名前空間に写像する。
 */
export const HUMAN_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const;

export type HumanBoneName = (typeof HUMAN_BONES)[number];

/** 骨格として最低限必要なボーン。これが欠けているモデルは動かせない。 */
export const REQUIRED_BONES: HumanBoneName[] = [
  'hips',
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
  'leftUpperLeg',
  'leftLowerLeg',
  'rightUpperLeg',
  'rightLowerLeg',
];

/**
 * 名前からボーンを推定するための別名表。
 * VRM / Mixamo / Unreal / Blender Rigify など、よくある命名を網羅する。
 * 比較時は小文字化して英数字以外を除去する。
 */
const BONE_ALIASES: Record<HumanBoneName, string[]> = {
  hips: ['hips', 'hip', 'pelvis', 'mixamorighips', 'bip01pelvis', 'root'],
  spine: ['spine', 'spine1', 'mixamorigspine', 'bip01spine'],
  chest: ['chest', 'upperchest', 'spine2', 'spine3', 'mixamorigspine1', 'mixamorigspine2', 'bip01spine1'],
  neck: ['neck', 'mixamorigneck', 'bip01neck'],
  head: ['head', 'mixamorighead', 'bip01head'],
  leftUpperArm: ['leftupperarm', 'leftarm', 'upperarml', 'arml', 'mixamorigleftarm', 'lupperarm', 'bip01larm'],
  leftLowerArm: ['leftlowerarm', 'leftforearm', 'lowerarml', 'forearml', 'mixamorigleftforearm', 'llowerarm'],
  leftHand: ['lefthand', 'handl', 'mixamoriglefthand', 'lhand'],
  rightUpperArm: ['rightupperarm', 'rightarm', 'upperarmr', 'armr', 'mixamorigrightarm', 'rupperarm', 'bip01rarm'],
  rightLowerArm: ['rightlowerarm', 'rightforearm', 'lowerarmr', 'forearmr', 'mixamorigrightforearm', 'rlowerarm'],
  rightHand: ['righthand', 'handr', 'mixamorigrighthand', 'rhand'],
  leftUpperLeg: ['leftupperleg', 'leftupleg', 'thighl', 'upperlegl', 'mixamorigleftupleg', 'lthigh'],
  leftLowerLeg: ['leftlowerleg', 'leftleg', 'calfl', 'shinl', 'lowerlegl', 'mixamorigleftleg', 'lcalf'],
  leftFoot: ['leftfoot', 'footl', 'mixamorigleftfoot', 'lfoot', 'ankle_l', 'anklel'],
  rightUpperLeg: ['rightupperleg', 'rightupleg', 'thighr', 'upperlegr', 'mixamorigrightupleg', 'rthigh'],
  rightLowerLeg: ['rightlowerleg', 'rightleg', 'calfr', 'shinr', 'lowerlegr', 'mixamorigrightleg', 'rcalf'],
  rightFoot: ['rightfoot', 'footr', 'mixamorigrightfoot', 'rfoot', 'ankle_r', 'ankler'],
};

export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * オブジェクト階層のボーン名から humanoid ボーンを推定する。
 * 別名の完全一致を優先し、見つからないものだけ部分一致で拾う。
 */
export function guessBonesByName(root: THREE.Object3D): Partial<Record<HumanBoneName, THREE.Object3D>> {
  const candidates: Array<{ node: THREE.Object3D; key: string }> = [];
  root.traverse((node) => {
    if (node.name) candidates.push({ node, key: normalizeBoneName(node.name) });
  });

  const result: Partial<Record<HumanBoneName, THREE.Object3D>> = {};
  const used = new Set<THREE.Object3D>();

  for (const pass of ['exact', 'partial'] as const) {
    for (const bone of HUMAN_BONES) {
      if (result[bone]) continue;
      for (const alias of BONE_ALIASES[bone]) {
        const found = candidates.find(({ node, key }) => {
          if (used.has(node)) return false;
          return pass === 'exact' ? key === alias : key.includes(alias);
        });
        if (found) {
          result[bone] = found.node;
          used.add(found.node);
          break;
        }
      }
    }
  }
  return result;
}

/**
 * 「このボーンを、どの関節ペアの向きに合わせるか」の定義。
 * `aim` は向きの基準にする子ボーン（アバター側）。
 */
interface BoneDriver {
  bone: HumanBoneName;
  aim: HumanBoneName;
  from: JointName;
  to: JointName;
}

const DRIVERS: BoneDriver[] = [
  { bone: 'spine', aim: 'chest', from: 'spine', to: 'chest' },
  { bone: 'chest', aim: 'neck', from: 'chest', to: 'neck' },
  { bone: 'neck', aim: 'head', from: 'neck', to: 'head' },
  { bone: 'leftUpperArm', aim: 'leftLowerArm', from: 'shoulderL', to: 'elbowL' },
  { bone: 'leftLowerArm', aim: 'leftHand', from: 'elbowL', to: 'wristL' },
  { bone: 'rightUpperArm', aim: 'rightLowerArm', from: 'shoulderR', to: 'elbowR' },
  { bone: 'rightLowerArm', aim: 'rightHand', from: 'elbowR', to: 'wristR' },
  { bone: 'leftUpperLeg', aim: 'leftLowerLeg', from: 'hipL', to: 'kneeL' },
  { bone: 'leftLowerLeg', aim: 'leftFoot', from: 'kneeL', to: 'ankleL' },
  { bone: 'rightUpperLeg', aim: 'rightLowerLeg', from: 'hipR', to: 'kneeR' },
  { bone: 'rightLowerLeg', aim: 'rightFoot', from: 'kneeR', to: 'ankleR' },
];

interface BoneRest {
  /** レストポーズでのローカル回転。毎フレームここへ戻してから姿勢を作る。 */
  localQuat: THREE.Quaternion;
  /** 向きの基準にする子ボーン */
  aim: THREE.Object3D | null;
}

export interface AvatarRig {
  /** シーンに追加するオブジェクト（scale 済み） */
  root: THREE.Object3D;
  /** アバター本体（root の子。スケール調整のために1段包んでいる） */
  model: THREE.Object3D;
  bones: Partial<Record<HumanBoneName, THREE.Object3D>>;
  rest: Partial<Record<HumanBoneName, BoneRest>>;
  /** 胴長(hips→chest) を 1 にするための倍率 */
  unitScale: number;
  /** 胴長=1 単位での全身の高さ（カメラの画角決定に使う） */
  totalHeight: number;
  /** レストポーズでの hips の高さ（胴長=1 単位） */
  hipsHeight: number;
  /** モデルの正面が -Z 向き（glTF 標準 / VRM 1.0）なら true */
  facesBackward: boolean;
  warnings: string[];
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ1 = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpSide = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpForward = new THREE.Vector3();

/**
 * 読み込んだモデルからリグを構築する。
 *
 * ここでレストポーズ（＝モデル本来の姿勢）を記録しておき、以後は
 * 「レスト時の向き → 目標の向き」の差分回転だけを適用する。
 * ボーンの長さには一切触れないため、アバターの体型はそのまま保たれる。
 */
export function buildAvatarRig(
  model: THREE.Object3D,
  bones: Partial<Record<HumanBoneName, THREE.Object3D>>,
): AvatarRig {
  const warnings: string[] = [];
  const missing = REQUIRED_BONES.filter((bone) => !bones[bone]);
  if (missing.length > 0) {
    throw new Error(
      `ヒューマノイドのボーンが不足しています（${missing.join(', ')}）。VRM もしくは標準的な人型ボーン名の glTF を使用してください。`,
    );
  }

  const root = new THREE.Group();
  root.add(model);
  root.updateMatrixWorld(true);

  const worldOf = (bone: HumanBoneName, out: THREE.Vector3): THREE.Vector3 =>
    out.setFromMatrixPosition(bones[bone]!.matrixWorld);

  // 胴長（hips→chest。chest が無ければ spine、それも無ければ肩の中点）で正規化する
  const hipsPos = worldOf('hips', new THREE.Vector3());
  const upperRef = bones.chest ?? bones.spine ?? bones.neck ?? bones.head;
  let torso = 0;
  if (upperRef) {
    torso = tmpV1.setFromMatrixPosition(upperRef.matrixWorld).distanceTo(hipsPos);
  }
  if (!(torso > 1e-6)) {
    // 胴のボーンが取れない場合は肩幅から推定する
    const l = tmpV1.setFromMatrixPosition(bones.leftUpperArm!.matrixWorld);
    const r = tmpV2.setFromMatrixPosition(bones.rightUpperArm!.matrixWorld);
    torso = l.distanceTo(r) || 1;
    warnings.push('胴のボーンが見つからないため、肩幅から大きさを推定しました。');
  }

  const unitScale = 1 / torso;
  root.scale.setScalar(unitScale);
  root.updateMatrixWorld(true);

  // レストポーズの記録（ローカル回転を保存し、毎フレームここから作り直す）
  const rest: Partial<Record<HumanBoneName, BoneRest>> = {};
  for (const driver of DRIVERS) {
    const bone = bones[driver.bone];
    const aim = bones[driver.aim];
    if (!bone || !aim) continue;
    const a = tmpV1.setFromMatrixPosition(bone.matrixWorld);
    const b = tmpV2.setFromMatrixPosition(aim.matrixWorld);
    if (a.distanceToSquared(b) < 1e-12) continue;
    rest[driver.bone] = { localQuat: bone.quaternion.clone(), aim };
  }
  rest.hips = { localQuat: bones.hips!.quaternion.clone(), aim: null };

  const driven = DRIVERS.filter((d) => rest[d.bone]).length;
  if (driven < DRIVERS.length) {
    warnings.push(`${DRIVERS.length - driven} 本のボーンは対応付けできず、動きません。`);
  }

  // メッシュから寸法を取る。スキン付きメッシュを持たないリグ（ボーンだけの
  // モデルやテスト用の骨格）では空になるため、ボーン位置でも必ず広げておく。
  // 空のままだと min/max が ±Infinity になり、以降の計算が NaN になる。
  const box = new THREE.Box3().setFromObject(root);
  for (const bone of Object.values(bones)) {
    if (bone) box.expandByPoint(tmpV1.setFromMatrixPosition(bone.matrixWorld));
  }
  const totalHeight = Math.max(0.5, box.max.y - box.min.y);
  const hipsHeight = tmpV1.setFromMatrixPosition(bones.hips!.matrixWorld).y - box.min.y;

  // 正面の向きは幾何から判定する。
  // 本ツールの座標系ではキャラクターの「左」が +X（カメラを向いたとき画面右）。
  // モデルのレストポーズで左腕が -X 側にあるなら、そのモデルは背を向けている。
  const leftArm = tmpV1.setFromMatrixPosition(bones.leftUpperArm!.matrixWorld);
  const rightArm = tmpV2.setFromMatrixPosition(bones.rightUpperArm!.matrixWorld);
  const facesBackward = leftArm.x - rightArm.x < 0;

  return { root, model, bones, rest, unitScale, totalHeight, hipsHeight, facesBackward, warnings };
}

export interface ApplyPoseOptions {
  /** 元動画の移動量をどれだけ反映するか 0..1 */
  rootMotion?: number;
  /** 正面の向きを 180° 反転する（自動判定を手動で上書きする用） */
  flipFacing?: boolean;
}

/**
 * モーション 1 フレームをアバターに適用する。
 *
 * ・hips は「肩と腰の軸から作った基底」で向きを決める（体の正面を決める）
 * ・他のボーンは「レスト時の向き → 目標の向き」の最小回転だけを掛ける
 *   （ボーンの長さもローカル位置も変えないので、アバターの体型は保たれる）
 */
export function applyPoseToAvatar(
  rig: AvatarRig,
  frame: MotionFrame,
  options: ApplyPoseOptions = {},
): void {
  const rootMotion = options.rootMotion ?? 0;
  const flip = options.flipFacing ?? rig.facesBackward;

  const joint = (name: JointName, out: THREE.Vector3): THREE.Vector3 => {
    const j = getJoint(frame, name);
    return out.set(j.x, j.y, j.z);
  };

  // --- hips: 基底から姿勢を決める -----------------------------------------
  const hips = rig.bones.hips!;
  const hipL = joint('hipL', new THREE.Vector3());
  const hipR = joint('hipR', new THREE.Vector3());
  const chest = joint('chest', new THREE.Vector3());
  const hip = joint('hip', new THREE.Vector3());

  tmpSide.copy(hipL).sub(hipR);
  tmpUp.copy(chest).sub(hip);
  if (tmpUp.lengthSq() < 1e-10) tmpUp.set(0, 1, 0);
  tmpUp.normalize();
  // side を up に直交化
  tmpSide.addScaledVector(tmpUp, -tmpSide.dot(tmpUp));
  if (tmpSide.lengthSq() < 1e-10) tmpSide.set(1, 0, 0);
  tmpSide.normalize();
  tmpForward.copy(tmpSide).cross(tmpUp).normalize();

  // 前フレームの姿勢が残らないよう、まずレストポーズへ戻す
  for (const driver of DRIVERS) {
    const bone = rig.bones[driver.bone];
    const restInfo = rig.rest[driver.bone];
    if (bone && restInfo) bone.quaternion.copy(restInfo.localQuat);
  }

  tmpM.makeBasis(tmpSide, tmpUp, tmpForward);
  const hipsWorldQuat = new THREE.Quaternion().setFromRotationMatrix(tmpM);
  if (flip) {
    // モデルの正面が -Z 向きなら、Y 軸まわりに 180° 回して正面をカメラへ向ける
    hipsWorldQuat.multiply(tmpQ1.setFromAxisAngle(Y_AXIS, Math.PI));
  }
  setWorldQuaternion(hips, hipsWorldQuat);

  // 足が地面に着くよう、腰の高さは常にレスト値を基準にする
  const parentInverse = new THREE.Matrix4();
  if (hips.parent) {
    hips.parent.updateWorldMatrix(true, false);
    parentInverse.copy(hips.parent.matrixWorld).invert();
  }
  const worldPos = tmpV1.set(
    frame.root.x * rootMotion * 0.5,
    rig.hipsHeight,
    0,
  );
  hips.position.copy(worldPos.applyMatrix4(parentInverse));
  hips.updateMatrixWorld(true);

  // --- 各ボーンを現在の向きから目標方向へ回す -----------------------------
  //
  // 親を先に処理する順で回す。各ボーンは「親の姿勢を反映した現在の向き」から
  // 目標方向への最小回転だけを足すので、胴のひねりや正面反転が末端まで伝わる。
  for (const driver of DRIVERS) {
    const bone = rig.bones[driver.bone];
    const restInfo = rig.rest[driver.bone];
    if (!bone || !restInfo?.aim) continue;

    const from = joint(driver.from, tmpV1);
    const to = joint(driver.to, tmpV2);
    const target = new THREE.Vector3().subVectors(to, from);
    if (target.lengthSq() < 1e-10) continue;
    target.normalize();

    const bonePos = tmpV1.setFromMatrixPosition(bone.matrixWorld);
    const aimPos = tmpV2.setFromMatrixPosition(restInfo.aim.matrixWorld);
    const current = new THREE.Vector3().subVectors(aimPos, bonePos);
    if (current.lengthSq() < 1e-12) continue;
    current.normalize();

    tmpQ1.setFromUnitVectors(current, target);
    tmpQ2.setFromRotationMatrix(tmpM.extractRotation(bone.matrixWorld));
    setWorldQuaternion(bone, tmpQ1.multiply(tmpQ2));
    bone.updateMatrixWorld(true);
  }
}

/** ワールド回転を、親を考慮したローカル回転として設定する。 */
function setWorldQuaternion(object: THREE.Object3D, worldQuat: THREE.Quaternion): void {
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    const parentQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(object.parent.matrixWorld),
    );
    object.quaternion.copy(parentQuat.invert().multiply(worldQuat));
  } else {
    object.quaternion.copy(worldQuat);
  }
}

/** リグが解放できるリソースを破棄する。 */
export function disposeAvatarRig(rig: AvatarRig): void {
  rig.root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
