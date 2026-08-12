/**
 * 描画の目視確認用ページ（開発ツール）。
 * アプリ本体の機能ではなく、キャラクター描画と合成処理が壊れていないかを
 * ブラウザ上で一目で確認するためのもの。`npm run check:visual` から利用する。
 */
import { buildRig, createSampleAppearances, createDefaultAppearance } from '../lib/character/appearance';
import { drawCharacter } from '../lib/character/draw';
import { retarget } from '../lib/character/retarget';
import { JOINT_COUNT, JOINT_INDEX, type JointName, type MotionClip, type MotionFrame } from '../lib/pose/types';
import { createProject } from '../lib/project/types';
import { renderFrame } from '../lib/render/composer';
import type { AudioAnalysis } from '../lib/audio/types';

/** 正規化空間で「踊っている」姿勢を合成する（描画確認専用のダミー姿勢）。 */
function syntheticPose(phase: number): MotionFrame {
  const positions = new Float32Array(JOINT_COUNT * 2);
  const confidence = new Float32Array(JOINT_COUNT).fill(1);
  const set = (name: JointName, x: number, y: number) => {
    positions[JOINT_INDEX[name] * 2] = x;
    positions[JOINT_INDEX[name] * 2 + 1] = y;
  };

  const swing = Math.sin(phase);
  const swing2 = Math.sin(phase * 2);

  set('hip', 0, 0);
  set('spine', swing * 0.04, -0.45);
  set('chest', swing * 0.06, -1);
  set('neck', swing * 0.07, -1.2);
  set('head', swing * 0.09, -1.5);

  set('shoulderL', -0.33 + swing * 0.05, -1.02);
  set('elbowL', -0.6 + swing * 0.18, -1.2 - swing * 0.35);
  set('wristL', -0.8 + swing * 0.3, -1.5 - swing * 0.5);

  set('shoulderR', 0.33 + swing * 0.05, -1.02);
  set('elbowR', 0.62 - swing * 0.14, -0.62 + swing2 * 0.2);
  set('wristR', 0.86 - swing * 0.24, -0.2 + swing2 * 0.34);

  set('hipL', -0.17, 0.02);
  set('kneeL', -0.22 + swing2 * 0.08, 0.92);
  set('ankleL', -0.26 + swing2 * 0.12, 1.8);
  set('footL', -0.3 + swing2 * 0.12, 1.98);

  set('hipR', 0.17, 0.02);
  set('kneeR', 0.24 - swing2 * 0.1, 0.9);
  set('ankleR', 0.3 - swing2 * 0.14, 1.78);
  set('footR', 0.36 - swing2 * 0.14, 1.96);

  return {
    t: phase / (Math.PI * 2),
    positions,
    confidence,
    root: { x: swing * 0.2, y: -Math.abs(swing2) * 0.08 },
    facing: 1,
    mirrored: false,
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
      low: Float32Array.from({ length: 600 }, (_, i) => 0.5 + 0.5 * Math.sin(i / 8)),
      mid: new Float32Array(600),
      high: new Float32Array(600),
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
  // 1) 容姿バリエーション — 同じ姿勢を異なる容姿で描く
  const appearances = [
    ...createSampleAppearances(),
    createDefaultAppearance({ name: 'デフォルメ (頭大)', headScale: 1.5, hairStyle: 'long', outfit: 'dress' }),
    createDefaultAppearance({ name: '低頭身 / ショート', headScale: 0.78, hairStyle: 'short', outfit: 'idol' }),
  ];
  const pose = syntheticPose(1.1);

  // 0) 拡大表示 — 線の重なりや関節の繋ぎ目を細かく確認するための大きめの1枚
  {
    const appearance = appearances[2];
    const canvas = makeCanvas(900, 1300, `拡大確認: ${appearance.name}`);
    const ctx = canvas.getContext('2d')!;
    const rig = buildRig(appearance);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.74);
    ctx.scale(310, 310);
    drawCharacter(ctx, retarget(pose, rig), appearance, rig, { sway: 0.3, bob: 0, blink: 0, beat: 0 });
    ctx.restore();
  }

  for (const appearance of appearances) {
    const canvas = makeCanvas(420, 640, appearance.name);
    const ctx = canvas.getContext('2d')!;
    const rig = buildRig(appearance);
    const unit = 150;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.72);
    ctx.scale(unit, unit);
    drawCharacter(ctx, retarget(pose, rig), appearance, rig, { sway: 0.4, bob: 0, blink: 0, beat: 0 });
    ctx.restore();
  }

  // 2) 姿勢バリエーション — 同じ容姿で動きが変わることを確認
  const appearance = appearances[0];
  const rig = buildRig(appearance);
  for (let i = 0; i < 4; i++) {
    const phase = (i / 4) * Math.PI * 2;
    const canvas = makeCanvas(420, 640, `ポーズ ${i + 1}/4`);
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.72);
    ctx.scale(150, 150);
    drawCharacter(ctx, retarget(syntheticPose(phase), rig), appearance, rig, {
      sway: Math.sin(phase) * 0.6,
      bob: 0,
      blink: 0,
      beat: 0,
    });
    ctx.restore();
  }

  // 3) 合成フレーム（背景・演出・テロップ込み）
  const clip = syntheticClip();
  const analysis = syntheticAnalysis();
  const backgrounds = ['gradient', 'stage', 'grid', 'solid'] as const;
  backgrounds.forEach((kind, i) => {
    const project = createProject({ appearance: appearances[i % appearances.length] });
    project.background = { ...project.background, kind };
    project.caption = { ...project.caption, enabled: true, text: `背景: ${kind}` };
    const canvas = makeCanvas(540, 960, `合成フレーム (${kind})`);
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.scale(canvas.width / 1080, canvas.height / 1920);
    renderFrame(ctx, i * 0.5 + 0.02, { project, clip, analysis });
    ctx.restore();
  });

  // 4) 空状態（モーション未設定）
  const emptyProject = createProject();
  const emptyCanvas = makeCanvas(540, 960, '空状態（モーション未設定）');
  const emptyCtx = emptyCanvas.getContext('2d')!;
  emptyCtx.save();
  emptyCtx.scale(emptyCanvas.width / 1080, emptyCanvas.height / 1920);
  renderFrame(emptyCtx, 0, { project: emptyProject, clip: null, analysis: null });
  emptyCtx.restore();

  document.body.dataset.renderComplete = 'true';
}

main();
