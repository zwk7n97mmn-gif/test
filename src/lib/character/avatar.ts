import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  buildAvatarRig,
  guessBonesByName,
  HUMAN_BONES,
  type AvatarRig,
  type HumanBoneName,
} from './avatarRetarget';

export class AvatarLoadError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AvatarLoadError';
  }
}

export type AvatarKind = 'vrm' | 'gltf';

export interface LoadedAvatar {
  rig: AvatarRig;
  kind: AvatarKind;
  /** ボーン対応がどこから来たか（表示用） */
  mappingSource: 'vrm-humanoid' | 'bone-names';
  boneCount: number;
}

/** 対応する拡張子。 */
export const AVATAR_EXTENSIONS = ['.vrm', '.glb', '.gltf'] as const;

/** アバターファイルの上限（モバイルのメモリを考慮）。 */
export const MAX_AVATAR_BYTES = 80 * 1024 * 1024;

/**
 * VRM / glTF のヒューマノイドアバターを読み込む。
 *
 * VRM は glTF の拡張なので、three.js 標準の GLTFLoader で本体を読み、
 * humanoid のボーン対応だけを拡張から自前で読み取る
 * （専用ライブラリを増やさずに VRM 0.x / 1.0 の両方へ対応する）。
 */
export async function loadAvatar(blob: Blob, fileName: string): Promise<LoadedAvatar> {
  if (blob.size > MAX_AVATAR_BYTES) {
    throw new AvatarLoadError(
      `アバターのファイルが大きすぎます（${(blob.size / 1024 / 1024).toFixed(0)}MB）。`,
      `${MAX_AVATAR_BYTES / 1024 / 1024}MB 以下のモデルをご利用ください。`,
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await blob.arrayBuffer();
  } catch (err) {
    throw new AvatarLoadError('ファイルを読み込めませんでした。', undefined, err);
  }

  const loader = new GLTFLoader();
  let gltf: GLTF;
  try {
    gltf = await loader.parseAsync(buffer, '');
  } catch (err) {
    throw new AvatarLoadError(
      'このファイルを 3D モデルとして読み込めませんでした。',
      'VRM（.vrm）または glTF（.glb / .gltf）形式か確認してください。テクスチャが外部ファイルの .gltf は読み込めません（.glb に変換してください）。',
      err,
    );
  }

  const json = (gltf.parser.json ?? {}) as {
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  const isVrm =
    fileName.toLowerCase().endsWith('.vrm') ||
    Boolean(json.extensions?.VRM) ||
    Boolean(json.extensions?.VRMC_vrm);

  const model = gltf.scene;
  model.updateMatrixWorld(true);

  let bones = await readVrmHumanBones(gltf, json);
  const mappingSource: LoadedAvatar['mappingSource'] = bones ? 'vrm-humanoid' : 'bone-names';
  if (!bones) bones = guessBonesByName(model);

  let rig: AvatarRig;
  try {
    rig = buildAvatarRig(model, bones);
  } catch (err) {
    throw new AvatarLoadError(
      err instanceof Error ? err.message : 'ヒューマノイドとして解釈できませんでした。',
      'VRM 形式、または Mixamo などの標準的な人型ボーン名を持つモデルをご利用ください。',
      err,
    );
  }

  prepareForRendering(rig.root);

  return {
    rig,
    kind: isVrm ? 'vrm' : 'gltf',
    mappingSource,
    boneCount: HUMAN_BONES.filter((bone) => bones![bone]).length,
  };
}

/**
 * VRM 拡張から humanoid ボーン対応を読む。
 * VRM 0.x: extensions.VRM.humanoid.humanBones = [{ bone, node }]
 * VRM 1.0: extensions.VRMC_vrm.humanoid.humanBones = { hips: { node }, ... }
 */
async function readVrmHumanBones(
  gltf: GLTF,
  json: { extensions?: Record<string, unknown> },
): Promise<Partial<Record<HumanBoneName, THREE.Object3D>> | null> {
  const known = new Set<string>(HUMAN_BONES);
  const entries: Array<{ bone: string; node: number }> = [];

  const vrm0 = json.extensions?.VRM as
    | { humanoid?: { humanBones?: Array<{ bone?: string; node?: number }> } }
    | undefined;
  const vrm1 = json.extensions?.VRMC_vrm as
    | { humanoid?: { humanBones?: Record<string, { node?: number }> } }
    | undefined;

  if (Array.isArray(vrm0?.humanoid?.humanBones)) {
    for (const item of vrm0.humanoid.humanBones) {
      if (typeof item?.bone === 'string' && typeof item.node === 'number') {
        entries.push({ bone: item.bone, node: item.node });
      }
    }
  } else if (vrm1?.humanoid?.humanBones) {
    for (const [bone, value] of Object.entries(vrm1.humanoid.humanBones)) {
      if (typeof value?.node === 'number') entries.push({ bone, node: value.node });
    }
  }

  if (entries.length === 0) return null;

  const bones: Partial<Record<HumanBoneName, THREE.Object3D>> = {};
  for (const { bone, node } of entries) {
    if (!known.has(bone)) continue;
    try {
      const object = (await gltf.parser.getDependency('node', node)) as THREE.Object3D | undefined;
      if (object) bones[bone as HumanBoneName] = object;
    } catch {
      // 一部のボーンが解決できなくても、残りで動かせる場合がある
    }
  }
  return Object.keys(bones).length > 0 ? bones : null;
}

/**
 * 読み込んだモデルを本ツールのシーンで正しく見せるための調整。
 * スキニングされたメッシュはバウンディングボックスが実際の動きと合わないため、
 * カリングを切らないと画面から消えることがある。
 */
function prepareForRendering(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      // VRM の MToon などは標準ローダーでは PBR のフォールバックとして読まれる。
      // 片面描画のままだと髪や衣装が抜けて見えることがあるため両面にする。
      material.side = THREE.DoubleSide;
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.isMeshStandardMaterial && standard.map) {
        standard.map.anisotropy = 4;
      }
    }
  });
}
