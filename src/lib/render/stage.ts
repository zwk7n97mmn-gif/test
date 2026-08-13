import * as THREE from 'three';
import type { AudioAnalysis } from '../audio/types';
import { buildRig, type CharacterAppearance } from '../character/appearance';
import { Humanoid } from '../character/humanoid';
import { retarget, lowestPoint } from '../character/retarget';
import type { MotionFrame } from '../pose/types';
import type { Project } from '../project/types';

export class WebGLUnavailableError extends Error {
  constructor(
    message: string,
    readonly hint = 'ブラウザを再読み込みするか、他のタブを閉じてから再度お試しください。',
  ) {
    super(message);
    this.name = 'WebGLUnavailableError';
  }
}

export interface StageUpdate {
  project: Project;
  frame: MotionFrame | null;
  analysis: AudioAnalysis | null;
  time: number;
  /** 0..1 のビート強度 */
  beat: number;
  /** 0..1 の低域エネルギー */
  bass: number;
}

const MAX_PARTICLES = 260;

/**
 * three.js による 3D ステージ。
 *
 * WebGL コンテキストはモバイルで枚数制限が厳しいため、アプリ全体で 1 つを共有し、
 * プレビューと書き出しで使い回す（`getStage()`）。
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 9 / 16, 0.1, 100);
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly ground: THREE.Mesh;
  private readonly floorGlow: THREE.Mesh;
  private readonly particles: THREE.Points;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;

  private humanoid: Humanoid | null = null;
  private appearanceKey = '';
  private backgroundKey = '';
  private backgroundTexture: THREE.CanvasTexture | null = null;
  private contextLost = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      throw new WebGLUnavailableError(
        'このブラウザ／端末で 3D 描画（WebGL）を初期化できませんでした。',
        err instanceof Error ? err.message : undefined,
      );
    }
    this.renderer = renderer;
    this.renderer.setPixelRatio(1); // 出力解像度はキャンバス側で指定する
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    // --- ライティング（キー / リム / 環境の3灯） ---------------------------
    this.ambient = new THREE.HemisphereLight(0xdfe7ff, 0x2b2436, 0.85);
    this.scene.add(this.ambient);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    this.keyLight.position.set(2.2, 5.2, 4.0);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 20;
    this.keyLight.shadow.camera.left = -3;
    this.keyLight.shadow.camera.right = 3;
    this.keyLight.shadow.camera.top = 6;
    this.keyLight.shadow.camera.bottom = -1;
    this.keyLight.shadow.bias = -0.0018;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.rimLight = new THREE.DirectionalLight(0xbcd4ff, 1.5);
    this.rimLight.position.set(-3.2, 3.4, -4.2);
    this.scene.add(this.rimLight);

    // --- 地面（影のみを落とす） -------------------------------------------
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.ShadowMaterial({ opacity: 0.42 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // --- 低音に反応する床の光 ---------------------------------------------
    this.floorGlow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.floorGlow.rotation.x = -Math.PI / 2;
    this.floorGlow.position.y = 0.004;
    this.scene.add(this.floorGlow);

    // --- パーティクル -------------------------------------------------------
    this.particlePositions = new Float32Array(MAX_PARTICLES * 3);
    this.particleColors = new Float32Array(MAX_PARTICLES * 3);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));
    this.particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        size: 0.075,
        vertexColors: true,
        transparent: true,
        // 加算合成なので、色を黒に近づけることが「消える」ことに等しい
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  get lost(): boolean {
    return this.contextLost;
  }

  setSize(width: number, height: number): void {
    const current = this.renderer.getSize(new THREE.Vector2());
    if (current.x === width && current.y === height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 姿勢・カメラ・ライト・演出を時刻に応じて更新し、1 フレーム描画する。 */
  render(update: StageUpdate): void {
    if (this.contextLost) return;
    const { project, frame, beat, bass, analysis, time } = update;

    this.syncAppearance(project.appearance);
    this.syncBackground(project);

    const rig = buildRig(project.appearance);
    const humanoid = this.humanoid;

    if (humanoid) {
      humanoid.root.visible = frame !== null;
      if (frame) {
        const skeleton = retarget(frame, rig);
        humanoid.update(skeleton);
        // 足裏が地面に接するように全体を持ち上げる
        const lift = -lowestPoint(skeleton) + rig.foot * 0.12;
        const travel = project.timing.rootMotion;
        humanoid.root.position.set(
          frame.root.x * travel * 0.5,
          lift + Math.max(0, frame.root.y * travel * 0.25),
          0,
        );
      }
    }

    this.updateCamera(project, rig.totalHeight, beat, frame);
    this.updateEffects(project, analysis, time, beat, bass, rig.totalHeight);

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.humanoid?.dispose();
    this.backgroundTexture?.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.floorGlow.geometry.dispose();
    (this.floorGlow.material as THREE.Material).dispose();
    this.particles.geometry.dispose();
    (this.particles.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = () => {
    this.contextLost = false;
    // マテリアル・テクスチャは three.js が再アップロードするため、再構築は不要。
    this.backgroundKey = '';
  };

  private syncAppearance(appearance: CharacterAppearance): void {
    const key = JSON.stringify(appearance);
    if (key === this.appearanceKey && this.humanoid) return;
    this.appearanceKey = key;
    if (!this.humanoid) {
      this.humanoid = new Humanoid(appearance);
      this.scene.add(this.humanoid.root);
    } else {
      this.humanoid.applyAppearance(appearance);
    }
  }

  private syncBackground(project: Project): void {
    const { background } = project;
    const key = `${background.kind}|${background.colorA}|${background.colorB}`;
    if (key === this.backgroundKey && this.backgroundTexture) return;
    this.backgroundKey = key;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    switch (background.kind) {
      case 'solid': {
        ctx.fillStyle = background.colorA;
        ctx.fillRect(0, 0, 64, 256);
        break;
      }
      case 'stage': {
        const radial = ctx.createRadialGradient(32, 150, 4, 32, 150, 190);
        radial.addColorStop(0, background.colorA);
        radial.addColorStop(1, shadeCss(background.colorB, -0.65));
        ctx.fillStyle = radial;
        ctx.fillRect(0, 0, 64, 256);
        break;
      }
      case 'grid': {
        ctx.fillStyle = background.colorA;
        ctx.fillRect(0, 0, 64, 256);
        ctx.strokeStyle = background.colorB;
        ctx.lineWidth = 2;
        for (let y = 0; y <= 256; y += 32) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(64, y);
          ctx.stroke();
        }
        break;
      }
      default: {
        const linear = ctx.createLinearGradient(0, 0, 0, 256);
        linear.addColorStop(0, background.colorA);
        linear.addColorStop(1, background.colorB);
        ctx.fillStyle = linear;
        ctx.fillRect(0, 0, 64, 256);
      }
    }

    this.backgroundTexture?.dispose();
    this.backgroundTexture = new THREE.CanvasTexture(canvas);
    this.backgroundTexture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.backgroundTexture;

    // 環境光を背景色になじませる
    this.ambient.color.set(background.colorA);
    this.ambient.groundColor.set(background.colorB);
  }

  private updateCamera(project: Project, totalHeight: number, beat: number, frame: MotionFrame | null): void {
    const zoom = 1 - beat * project.effects.zoomPunch * 0.055;
    // 画面に収める世界高さ。scale が大きいほど寄る。
    const visibleHeight = (totalHeight * 1.35) / project.timing.scale;
    const distance = (visibleHeight / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * zoom;

    // 足元が anchorY の高さに来るようにフレーム中心を決める
    const centerY = project.timing.anchorY * visibleHeight - visibleHeight / 2;
    const driftX = frame ? frame.root.x * project.timing.rootMotion * 0.12 : 0;

    this.camera.position.set(driftX, centerY, distance);
    this.camera.lookAt(driftX, centerY, 0);
    this.keyLight.target.position.set(0, totalHeight * 0.5, 0);
    this.keyLight.target.updateMatrixWorld();
  }

  private updateEffects(
    project: Project,
    analysis: AudioAnalysis | null,
    time: number,
    beat: number,
    bass: number,
    totalHeight: number,
  ): void {
    this.keyLight.intensity = 2.1 + beat * project.background.beatReactivity * 1.5;
    this.rimLight.intensity = 1.5 + beat * project.background.beatReactivity * 1.1;

    // 床の光
    const glowMaterial = this.floorGlow.material as THREE.MeshBasicMaterial;
    const glowStrength = project.effects.bassPulse * (0.12 + bass * 0.5);
    glowMaterial.opacity = glowStrength;
    glowMaterial.color.set(project.background.colorA);
    const glowScale = totalHeight * (0.35 + bass * 0.3);
    this.floorGlow.scale.set(glowScale, glowScale, glowScale);
    this.floorGlow.visible = glowStrength > 0.005;

    this.updateParticles(project, analysis, time, totalHeight);
  }

  /**
   * ビートごとに決定的な擬似乱数で粒子を配置する。
   * 時刻 t から一意に決まるため、シークしても書き出しても同じ絵になる。
   */
  private updateParticles(
    project: Project,
    analysis: AudioAnalysis | null,
    time: number,
    totalHeight: number,
  ): void {
    const amount = project.effects.particles;
    this.particles.visible = amount > 0.01 && !!analysis && analysis.beats.length > 0;
    if (!this.particles.visible || !analysis) return;

    const life = 1.3;
    const perBeat = Math.min(40, Math.round(6 + amount * 22));
    const color = new THREE.Color(project.background.colorA).lerp(new THREE.Color('#ffffff'), 0.7);

    let cursor = 0;
    for (let i = analysis.beats.length - 1; i >= 0 && cursor < MAX_PARTICLES; i--) {
      const beat = analysis.beats[i];
      const age = time - beat.time;
      if (age < 0) continue;
      if (age > life) break;
      const fade = 1 - age / life;

      for (let k = 0; k < perBeat && cursor < MAX_PARTICLES; k++, cursor++) {
        const r1 = hash2(i, k);
        const r2 = hash2(i, k + 97);
        const r3 = hash2(i, k + 311);
        const angle = r1 * Math.PI * 2;
        const radius = (0.3 + r2 * 1.1) * totalHeight * 0.45 * (0.35 + age);
        const rise = age * totalHeight * (0.25 + r3 * 0.5);

        this.particlePositions[cursor * 3] = Math.cos(angle) * radius;
        this.particlePositions[cursor * 3 + 1] = totalHeight * 0.12 + rise;
        this.particlePositions[cursor * 3 + 2] = Math.sin(angle) * radius;

        const brightness = fade * fade * amount;
        this.particleColors[cursor * 3] = color.r * brightness;
        this.particleColors[cursor * 3 + 1] = color.g * brightness;
        this.particleColors[cursor * 3 + 2] = color.b * brightness;
      }
    }
    // 余った粒子は輝度0にして見えなくする（加算合成なので黒＝不可視）
    for (let i = cursor; i < MAX_PARTICLES; i++) {
      this.particleColors[i * 3] = 0;
      this.particleColors[i * 3 + 1] = 0;
      this.particleColors[i * 3 + 2] = 0;
    }

    const geometry = this.particles.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('color').needsUpdate = true;
  }
}

/** 整数2つから 0..1 の決定的な擬似乱数を作る。 */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function shadeCss(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  color.lerp(new THREE.Color(amount >= 0 ? '#ffffff' : '#000000'), Math.abs(amount));
  return `#${color.getHexString()}`;
}

// ---------------------------------------------------------------------------
// アプリ全体で 1 つの WebGL コンテキストを共有する
// ---------------------------------------------------------------------------

let sharedStage: Stage | null = null;
let recoveryAt = 0;
let recoveryCount = 0;

/** コンテキストロストからの自動復帰の上限（これを超えたら諦めて理由を出す）。 */
const MAX_RECOVERIES = 3;
const RECOVERY_COOLDOWN_MS = 1500;

export function getStage(): Stage {
  if (!sharedStage) sharedStage = new Stage();
  return sharedStage;
}

/**
 * コンテキストが失われていれば作り直す。
 * 連続失敗でループしないよう、回数とクールダウンで抑制する。
 * @returns 復帰を試みた（または不要だった）場合 true、諦めた場合 false
 */
export function recoverStageIfLost(): boolean {
  if (!sharedStage?.lost) return true;
  if (recoveryCount >= MAX_RECOVERIES) return false;
  const now = Date.now();
  if (now - recoveryAt < RECOVERY_COOLDOWN_MS) return true;
  recoveryAt = now;
  recoveryCount++;
  resetStage();
  return true;
}

/** コンテキストロストからの復帰用。次回の getStage() で作り直す。 */
export function resetStage(): void {
  sharedStage?.dispose();
  sharedStage = null;
}

let webglAvailable: boolean | null = null;

/**
 * WebGL が使えるかを 1 度だけ判定してキャッシュする。
 *
 * ブラウザが同時に保持できる WebGL コンテキスト数には上限があるため、
 * 毎フレーム判定用のコンテキストを作ると本来のコンテキストが破棄されてしまう。
 * 判定に使ったコンテキストはその場で明示的に解放する。
 */
export function isWebGLAvailable(): boolean {
  if (webglAvailable !== null) return webglAvailable;
  try {
    const canvas = document.createElement('canvas');
    const context = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    webglAvailable = Boolean(context);
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return webglAvailable;
  } catch {
    webglAvailable = false;
    return false;
  }
}
