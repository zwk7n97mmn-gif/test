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
import { retarget } from '../src/lib/character/retarget';
import { OneEuroFilter } from '../src/lib/pose/oneEuro';

/** 直立したT字ポーズの33点ランドマークを作る。scale/offset で人物の大きさ・位置を変えられる。 */
function makeLandmarks(scale = 1, offsetX = 0, offsetY = 0): RawLandmark[] {
  const points = new Array<RawLandmark>(33).fill({ x: 0.5, y: 0.5, visibility: 0.2 });
  const set = (index: number, x: number, y: number, visibility = 0.95) => {
    points[index] = { x: 0.5 + x * scale + offsetX, y: 0.5 + y * scale + offsetY, visibility };
  };
  set(MP.nose, 0, -0.26);
  set(MP.earL, 0.03, -0.25);
  set(MP.earR, -0.03, -0.25);
  set(MP.shoulderL, 0.07, -0.15);
  set(MP.shoulderR, -0.07, -0.15);
  set(MP.elbowL, 0.14, -0.04);
  set(MP.elbowR, -0.14, -0.04);
  set(MP.wristL, 0.2, 0.06);
  set(MP.wristR, -0.2, 0.06);
  set(MP.hipL, 0.04, 0.05);
  set(MP.hipR, -0.04, 0.05);
  set(MP.kneeL, 0.045, 0.2);
  set(MP.kneeR, -0.045, 0.2);
  set(MP.ankleL, 0.05, 0.34);
  set(MP.ankleR, -0.05, 0.34);
  set(MP.footL, 0.06, 0.37);
  set(MP.footR, -0.06, 0.37);
  return points;
}

describe('ランドマークの正規化', () => {
  it('腰を原点、胴長を1に正規化する', () => {
    const frame = mapLandmarksToRig(makeLandmarks(), 1080, 1920, 0)!;
    expect(frame).not.toBeNull();
    const hip = getJoint(frame, 'hip');
    expect(hip.x).toBeCloseTo(0, 6);
    expect(hip.y).toBeCloseTo(0, 6);

    const chest = getJoint(frame, 'chest');
    expect(Math.hypot(chest.x, chest.y)).toBeCloseTo(1, 6);
  });

  it('人物の大きさが変わっても同じ姿勢なら同じ正規化結果になる（＝体格に依存しない）', () => {
    const small = mapLandmarksToRig(makeLandmarks(1), 1080, 1920, 0)!;
    const large = mapLandmarksToRig(makeLandmarks(2.4), 1080, 1920, 0)!;
    for (let i = 0; i < JOINT_COUNT * 2; i++) {
      expect(large.positions[i]).toBeCloseTo(small.positions[i], 5);
    }
  });

  it('画面内の位置は root に分離される', () => {
    const centered = mapLandmarksToRig(makeLandmarks(1, 0, 0), 1080, 1920, 0)!;
    const shifted = mapLandmarksToRig(makeLandmarks(1, 0.2, 0), 1080, 1920, 0)!;
    expect(shifted.root.x).toBeGreaterThan(centered.root.x);
    // 関節の相対配置は変わらない
    for (let i = 0; i < JOINT_COUNT * 2; i++) {
      expect(shifted.positions[i]).toBeCloseTo(centered.positions[i], 5);
    }
  });

  it('ランドマークが足りなければ null を返す', () => {
    expect(mapLandmarksToRig([{ x: 0, y: 0 }], 1080, 1920, 0)).toBeNull();
  });

  it('胴が潰れている（検出破綻）場合は null を返す', () => {
    const collapsed = makeLandmarks();
    collapsed[MP.shoulderL] = { x: 0.5, y: 0.55, visibility: 0.9 };
    collapsed[MP.shoulderR] = { x: 0.5, y: 0.55, visibility: 0.9 };
    collapsed[MP.hipL] = { x: 0.5, y: 0.55, visibility: 0.9 };
    collapsed[MP.hipR] = { x: 0.5, y: 0.55, visibility: 0.9 };
    expect(mapLandmarksToRig(collapsed, 1080, 1920, 0)).toBeNull();
  });
});

describe('後処理', () => {
  const frame = () => mapLandmarksToRig(makeLandmarks(), 1080, 1920, 0)!;

  it('検出ゼロなら空配列と警告を返す（値をでっち上げない）', () => {
    const result = postProcessFrames([null, null, null], 30);
    expect(result.frames).toEqual([]);
    expect(result.detectionRate).toBe(0);
    expect(result.warnings[0]).toContain('検出できませんでした');
  });

  it('短い欠落は前後から補間して埋める', () => {
    const frames = [frame(), null, null, frame()];
    frames.forEach((f, i) => {
      if (f) f.t = i / 30;
    });
    const result = postProcessFrames(frames, 30);
    expect(result.frames.length).toBe(4);
    expect(result.detectionRate).toBeCloseTo(0.5, 5);
  });

  it('長い欠落は埋めずに除外し、警告を出す', () => {
    const frames: Array<MotionFrame | null> = [frame(), ...new Array(40).fill(null), frame()];
    frames[0]!.t = 0;
    frames[41]!.t = 41 / 30;
    const result = postProcessFrames(frames, 30);
    expect(result.frames.length).toBe(2);
    expect(result.warnings.join()).toContain('未検出区間');
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
    const variance =
      tail.reduce((sum, v) => sum + (v - 1) ** 2, 0) / tail.length;
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
  const frames = [0, 1, 2].map((i) => {
    const f = mapLandmarksToRig(makeLandmarks(), 1080, 1920, i / 30)!;
    return f;
  });
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
    for (let i = 0; i < JOINT_COUNT * 2; i++) {
      expect(restored.frames[0].positions[i]).toBeCloseTo(clip.frames[0].positions[i], 3);
    }
  });

  it('不正な JSON は分かりやすい例外になる', () => {
    expect(() => deserializeClip(null)).toThrow(/形式が不正/);
    expect(() => deserializeClip({ formatVersion: 99 })).toThrow(/未対応のフォーマット/);
    expect(() => deserializeClip({ formatVersion: 1, frames: [] })).toThrow(/フレームが含まれていません/);
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
  });
});

describe('リターゲット（容姿とモーションの分離）', () => {
  it('骨の長さはリグ側の値になる（元人物の体格に依存しない）', () => {
    const frame = mapLandmarksToRig(makeLandmarks(), 1080, 1920, 0)!;
    const rig = buildRig(createDefaultAppearance());
    const posed = retarget(frame, rig);

    const thigh = Math.hypot(
      posed.points.kneeL.x - posed.points.hipL.x,
      posed.points.kneeL.y - posed.points.hipL.y,
    );
    expect(thigh).toBeCloseTo(rig.thigh, 6);

    const upperArm = Math.hypot(
      posed.points.elbowR.x - posed.points.shoulderR.x,
      posed.points.elbowR.y - posed.points.shoulderR.y,
    );
    expect(upperArm).toBeCloseTo(rig.upperArm, 6);
  });

  it('容姿を変えても関節の角度（＝動き）は変わらない', () => {
    const frame = mapLandmarksToRig(makeLandmarks(), 1080, 1920, 0)!;
    const slim = retarget(frame, buildRig(createDefaultAppearance({ headScale: 0.8, legLength: 0.85, bodyType: 'slim' })));
    const chibi = retarget(frame, buildRig(createDefaultAppearance({ headScale: 1.5, legLength: 1.2, bodyType: 'soft' })));

    const angle = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.atan2(b.y - a.y, b.x - a.x);

    expect(angle(slim.points.hipL, slim.points.kneeL)).toBeCloseTo(
      angle(chibi.points.hipL, chibi.points.kneeL),
      6,
    );
    expect(angle(slim.points.elbowR, slim.points.wristR)).toBeCloseTo(
      angle(chibi.points.elbowR, chibi.points.wristR),
      6,
    );
  });

  it('関節が重なっていても既定方向にフォールバックして破綻しない', () => {
    const frame = mapLandmarksToRig(makeLandmarks(), 1080, 1920, 0)!;
    // 膝と足首を完全に同じ位置にする
    frame.positions[12 * 2] = frame.positions[13 * 2];
    frame.positions[12 * 2 + 1] = frame.positions[13 * 2 + 1];
    const posed = retarget(frame, buildRig(createDefaultAppearance()));
    for (const point of Object.values(posed.points)) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});
