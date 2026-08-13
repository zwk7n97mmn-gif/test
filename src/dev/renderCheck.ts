/**
 * 描画の目視確認用ページ（開発ツール）。
 * アプリ本体の機能ではなく、3D キャラクターと合成処理が壊れていないかを
 * ブラウザ上で一目で確認するためのもの。`npm run check:visual` から利用する。
 */
import { createSampleAppearances, createDefaultAppearance } from '../lib/character/appearance';
import { JOINT_COUNT, JOINT_INDEX, type JointName, type MotionClip, type MotionFrame } from '../lib/pose/types';
import { createProject } from '../lib/project/types';
import { renderFrame } from '../lib/render/composer';
import type { AudioAnalysis } from '../lib/audio/types';

/** 正規化空間（腰原点・胴長1・Y上）で「踊っている」姿勢を合成する（描画確認専用）。 */
function syntheticPose(phase: number): MotionFrame {
  const positions = new Float32Array(JOINT_COUNT * 3);
  const confidence = new Float32Array(JOINT_COUNT).fill(1);
  const set = (name: JointName, x: number, y: number, z: number) => {
    const i = JOINT_INDEX[name];
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  };

  const swing = Math.sin(phase);
  const swing2 = Math.sin(phase * 2);
  const twist = swing * 0.18;

  set('hip', 0, 0, 0);
  set('spine', swing * 0.03, 0.45, 0.01);
  set('chest', swing * 0.05, 1, 0.02);
  set('neck', swing * 0.06, 1.18, 0.02);
  set('head', swing * 0.08, 1.5, 0.03);

  // 肩はひねりに応じて前後にずれる
  set('shoulderL', 0.4, 0.98, twist);
  set('elbowL', 0.72 + swing * 0.16, 0.52 + swing * 0.5, 0.12 + twist);
  set('wristL', 0.92 + swing * 0.3, 0.1 + swing * 1.15, 0.24 + twist);

  set('shoulderR', -0.4, 0.98, -twist);
  set('elbowR', -0.74 + swing2 * 0.08, 0.42 - swing2 * 0.2, 0.1 - twist);
  set('wristR', -0.9 + swing2 * 0.2, -0.06 - swing2 * 0.4, 0.3 - twist);

  set('hipL', 0.17, 0.02, 0);
  set('kneeL', 0.22 + swing2 * 0.06, -0.95, 0.06 + swing2 * 0.12);
  set('ankleL', 0.26 + swing2 * 0.1, -1.85, -0.02 + swing2 * 0.2);
  set('footL', 0.28 + swing2 * 0.1, -1.98, 0.18 + swing2 * 0.2);

  set('hipR', -0.17, 0.02, 0);
  set('kneeR', -0.24 - swing2 * 0.05, -0.94, 0.05 - swing2 * 0.1);
  set('ankleR', -0.3 - swing2 * 0.08, -1.84, -0.03 - swing2 * 0.18);
  set('footR', -0.32 - swing2 * 0.08, -1.97, 0.17 - swing2 * 0.18);

  return {
    t: phase / (Math.PI * 2),
    positions,
    confidence,
    root: { x: swing * 0.25, y: Math.abs(swing2) * 0.06, z: 0 },
    facing: 1,
  };
}

function syntheticClip(): MotionClip {
  const fps = 30;
  const frameCount = 60;
  const frames = Array.from({ length: frameCount }, (_, i) => {
    const frame = syntheticPose((i / frameCount) * Math.PI * 2);
    frame.t = i / fps;
    return frame;
  });
  return {
    id: 'dev-clip',
    name: 'synthetic',
    fps,
    duration: (frameCount - 1) / fps,
    frames,
    source: { kind: 'import', fileName: 'synthetic', backend: 'dev', width: 1080, height: 1920 },
    quality: { detectionRate: 1, meanConfidence: 1, warnings: [] },
  };
}

function syntheticAnalysis(bpm = 120, duration = 8): AudioAnalysis {
  const beatDuration = 60 / bpm;
  const count = Math.floor(duration / beatDuration);
  return {
    duration,
    sampleRate: 44100,
    bpm,
    bpmConfidence: 0.9,
    hopTime: 512 / 44100,
    onsetEnvelope: new Float32Array(0),
    energyEnvelope: new Float32Array(0),
    bands: {
      low: Float32Array.from({ length: 900 }, (_, i) => 0.5 + 0.5 * Math.sin(i / 9)),
      mid: new Float32Array(900),
      high: new Float32Array(900),
    },
    onsets: [],
    beats: Array.from({ length: count }, (_, i) => ({
      time: i * beatDuration,
      indexInBar: i % 4,
      strength: 1,
    })),
    sections: [],
    hook: null,
    waveform: new Float32Array(0),
    warnings: [],
  };
}

function makeCanvas(width: number, height: number, label: string): HTMLCanvasElement {
  const wrapper = document.createElement('figure');
  wrapper.style.cssText = 'margin:0;display:flex;flex-direction:column;gap:6px;align-items:center';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `width:${width / 2}px;height:${height / 2}px;background:#1b1826;border:1px solid #7a7098;border-radius:8px`;
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  caption.style.cssText = 'font:12px system-ui;color:#c6bfd8';
  wrapper.append(canvas, caption);
  document.getElementById('grid')!.append(wrapper);
  return canvas;
}

function main(): void {
  const clip = syntheticClip();
  const analysis = syntheticAnalysis();

  const appearances = [
    ...createSampleAppearances(),
    createDefaultAppearance({
      name: '低身長・大きい頭',
      headScale: 1.28,
      legLength: 0.88,
      hairStyle: 'bob',
      outfit: 'jacket',
      topColor: '#3f5f8c',
      bottomColor: '#22252e',
      skinTone: '#f6d9c4',
    }),
    createDefaultAppearance({
      name: '長身・スリム',
      headScale: 0.84,
      legLength: 1.18,
      limbThickness: 0.85,
      shoulderWidth: 0.92,
      build: 'slim',
      hairStyle: 'short',
      outfit: 'tanktop',
      skinTone: '#7d4f33',
      topColor: '#d94f6a',
      bottomColor: '#1b1e26',
    }),
  ];

  // 1) 容姿バリエーション — 同じ姿勢を異なる容姿で描く
  for (const appearance of appearances) {
    const project = createProject({ appearance });
    project.background = { ...project.background, kind: 'gradient' };
    project.effects = { ...project.effects, particles: 0 };
    const canvas = makeCanvas(420, 720, appearance.name);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, 0.28, { project, clip, analysis });
  }

  // 2) 姿勢バリエーション — 同じ容姿で動きが変わることを確認
  for (let i = 0; i < 4; i++) {
    const project = createProject({ appearance: appearances[0] });
    project.timing = { ...project.timing, mode: 'original', loop: true };
    project.effects = { ...project.effects, particles: 0 };
    const canvas = makeCanvas(420, 720, `ポーズ ${i + 1}/4`);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, (i / 4) * clip.duration, { project, clip, analysis });
  }

  // 3) 背景・演出のバリエーション
  const backgrounds = ['gradient', 'stage', 'grid', 'solid'] as const;
  backgrounds.forEach((kind, i) => {
    const project = createProject({ appearance: appearances[i % appearances.length] });
    project.background = { ...project.background, kind };
    project.caption = { ...project.caption, enabled: true, text: `背景: ${kind}` };
    const canvas = makeCanvas(420, 746, `合成フレーム (${kind})`);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, i * 0.5 + 0.05, { project, clip, analysis });
  });

  // 3.5) 顔の寄り（目・眉・口が描けているかの確認）
  {
    const project = createProject({ appearance: appearances[0] });
    // anchorY を大きくするとフレーム中心が上がる = 顔に寄る
    // （UI 上の上限は超えるが、確認用に直接指定している）
    project.timing = { ...project.timing, scale: 6, anchorY: 4.62, rootMotion: 0 };
    project.effects = { ...project.effects, particles: 0, bassPulse: 0 };
    const canvas = makeCanvas(560, 560, '顔の寄り（目・眉・口の確認）');
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, 0.28, { project, clip, analysis });
  }

  // 4) 左右反転
  {
    const project = createProject({ appearance: appearances[0] });
    project.timing = { ...project.timing, mirror: true };
    const canvas = makeCanvas(420, 720, '左右反転');
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, 0.28, { project, clip, analysis });
  }

  // 5) 空状態（モーション未設定）
  {
    const canvas = makeCanvas(420, 746, '空状態（モーション未設定）');
    const ctx = canvas.getContext('2d', { alpha: false })!;
    renderFrame(ctx, 0, { project: createProject(), clip: null, analysis: null });
  }

  document.body.dataset.renderComplete = 'true';
}

main();
