import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { AudioAnalysis } from '../audio/types';
import { applyPoseToAvatar, disposeAvatarRig, type AvatarRig } from '../character/avatarRetarget';
import type { CharacterAppearance } from '../character/appearance';
import { buildBuiltinAvatar, builtinStructureKey, updateBuiltinColors } from '../character/builtinAvatar';
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
  /** 読み込み済みの外部アバター。指定時は内蔵キャラクターの代わりに使う。 */
  avatar: AvatarRig | null;
}

const MAX_PARTICLES = 260;

/**
 * three.js による 3D ステージ。
 *
 * WebGL コンテキストはモバイルで枚数制限が厳しいため、アプリ全体で 1 つを共有し、
 * プレビューと書き出しで使い回す（`getStage()`）。
 */
/** 影の中が潰れないようにするための、環境光の下限色。 */
const SKY_FILL = new THREE.Color('#e6ecff');
const GROUND_FILL = new THREE.Color('#7d7594');

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

  /** 内蔵キャラクター（外部アバターと同じ AvatarRig 形式） */
  private builtin: AvatarRig | null = null;
  private avatar: AvatarRig | null = null;
  private environment: THREE.Texture | null = null;
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
    // 環境光を強くしすぎると影が塗りつぶされるため、控えめにする
    this.ambient = new THREE.HemisphereLight(0xdfe7ff, 0x2b2436, 0.58);
    this.scene.add(this.ambient);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
    // 真正面から当てると体の起伏が出ないので、斜め上から当てる
    this.keyLight.position.set(3.4, 5.2, 3.0);
    this.keyLight.castShadow = true;
    // 体の自己遮蔽まで拾うため、地面に落とすだけだった頃より解像度を上げる
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1;
    this.keyLight.shadow.camera.far = 20;
    // 影用カメラは人物にぴったり寄せる。広いほど 1 テクセルが粗くなり、
    // 顔に落ちる前髪の影がギザギザになる。腕を伸ばした分の余裕だけ残す。
    this.keyLight.shadow.camera.left = -2.6;
    this.keyLight.shadow.camera.right = 2.6;
    this.keyLight.shadow.camera.top = 6;
    this.keyLight.shadow.camera.bottom = -0.4;
    this.keyLight.shadow.bias = -0.0004;
    // 曲面のセルフシャドウで縞（shadow acne）が出ないよう、法線方向にずらす。
    // 手足の半径が 0.1 前後なので、大きくしすぎると体の陰影ごと消えてしまう。
    this.keyLight.shadow.normalBias = 0.006;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.rimLight = new THREE.DirectionalLight(0xbcd4ff, 0.9);
    this.rimLight.position.set(-3.2, 3.4, -4.2);
    this.scene.add(this.rimLight);

    // --- 環境光（IBL） -------------------------------------------------------
    // 点光源だけだと肌や布が硬く見えるため、簡易的な室内環境を焼き込んで
    // 反射・陰影に階調を与える（実写寄りの見えに効く）。
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.environment;
      this.scene.environmentIntensity = 0.5;
      pmrem.dispose();
    } catch {
      // 環境マップが作れない環境でも、3灯だけで描画は成立する
    }

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

    this.syncBackground(project);
    this.syncAvatar(update.avatar);
    if (!update.avatar) this.syncBuiltin(project.appearance);

    // 外部アバターがあればそれを、無ければ内蔵キャラクターを動かす。
    // どちらも同じ AvatarRig なので、以降の処理は完全に共通。
    const character = this.avatar ?? this.builtin;
    if (this.builtin) this.builtin.root.visible = !this.avatar && frame !== null;
    if (this.avatar) this.avatar.root.visible = frame !== null;

    const totalHeight = character?.totalHeight ?? 4;
    if (character && frame) {
      applyPoseToAvatar(character, frame, {
        rootMotion: project.timing.rootMotion,
        flipFacing: this.avatar
          ? (project.avatarFlipFacing ?? this.avatar.facesBackward)
          : character.facesBackward,
      });
      this.groundAvatar(character);
    }

    this.updateCamera(project, totalHeight, beat, frame);
    this.updateEffects(project, analysis, time, beat, bass, totalHeight);

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (this.builtin) disposeAvatarRig(this.builtin);
    this.backgroundTexture?.dispose();
    this.environment?.dispose();
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

  /** 使用するアバターを差し替える。null なら内蔵キャラクターに戻す。 */
  private syncAvatar(avatar: AvatarRig | null): void {
    if (this.avatar === avatar) return;
    if (this.avatar) this.scene.remove(this.avatar.root);
    this.avatar = avatar;
    if (avatar) this.scene.add(avatar.root);
  }

  /**
   * 内蔵キャラクターを容姿に合わせて作り直す。
   * スキンメッシュの形状が容姿に依存するため、変更時はジオメトリごと再生成する。
   */
  private syncBuiltin(appearance: CharacterAppearance): void {
    const key = builtinStructureKey(appearance);
    if (key === this.appearanceKey && this.builtin) {
      // 形状が同じなら色だけ差し替える（スライダー操作中もフレーム落ちしない）
      updateBuiltinColors(this.builtin, appearance);
      return;
    }
    this.appearanceKey = key;
    if (this.builtin) {
      this.scene.remove(this.builtin.root);
      disposeAvatarRig(this.builtin);
    }
    this.builtin = buildBuiltinAvatar(appearance);
    updateBuiltinColors(this.builtin, appearance);
    this.scene.add(this.builtin.root);
  }

  /** ポーズ適用後に、最も低い足が地面に接するよう全体を上下させる。 */
  private groundAvatar(avatar: AvatarRig): void {
    avatar.root.position.y = 0;
    avatar.root.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const bone of [avatar.bones.leftFoot, avatar.bones.rightFoot, avatar.bones.leftLowerLeg, avatar.bones.rightLowerLeg]) {
      if (!bone) continue;
      const y = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld).y;
      if (y < lowest) lowest = y;
    }
    if (Number.isFinite(lowest)) {
      // 足首ボーンは足裏より少し上にあるため、その分だけ余分に下げない
      avatar.root.position.y = -lowest + avatar.totalHeight * 0.02;
      avatar.root.updateMatrixWorld(true);
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

    // 環境光を背景色になじませる。
    // ただし背景をそのまま使うと、暗い背景のときに影の中が真っ黒に潰れてしまう。
    // 色みだけを borrow して明るさは持ち上げる。
    this.ambient.color.set(background.colorA).lerp(SKY_FILL, 0.55);
    this.ambient.groundColor.set(background.colorB).lerp(GROUND_FILL, 0.6);
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
    this.keyLight.intensity = 2.6 + beat * project.background.beatReactivity * 1.5;
    this.rimLight.intensity = 0.9 + beat * project.background.beatReactivity * 1.1;

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
