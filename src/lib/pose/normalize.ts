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

/** 正面を向いた人物の肩幅 / 胴長の目安。facing 推定の基準値。 */
const FRONTAL_SHOULDER_RATIO = 0.72;

/**
 * MediaPipe の 33 点ランドマーク（画像正規化座標）を、
 * 腰原点・胴長1のキャラクター非依存空間へ写像する。
 *
 * 「容姿だけを変えて動きは元動画から取る」という要件は、この正規化が担保する:
 * ここで体格情報（絶対サイズ・体型）を落とし、関節の相対配置＝動きだけを残す。
 */
export function mapLandmarksToRig(
  landmarks: readonly RawLandmark[],
  videoWidth: number,
  videoHeight: number,
  time: number,
): MotionFrame | null {
  if (landmarks.length < 33) return null;
  const aspect = videoHeight > 0 ? videoWidth / videoHeight : 1;

  // x をアスペクト補正して「画像高さ」を単位にそろえる（横長動画で体が歪むのを防ぐ）
  const px = (i: number) => landmarks[i].x * aspect;
  const py = (i: number) => landmarks[i].y;
  const vis = (i: number) => clamp01(landmarks[i].visibility ?? 1);

  const hipMid = { x: (px(MP.hipL) + px(MP.hipR)) / 2, y: (py(MP.hipL) + py(MP.hipR)) / 2 };
  const shoulderMid = {
    x: (px(MP.shoulderL) + px(MP.shoulderR)) / 2,
    y: (py(MP.shoulderL) + py(MP.shoulderR)) / 2,
  };

  const torso = Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y);
  // 胴が潰れている＝真横 or 検出失敗。この姿勢を通すと後段でゼロ除算になる。
  if (!Number.isFinite(torso) || torso < 1e-4) return null;

  const positions = new Float32Array(JOINT_COUNT * 2);
  const confidence = new Float32Array(JOINT_COUNT);

  const set = (name: JointName, x: number, y: number, c: number) => {
    const i = JOINT_INDEX[name];
    positions[i * 2] = (x - hipMid.x) / torso;
    positions[i * 2 + 1] = (y - hipMid.y) / torso;
    confidence[i] = clamp01(c);
  };

  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

  // 頭中心は両耳の中点を優先し、取れなければ鼻で代用する
  const earConfidence = Math.min(vis(MP.earL), vis(MP.earR));
  const head =
    earConfidence > 0.3
      ? { x: (px(MP.earL) + px(MP.earR)) / 2, y: (py(MP.earL) + py(MP.earR)) / 2, c: earConfidence }
      : { x: px(MP.nose), y: py(MP.nose), c: vis(MP.nose) };

  const torsoConfidence = Math.min(
    vis(MP.hipL),
    vis(MP.hipR),
    vis(MP.shoulderL),
    vis(MP.shoulderR),
  );

  set('hip', hipMid.x, hipMid.y, torsoConfidence);
  set('spine', lerp(hipMid.x, shoulderMid.x, 0.45), lerp(hipMid.y, shoulderMid.y, 0.45), torsoConfidence);
  set('chest', shoulderMid.x, shoulderMid.y, torsoConfidence);
  set(
    'neck',
    lerp(shoulderMid.x, head.x, 0.35),
    lerp(shoulderMid.y, head.y, 0.35),
    Math.min(torsoConfidence, head.c),
  );
  set('head', head.x, head.y, head.c);

  set('shoulderL', px(MP.shoulderL), py(MP.shoulderL), vis(MP.shoulderL));
  set('elbowL', px(MP.elbowL), py(MP.elbowL), vis(MP.elbowL));
  set('wristL', px(MP.wristL), py(MP.wristL), vis(MP.wristL));
  set('shoulderR', px(MP.shoulderR), py(MP.shoulderR), vis(MP.shoulderR));
  set('elbowR', px(MP.elbowR), py(MP.elbowR), vis(MP.elbowR));
  set('wristR', px(MP.wristR), py(MP.wristR), vis(MP.wristR));

  set('hipL', px(MP.hipL), py(MP.hipL), vis(MP.hipL));
  set('kneeL', px(MP.kneeL), py(MP.kneeL), vis(MP.kneeL));
  set('ankleL', px(MP.ankleL), py(MP.ankleL), vis(MP.ankleL));
  set('footL', px(MP.footL), py(MP.footL), vis(MP.footL));
  set('hipR', px(MP.hipR), py(MP.hipR), vis(MP.hipR));
  set('kneeR', px(MP.kneeR), py(MP.kneeR), vis(MP.kneeR));
  set('ankleR', px(MP.ankleR), py(MP.ankleR), vis(MP.ankleR));
  set('footR', px(MP.footR), py(MP.footR), vis(MP.footR));

  const shoulderWidth = Math.hypot(
    px(MP.shoulderL) - px(MP.shoulderR),
    py(MP.shoulderL) - py(MP.shoulderR),
  );
  const facing = clamp01(shoulderWidth / torso / FRONTAL_SHOULDER_RATIO);

  return {
    t: time,
    positions,
    confidence,
    root: { x: (hipMid.x - aspect / 2) / torso, y: (hipMid.y - 0.5) / torso },
    facing,
    mirrored: px(MP.shoulderL) < px(MP.shoulderR),
  };
}

export interface PostProcessOptions {
  /** 1€ Filter の最小カットオフ。小さいほど滑らか、大きいほど追従重視。 */
  minCutoff?: number;
  beta?: number;
  /** この信頼度未満の関節は前後フレームから補間する */
  confidenceFloor?: number;
}

/**
 * 抽出直後のフレーム列を仕上げる:
 *  - 検出できなかった区間を前後から線形補間で埋める（穴が長すぎる場合は埋めずに警告）
 *  - 1€ Filter でジッタ除去
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
    let start = i - 1;
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
  const posFilter = new VectorOneEuro(JOINT_COUNT * 2, options.minCutoff ?? 1.2, options.beta ?? 0.02);
  const rootFilter = new VectorOneEuro(2, options.minCutoff ?? 1.2, options.beta ?? 0.02);
  const rootBuf = new Float32Array(2);

  const smoothed: MotionFrame[] = kept.map((f) => {
    const positions = posFilter.filter(f.positions, f.t, new Float32Array(JOINT_COUNT * 2));
    rootBuf[0] = f.root.x;
    rootBuf[1] = f.root.y;
    const root = rootFilter.filter(rootBuf, f.t, new Float32Array(2));
    return { ...f, positions, root: { x: root[0], y: root[1] } };
  });

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
    mirrored: src.mirrored,
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
    root: { x: a.root.x + (b.root.x - a.root.x) * u, y: a.root.y + (b.root.y - a.root.y) * u },
    facing: a.facing + (b.facing - a.facing) * u,
    mirrored: u < 0.5 ? a.mirrored : b.mirrored,
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
    for (let i = 0; i < JOINT_COUNT; i++) positions[i * 2] = -positions[i * 2];
    for (const [l, r] of swap) {
      const li = JOINT_INDEX[l];
      const ri = JOINT_INDEX[r];
      swapAt(positions, li * 2, ri * 2);
      swapAt(positions, li * 2 + 1, ri * 2 + 1);
      swapAt(confidence, li, ri);
    }
    return { ...f, positions, confidence, root: { x: -f.root.x, y: f.root.y }, mirrored: !f.mirrored };
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
