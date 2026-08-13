import * as THREE from 'three';
import { buildRig, type CharacterAppearance, type CharacterRig } from './appearance';
import { buildAvatarRig, type AvatarRig, type HumanBoneName } from './avatarRetarget';

/**
 * 内蔵キャラクターを「外部アバターと同じ形式（AvatarRig）」で組み立てる。
 *
 * ボーン付きのスキンメッシュとして生成するため、肘や膝が曲がっても継ぎ目が出ない。
 * 駆動は外部アバターとまったく同じ `applyPoseToAvatar` を通るので、
 * リターゲットの経路が 1 本に統一される。
 *
 * これにより「無料・スマホだけ」で完結する: 外部モデルを入手しなくても、
 * アプリ内の設定だけで体型・髪型・服装・肌色を変えたキャラクターを動かせる。
 */
export function buildBuiltinAvatar(appearance: CharacterAppearance): AvatarRig {
  const rig = buildRig(appearance);
  const model = new THREE.Group();
  model.name = 'BuiltinCharacter';

  const { bones, boneList, index } = createSkeletonBones(rig);
  model.add(bones.hips);

  const materials = createMaterials(appearance);
  // 色だけの変更でジオメトリを作り直さずに済むよう、マテリアルを外から触れるようにしておく
  model.userData.materials = materials;
  const body = buildBodyMesh(appearance, rig, boneList, index);
  model.add(body.mesh);
  body.mesh.material = [materials.skin, materials.top, materials.bottom];

  // 骨に直接ぶら下げる剛体パーツ（変形が不要なもの）
  bones.head.add(buildHead(appearance, rig, materials));
  for (const side of ['left', 'right'] as const) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(rig.armRadius * 1.05, 14, 10), materials.skin);
    hand.scale.set(1, 1.15, 0.75);
    hand.position.y = 0;
    bones[`${side}Hand` as 'leftHand'].add(hand);

    const shoe = new THREE.Mesh(new THREE.CapsuleGeometry(rig.legRadius * 0.72, rig.foot * 0.6, 4, 12), materials.shoe);
    shoe.rotation.x = Math.PI / 2;
    shoe.position.set(0, -rig.legRadius * 0.3, rig.foot * 0.35);
    shoe.scale.set(0.95, 1, 0.85);
    bones[`${side}Foot` as 'leftFoot'].add(shoe);
  }

  const skirt = buildSkirt(appearance, rig, materials);
  if (skirt) bones.hips.add(skirt);

  model.updateMatrixWorld(true);
  body.mesh.bind(new THREE.Skeleton(boneList), new THREE.Matrix4());

  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    }
  });

  return buildAvatarRig(model, bones);
}

// ---------------------------------------------------------------------------
// 骨格
// ---------------------------------------------------------------------------

type BoneMap = Record<HumanBoneName, THREE.Bone>;

/**
 * レストポーズ（T ポーズ・正面 +Z・足裏が y=0）の骨格を作る。
 * 単位は胴長 = 1。hipToSpine + spineToChest がちょうど 1 になるので、
 * `buildAvatarRig` 側のスケール調整は 1 倍になり、スキニングに影響しない。
 */
function createSkeletonBones(rig: CharacterRig): {
  bones: BoneMap;
  boneList: THREE.Bone[];
  index: Record<HumanBoneName, number>;
} {
  const boneList: THREE.Bone[] = [];
  const index = {} as Record<HumanBoneName, number>;

  const make = (name: HumanBoneName, x: number, y: number, z: number, parent?: THREE.Bone): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    if (parent) parent.add(bone);
    index[name] = boneList.length;
    boneList.push(bone);
    return bone;
  };

  const ankleHeight = rig.foot * 0.42;
  const hipsY = ankleHeight + rig.thigh + rig.shin;

  const hips = make('hips', 0, hipsY, 0);
  const spine = make('spine', 0, rig.hipToSpine, 0, hips);
  const chest = make('chest', 0, rig.spineToChest, 0, spine);
  const neck = make('neck', 0, rig.chestToNeck, 0, chest);
  const head = make('head', 0, rig.neckToHead, 0, neck);

  const bones = { hips, spine, chest, neck, head } as BoneMap;

  for (const side of ['left', 'right'] as const) {
    const dir = side === 'left' ? 1 : -1;
    const upperArm = make(`${side}UpperArm` as HumanBoneName, dir * rig.shoulderOffset, -0.05, 0, chest);
    const lowerArm = make(`${side}LowerArm` as HumanBoneName, dir * rig.upperArm, 0, 0, upperArm);
    const hand = make(`${side}Hand` as HumanBoneName, dir * rig.foreArm, 0, 0, lowerArm);
    bones[`${side}UpperArm` as HumanBoneName] = upperArm;
    bones[`${side}LowerArm` as HumanBoneName] = lowerArm;
    bones[`${side}Hand` as HumanBoneName] = hand;

    const upperLeg = make(`${side}UpperLeg` as HumanBoneName, dir * rig.hipOffset, -0.04, 0, hips);
    const lowerLeg = make(`${side}LowerLeg` as HumanBoneName, 0, -rig.thigh, 0, upperLeg);
    const foot = make(`${side}Foot` as HumanBoneName, 0, -rig.shin, 0, lowerLeg);
    bones[`${side}UpperLeg` as HumanBoneName] = upperLeg;
    bones[`${side}LowerLeg` as HumanBoneName] = lowerLeg;
    bones[`${side}Foot` as HumanBoneName] = foot;
  }

  hips.updateMatrixWorld(true);
  return { bones, boneList, index };
}

// ---------------------------------------------------------------------------
// スキンメッシュ生成
// ---------------------------------------------------------------------------

/** 素材の割り当て。ジオメトリグループの添字に対応する。 */
const MAT_SKIN = 0;
const MAT_TOP = 1;
const MAT_BOTTOM = 2;

interface TubeBuilder {
  positions: number[];
  uvs: number[];
  skinIndices: number[];
  skinWeights: number[];
  indices: number[];
  groups: Array<{ start: number; count: number; material: number }>;
}

/**
 * 折れ線に沿ってリングを並べ、チューブ状のスキンメッシュを作る。
 * 関節付近のリングは前後 2 本のボーンへ 50:50 で配分するので、曲げても滑らかにつながる。
 */
function emitTube(
  builder: TubeBuilder,
  points: THREE.Vector3[],
  boneIndices: number[],
  options: {
    steps: number;
    radius: (t: number) => number;
    material: (t: number) => number;
    depthScale?: number;
    blend?: number;
    capStart?: boolean;
    capEnd?: boolean;
  },
): void {
  const radial = 14;
  const depthScale = options.depthScale ?? 1;
  const segmentLengths = points.slice(0, -1).map((p, i) => p.distanceTo(points[i + 1]));
  const total = segmentLengths.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return;

  const rings: Array<{ center: THREE.Vector3; tangent: THREE.Vector3; t: number; weights: Array<[number, number]> }> = [];

  let travelled = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const segLength = segmentLengths[i];
    const tangent = to.clone().sub(from).normalize();
    const blendDist = Math.min(
      options.blend ?? 0.22,
      segLength * 0.45,
      (segmentLengths[i - 1] ?? segLength) * 0.45,
      (segmentLengths[i + 1] ?? segLength) * 0.45,
    );

    const startStep = i === 0 ? 0 : 1;
    for (let s = startStep; s <= options.steps; s++) {
      const local = s / options.steps;
      const center = from.clone().lerp(to, local);
      const t = (travelled + local * segLength) / total;

      const d0 = local * segLength;
      const d1 = (1 - local) * segLength;
      const weights: Array<[number, number]> = [[boneIndices[i], 1]];
      if (i > 0 && d0 < blendDist) {
        const w = 0.5 * (1 - d0 / blendDist);
        weights.length = 0;
        weights.push([boneIndices[i - 1], w], [boneIndices[i], 1 - w]);
      } else if (i < points.length - 2 && d1 < blendDist) {
        const w = 0.5 * (1 - d1 / blendDist);
        weights.length = 0;
        weights.push([boneIndices[i], 1 - w], [boneIndices[i + 1], w]);
      }
      rings.push({ center, tangent, t, weights });
    }
    travelled += segLength;
  }

  const baseVertex = builder.positions.length / 3;
  const reference = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();

  for (const ring of rings) {
    // 接線と平行にならない基準ベクトルを選んで直交フレームを作る
    reference.set(0, 1, 0);
    if (Math.abs(ring.tangent.y) > 0.9) reference.set(0, 0, 1);
    side.copy(reference).cross(ring.tangent).normalize();
    up.copy(ring.tangent).cross(side).normalize();

    const r = options.radius(ring.t);
    for (let k = 0; k <= radial; k++) {
      const angle = (k / radial) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      builder.positions.push(
        ring.center.x + side.x * cos * r + up.x * sin * r * depthScale,
        ring.center.y + side.y * cos * r + up.y * sin * r * depthScale,
        ring.center.z + side.z * cos * r + up.z * sin * r * depthScale,
      );
      builder.uvs.push(k / radial, ring.t);

      const w = ring.weights;
      builder.skinIndices.push(w[0][0], w[1]?.[0] ?? 0, 0, 0);
      builder.skinWeights.push(w[0][1], w[1]?.[1] ?? 0, 0, 0);
    }
  }

  // 面を張る。素材が切り替わるところでグループを分ける。
  const ringVerts = radial + 1;
  let groupStart = builder.indices.length;
  let groupMaterial = options.material(rings[0].t);

  for (let i = 0; i < rings.length - 1; i++) {
    const material = options.material(rings[i + 1].t);
    if (material !== groupMaterial) {
      builder.groups.push({
        start: groupStart,
        count: builder.indices.length - groupStart,
        material: groupMaterial,
      });
      groupStart = builder.indices.length;
      groupMaterial = material;
    }
    for (let k = 0; k < radial; k++) {
      const a = baseVertex + i * ringVerts + k;
      const b = a + 1;
      const c = a + ringVerts;
      const d = c + 1;
      builder.indices.push(a, c, b, b, c, d);
    }
  }
  builder.groups.push({
    start: groupStart,
    count: builder.indices.length - groupStart,
    material: groupMaterial,
  });

  // 端を閉じる（開いたままだと内側が見えてしまう）
  const capRing = (ringIndex: number, material: number, flip: boolean) => {
    const ring = rings[ringIndex];
    const centerIndex = builder.positions.length / 3;
    builder.positions.push(ring.center.x, ring.center.y, ring.center.z);
    builder.uvs.push(0.5, ring.t);
    const w = ring.weights;
    builder.skinIndices.push(w[0][0], w[1]?.[0] ?? 0, 0, 0);
    builder.skinWeights.push(w[0][1], w[1]?.[1] ?? 0, 0, 0);

    const start = builder.indices.length;
    for (let k = 0; k < radial; k++) {
      const a = baseVertex + ringIndex * ringVerts + k;
      const b = a + 1;
      if (flip) builder.indices.push(centerIndex, b, a);
      else builder.indices.push(centerIndex, a, b);
    }
    builder.groups.push({ start, count: builder.indices.length - start, material });
  };

  if (options.capStart) capRing(0, options.material(0), true);
  if (options.capEnd) capRing(rings.length - 1, options.material(1), false);
}

/** 胴・首・腕・脚をまとめた 1 枚のスキンメッシュを作る。 */
function buildBodyMesh(
  appearance: CharacterAppearance,
  rig: CharacterRig,
  boneList: THREE.Bone[],
  index: Record<HumanBoneName, number>,
): { mesh: THREE.SkinnedMesh } {
  const builder: TubeBuilder = {
    positions: [],
    uvs: [],
    skinIndices: [],
    skinWeights: [],
    indices: [],
    groups: [],
  };

  const worldOf = (name: HumanBoneName) =>
    new THREE.Vector3().setFromMatrixPosition(boneList[index[name]].matrixWorld);

  // --- 胴 -------------------------------------------------------------------
  const hips = worldOf('hips');
  const spine = worldOf('spine');
  const chest = worldOf('chest');
  const neck = worldOf('neck');
  const torsoTop = chest.clone().lerp(neck, 0.55);

  const torsoMaterial = torsoMaterialFn(appearance);
  emitTube(builder, [hips.clone().setY(hips.y - rig.hipToSpine * 0.45), spine, chest, torsoTop], [index.hips, index.spine, index.chest, index.chest], {
    steps: 5,
    depthScale: rig.torsoDepth,
    radius: (t) => {
      // 腰 → くびれ → 胸 → 肩口 の曲線
      const profile = [
        [0, 0.96],
        [0.22, 1.0],
        [0.46, 0.8],
        [0.72, 1.0],
        [0.9, 0.95],
        [1, 0.6],
      ] as const;
      return rig.torsoRadius * sampleProfile(profile, t);
    },
    material: torsoMaterial,
    capStart: true,
    capEnd: true,
  });

  // --- 首 -------------------------------------------------------------------
  // 頭蓋の下端（head ボーンの少し下）で止める。ここを頭の位置まで伸ばすと首が長くなりすぎる。
  const head = worldOf('head');
  const neckTop = head.clone().setY(head.y - rig.headRadius * 0.45);
  emitTube(builder, [chest, neckTop], [index.chest, index.neck], {
    steps: 3,
    radius: (t) => rig.headRadius * (0.52 - 0.12 * t),
    material: () => MAT_SKIN,
  });

  // --- 腕・脚 ---------------------------------------------------------------
  const sleeve = sleeveMaterialFn(appearance);
  const legwear = legMaterialFn(appearance);

  for (const side of ['left', 'right'] as const) {
    const upperArm = `${side}UpperArm` as HumanBoneName;
    const lowerArm = `${side}LowerArm` as HumanBoneName;
    const hand = `${side}Hand` as HumanBoneName;
    emitTube(
      builder,
      [worldOf(upperArm), worldOf(lowerArm), worldOf(hand)],
      [index[upperArm], index[lowerArm], index[hand]],
      {
        steps: 5,
        blend: rig.upperArm * 0.3,
        radius: (t) =>
          rig.armRadius * sampleProfile([
            [0, 1.3],
            [0.2, 1.0],
            [0.5, 0.92],
            [0.78, 0.8],
            [1, 0.66],
          ], t),
        material: sleeve,
        capStart: true,
        capEnd: true,
      },
    );

    const upperLeg = `${side}UpperLeg` as HumanBoneName;
    const lowerLeg = `${side}LowerLeg` as HumanBoneName;
    const foot = `${side}Foot` as HumanBoneName;
    emitTube(
      builder,
      [worldOf(upperLeg), worldOf(lowerLeg), worldOf(foot)],
      [index[upperLeg], index[lowerLeg], index[foot]],
      {
        steps: 6,
        blend: rig.thigh * 0.26,
        radius: (t) =>
          rig.legRadius * sampleProfile([
            [0, 1.25],
            [0.22, 1.05],
            [0.5, 0.82],
            [0.72, 0.78],
            [1, 0.5],
          ], t),
        material: legwear,
        capStart: true,
        capEnd: true,
      },
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(builder.uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(builder.skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(builder.skinWeights, 4));
  geometry.setIndex(builder.indices);
  for (const group of builder.groups) {
    if (group.count > 0) geometry.addGroup(group.start, group.count, group.material);
  }
  geometry.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(geometry);
  mesh.name = 'Body';
  return { mesh };
}

/** 制御点 [(t, 値)] を線形補間して読む。 */
function sampleProfile(profile: ReadonlyArray<readonly [number, number]>, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < profile.length - 1; i++) {
    const [t0, v0] = profile[i];
    const [t1, v1] = profile[i + 1];
    if (clamped <= t1) {
      const u = t1 - t0 < 1e-6 ? 0 : (clamped - t0) / (t1 - t0);
      return v0 + (v1 - v0) * u;
    }
  }
  return profile[profile.length - 1][1];
}

function torsoMaterialFn(a: CharacterAppearance): (t: number) => number {
  switch (a.outfit) {
    case 'dress':
      return () => MAT_TOP;
    case 'tanktop':
      return (t) => (t < 0.3 ? MAT_BOTTOM : t < 0.52 ? MAT_SKIN : MAT_TOP);
    default:
      return (t) => (t < 0.34 ? MAT_BOTTOM : MAT_TOP);
  }
}

function sleeveMaterialFn(a: CharacterAppearance): (t: number) => number {
  switch (a.outfit) {
    case 'hoodie':
    case 'jacket':
      return (t) => (t < 0.82 ? MAT_TOP : MAT_SKIN);
    case 'tshirt':
      return (t) => (t < 0.3 ? MAT_TOP : MAT_SKIN);
    default:
      return () => MAT_SKIN;
  }
}

function legMaterialFn(a: CharacterAppearance): (t: number) => number {
  switch (a.outfit) {
    case 'dress':
    case 'jacket':
      return () => MAT_SKIN;
    case 'tanktop':
      return (t) => (t < 0.3 ? MAT_BOTTOM : MAT_SKIN);
    default:
      return (t) => (t < 0.88 ? MAT_BOTTOM : MAT_SKIN);
  }
}

// ---------------------------------------------------------------------------
// マテリアル・頭部・スカート
// ---------------------------------------------------------------------------

interface Materials {
  skin: THREE.MeshStandardMaterial;
  skinDark: THREE.MeshStandardMaterial;
  top: THREE.MeshStandardMaterial;
  bottom: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  shoe: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  sclera: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
}

function createMaterials(a: CharacterAppearance): Materials {
  const make = (color: string, roughness: number) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness: 0 });
  return {
    skin: make(a.skinTone, 1 - a.skinGloss * 0.55),
    skinDark: make(shade(a.skinTone, -0.28), 0.85),
    top: make(a.topColor, 0.88),
    bottom: make(a.bottomColor, 0.88),
    hair: make(a.hairColor, 0.42),
    shoe: make(a.shoeColor, 0.6),
    eye: make(a.eyeColor, 0.3),
    sclera: make('#f6f4f2', 0.3),
    dark: make('#14100e', 0.4),
  };
}

/** 頭（頭蓋・顔・髪）。head ボーンにぶら下げる剛体グループ。 */
function buildHead(a: CharacterAppearance, rig: CharacterRig, m: Materials): THREE.Group {
  const R = rig.headRadius;
  const group = new THREE.Group();
  group.name = 'Head';

  // head ボーンは両耳の中点＝頭のほぼ中心に来るため、頭蓋はその近くに置く
  const skullY = R * 0.15;
  const rx = R * 0.9;
  const ry = R * 1.06;
  const rz = R * 0.95;

  const skull = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 20), m.skin);
  skull.scale.set(0.9, 1.06, 0.95);
  skull.position.y = skullY;
  group.add(skull);

  /** 頭蓋（楕円体）表面の Z 座標。顔のパーツはこの上に置く。 */
  const surfaceZ = (dx: number, dy: number): number => {
    const k = 1 - (dx / rx) ** 2 - (dy / ry) ** 2;
    return k > 0 ? rz * Math.sqrt(k) : 0;
  };

  const jaw = new THREE.Mesh(new THREE.SphereGeometry(R * 0.72, 20, 14), m.skin);
  jaw.scale.set(0.92, 0.86, 0.98);
  jaw.position.set(0, skullY - R * 0.42, R * 0.06);
  group.add(jaw);

  for (const sign of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 10, 8), m.skin);
    ear.scale.set(0.4, 1, 0.75);
    ear.position.set(sign * rx * 0.97, skullY - R * 0.02, -R * 0.02);
    group.add(ear);
  }

  const eyeDx = R * 0.36;
  const eyeDy = R * 0.04;
  for (const sign of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sign * eyeDx, skullY + eyeDy, surfaceZ(eyeDx, eyeDy) * 0.93);

    const scleraRadius = R * 0.155;
    const scleraDepth = 0.5;
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(scleraRadius, 16, 12), m.sclera);
    sclera.scale.set(1, 0.62, scleraDepth);
    eye.add(sclera);

    // 虹彩・瞳孔は平面ディスク（球にすると白目の内側に埋まる）
    const front = scleraRadius * scleraDepth;
    const iris = new THREE.Mesh(new THREE.CircleGeometry(R * 0.072, 20), m.eye);
    iris.position.z = front + R * 0.004;
    eye.add(iris);
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(R * 0.032, 16), m.dark);
    pupil.position.z = front + R * 0.008;
    eye.add(pupil);

    const lash = new THREE.Mesh(new THREE.BoxGeometry(R * 0.42, R * 0.03, R * 0.04), m.dark);
    lash.position.set(0, R * 0.1, R * 0.02);
    eye.add(lash);

    group.add(eye);
  }

  const browDy = R * 0.2;
  for (const sign of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(R * 0.34, R * 0.06, R * 0.08), m.hair);
    brow.position.set(sign * eyeDx, skullY + browDy, surfaceZ(eyeDx, browDy) * 0.99);
    brow.rotation.z = sign * -0.14;
    group.add(brow);
  }

  const noseDy = -R * 0.14;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(R * 0.11, 12, 10), m.skin);
  nose.scale.set(0.75, 1.3, 1.1);
  nose.position.set(0, skullY + noseDy, surfaceZ(0, noseDy) * 0.98);
  group.add(nose);

  const mouthDy = -R * 0.3;
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(R * 0.28, R * 0.06, R * 0.05), m.skinDark);
  mouth.position.set(0, skullY + mouthDy, surfaceZ(0, mouthDy) * 0.99);
  group.add(mouth);

  group.add(buildHair(a, R, m.hair, skullY));
  return group;
}

function buildHair(a: CharacterAppearance, R: number, material: THREE.Material, skullY: number): THREE.Group {
  const hair = new THREE.Group();

  // 頭頂だけを覆う（広げすぎると顔が隠れる）
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.06, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.44),
    material,
  );
  cap.position.y = skullY;
  cap.scale.set(0.94, 1.1, 0.98);
  hair.add(cap);

  // 後頭部（three.js の球は phi=π/2 が +Z なので π〜2π が背面）
  // thetaLength を広げすぎると髪が顎の下まで回り込み、首の前に飛び出して見える
  const back = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.04, 24, 16, Math.PI, Math.PI, 0, Math.PI * 0.62),
    material,
  );
  back.position.y = skullY;
  back.scale.set(0.94, 1.08, 0.98);
  hair.add(back);

  switch (a.hairStyle) {
    case 'short':
      break;
    case 'bob': {
      const bob = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.06, R * 1.12, R * 0.9, 24, 1, true), material);
      bob.position.set(0, skullY - R * 0.27, -R * 0.06);
      bob.scale.set(1, 1, 0.95);
      hair.add(bob);
      break;
    }
    case 'long': {
      const length = R * 3.4;
      const strand = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.62, length * 0.7, 4, 16), material);
      strand.scale.set(1.5, 1, 0.6);
      strand.position.set(0, skullY - length * 0.4, -R * 0.75);
      hair.add(strand);
      break;
    }
    case 'ponytail': {
      const tie = new THREE.Mesh(new THREE.SphereGeometry(R * 0.22, 12, 10), material);
      tie.position.set(0, skullY + R * 0.5, -R * 0.95);
      hair.add(tie);
      // 首を貫かないよう、頭蓋より確実に後方（-Z）へ置く
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.26, R * 1.3, 4, 14), material);
      tail.position.set(0, skullY - R * 0.3, -R * 1.35);
      tail.rotation.x = -0.18;
      hair.add(tail);
      break;
    }
    case 'bun': {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(R * 0.42, 16, 12), material);
      bun.position.set(0, skullY + R * 0.72, -R * 0.9);
      hair.add(bun);
      break;
    }
  }
  return hair;
}

/** スカート（ワンピース / ジャケット時）。hips ボーンにぶら下げる。 */
function buildSkirt(a: CharacterAppearance, rig: CharacterRig, m: Materials): THREE.Mesh | null {
  if (a.outfit !== 'dress' && a.outfit !== 'jacket') return null;
  const length = rig.thigh * (a.outfit === 'dress' ? 0.62 : 0.5);
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(rig.torsoRadius * 1.02, rig.torsoRadius * 1.75, length, 26, 1, true),
    a.outfit === 'dress' ? m.top : m.bottom,
  );
  skirt.material.side = THREE.DoubleSide;
  skirt.position.y = -length * 0.42;
  skirt.scale.z = rig.torsoDepth * 1.1;
  return skirt;
}

/**
 * 形状に関わるパラメータ。ここが変わったときだけメッシュを作り直せばよい。
 * 色だけの変更（スライダー操作中など）は `updateBuiltinColors` で足りる。
 */
export function builtinStructureKey(a: CharacterAppearance): string {
  return [a.headScale, a.legLength, a.shoulderWidth, a.limbThickness, a.build, a.hairStyle, a.outfit].join('|');
}

/** 既存の内蔵キャラクターの色だけを更新する。 */
export function updateBuiltinColors(rig: AvatarRig, a: CharacterAppearance): void {
  const m = rig.model.userData.materials as Materials | undefined;
  if (!m) return;
  m.skin.color.set(a.skinTone);
  m.skin.roughness = 1 - a.skinGloss * 0.55;
  m.skinDark.color.set(shade(a.skinTone, -0.28));
  m.hair.color.set(a.hairColor);
  m.top.color.set(a.topColor);
  m.bottom.color.set(a.bottomColor);
  m.shoe.color.set(a.shoeColor);
  m.eye.color.set(a.eyeColor);
}

function shade(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  color.lerp(new THREE.Color(amount >= 0 ? '#ffffff' : '#000000'), Math.abs(amount));
  return `#${color.getHexString()}`;
}
