import { describe, expect, it } from 'vitest';
import { mapLandmarksToRig, mirrorClip, MP, postProcessFrames, type RawLandmark } from '../src/lib/pose/normalize';
import {
  JOINT_COUNT,
  deserializeClip,
  getJoint,
  sampleClip,
  serializeClip,
  type MotionClip,
  type MotionFrame,
} from '../src/lib/pose/types';
import { buildRig, createDefaultAppearance } from '../src/lib/character/appearance';
import { buildBuiltinAvatar } from '../src/lib/character/builtinAvatar';
import { applyPoseToAvatar } from '../src/lib/character/avatarRetarget';
import { OneEuroFilter } from '../src/lib/pose/oneEuro';

/**
 * 直立姿勢の 33 点ワールドランドマークを作る。
 * MediaPipe の規約に合わせ Y は下向き・Z はカメラ奥方向で格納する
 * （テスト内では「上向き / 手前」で書き、変換時に反転する）。
 */
function makeWorld(scale = 1, lift = 0): RawLandmark[] {
  const points = new Array<RawLandmark>(33).fill({ x: 0, y: 0, z: 0, visibility: 0.2 });
  const set = (index: number, x: number, yUp: number, zFront = 0, visibility = 0.95) => {
    points[index] = { x: x * scale, y: -(yUp + lift) * scale, z: -zFront * scale, visibility };
  };
  set(MP.nose, 0, 0.74, 0.12);
  set(MP.earL, 0.05, 0.75, 0);
  set(MP.earR, -0.05, 0.75, 0);
  set(MP.shoulderL, 0.19, 0.5, 0);
  set(MP.shoulderR, -0.19, 0.5, 0);
  set(MP.elbowL, 0.33, 0.18, 0.02);
  set(MP.elbowR, -0.33, 0.18, 0.02);
  set(MP.wristL, 0.4, -0.12, 0.05);
  set(MP.wristR, -0.4, -0.12, 0.05);
  set(MP.hipL, 0.09, 0, 0);
  set(MP.hipR, -0.09, 0, 0);
  set(MP.kneeL, 0.1, -0.45, 0.02);
  set(MP.kneeR, -0.1, -0.45, 0.02);
  set(MP.ankleL, 0.11, -0.88, -0.01);
  set(MP.ankleR, -0.11, -0.88, -0.01);
  set(MP.footL, 0.11, -0.94, 0.09);
  set(MP.footR, -0.11, -0.94, 0.09);
  return points;
}

/** 画面座標のランドマーク（0..1）。立ち位置の算出にのみ使われる。 */
function makeScreen(offsetX = 0): RawLandmark[] {
  const points = new Array<RawLandmark>(33).fill({ x: 0.5, y: 0.5 });
  const set = (index: number, x: number, y: number) => {
    points[index] = { x: 0.5 + x + offsetX, y: 0.5 + y };
  };
  set(MP.shoulderL, 0.07, -0.15);
  set(MP.shoulderR, -0.07, -0.15);
  set(MP.hipL, 0.04, 0.05);
  set(MP.hipR, -0.04, 0.05);
  return points;
}

describe('ランドマークの 3D 正規化', () => {
  it('腰を原点、胴長を1に正規化する', () => {
    const frame = mapLandmarksToRig(makeWorld(), null, 1080, 1920, 0)!;
    expect(frame).not.toBeNull();

    const hip = getJoint(frame, 'hip');
    expect(hip.x).toBeCloseTo(0, 6);
    expect(hip.y).toBeCloseTo(0, 6);
    expect(hip.z).toBeCloseTo(0, 6);

    const chest = getJoint(frame, 'chest');
    expect(Math.hypot(chest.x, chest.y, chest.z)).toBeCloseTo(1, 6);
  });

  it('Y 上向きに変換される（頭が腰より上）', () => {
    const frame = mapLandmarksToRig(makeWorld(), null, 1080, 1920, 0)!;
    expect(getJoint(frame, 'head').y).toBeGreaterThan(0);
    expect(getJoint(frame, 'ankleL').y).toBeLessThan(0);
  });

  it('人物の大きさが変わっても同じ姿勢なら同じ正規化結果になる（＝体格に依存しない）', () => {
    const small = mapLandmarksToRig(makeWorld(1), null, 1080, 1920, 0)!;
    const large = mapLandmarksToRig(makeWorld(2.4), null, 1080, 1920, 0)!;
    for (let i = 0; i < JOINT_COUNT * 3; i++) {
      expect(large.positions[i]).toBeCloseTo(small.positions[i], 5);
    }
  });

  it('カメラからの距離（world 側の平行移動）にも影響されない', () => {
    const near = mapLandmarksToRig(makeWorld(1, 0), null, 1080, 1920, 0)!;
    const far = mapLandmarksToRig(makeWorld(1, 3), null, 1080, 1920, 0)!;
    for (let i = 0; i < JOINT_COUNT * 3; i++) {
      expect(far.positions[i]).toBeCloseTo(near.positions[i], 5);
    }
  });

  it('画面内の立ち位置は root に分離され、関節の相対配置は変わらない', () => {
    const centered = mapLandmarksToRig(makeWorld(), makeScreen(0), 1080, 1920, 0)!;
    const shifted = mapLandmarksToRig(makeWorld(), makeScreen(0.2), 1080, 1920, 0)!;
    expect(shifted.root.x).toBeGreaterThan(centered.root.x);
    for (let i = 0; i < JOINT_COUNT * 3; i++) {
      expect(shifted.positions[i]).toBeCloseTo(centered.positions[i], 5);
    }
  });

  it('正面を向いていれば facing が 1 に近い', () => {
    const frame = mapLandmarksToRig(makeWorld(), null, 1080, 1920, 0)!;
    expect(frame.facing).toBeGreaterThan(0.9);
  });

  it('横を向くと facing が下がる', () => {
    const world = makeWorld();
    // 肩を奥行き方向に並べる＝真横
    world[MP.shoulderL] = { x: 0, y: -0.5, z: -0.19, visibility: 0.95 };
    world[MP.shoulderR] = { x: 0, y: -0.5, z: 0.19, visibility: 0.95 };
    const frame = mapLandmarksToRig(world, null, 1080, 1920, 0)!;
    expect(frame.facing).toBeLessThan(0.2);
  });

  it('ランドマークが足りなければ null を返す', () => {
    expect(mapLandmarksToRig([{ x: 0, y: 0 }], null, 1080, 1920, 0)).toBeNull();
  });

  it('胴が潰れている（検出破綻）場合は null を返す', () => {
    const world = makeWorld();
    for (const index of [MP.shoulderL, MP.shoulderR, MP.hipL, MP.hipR]) {
      world[index] = { x: 0, y: 0, z: 0, visibility: 0.9 };
    }
    expect(mapLandmarksToRig(world, null, 1080, 1920, 0)).toBeNull();
  });
});

describe('後処理', () => {
  const frame = (t = 0) => mapLandmarksToRig(makeWorld(), null, 1080, 1920, t)!;

  it('検出ゼロなら空配列と警告を返す（値をでっち上げない）', () => {
    const result = postProcessFrames([null, null, null], 30);
    expect(result.frames).toEqual([]);
    expect(result.detectionRate).toBe(0);
    expect(result.warnings[0]).toContain('検出できませんでした');
  });

  it('短い欠落は前後から補間して埋める', () => {
    const frames = [frame(0), null, null, frame(3 / 30)];
    const result = postProcessFrames(frames, 30);
    expect(result.frames.length).toBe(4);
    expect(result.detectionRate).toBeCloseTo(0.5, 5);
  });

  it('長い欠落は埋めずに除外し、警告を出す', () => {
    const frames: Array<MotionFrame | null> = [frame(0), ...new Array(40).fill(null), frame(41 / 30)];
    const result = postProcessFrames(frames, 30);
    expect(result.frames.length).toBe(2);
    expect(result.warnings.join()).toContain('未検出区間');
  });

  it('上下が反転した姿勢を自動補正する', () => {
    const flipped = Array.from({ length: 10 }, (_, i) => {
      const f = frame(i / 30);
      for (let j = 0; j < JOINT_COUNT; j++) f.positions[j * 3 + 1] *= -1;
      return f;
    });
    const result = postProcessFrames(flipped, 30);
    expect(result.warnings.join()).toContain('上下が反転');
    expect(getJoint(result.frames[0], 'head').y).toBeGreaterThan(0);
  });
});

describe('1€ フィルタ', () => {
  it('ノイズを減らしつつ信号の平均値を保つ', () => {
    const filter = new OneEuroFilter(1.0, 0.007);
    let lastOutput = 0;
    const outputs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const noisy = 1 + (i % 2 === 0 ? 0.4 : -0.4);
      lastOutput = filter.filter(noisy, i / 60);
      outputs.push(lastOutput);
    }
    const tail = outputs.slice(-50);
    const variance = tail.reduce((sum, v) => sum + (v - 1) ** 2, 0) / tail.length;
    expect(variance).toBeLessThan(0.02);
    expect(lastOutput).toBeGreaterThan(0.7);
    expect(lastOutput).toBeLessThan(1.3);
  });

  it('NaN を入力しても壊れない', () => {
    const filter = new OneEuroFilter();
    filter.filter(5, 0);
    expect(filter.filter(NaN, 1)).toBe(5);
  });
});

function makeClip(): MotionClip {
  const frames = [0, 1, 2].map((i) => mapLandmarksToRig(makeWorld(), makeScreen(), 1080, 1920, i / 30)!);
  return {
    id: 'clip-1',
    name: 'test',
    fps: 30,
    duration: 2 / 30,
    frames,
    source: { kind: 'video', fileName: 'a.mp4', backend: 'test', width: 1080, height: 1920 },
    quality: { detectionRate: 1, meanConfidence: 0.9, warnings: [] },
  };
}

describe('クリップの直列化とサンプリング', () => {
  it('JSON 往復で姿勢が保たれる', () => {
    const clip = makeClip();
    const restored = deserializeClip(JSON.parse(JSON.stringify(serializeClip(clip))));
    expect(restored.frames.length).toBe(clip.frames.length);
    for (let i = 0; i < JOINT_COUNT * 3; i++) {
      expect(restored.frames[0].positions[i]).toBeCloseTo(clip.frames[0].positions[i], 3);
    }
  });

  it('2D 形式（v1）は明確なメッセージで拒否する', () => {
    expect(() => deserializeClip({ formatVersion: 1, frames: [] })).toThrow(/2D 形式/);
  });

  it('不正な JSON は分かりやすい例外になる', () => {
    expect(() => deserializeClip(null)).toThrow(/形式が不正/);
    expect(() => deserializeClip({ formatVersion: 99 })).toThrow(/未対応のフォーマット/);
    expect(() => deserializeClip({ formatVersion: 2, frames: [] })).toThrow(/フレームが含まれていません/);
  });

  it('範囲外の時刻はクランプされる', () => {
    const clip = makeClip();
    expect(sampleClip(clip, -5)!.t).toBe(clip.frames[0].t);
    expect(sampleClip(clip, 999)!.t).toBe(clip.frames[clip.frames.length - 1].t);
  });

  it('左右反転すると X 座標の符号が反転する', () => {
    const clip = makeClip();
    const mirrored = mirrorClip(clip);
    const original = getJoint(clip.frames[0], 'wristL');
    const flipped = getJoint(mirrored.frames[0], 'wristR');
    expect(flipped.x).toBeCloseTo(-original.x, 6);
    expect(flipped.y).toBeCloseTo(original.y, 6);
  });
});

describe('内蔵キャラクター（容姿とモーションの分離）', () => {
  const frame = () => mapLandmarksToRig(makeWorld(), null, 1080, 1920, 0)!;

  const worldPos = (object: { matrixWorld: { elements: number[] } }) => ({
    x: object.matrixWorld.elements[12],
    y: object.matrixWorld.elements[13],
    z: object.matrixWorld.elements[14],
  });
  const direction = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    return { x: d.x / len, y: d.y / len, z: d.z / len };
  };

  it('胴長が 1 に正規化され、内蔵キャラクターがヒューマノイドとして成立する', () => {
    const rig = buildBuiltinAvatar(createDefaultAppearance());
    expect(rig.unitScale).toBeCloseTo(1, 6);
    expect(rig.bones.hips).toBeTruthy();
    expect(rig.bones.leftLowerLeg).toBeTruthy();
    expect(rig.facesBackward).toBe(false);
    expect(rig.warnings).toEqual([]);
  });

  it('容姿を変えても関節の向き（＝動き）は変わらない', () => {
    const source = frame();
    const slim = buildBuiltinAvatar(
      createDefaultAppearance({ headScale: 0.85, legLength: 0.9, build: 'slim', limbThickness: 0.8 }),
    );
    const heavy = buildBuiltinAvatar(
      createDefaultAppearance({ headScale: 1.25, legLength: 1.18, build: 'curvy', limbThickness: 1.3 }),
    );
    for (const rig of [slim, heavy]) {
      applyPoseToAvatar(rig, source, { flipFacing: false });
      rig.root.updateMatrixWorld(true);
    }

    for (const [from, to] of [
      ['leftUpperArm', 'leftLowerArm'],
      ['leftLowerArm', 'leftHand'],
      ['rightUpperLeg', 'rightLowerLeg'],
      ['rightLowerLeg', 'rightFoot'],
      ['spine', 'chest'],
    ] as const) {
      const a = direction(worldPos(slim.bones[from]!), worldPos(slim.bones[to]!));
      const b = direction(worldPos(heavy.bones[from]!), worldPos(heavy.bones[to]!));
      expect(a.x).toBeCloseTo(b.x, 5);
      expect(a.y).toBeCloseTo(b.y, 5);
      expect(a.z).toBeCloseTo(b.z, 5);
    }
  });

  it('容姿によって骨の長さは変わる（体型が反映される）', () => {
    const short = buildBuiltinAvatar(createDefaultAppearance({ legLength: 0.85 }));
    const tall = buildBuiltinAvatar(createDefaultAppearance({ legLength: 1.2 }));
    const thighLength = (rig: ReturnType<typeof buildBuiltinAvatar>) => {
      rig.root.updateMatrixWorld(true);
      const a = worldPos(rig.bones.leftUpperLeg!);
      const b = worldPos(rig.bones.leftLowerLeg!);
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    };
    expect(thighLength(tall)).toBeGreaterThan(thighLength(short));
  });

  it('スキンメッシュにボーン重みが設定されている', () => {
    const rig = buildBuiltinAvatar(createDefaultAppearance());
    let skinned = 0;
    rig.root.traverse((node) => {
      const mesh = node as { isSkinnedMesh?: boolean; geometry?: { attributes: Record<string, { count: number; array: ArrayLike<number> }> } };
      if (!mesh.isSkinnedMesh || !mesh.geometry) return;
      skinned++;
      const weight = mesh.geometry.attributes.skinWeight;
      expect(weight).toBeTruthy();
      expect(weight.count).toBeGreaterThan(100);
      // 重みの合計が 1 になっていること（LBS が壊れない条件）
      for (let i = 0; i < Math.min(weight.count, 200); i++) {
        const sum =
          weight.array[i * 4] + weight.array[i * 4 + 1] + weight.array[i * 4 + 2] + weight.array[i * 4 + 3];
        expect(sum).toBeCloseTo(1, 4);
      }
    });
    expect(skinned).toBe(1);
  });

  it('全ての服装・髪型で例外なく生成できる', () => {
    for (const outfit of ['tshirt', 'hoodie', 'tanktop', 'dress', 'jacket'] as const) {
      for (const hairStyle of ['short', 'bob', 'long', 'ponytail', 'bun'] as const) {
        expect(() => buildBuiltinAvatar(createDefaultAppearance({ outfit, hairStyle }))).not.toThrow();
      }
    }
  });
});

describe('リグの導出', () => {
  it('既定値でおよそ 7 頭身になる', () => {
    const appearance = createDefaultAppearance();
    const rig = buildRig(appearance);
    const heads = rig.totalHeight / (rig.headRadius * 2.2);
    expect(heads).toBeGreaterThan(6);
    expect(heads).toBeLessThan(8);
  });

  it('頭を大きくすると頭身が下がる', () => {
    const small = buildRig(createDefaultAppearance({ headScale: 0.8 }));
    const large = buildRig(createDefaultAppearance({ headScale: 1.3 }));
    expect(large.headRadius).toBeGreaterThan(small.headRadius);
    expect(large.totalHeight / large.headRadius).toBeLessThan(small.totalHeight / small.headRadius);
  });

  it('脚を長くすると全身が高くなる', () => {
    const short = buildRig(createDefaultAppearance({ legLength: 0.85 }));
    const tall = buildRig(createDefaultAppearance({ legLength: 1.2 }));
    expect(tall.totalHeight).toBeGreaterThan(short.totalHeight);
  });
});
