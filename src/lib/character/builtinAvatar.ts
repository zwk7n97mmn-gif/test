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
  // 添字は MAT_* 定数と一致させる
  body.mesh.material = [
    materials.skin,
    materials.top,
    materials.bottom,
    materials.accent,
    materials.inner,
    materials.shoe,
  ];

  // 骨に直接ぶら下げる剛体パーツ（変形が不要なもの）
  bones.head.add(buildHead(appearance, rig, materials));
  // 手袋のある衣装では手も手袋の色にする（袖だけ色が違うと切れて見える）
  const handMaterial = appearance.outfit === 'idol' ? materials.accent : materials.skin;
  for (const side of ['left', 'right'] as const) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(rig.armRadius * 1.05, 14, 10), handMaterial);
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

  const emblem = buildChestEmblem(appearance, rig, materials);
  if (emblem) bones.chest.add(emblem);

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

/** 素材の割り当て。ジオメトリグループの添字に対応する（材質配列の順序と一致させること）。 */
const MAT_SKIN = 0;
const MAT_TOP = 1;
const MAT_BOTTOM = 2;
const MAT_ACCENT = 3;
const MAT_INNER = 4;
const MAT_SHOE = 5;

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
    case 'idol':
      // 下から 腰（スカート） → 差し色のベルト部 → インナー → 肩のケープ
      return (t) => (t < 0.2 ? MAT_BOTTOM : t < 0.55 ? MAT_ACCENT : t < 0.88 ? MAT_INNER : MAT_TOP);
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
    case 'idol':
      // 肩のパフスリーブ → 素肌 → 肘上まである長手袋
      return (t) => (t < 0.16 ? MAT_TOP : t < 0.44 ? MAT_SKIN : MAT_ACCENT);
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
    case 'idol':
      // 膝上まであるロングブーツ
      return (t) => (t < 0.66 ? MAT_SKIN : MAT_SHOE);
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
  /** 毛先。hairGradient が 0 なら hair と同じ色になる。 */
  hairTip: THREE.MeshStandardMaterial;
  shoe: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  /** 虹彩の外周。瞳に立体感を出す。 */
  eyeRim: THREE.MeshStandardMaterial;
  sclera: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  mouth: THREE.MeshStandardMaterial;
  /** 頬の赤み。アニメ調のときだけ使う。 */
  blush: THREE.MeshStandardMaterial;
  /** 虹彩の下側を明るくして、瞳にグラデーションを作る。 */
  eyeGlow: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  inner: THREE.MeshStandardMaterial;
  /** 瞳のハイライトや花びらなど、光って見せたい白。 */
  highlight: THREE.MeshStandardMaterial;
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
    hairTip: make(mix(a.hairColor, a.accentColor, a.hairGradient), 0.42),
    shoe: make(a.shoeColor, 0.6),
    eye: make(a.eyeColor, 0.22),
    eyeRim: make(shade(a.eyeColor, -0.3), 0.3),
    sclera: make('#f8f6f6', 0.3),
    dark: make('#14100e', 0.4),
    mouth: make(mouthColor(a.skinTone), 0.55),
    blush: make(mix(a.skinTone, '#e2607f', 0.45), 0.9),
    eyeGlow: make(mix(a.eyeColor, '#ffffff', 0.42), 0.22),
    accent: make(a.accentColor, 0.7),
    inner: make(a.innerColor, 0.85),
    highlight: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ffffff'),
      roughness: 0.15,
      metalness: 0,
      // 影の中に入っても消えないよう、わずかに自己発光させる
      emissive: new THREE.Color('#ffffff'),
      emissiveIntensity: 0.5,
    }),
  };
}

/**
 * 顔の造形パラメータ。すべて頭半径 R に対する比率で持つ。
 *
 * アニメ調は「目が大きく、鼻と口が小さく、顔の下半分が短い」という
 * 定型があり、そこだけを差し替えれば同じ組み立て手順を使い回せる。
 */
interface FaceMetrics {
  jawScale: readonly [number, number, number];
  jawDy: number;
  eyeDx: number;
  eyeDy: number;
  /** 顔の曲面に沿わせるための、目の外向き回転（ラジアン） */
  eyeYaw: number;
  eyeInset: number;
  scleraR: number;
  scleraScaleY: number;
  scleraDepth: number;
  irisR: number;
  pupilR: number;
  /** まつげ円弧の内半径（白目半径に対する比） */
  lashW: number;
  /** まつげ円弧の太さ（白目半径に対する比） */
  lashH: number;
  browW: number;
  browH: number;
  browDy: number;
  noseR: number;
  noseDy: number;
  mouthW: number;
  mouthH: number;
  mouthDy: number;
  /** 頬の赤みの大きさ（R 比）。0 で描かない。 */
  blushR: number;
  /** 口を開いた形（歌っている口）にするか */
  mouthOpen: boolean;
  /** 目尻のまつげの長さ（白目半径比）。0 で描かない。 */
  outerLash: number;
}

const FACE_METRICS: Record<CharacterAppearance['faceStyle'], FaceMetrics> = {
  natural: {
    jawScale: [0.92, 0.86, 0.98],
    jawDy: -0.42,
    eyeDx: 0.36,
    eyeDy: 0.04,
    eyeYaw: 0.18,
    eyeInset: 0.93,
    scleraR: 0.155,
    scleraScaleY: 0.62,
    scleraDepth: 0.5,
    irisR: 0.072,
    pupilR: 0.032,
    lashW: 0.82,
    lashH: 0.16,
    browW: 0.34,
    browH: 0.06,
    browDy: 0.2,
    noseR: 0.11,
    noseDy: -0.14,
    mouthW: 0.28,
    mouthH: 0.075,
    mouthDy: -0.36,
    blushR: 0,
    mouthOpen: false,
    outerLash: 0,
  },
  anime: {
    jawScale: [0.7, 0.82, 0.86],
    jawDy: -0.42,
    eyeDx: 0.39,
    eyeDy: -0.16,
    // 平たい目を丸い頭に乗せるので、外側へ倒して曲面に沿わせる
    eyeYaw: 0.42,
    eyeInset: 0.99,
    scleraR: 0.225,
    scleraScaleY: 0.9,
    scleraDepth: 0.22,
    irisR: 0.178,
    pupilR: 0.052,
    lashW: 0.84,
    lashH: 0.2,
    browW: 0.24,
    browH: 0.032,
    browDy: 0.13,
    noseR: 0.05,
    noseDy: -0.3,
    mouthW: 0.22,
    mouthH: 0.15,
    mouthDy: -0.42,
    blushR: 0.19,
    mouthOpen: true,
    outerLash: 0.42,
  },
};

/** 頭（頭蓋・顔・髪）。head ボーンにぶら下げる剛体グループ。 */
function buildHead(a: CharacterAppearance, rig: CharacterRig, m: Materials): THREE.Group {
  const R = rig.headRadius;
  const f = FACE_METRICS[a.faceStyle];
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
  jaw.scale.set(...f.jawScale);
  jaw.position.set(0, skullY + R * f.jawDy, R * 0.06);
  group.add(jaw);

  for (const sign of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 10, 8), m.skin);
    ear.scale.set(0.4, 1, 0.75);
    ear.position.set(sign * rx * 0.97, skullY - R * 0.02, -R * 0.02);
    group.add(ear);
  }

  const eyeDx = R * f.eyeDx;
  const eyeDy = R * f.eyeDy;
  for (const sign of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sign * eyeDx, skullY + eyeDy, surfaceZ(eyeDx, eyeDy) * f.eyeInset);
    eye.rotation.y = sign * f.eyeYaw;

    const scleraRadius = R * f.scleraR;
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(scleraRadius, 18, 14), m.sclera);
    sclera.scale.set(1, f.scleraScaleY, f.scleraDepth);
    eye.add(sclera);

    // 虹彩・瞳孔は平面ディスク（球にすると白目の内側に埋まる）。
    // 縦に伸ばした楕円にすると、白目が目頭・目尻だけに残ってアニメ的な瞳になる。
    const front = scleraRadius * f.scleraDepth;
    const step = R * 0.004;
    const irisR = R * f.irisR;
    const irisScaleY = Math.min(1.18, (scleraRadius * f.scleraScaleY * 0.98) / irisR);

    const rim = new THREE.Mesh(new THREE.CircleGeometry(irisR, 24), m.eyeRim);
    rim.position.z = front + step;
    rim.scale.y = irisScaleY;
    eye.add(rim);
    const iris = new THREE.Mesh(new THREE.CircleGeometry(irisR * 0.86, 24), m.eye);
    iris.position.z = front + step * 2;
    iris.scale.y = irisScaleY;
    eye.add(iris);

    // 虹彩の下半分を明るくする（アニメの瞳は下側が光っていることが多い）
    const glow = new THREE.Mesh(new THREE.CircleGeometry(irisR * 0.62, 20), m.eyeGlow);
    glow.position.set(0, -irisR * 0.3 * irisScaleY, front + step * 2.5);
    glow.scale.y = irisScaleY * 0.9;
    eye.add(glow);

    const pupil = new THREE.Mesh(new THREE.CircleGeometry(R * f.pupilR, 18), m.dark);
    pupil.position.z = front + step * 3;
    pupil.scale.y = irisScaleY * 1.05;
    eye.add(pupil);

    for (const highlight of buildEyeHighlights(a.eyeSparkle, irisR, m.highlight)) {
      highlight.position.z += front + step * 4;
      eye.add(highlight);
    }

    // まぶた（上まつげ）。まっすぐな棒ではなく、目の上端に沿う円弧にする。
    const lash = new THREE.Mesh(
      new THREE.RingGeometry(
        scleraRadius * f.lashW,
        scleraRadius * (f.lashW + f.lashH),
        24,
        1,
        Math.PI * 0.08,
        Math.PI * 0.84,
      ),
      m.dark,
    );
    lash.position.z = front + step * 5;
    lash.scale.y = f.scleraScaleY;
    eye.add(lash);

    // 目尻のまつげ。跳ね上げると一気にアニメらしい目元になる。
    if (f.outerLash > 0) {
      const length = scleraRadius * f.outerLash;
      const outer = new THREE.Mesh(new THREE.ConeGeometry(scleraRadius * 0.14, length, 6), m.dark);
      outer.position.set(
        sign * scleraRadius * 0.94,
        scleraRadius * f.scleraScaleY * 0.62,
        front + step * 5,
      );
      // 外側かつ上向きに倒す（sign は左右で符号が変わる）
      outer.rotation.z = sign * -0.85;
      outer.scale.z = 0.4;
      eye.add(outer);
    }

    group.add(eye);
  }

  // 頬の赤み
  if (f.blushR > 0) {
    const blushDx = R * (f.eyeDx + 0.24);
    const blushDy = R * (f.eyeDy - 0.28);
    for (const sign of [-1, 1]) {
      const blush = new THREE.Mesh(new THREE.CircleGeometry(R * f.blushR, 20), m.blush);
      blush.position.set(sign * blushDx, skullY + blushDy, surfaceZ(blushDx, blushDy) + R * 0.01);
      blush.scale.y = 0.62;
      blush.rotation.y = sign * 0.5;
      group.add(blush);
    }
  }

  const browDy = R * f.browDy;
  for (const sign of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(R * f.browW, R * f.browH, R * 0.08), m.hair);
    brow.position.set(sign * eyeDx, skullY + browDy, surfaceZ(eyeDx, browDy) * 0.99);
    brow.rotation.z = sign * -0.14;
    group.add(brow);
  }

  const noseDy = R * f.noseDy;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(R * f.noseR, 12, 10), m.skin);
  nose.scale.set(0.75, 1.3, 1.1);
  nose.position.set(0, skullY + noseDy, surfaceZ(0, noseDy) * 0.98);
  group.add(nose);

  // 口は頭蓋の表面に「貼る」。箱を表面上に置くと半分が埋まって見えなくなるので、
  // 平面ディスクを surfaceZ より前に出す。
  const mouthDy = R * f.mouthDy;
  const mouthR = R * f.mouthW * 0.5;
  const mouthZ = surfaceZ(0, mouthDy) + R * 0.012;
  if (f.mouthOpen) {
    // 歌っている口。円の下半分だけを使うと、口角の上がった開いた口になる。
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(mouthR, 24, Math.PI, Math.PI), m.mouth);
    mouth.scale.y = (f.mouthH / f.mouthW) * 2;
    mouth.position.set(0, skullY + mouthDy, mouthZ);
    group.add(mouth);

    // 上の歯。開いた口の上辺に薄く入れると立体感が出る。
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(mouthR * 1.72, mouthR * 0.2, R * 0.01), m.sclera);
    teeth.position.set(0, skullY + mouthDy - mouthR * 0.1, mouthZ + R * 0.004);
    group.add(teeth);
  } else {
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(mouthR, 20), m.mouth);
    mouth.scale.y = f.mouthH / f.mouthW;
    mouth.position.set(0, skullY + mouthDy, mouthZ);
    group.add(mouth);
  }

  group.add(buildHair(a, R, m, skullY, surfaceZ));
  const accessory = buildHairAccessory(a, R, m);
  if (accessory) {
    accessory.position.set(R * 0.72, skullY + R * 0.72, R * 0.02);
    accessory.rotation.set(0.18, 0.5, -0.2);
    group.add(accessory);
  }
  return group;
}

/** 星形（尖った点が points 個）の平面シェイプ。 */
function starShape(points: number, outer: number, inner: number): THREE.Shape {
  const shape = new THREE.Shape();
  const steps = points * 2;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/** ハート形の平面シェイプ（原点中心、幅がおよそ 2×size）。 */
function heartShape(size: number): THREE.Shape {
  const s = size;
  // 下の尖り → 左のふくらみ → 中央のくぼみ → 右のふくらみ → 下の尖り
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.0 * s);
  shape.bezierCurveTo(-1.3 * s, -0.2 * s, -0.9 * s, 1.0 * s, 0, 0.45 * s);
  shape.bezierCurveTo(0.9 * s, 1.0 * s, 1.3 * s, -0.2 * s, 0, -1.0 * s);
  return shape;
}

/** 瞳のハイライト。原点は虹彩の中心、Z は呼び出し側で押し出す。 */
function buildEyeHighlights(
  style: CharacterAppearance['eyeSparkle'],
  irisRadius: number,
  material: THREE.Material,
): THREE.Mesh[] {
  if (style === 'none') return [];
  if (style === 'star') {
    const star = new THREE.Mesh(
      new THREE.ShapeGeometry(starShape(4, irisRadius * 0.66, irisRadius * 0.16), 4),
      material,
    );
    star.position.set(-irisRadius * 0.22, irisRadius * 0.3, 0);
    star.rotation.z = 0.2;
    const small = new THREE.Mesh(new THREE.CircleGeometry(irisRadius * 0.17, 12), material);
    small.position.set(irisRadius * 0.42, -irisRadius * 0.46, 0);
    return [star, small];
  }
  const big = new THREE.Mesh(new THREE.CircleGeometry(irisRadius * 0.4, 16), material);
  big.position.set(-irisRadius * 0.32, irisRadius * 0.34, 0);
  const small = new THREE.Mesh(new THREE.CircleGeometry(irisRadius * 0.17, 12), material);
  small.position.set(irisRadius * 0.36, -irisRadius * 0.36, 0);
  return [big, small];
}

/** 髪飾り。head ボーンに付くので、頭を振れば一緒に動く。 */
function buildHairAccessory(a: CharacterAppearance, R: number, m: Materials): THREE.Group | null {
  if (a.hairAccessory === 'none') return null;
  const group = new THREE.Group();
  group.name = 'HairAccessory';

  switch (a.hairAccessory) {
    case 'star': {
      const star = new THREE.Mesh(
        new THREE.ExtrudeGeometry(starShape(5, R * 0.28, R * 0.13), {
          depth: R * 0.06,
          bevelEnabled: false,
          curveSegments: 2,
        }),
        m.inner,
      );
      group.add(star);
      break;
    }
    case 'ribbon': {
      for (const sign of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 12, 10), m.accent);
        wing.scale.set(1.15, 0.7, 0.42);
        wing.position.set(sign * R * 0.2, 0, 0);
        wing.rotation.z = sign * 0.42;
        group.add(wing);
      }
      const knot = new THREE.Mesh(new THREE.SphereGeometry(R * 0.09, 10, 8), m.accent);
      knot.scale.z = 0.6;
      group.add(knot);
      break;
    }
    case 'flower': {
      for (let i = 0; i < 6; i++) {
        const petal = new THREE.Mesh(new THREE.SphereGeometry(R * 0.11, 10, 8), m.highlight);
        petal.scale.set(1, 0.5, 0.35);
        const angle = (i / 6) * Math.PI * 2;
        petal.position.set(Math.cos(angle) * R * 0.13, Math.sin(angle) * R * 0.13, 0);
        petal.rotation.z = angle;
        group.add(petal);
      }
      const core = new THREE.Mesh(new THREE.SphereGeometry(R * 0.075, 10, 8), m.inner);
      core.scale.z = 0.6;
      group.add(core);
      break;
    }
  }
  return group;
}

function buildHair(
  a: CharacterAppearance,
  R: number,
  m: Materials,
  skullY: number,
  /** 頭蓋表面の Z（顔の原点は skullY）。前髪を面に沿わせるのに使う。 */
  surfaceZ: (dx: number, dy: number) => number,
): THREE.Group {
  const hair = new THREE.Group();
  const material = m.hair;
  const tip = m.hairTip;

  /**
   * 毛束（房）。位置は房の中心。
   * 上半分を根元の色、下半分を毛先の色にして、髪のグラデーションを表現する。
   * `material` を渡した場合は単色（顔まわりの毛束など、色を変えたくないもの）。
   */
  const strand = (options: {
    radius: number;
    length: number;
    position: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    material?: THREE.Material;
  }): THREE.Object3D => {
    const group = new THREE.Group();
    group.position.set(...options.position);
    if (options.rotation) group.rotation.set(...options.rotation);
    if (options.scale) group.scale.set(...options.scale);

    // 継ぎ目が出ないよう、上下の区間を少し重ねる
    const half = options.length * 0.56;
    const parts: Array<[THREE.Material, number]> = options.material
      ? [[options.material, 0]]
      : [
          [material, options.length * 0.22],
          [tip, -options.length * 0.22],
        ];
    for (const [partMaterial, offsetY] of parts) {
      const span = options.material ? options.length : half;
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(options.radius, Math.max(span - options.radius * 2, 0.001), 4, 14),
        partMaterial,
      );
      mesh.position.y = offsetY;
      group.add(mesh);
    }
    return group;
  };

  // 顔まわりの毛束。輪郭を締めるためのものなので、細く・根元の色で・耳の横に置く。
  const addSideLocks = (length: number, radius: number) => {
    for (const sign of [-1, 1]) {
      hair.add(
        strand({
          radius,
          length,
          position: [sign * R * 0.86, skullY - length * 0.4, R * 0.02],
          rotation: [0, 0, sign * 0.05],
          scale: [1, 1, 0.66],
          material,
        }),
      );
    }
  };

  // 前髪。アニメ調の顔は額が広く見えやすいので、尖った毛束を垂らして輪郭を作る。
  // 額の曲面に沿わせないと頭の中に埋まってしまうので、根元・毛先とも表面の少し外に置く。
  if (a.faceStyle === 'anime') {
    const point = (dx: number, dy: number, outward: number) =>
      new THREE.Vector3(dx, dy, surfaceZ(dx, dy) * outward);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = -2; i <= 2; i++) {
      const dx = i * R * 0.26;
      // 眉（skullY + browDy）に掛からない高さで止める
      // 外側の一束だけ長く垂らすと、のっぺりした「ヘルメット」に見えなくなる
      const tipY = Math.abs(i) === 2 ? R * 0.02 : R * (0.14 + Math.abs(i) * 0.06);
      const tip = point(dx * (Math.abs(i) === 2 ? 1.3 : 1.06), tipY, 1.12);
      // 根元は頭蓋の内側に埋めておく。表に出すと切り口が冠部の凹凸として見える。
      const root = point(dx * 0.7, R * 0.8, 0.85);
      const axis = tip.clone().sub(root);
      const length = axis.length();
      if (length < 1e-4) continue;

      const bang = new THREE.Mesh(new THREE.ConeGeometry(R * 0.15, length, 8), material);
      // ConeGeometry は +Y 方向が尖端なので、根元→毛先の向きに合わせる
      bang.quaternion.setFromUnitVectors(up, axis.clone().normalize());
      bang.position.copy(root).addScaledVector(axis, 0.5);
      bang.position.y += skullY;
      bang.scale.z = 0.5;
      hair.add(bang);
    }
  }

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
      const back = strand({
        radius: R * 0.62,
        length: length * 0.98,
        position: [0, skullY - length * 0.4, -R * 0.75],
        scale: [1.5, 1, 0.6],
      });
      hair.add(back);
      addSideLocks(R * 2.1, R * 0.15);
      break;
    }
    case 'hime': {
      // 背中の直毛 + 顎の高さで切りそろえた左右の毛束
      hair.add(
        strand({
          radius: R * 0.66,
          length: R * 4.2,
          position: [0, skullY - R * 1.9, -R * 0.7],
          scale: [1.45, 1, 0.55],
        }),
      );
      // 顎の高さで切りそろえた毛束は根元の色のまま（毛先だけ色が変わると不自然）
      addSideLocks(R * 1.5, R * 0.18);
      break;
    }
    case 'ponytail': {
      const tie = new THREE.Mesh(new THREE.SphereGeometry(R * 0.22, 12, 10), material);
      tie.position.set(0, skullY + R * 0.5, -R * 0.95);
      hair.add(tie);
      // 首を貫かないよう、頭蓋より確実に後方（-Z）へ置く
      const tail = strand({
        radius: R * 0.26,
        length: R * 1.82,
        position: [0, skullY - R * 0.3, -R * 1.35],
        rotation: [-0.18, 0, 0],
      });
      hair.add(tail);
      addSideLocks(R * 1.7, R * 0.13);
      break;
    }
    case 'twintail': {
      for (const sign of [-1, 1]) {
        const tie = new THREE.Mesh(new THREE.SphereGeometry(R * 0.18, 12, 10), m.accent);
        tie.position.set(sign * R * 0.8, skullY + R * 0.4, -R * 0.5);
        hair.add(tie);
        // 結び目から外へ広がり、後方へ流れる長い房。
        // 腕とぶつからないよう、頭より確実に後ろ（-Z）へ逃がす。
        hair.add(
          strand({
            radius: R * 0.27,
            length: R * 3.6,
            position: [sign * R * 1.12, skullY - R * 1.3, -R * 1.0],
            rotation: [-0.12, 0, sign * 0.22],
            scale: [1, 1, 0.9],
          }),
        );
      }
      addSideLocks(R * 1.9, R * 0.13);
      break;
    }
    case 'sidetail': {
      const sign = 1;
      const tie = new THREE.Mesh(new THREE.SphereGeometry(R * 0.19, 12, 10), m.accent);
      tie.position.set(sign * R * 0.84, skullY + R * 0.42, -R * 0.44);
      hair.add(tie);
      hair.add(
        strand({
          radius: R * 0.32,
          length: R * 3.3,
          position: [sign * R * 1.18, skullY - R * 1.15, -R * 0.92],
          rotation: [-0.1, 0, sign * 0.2],
          scale: [1, 1, 0.9],
        }),
      );
      addSideLocks(R * 1.9, R * 0.13);
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

/** 胸の飾り（アイドル衣装のみ）。chest ボーンに付ける。 */
function buildChestEmblem(a: CharacterAppearance, rig: CharacterRig, m: Materials): THREE.Mesh | null {
  if (a.outfit !== 'idol') return null;
  const size = rig.torsoRadius * 0.3;
  const emblem = new THREE.Mesh(
    new THREE.ExtrudeGeometry(heartShape(size), { depth: size * 0.16, bevelEnabled: false, curveSegments: 6 }),
    m.accent,
  );
  // 胸の高さ（インナーの範囲）で、胴の前面より少しだけ手前に出す
  emblem.position.set(0, -rig.spineToChest * 0.4, rig.torsoRadius * rig.torsoDepth * 1.02);
  return emblem;
}

/**
 * プリーツスカートのジオメトリ。
 * 半径を角度方向の三角波で揺らし、裾へ向かうほど襞（ひだ）が深くなるようにする。
 */
function pleatedSkirtGeometry(
  topRadius: number,
  bottomRadius: number,
  length: number,
  pleats: number,
  depth: number,
): THREE.BufferGeometry {
  const radial = pleats * 4;
  const rows = 6;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const baseRadius = topRadius + (bottomRadius - topRadius) * v;
    for (let i = 0; i <= radial; i++) {
      const u = i / radial;
      const angle = u * Math.PI * 2;
      // 三角波（-1..1）。sin より襞の折り目がはっきり出る。
      const phase = (u * pleats) % 1;
      const wave = 1 - 4 * Math.abs(phase - 0.5);
      const r = baseRadius * (1 + depth * v * wave);
      positions.push(Math.cos(angle) * r, -v * length, Math.sin(angle) * r);
      uvs.push(u, 1 - v);
    }
  }

  const stride = radial + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < radial; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** スカート（ワンピース / ジャケット / アイドル衣装）。hips ボーンにぶら下げる。 */
function buildSkirt(a: CharacterAppearance, rig: CharacterRig, m: Materials): THREE.Object3D | null {
  if (a.outfit === 'idol') {
    const group = new THREE.Group();
    group.name = 'Skirt';

    // 共有マテリアルに side を設定すると瞳などにも波及するので、ここだけ複製する
    const waistMaterial = m.dark.clone();
    waistMaterial.side = THREE.DoubleSide;
    const waist = new THREE.Mesh(
      new THREE.CylinderGeometry(rig.torsoRadius * 1.04, rig.torsoRadius * 1.06, rig.torsoRadius * 0.3, 26, 1, true),
      waistMaterial,
    );
    waist.position.y = rig.torsoRadius * 0.12;
    waist.scale.z = rig.torsoDepth * 1.08;
    group.add(waist);

    // 白いプリーツスカート
    const length = rig.thigh * 0.58;
    const skirt = new THREE.Mesh(
      pleatedSkirtGeometry(rig.torsoRadius * 1.02, rig.torsoRadius * 1.55, length, 16, 0.13),
      m.bottom,
    );
    skirt.material.side = THREE.DoubleSide;
    skirt.position.y = 0;
    skirt.scale.z = rig.torsoDepth * 1.1;
    group.add(skirt);

    // 差し色のオーバースカート（短く、外側に重ねる）
    const overLength = length * 0.5;
    const over = new THREE.Mesh(
      pleatedSkirtGeometry(rig.torsoRadius * 1.1, rig.torsoRadius * 1.42, overLength, 12, 0.1),
      m.top,
    );
    over.material.side = THREE.DoubleSide;
    over.position.y = rig.torsoRadius * 0.04;
    over.scale.z = rig.torsoDepth * 1.12;
    group.add(over);

    return group;
  }

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
  return [
    a.headScale,
    a.legLength,
    a.shoulderWidth,
    a.limbThickness,
    a.build,
    a.hairStyle,
    a.outfit,
    a.faceStyle,
    a.eyeSparkle,
    a.hairAccessory,
  ].join('|');
}

/** 既存の内蔵キャラクターの色だけを更新する。 */
export function updateBuiltinColors(rig: AvatarRig, a: CharacterAppearance): void {
  const m = rig.model.userData.materials as Materials | undefined;
  if (!m) return;
  m.skin.color.set(a.skinTone);
  m.skin.roughness = 1 - a.skinGloss * 0.55;
  m.skinDark.color.set(shade(a.skinTone, -0.28));
  m.mouth.color.set(mouthColor(a.skinTone));
  m.hair.color.set(a.hairColor);
  m.hairTip.color.set(mix(a.hairColor, a.accentColor, a.hairGradient));
  m.top.color.set(a.topColor);
  m.bottom.color.set(a.bottomColor);
  m.shoe.color.set(a.shoeColor);
  m.eye.color.set(a.eyeColor);
  m.eyeRim.color.set(shade(a.eyeColor, -0.3));
  m.eyeGlow.color.set(mix(a.eyeColor, '#ffffff', 0.42));
  m.blush.color.set(mix(a.skinTone, '#e2607f', 0.45));
  m.accent.color.set(a.accentColor);
  m.inner.color.set(a.innerColor);
}

function shade(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  color.lerp(new THREE.Color(amount >= 0 ? '#ffffff' : '#000000'), Math.abs(amount));
  return `#${color.getHexString()}`;
}

/** 唇の色。肌の色を残しつつ、はっきり見える赤みのある暗色にする。 */
function mouthColor(skinTone: string): string {
  return mix(shade(skinTone, -0.5), '#7a2531', 0.6);
}

function mix(hex: string, towards: string, amount: number): string {
  const color = new THREE.Color(hex);
  color.lerp(new THREE.Color(towards), Math.min(1, Math.max(0, amount)));
  return `#${color.getHexString()}`;
}
