import { JOINT_COUNT, JOINT_INDEX, type JointName, type MotionClip, type MotionFrame } from './types';
import { VectorOneEuro } from './oneEuro';

export interface RawLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

/** MediaPipe Pose の 33 点ランドマークの添字。 */
export const MP = {
  nose: 0,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
  footL: 31,
  footR: 32,
} as const;

/**
 * MediaPipe の 3D ワールドランドマーク（メートル単位・腰原点・Y下向き）を、
 * 腰原点・胴長1・Y上向きのキャラクター非依存空間へ写像する。
 *
 * 「容姿だけを変えて動きは元動画から取る」という要件は、この正規化が担保する:
 * ここで体格の絶対サイズを落とし、関節の相対配置＝動きだけを残す。
 *
 * @param world  worldLandmarks（3D, メートル）。これが動きの実体。
 * @param screen 画面座標のランドマーク（0..1）。画面内での立ち位置の算出にのみ使う。
 */
export function mapLandmarksToRig(
  world: readonly RawLandmark[],
  screen: readonly RawLandmark[] | null,
  videoWidth: number,
  videoHeight: number,
  time: number,
): MotionFrame | null {
  if (world.length < 33) return null;

  // MediaPipe は Y 下向き・Z がカメラ奥方向。ここで Y 上・Z 手前の右手系へ揃える。
  const px = (i: number) => world[i].x;
  const py = (i: number) => -world[i].y;
  const pz = (i: number) => -(world[i].z ?? 0);
  const vis = (i: number) => clamp01(world[i].visibility ?? 1);

  const mid = (a: number, b: number) => ({
    x: (px(a) + px(b)) / 2,
    y: (py(a) + py(b)) / 2,
    z: (pz(a) + pz(b)) / 2,
  });

  const hipMid = mid(MP.hipL, MP.hipR);
  const shoulderMid = mid(MP.shoulderL, MP.shoulderR);

  const torso = Math.hypot(
    shoulderMid.x - hipMid.x,
    shoulderMid.y - hipMid.y,
    shoulderMid.z - hipMid.z,
  );
  // 胴が潰れている＝検出失敗。この姿勢を通すと後段でゼロ除算になる。
  if (!Number.isFinite(torso) || torso < 1e-4) return null;

  const positions = new Float32Array(JOINT_COUNT * 3);
  const confidence = new Float32Array(JOINT_COUNT);

  const set = (name: JointName, x: number, y: number, z: number, c: number) => {
    const i = JOINT_INDEX[name];
    positions[i * 3] = (x - hipMid.x) / torso;
    positions[i * 3 + 1] = (y - hipMid.y) / torso;
    positions[i * 3 + 2] = (z - hipMid.z) / torso;
    confidence[i] = clamp01(c);
  };

  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

  // 頭中心は両耳の中点を優先し、取れなければ鼻で代用する
  const earConfidence = Math.min(vis(MP.earL), vis(MP.earR));
  const ears = mid(MP.earL, MP.earR);
  const head =
    earConfidence > 0.3
      ? { ...ears, c: earConfidence }
      : { x: px(MP.nose), y: py(MP.nose), z: pz(MP.nose), c: vis(MP.nose) };

  const torsoConfidence = Math.min(vis(MP.hipL), vis(MP.hipR), vis(MP.shoulderL), vis(MP.shoulderR));

  set('hip', hipMid.x, hipMid.y, hipMid.z, torsoConfidence);
  set(
    'spine',
    lerp(hipMid.x, shoulderMid.x, 0.45),
    lerp(hipMid.y, shoulderMid.y, 0.45),
    lerp(hipMid.z, shoulderMid.z, 0.45),
    torsoConfidence,
  );
  set('chest', shoulderMid.x, shoulderMid.y, shoulderMid.z, torsoConfidence);
  set(
    'neck',
    lerp(shoulderMid.x, head.x, 0.32),
    lerp(shoulderMid.y, head.y, 0.32),
    lerp(shoulderMid.z, head.z, 0.32),
    Math.min(torsoConfidence, head.c),
  );
  set('head', head.x, head.y, head.z, head.c);

  const direct: Array<[JointName, number]> = [
    ['shoulderL', MP.shoulderL],
    ['elbowL', MP.elbowL],
    ['wristL', MP.wristL],
    ['shoulderR', MP.shoulderR],
    ['elbowR', MP.elbowR],
    ['wristR', MP.wristR],
    ['hipL', MP.hipL],
    ['kneeL', MP.kneeL],
    ['ankleL', MP.ankleL],
    ['footL', MP.footL],
    ['hipR', MP.hipR],
    ['kneeR', MP.kneeR],
    ['ankleR', MP.ankleR],
    ['footR', MP.footR],
  ];
  for (const [name, index] of direct) {
    set(name, px(index), py(index), pz(index), vis(index));
  }

  // 肩ベクトルの XZ 平面上の長さが胴長に対してどれだけあるかで正面度を測る
  const shoulderSpan = Math.hypot(
    px(MP.shoulderL) - px(MP.shoulderR),
    py(MP.shoulderL) - py(MP.shoulderR),
    pz(MP.shoulderL) - pz(MP.shoulderR),
  );
  const shoulderFlat = Math.abs(px(MP.shoulderL) - px(MP.shoulderR));
  const facing = shoulderSpan > 1e-6 ? clamp01(shoulderFlat / shoulderSpan) : 1;

  // 画面内の立ち位置は screen ランドマークから求める（world は常に腰原点のため）
  let root = { x: 0, y: 0, z: 0 };
  if (screen && screen.length >= 33 && videoHeight > 0) {
    const aspect = videoWidth / videoHeight;
    const sx = ((screen[MP.hipL].x + screen[MP.hipR].x) / 2) * aspect;
    const sy = (screen[MP.hipL].y + screen[MP.hipR].y) / 2;
    const sTorso =
      Math.hypot(
        (screen[MP.shoulderL].x + screen[MP.shoulderR].x) / 2 * aspect - sx,
        (screen[MP.shoulderL].y + screen[MP.shoulderR].y) / 2 - sy,
      ) || 1;
    root = {
      x: (sx - aspect / 2) / sTorso,
      // 画面座標は下向きが正なので反転して「上が＋」に揃える
      y: -(sy - 0.5) / sTorso,
      z: (world[MP.hipL].z ?? 0) + (world[MP.hipR].z ?? 0),
    };
  }

  return { t: time, positions, confidence, root, facing };
}

export interface PostProcessOptions {
  /** 1€ Filter の最小カットオフ。小さいほど滑らか、大きいほど追従重視。 */
  minCutoff?: number;
  beta?: number;
}

/**
 * 抽出直後のフレーム列を仕上げる:
 *  - 検出できなかった区間を前後から線形補間で埋める（穴が長すぎる場合は埋めずに警告）
 *  - 1€ Filter でジッタ除去
 *  - 上下が反転していないか検査して補正
 *  - 品質メトリクスを算出
 *
 * frames には「検出できなかったフレーム」を null で渡す。
 */
export function postProcessFrames(
  frames: Array<MotionFrame | null>,
  fps: number,
  options: PostProcessOptions = {},
): { frames: MotionFrame[]; detectionRate: number; meanConfidence: number; warnings: string[] } {
  const warnings: string[] = [];
  const total = frames.length;
  const detected = frames.filter((f): f is MotionFrame => f !== null);

  if (detected.length === 0) {
    return {
      frames: [],
      detectionRate: 0,
      meanConfidence: 0,
      warnings: ['動画から人物の姿勢を検出できませんでした。全身が映っている素材を使ってください。'],
    };
  }

  const maxGapFrames = Math.max(2, Math.round(fps * 0.5)); // 0.5秒を超える欠落は埋めない
  const filled: Array<MotionFrame | null> = frames.slice();
  let longestGap = 0;

  for (let i = 0; i < total; i++) {
    if (filled[i] !== null) continue;
    const start = i - 1;
    let end = i;
    while (end < total && filled[end] === null) end++;
    const gap = end - i;
    longestGap = Math.max(longestGap, gap);

    if (start < 0 || end >= total || gap > maxGapFrames) {
      // 端の欠落は最近傍で埋め、長い欠落はそのまま落とす（捏造しない）
      const donor = start >= 0 ? filled[start] : end < total ? filled[end] : null;
      if (donor && gap <= maxGapFrames) {
        for (let k = i; k < end; k++) filled[k] = cloneFrame(donor, frames[k]?.t ?? k / fps);
      }
    } else {
      const a = filled[start]!;
      const b = filled[end]!;
      for (let k = i; k < end; k++) {
        const u = (k - start) / (end - start);
        filled[k] = interpolateFrame(a, b, u, k / fps);
      }
    }
    i = end - 1;
  }

  const kept = filled.filter((f): f is MotionFrame => f !== null);
  if (kept.length === 0) {
    return {
      frames: [],
      detectionRate: 0,
      meanConfidence: 0,
      warnings: ['姿勢の検出結果が不足しており、モーションを構成できませんでした。'],
    };
  }

  if (longestGap > maxGapFrames) {
    warnings.push(
      `最長 ${(longestGap / fps).toFixed(1)} 秒の未検出区間がありました。その部分のフレームは除外しています。`,
    );
  }

  // 1€ Filter による平滑化
  const posFilter = new VectorOneEuro(JOINT_COUNT * 3, options.minCutoff ?? 1.2, options.beta ?? 0.02);
  const rootFilter = new VectorOneEuro(3, options.minCutoff ?? 1.2, options.beta ?? 0.02);
  const rootBuf = new Float32Array(3);

  const smoothed: MotionFrame[] = kept.map((f) => {
    const positions = posFilter.filter(f.positions, f.t, new Float32Array(JOINT_COUNT * 3));
    rootBuf[0] = f.root.x;
    rootBuf[1] = f.root.y;
    rootBuf[2] = f.root.z;
    const root = rootFilter.filter(rootBuf, f.t, new Float32Array(3));
    return { ...f, positions, root: { x: root[0], y: root[1], z: root[2] } };
  });

  // 上下反転の検査: 頭が腰より下にあり続ける場合は Y 軸の向きを補正する
  const headIndex = JOINT_INDEX.head;
  let upright = 0;
  for (const f of smoothed) {
    if (f.positions[headIndex * 3 + 1] > 0) upright++;
  }
  if (upright < smoothed.length * 0.2) {
    for (const f of smoothed) {
      for (let i = 0; i < JOINT_COUNT; i++) f.positions[i * 3 + 1] *= -1;
      f.root.y *= -1;
    }
    warnings.push('姿勢の上下が反転していたため自動補正しました。');
  }

  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const f of smoothed) {
    for (let i = 0; i < f.confidence.length; i++) {
      confidenceSum += f.confidence[i];
      confidenceCount++;
    }
  }
  const meanConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  const detectionRate = total > 0 ? detected.length / total : 0;

  if (detectionRate < 0.6) {
    warnings.push(
      `姿勢を検出できたのは全体の ${(detectionRate * 100).toFixed(0)}% です。人物が小さい・見切れている可能性があります。`,
    );
  }
  if (meanConfidence < 0.5) {
    warnings.push('関節の検出信頼度が低めです。明るく、全身が入った動画を使うと精度が上がります。');
  }

  return { frames: smoothed, detectionRate, meanConfidence, warnings };
}

function cloneFrame(src: MotionFrame, t: number): MotionFrame {
  return {
    t,
    positions: Float32Array.from(src.positions),
    confidence: Float32Array.from(src.confidence),
    root: { ...src.root },
    facing: src.facing,
  };
}

function interpolateFrame(a: MotionFrame, b: MotionFrame, u: number, t: number): MotionFrame {
  const positions = new Float32Array(a.positions.length);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = a.positions[i] + (b.positions[i] - a.positions[i]) * u;
  }
  const confidence = new Float32Array(a.confidence.length);
  for (let i = 0; i < confidence.length; i++) {
    // 補間で作った値なので信頼度は下げて記録する
    confidence[i] = (a.confidence[i] + (b.confidence[i] - a.confidence[i]) * u) * 0.5;
  }
  return {
    t,
    positions,
    confidence,
    root: {
      x: a.root.x + (b.root.x - a.root.x) * u,
      y: a.root.y + (b.root.y - a.root.y) * u,
      z: a.root.z + (b.root.z - a.root.z) * u,
    },
    facing: a.facing + (b.facing - a.facing) * u,
  };
}

/** クリップ全体を左右反転する（振り付けの鏡像化）。 */
export function mirrorClip(clip: MotionClip): MotionClip {
  const swap: Array<[JointName, JointName]> = [
    ['shoulderL', 'shoulderR'],
    ['elbowL', 'elbowR'],
    ['wristL', 'wristR'],
    ['hipL', 'hipR'],
    ['kneeL', 'kneeR'],
    ['ankleL', 'ankleR'],
    ['footL', 'footR'],
  ];
  const frames = clip.frames.map((f) => {
    const positions = Float32Array.from(f.positions);
    const confidence = Float32Array.from(f.confidence);
    for (let i = 0; i < JOINT_COUNT; i++) positions[i * 3] = -positions[i * 3];
    for (const [l, r] of swap) {
      const li = JOINT_INDEX[l];
      const ri = JOINT_INDEX[r];
      for (let axis = 0; axis < 3; axis++) swapAt(positions, li * 3 + axis, ri * 3 + axis);
      swapAt(confidence, li, ri);
    }
    return { ...f, positions, confidence, root: { ...f.root, x: -f.root.x } };
  });
  return { ...clip, id: crypto.randomUUID(), name: `${clip.name} (反転)`, frames };
}

function swapAt(arr: Float32Array, a: number, b: number): void {
  const tmp = arr[a];
  arr[a] = arr[b];
  arr[b] = tmp;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
