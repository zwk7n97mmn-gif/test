/** キャラクターリグの共通関節名。抽出バックエンドが何であれ、この名前空間に写像する。 */
export const JOINT_NAMES = [
  'hip',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'elbowL',
  'wristL',
  'shoulderR',
  'elbowR',
  'wristR',
  'hipL',
  'kneeL',
  'ankleL',
  'footL',
  'hipR',
  'kneeR',
  'ankleR',
  'footR',
] as const;

export type JointName = (typeof JOINT_NAMES)[number];

export const JOINT_INDEX: Record<JointName, number> = JOINT_NAMES.reduce(
  (acc, name, i) => {
    acc[name] = i;
    return acc;
  },
  {} as Record<JointName, number>,
);

export const JOINT_COUNT = JOINT_NAMES.length;

/**
 * 1フレーム分の姿勢。
 * 座標系: 原点=腰(hip)、+X=右(画面右)、+Y=下、単位=胴長(hip→chest)を1とする正規化空間。
 * これによりキャラクターの体格が変わってもモーションは不変になる。
 */
export interface MotionFrame {
  /** クリップ先頭からの秒数 */
  t: number;
  /** JOINT_COUNT * 2 の [x, y] 配列 */
  positions: Float32Array;
  /** 関節ごとの信頼度 0..1 */
  confidence: Float32Array;
  /** 画面内でのルート位置（胴長単位、フレーム中心が原点） */
  root: { x: number; y: number };
  /** 正面向き度合い。1=正面、0=真横。肩幅/胴長から推定。 */
  facing: number;
  /** 左右反転しているか（右肩が画面左に来ている） */
  mirrored: boolean;
}

export interface MotionClip {
  id: string;
  name: string;
  fps: number;
  duration: number;
  frames: MotionFrame[];
  source: {
    kind: 'video' | 'import';
    fileName: string;
    /** 抽出に使ったバックエンド識別子 */
    backend: string;
    width: number;
    height: number;
  };
  /** 抽出時の品質メトリクス */
  quality: {
    /** 姿勢が検出できたフレームの割合 0..1 */
    detectionRate: number;
    /** 平均信頼度 0..1 */
    meanConfidence: number;
    warnings: string[];
  };
}

/** JSON へ直列化するときの形（Float32Array は通常配列にする） */
export interface SerializedMotionClip {
  formatVersion: 1;
  id: string;
  name: string;
  fps: number;
  duration: number;
  source: MotionClip['source'];
  quality: MotionClip['quality'];
  joints: readonly string[];
  frames: Array<{
    t: number;
    p: number[];
    c: number[];
    root: [number, number];
    facing: number;
    mirrored: boolean;
  }>;
}

export function serializeClip(clip: MotionClip): SerializedMotionClip {
  return {
    formatVersion: 1,
    id: clip.id,
    name: clip.name,
    fps: clip.fps,
    duration: clip.duration,
    source: clip.source,
    quality: clip.quality,
    joints: JOINT_NAMES,
    frames: clip.frames.map((f) => ({
      t: round4(f.t),
      p: Array.from(f.positions, round4),
      c: Array.from(f.confidence, round3),
      root: [round4(f.root.x), round4(f.root.y)],
      facing: round3(f.facing),
      mirrored: f.mirrored,
    })),
  };
}

export function deserializeClip(data: unknown): MotionClip {
  if (typeof data !== 'object' || data === null) {
    throw new Error('モーションファイルの形式が不正です（オブジェクトではありません）。');
  }
  const raw = data as Partial<SerializedMotionClip>;
  if (raw.formatVersion !== 1) {
    throw new Error(`未対応のフォーマットバージョンです: ${String(raw.formatVersion)}`);
  }
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) {
    throw new Error('モーションファイルにフレームが含まれていません。');
  }
  if (!Array.isArray(raw.joints) || raw.joints.length !== JOINT_COUNT) {
    throw new Error(`関節数が一致しません（期待 ${JOINT_COUNT} / 実際 ${raw.joints?.length ?? 0}）。`);
  }
  const frames: MotionFrame[] = raw.frames.map((f, i) => {
    if (!Array.isArray(f.p) || f.p.length !== JOINT_COUNT * 2) {
      throw new Error(`フレーム ${i} の座標数が不正です。`);
    }
    return {
      t: Number(f.t) || 0,
      positions: Float32Array.from(f.p),
      confidence: Float32Array.from(
        Array.isArray(f.c) && f.c.length === JOINT_COUNT ? f.c : new Array(JOINT_COUNT).fill(1),
      ),
      root: { x: f.root?.[0] ?? 0, y: f.root?.[1] ?? 0 },
      facing: typeof f.facing === 'number' ? f.facing : 1,
      mirrored: Boolean(f.mirrored),
    };
  });
  return {
    id: raw.id || crypto.randomUUID(),
    name: raw.name || 'imported-clip',
    fps: raw.fps || 30,
    duration: raw.duration || frames[frames.length - 1].t,
    frames,
    source: raw.source ?? {
      kind: 'import',
      fileName: 'unknown',
      backend: 'import',
      width: 0,
      height: 0,
    },
    quality: raw.quality ?? { detectionRate: 1, meanConfidence: 1, warnings: [] },
  };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const round3 = (v: number) => Math.round(v * 1e3) / 1e3;

/** 指定時刻の姿勢を線形補間で取得する。範囲外はクランプ。 */
export function sampleClip(clip: MotionClip, time: number): MotionFrame | null {
  const frames = clip.frames;
  if (frames.length === 0) return null;
  if (time <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (time >= last.t) return last;

  // 等間隔前提で当たりをつけてから線形探索（可変フレームレートにも対応）
  let lo = Math.min(frames.length - 1, Math.max(0, Math.floor(time * clip.fps)));
  while (lo > 0 && frames[lo].t > time) lo--;
  while (lo < frames.length - 2 && frames[lo + 1].t <= time) lo++;

  const a = frames[lo];
  const b = frames[lo + 1];
  const span = b.t - a.t;
  const u = span > 0 ? (time - a.t) / span : 0;

  const positions = new Float32Array(JOINT_COUNT * 2);
  const confidence = new Float32Array(JOINT_COUNT);
  for (let i = 0; i < JOINT_COUNT * 2; i++) {
    positions[i] = a.positions[i] + (b.positions[i] - a.positions[i]) * u;
  }
  for (let i = 0; i < JOINT_COUNT; i++) {
    confidence[i] = a.confidence[i] + (b.confidence[i] - a.confidence[i]) * u;
  }
  return {
    t: time,
    positions,
    confidence,
    root: { x: a.root.x + (b.root.x - a.root.x) * u, y: a.root.y + (b.root.y - a.root.y) * u },
    facing: a.facing + (b.facing - a.facing) * u,
    mirrored: u < 0.5 ? a.mirrored : b.mirrored,
  };
}

export function getJoint(frame: MotionFrame, name: JointName): { x: number; y: number; c: number } {
  const i = JOINT_INDEX[name];
  return { x: frame.positions[i * 2], y: frame.positions[i * 2 + 1], c: frame.confidence[i] };
}
