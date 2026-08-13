import * as THREE from 'three';
import type { Vec3 } from '../pose/types';
import type { CharacterAppearance, CharacterRig } from './appearance';
import { buildRig } from './appearance';
import type { PosedSkeleton } from './retarget';

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();

/**
 * 3D ヒューマノイド。
 *
 * 骨の「長さ」はリグ（＝容姿）から、「向き」はモーションから来る。
 * 各パーツは独立した剛体で、毎フレーム位置と姿勢だけを更新する
 * （スキニングを使わないぶん軽く、スマートフォンでも 30fps を維持しやすい）。
 */
export class Humanoid {
  readonly root = new THREE.Group();

  private rig: CharacterRig;
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly parts = new Map<string, THREE.Object3D>();
  private materials!: {
    skin: THREE.MeshStandardMaterial;
    skinDark: THREE.MeshStandardMaterial;
    hair: THREE.MeshStandardMaterial;
    top: THREE.MeshStandardMaterial;
    bottom: THREE.MeshStandardMaterial;
    shoe: THREE.MeshStandardMaterial;
    eye: THREE.MeshStandardMaterial;
    sclera: THREE.MeshStandardMaterial;
    dark: THREE.MeshStandardMaterial;
  };

  /** 見た目の構造を変えずに色だけ変えられるかの判定に使う */
  private structureKey = '';

  constructor(appearance: CharacterAppearance) {
    this.rig = buildRig(appearance);
    this.build(appearance);
  }

  get currentRig(): CharacterRig {
    return this.rig;
  }

  /**
   * 容姿を反映する。骨格・髪型・衣装が変わっていなければ色の更新だけで済ませ、
   * ジオメトリの作り直しを避ける（スライダー操作中でも滑らかに動く）。
   */
  applyAppearance(appearance: CharacterAppearance): void {
    if (structureKeyOf(appearance) === this.structureKey) {
      this.updateColors(appearance);
      return;
    }
    this.disposeContents();
    this.rig = buildRig(appearance);
    this.build(appearance);
  }

  /** 1 フレーム分の姿勢を反映する。 */
  update(skeleton: PosedSkeleton): void {
    const p = skeleton.points;
    const rig = this.rig;

    // 体の向き（肩の軸）と腰の向きを算出。これで胴のひねりを表現する。
    const shoulderSide = vecFromTo(p.shoulderR, p.shoulderL, tmpSide).normalize();
    const hipSide = vecFromTo(p.hipR, p.hipL, new THREE.Vector3()).normalize();

    this.placeAxis('pelvis', p.hip, p.spine, hipSide, rig.hipToSpine);
    this.placeAxis('torso', p.spine, p.chest, shoulderSide, rig.spineToChest);
    this.placeAxis('top', p.spine, p.chest, shoulderSide, rig.spineToChest);
    this.placeAxis('hips-cloth', p.hip, p.spine, hipSide, rig.hipToSpine);
    this.placeAxis('skirt', p.hip, p.spine, hipSide, rig.hipToSpine);

    this.placeBone('neck', p.chest, p.head);
    this.placeAxis('head', p.neck, p.head, shoulderSide, rig.neckToHead);

    this.placeBone('upperArmL', p.shoulderL, p.elbowL);
    this.placeBone('foreArmL', p.elbowL, p.wristL);
    this.placeBone('sleeveL', p.shoulderL, p.elbowL);
    this.placeBone('sleeveLowL', p.elbowL, p.wristL);
    this.placePoint('handL', p.wristL);
    this.placePoint('shoulderBallL', p.shoulderL);

    this.placeBone('upperArmR', p.shoulderR, p.elbowR);
    this.placeBone('foreArmR', p.elbowR, p.wristR);
    this.placeBone('sleeveR', p.shoulderR, p.elbowR);
    this.placeBone('sleeveLowR', p.elbowR, p.wristR);
    this.placePoint('handR', p.wristR);
    this.placePoint('shoulderBallR', p.shoulderR);

    for (const side of ['L', 'R'] as const) {
      const hip = side === 'L' ? p.hipL : p.hipR;
      const knee = side === 'L' ? p.kneeL : p.kneeR;
      const ankle = side === 'L' ? p.ankleL : p.ankleR;
      const foot = side === 'L' ? p.footL : p.footR;
      this.placeBone(`thigh${side}`, hip, knee);
      this.placeBone(`shin${side}`, knee, ankle);
      this.placeBone(`pants${side}`, hip, knee);
      this.placeBone(`pantsLow${side}`, knee, ankle);
      this.placeBone(`shoe${side}`, ankle, foot);
      this.placePoint(`kneeBall${side}`, knee);
    }
  }

  dispose(): void {
    this.disposeContents();
  }

  // -------------------------------------------------------------------------
  // 構築
  // -------------------------------------------------------------------------

  private build(a: CharacterAppearance): void {
    this.structureKey = structureKeyOf(a);
    const rig = this.rig;
    this.materials = this.createMaterials(a);

    const skin = this.materials.skin;
    const overlap = 1.18; // 継ぎ目を隠すためのわずかな重なり

    // --- 胴 -----------------------------------------------------------------
    const rHip = rig.torsoRadius;
    const rWaist = rig.torsoRadius * 0.78;
    const rChest = rig.torsoRadius * 1.02;

    this.addPart(
      'pelvis',
      new THREE.Mesh(this.keep(torsoGeometry(rHip, rWaist, rig.hipToSpine * overlap, true, false)), skin),
      rig.torsoDepth,
    );
    this.addPart(
      'torso',
      new THREE.Mesh(
        this.keep(torsoGeometry(rWaist, rChest, rig.spineToChest * overlap, false, true)),
        skin,
      ),
      rig.torsoDepth,
    );

    // --- 首と頭 -------------------------------------------------------------
    const neckLength = rig.chestToNeck + rig.neckToHead * 0.4;
    this.addPart(
      'neck',
      new THREE.Mesh(this.keep(new THREE.CapsuleGeometry(rig.headRadius * 0.42, neckLength, 4, 12)), skin),
      1,
      neckLength / 2,
    );
    this.addPart('head', this.buildHead(a, rig), 1);

    // --- 腕 -----------------------------------------------------------------
    for (const side of ['L', 'R'] as const) {
      this.addPart(
        `upperArm${side}`,
        new THREE.Mesh(
          this.keep(new THREE.CapsuleGeometry(rig.armRadius, rig.upperArm * 0.92, 4, 14)),
          skin,
        ),
        1,
        rig.upperArm / 2,
      );
      this.addPart(
        `foreArm${side}`,
        new THREE.Mesh(
          this.keep(new THREE.CapsuleGeometry(rig.armRadius * 0.86, rig.foreArm * 0.92, 4, 14)),
          skin,
        ),
        1,
        rig.foreArm / 2,
      );
      this.addPart(
        `hand${side}`,
        new THREE.Mesh(this.keep(new THREE.SphereGeometry(rig.armRadius * 1.15, 14, 10)), skin),
        1,
      );
      this.addPart(
        `shoulderBall${side}`,
        new THREE.Mesh(this.keep(new THREE.SphereGeometry(rig.armRadius * 1.35, 14, 10)), skin),
        1,
      );
    }

    // --- 脚 -----------------------------------------------------------------
    for (const side of ['L', 'R'] as const) {
      this.addPart(
        `thigh${side}`,
        new THREE.Mesh(this.keep(new THREE.CapsuleGeometry(rig.legRadius, rig.thigh * 0.9, 4, 14)), skin),
        1,
        rig.thigh / 2,
      );
      this.addPart(
        `shin${side}`,
        new THREE.Mesh(
          this.keep(new THREE.CapsuleGeometry(rig.legRadius * 0.78, rig.shin * 0.9, 4, 14)),
          skin,
        ),
        1,
        rig.shin / 2,
      );
      this.addPart(
        `kneeBall${side}`,
        new THREE.Mesh(this.keep(new THREE.SphereGeometry(rig.legRadius * 0.92, 14, 10)), skin),
        1,
      );
      this.addPart(`shoe${side}`, this.buildShoe(rig), 1);
    }

    this.buildOutfit(a, rig);
    this.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        object.castShadow = true;
        object.receiveShadow = false;
      }
    });
  }

  private buildHead(a: CharacterAppearance, rig: CharacterRig): THREE.Group {
    const R = rig.headRadius;
    const group = new THREE.Group();
    const skin = this.materials.skin;

    // 頭蓋（わずかに縦長・前後に薄い人間の比率）
    const skullY = R * 0.55;
    const rx = R * 0.9;
    const ry = R * 1.06;
    const rz = R * 0.95;

    const skull = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R, 28, 20)), skin);
    skull.scale.set(0.9, 1.06, 0.95);
    skull.position.y = skullY;
    group.add(skull);

    /**
     * 頭蓋（楕円体）表面の Z 座標。
     * 顔のパーツをこの値に沿って置かないとメッシュの内部に埋まって見えなくなる。
     */
    const surfaceZ = (dx: number, dy: number): number => {
      const k = 1 - (dx / rx) ** 2 - (dy / ry) ** 2;
      return k > 0 ? rz * Math.sqrt(k) : 0;
    };

    // 顎
    const jaw = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R * 0.72, 20, 14)), skin);
    jaw.scale.set(0.92, 0.86, 0.98);
    jaw.position.set(0, R * 0.08, R * 0.06);
    group.add(jaw);

    // 耳
    for (const sign of [-1, 1]) {
      const ear = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R * 0.2, 10, 8)), skin);
      ear.scale.set(0.4, 1, 0.75);
      ear.position.set(sign * rx * 0.97, skullY - R * 0.02, -R * 0.02);
      group.add(ear);
    }

    // 目（白目 + 虹彩 + 瞳孔）— 表面からわずかに出っ張らせる
    const eyeDx = R * 0.36;
    const eyeDy = R * 0.04;
    for (const sign of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(sign * eyeDx, skullY + eyeDy, surfaceZ(eyeDx, eyeDy) * 0.93);

      const scleraRadius = R * 0.155;
      const scleraDepth = 0.5;
      const sclera = new THREE.Mesh(this.keep(new THREE.SphereGeometry(scleraRadius, 16, 12)), this.materials.sclera);
      sclera.scale.set(1, 0.62, scleraDepth);
      eye.add(sclera);

      // 虹彩と瞳孔は平面ディスク。球で作ると白目の内側に埋まって見えなくなるため、
      // 白目の表面（z = radius * depthScale）よりわずかに手前へ置く。
      const front = scleraRadius * scleraDepth;
      const iris = new THREE.Mesh(this.keep(new THREE.CircleGeometry(R * 0.072, 20)), this.materials.eye);
      iris.position.z = front + R * 0.004;
      eye.add(iris);

      const pupil = new THREE.Mesh(this.keep(new THREE.CircleGeometry(R * 0.032, 16)), this.materials.dark);
      pupil.position.z = front + R * 0.008;
      eye.add(pupil);

      // まぶたのライン（目もとを締めて顔として認識しやすくする）
      const lash = new THREE.Mesh(
        this.keep(new THREE.BoxGeometry(R * 0.42, R * 0.03, R * 0.04)),
        this.materials.dark,
      );
      lash.position.set(0, R * 0.1, R * 0.02);
      eye.add(lash);

      group.add(eye);
    }

    // 眉（生え際より下に来るように配置する）
    const browDy = R * 0.2;
    for (const sign of [-1, 1]) {
      const brow = new THREE.Mesh(this.keep(new THREE.BoxGeometry(R * 0.34, R * 0.06, R * 0.08)), this.materials.hair);
      brow.position.set(sign * eyeDx, skullY + browDy, surfaceZ(eyeDx, browDy) * 0.99);
      brow.rotation.z = sign * -0.14;
      group.add(brow);
    }

    // 鼻
    const noseDy = -R * 0.14;
    const nose = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R * 0.11, 12, 10)), skin);
    nose.scale.set(0.75, 1.3, 1.1);
    nose.position.set(0, skullY + noseDy, surfaceZ(0, noseDy) * 0.98);
    group.add(nose);

    // 口
    const mouthDy = -R * 0.38;
    const mouth = new THREE.Mesh(this.keep(new THREE.BoxGeometry(R * 0.28, R * 0.06, R * 0.05)), this.materials.skinDark);
    mouth.position.set(0, skullY + mouthDy, surfaceZ(0, mouthDy) * 0.99);
    group.add(mouth);

    group.add(this.buildHair(a, R));
    return group;
  }

  private buildHair(a: CharacterAppearance, R: number): THREE.Group {
    const hair = new THREE.Group();
    const material = this.materials.hair;

    // 頭頂部だけを覆うドーム。眉より下は開けて顔が見えるようにする。
    // （thetaLength を広げすぎると顔まで隠れてしまうので 0.44π で止める）
    const cap = new THREE.Mesh(
      this.keep(new THREE.SphereGeometry(R * 1.06, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.44)),
      material,
    );
    cap.position.set(0, R * 0.55, 0);
    cap.scale.set(0.94, 1.1, 0.98);
    hair.add(cap);

    // 後頭部。three.js の球は phi=π/2 が +Z なので、π〜2π が背面側になる。
    const back = new THREE.Mesh(
      this.keep(new THREE.SphereGeometry(R * 1.04, 24, 16, Math.PI, Math.PI, 0, Math.PI * 0.86)),
      material,
    );
    back.position.set(0, R * 0.55, 0);
    back.scale.set(0.94, 1.08, 0.98);
    hair.add(back);

    switch (a.hairStyle) {
      case 'short':
        break;
      case 'bob': {
        const bob = new THREE.Mesh(
          this.keep(new THREE.CylinderGeometry(R * 1.06, R * 1.12, R * 0.9, 24, 1, true)),
          material,
        );
        bob.position.set(0, R * 0.28, -R * 0.06);
        bob.scale.set(1, 1, 0.95);
        hair.add(bob);
        break;
      }
      case 'long': {
        const length = R * 3.4;
        const strand = new THREE.Mesh(
          this.keep(new THREE.CapsuleGeometry(R * 0.62, length * 0.7, 4, 16)),
          material,
        );
        strand.scale.set(1.5, 1, 0.6);
        strand.position.set(0, R * 0.5 - length * 0.45, -R * 0.5);
        hair.add(strand);
        break;
      }
      case 'ponytail': {
        const tie = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R * 0.24, 12, 10)), material);
        tie.position.set(0, R * 0.95, -R * 0.85);
        hair.add(tie);
        const tail = new THREE.Mesh(this.keep(new THREE.CapsuleGeometry(R * 0.3, R * 1.9, 4, 14)), material);
        tail.position.set(0, R * 0.05, -R * 1.05);
        tail.rotation.x = -0.35;
        hair.add(tail);
        break;
      }
      case 'bun': {
        const bun = new THREE.Mesh(this.keep(new THREE.SphereGeometry(R * 0.44, 16, 12)), material);
        bun.position.set(0, R * 1.28, -R * 0.62);
        hair.add(bun);
        break;
      }
    }
    return hair;
  }

  private buildShoe(rig: CharacterRig): THREE.Group {
    const group = new THREE.Group();
    const shoe = new THREE.Mesh(
      this.keep(new THREE.CapsuleGeometry(rig.legRadius * 0.82, rig.foot * 0.8, 4, 12)),
      this.materials.shoe,
    );
    shoe.position.y = rig.foot / 2;
    shoe.scale.set(0.95, 1, 1.25);
    group.add(shoe);
    return group;
  }

  private buildOutfit(a: CharacterAppearance, rig: CharacterRig): void {
    const top = this.materials.top;
    const bottom = this.materials.bottom;
    const rWaist = rig.torsoRadius * 0.78;
    const rChest = rig.torsoRadius * 1.02;
    const rHip = rig.torsoRadius;
    const pad = 0.04;

    const hasSleeves = a.outfit === 'hoodie' || a.outfit === 'jacket';
    const shortSleeves = a.outfit === 'tshirt';

    // 上衣の丈。襟が顎まで来ないよう、上端は鎖骨あたりで止める。
    // （height は spine→chest 軸の長さに対する倍率、offset はその軸に沿ったずらし量）
    const TOP_SHAPE: Record<typeof a.outfit, { height: number; offset: number }> = {
      tanktop: { height: 1.06, offset: -0.04 },
      tshirt: { height: 1.26, offset: -0.24 },
      hoodie: { height: 1.3, offset: -0.26 },
      jacket: { height: 1.3, offset: -0.26 },
      // ワンピースは腰まで一続きにしてスカートと繋げる
      dress: { height: 1.82, offset: -0.54 },
    };
    const shape = TOP_SHAPE[a.outfit];

    this.addPart(
      'top',
      new THREE.Mesh(
        this.keep(
          torsoGeometry(rWaist + pad, rChest + pad * 1.4, rig.spineToChest * shape.height, false, true, 0),
        ),
        top,
      ),
      rig.torsoDepth,
      rig.spineToChest * shape.offset,
    );

    // 腰まわり（ズボン/スカートの土台）
    if (a.outfit === 'dress' || a.outfit === 'jacket') {
      const skirt = new THREE.Mesh(
        this.keep(new THREE.CylinderGeometry(rHip + pad, rHip * 1.75, rig.thigh * 0.45, 26, 1, true)),
        a.outfit === 'dress' ? top : bottom,
      );
      skirt.position.y = -rig.thigh * 0.16;
      this.addPart('skirt', skirt, rig.torsoDepth * 1.05);
    } else {
      this.addPart(
        'hips-cloth',
        new THREE.Mesh(
          this.keep(torsoGeometry(rHip + pad * 1.5, rWaist + pad * 1.8, rig.hipToSpine * 1.15, true, false, 0)),
          bottom,
        ),
        rig.torsoDepth,
      );
    }

    // 袖
    for (const side of ['L', 'R'] as const) {
      if (hasSleeves || shortSleeves) {
        const length = shortSleeves ? rig.upperArm * 0.52 : rig.upperArm * 0.96;
        this.addPart(
          `sleeve${side}`,
          new THREE.Mesh(
            this.keep(new THREE.CapsuleGeometry(rig.armRadius * 1.28, length, 4, 14)),
            top,
          ),
          1,
          length / 2,
        );
      }
      if (hasSleeves) {
        this.addPart(
          `sleeveLow${side}`,
          new THREE.Mesh(
            this.keep(new THREE.CapsuleGeometry(rig.armRadius * 1.12, rig.foreArm * 0.9, 4, 14)),
            top,
          ),
          1,
          rig.foreArm / 2,
        );
      }
    }

    // 脚衣
    const legwear = a.outfit === 'dress' || a.outfit === 'jacket' ? 'none' : a.outfit === 'tanktop' ? 'short' : 'full';
    if (legwear !== 'none') {
      for (const side of ['L', 'R'] as const) {
        const length = legwear === 'short' ? rig.thigh * 0.55 : rig.thigh * 0.95;
        this.addPart(
          `pants${side}`,
          new THREE.Mesh(this.keep(new THREE.CapsuleGeometry(rig.legRadius * 1.2, length, 4, 14)), bottom),
          1,
          length / 2,
        );
        if (legwear === 'full') {
          this.addPart(
            `pantsLow${side}`,
            new THREE.Mesh(
              this.keep(new THREE.CapsuleGeometry(rig.legRadius * 1.0, rig.shin * 0.88, 4, 14)),
              bottom,
            ),
            1,
            rig.shin / 2,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // マテリアル
  // -------------------------------------------------------------------------

  private createMaterials(a: CharacterAppearance) {
    const make = (color: string, roughness: number, metalness = 0) => {
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });
      this.disposables.push(material);
      return material;
    };
    return {
      skin: make(a.skinTone, 1 - a.skinGloss * 0.55),
      skinDark: make(shadeHex(a.skinTone, -0.28), 0.85),
      hair: make(a.hairColor, 0.45),
      top: make(a.topColor, 0.86),
      bottom: make(a.bottomColor, 0.86),
      shoe: make(a.shoeColor, 0.62),
      eye: make(a.eyeColor, 0.32),
      sclera: make('#f6f4f2', 0.3),
      dark: make('#14100e', 0.4),
    };
  }

  private updateColors(a: CharacterAppearance): void {
    const m = this.materials;
    m.skin.color.set(a.skinTone);
    m.skin.roughness = 1 - a.skinGloss * 0.55;
    m.skinDark.color.set(shadeHex(a.skinTone, -0.28));
    m.hair.color.set(a.hairColor);
    m.top.color.set(a.topColor);
    m.bottom.color.set(a.bottomColor);
    m.shoe.color.set(a.shoeColor);
    m.eye.color.set(a.eyeColor);
  }

  // -------------------------------------------------------------------------
  // 配置ヘルパ
  // -------------------------------------------------------------------------

  /**
   * @param depthScale 前後方向の潰し（人体の断面は楕円のため）
   * @param offsetY    パーツをボーン方向に沿ってずらす量
   */
  private addPart(name: string, object: THREE.Object3D, depthScale = 1, offsetY = 0): void {
    const group = new THREE.Group();
    object.position.y += offsetY;
    if (depthScale !== 1) object.scale.z *= depthScale;
    group.add(object);
    this.parts.set(name, group);
    this.root.add(group);
  }

  private keep<T extends THREE.BufferGeometry>(geometry: T): T {
    this.disposables.push(geometry);
    return geometry;
  }

  /** a を原点として +Y が b を向くように配置する。 */
  private placeBone(name: string, a: Vec3, b: Vec3): void {
    const group = this.parts.get(name);
    if (!group) return;
    group.position.set(a.x, a.y, a.z);
    vecFromTo(a, b, tmpA);
    if (tmpA.lengthSq() < 1e-10) return;
    group.quaternion.setFromUnitVectors(UP, tmpA.normalize());
  }

  /**
   * +Y を a→b に向けたうえで、+X が sideHint 側を向くようにひねりを決める。
   * 胴・頭のように「どちらを向いているか」が重要なパーツに使う。
   */
  private placeAxis(name: string, a: Vec3, b: Vec3, sideHint: THREE.Vector3, _length: number): void {
    const group = this.parts.get(name);
    if (!group) return;
    group.position.set(a.x, a.y, a.z);

    vecFromTo(a, b, tmpA);
    if (tmpA.lengthSq() < 1e-10) return;
    const up = tmpA.normalize();

    // sideHint を up に直交化して基底を作る
    tmpB.copy(sideHint).addScaledVector(up, -sideHint.dot(up));
    if (tmpB.lengthSq() < 1e-8) {
      group.quaternion.setFromUnitVectors(UP, up);
      return;
    }
    const side = tmpB.normalize();
    tmpForward.copy(side).cross(up).normalize();
    tmpMatrix.makeBasis(side, up, tmpForward);
    group.quaternion.setFromRotationMatrix(tmpMatrix);
  }

  private placePoint(name: string, a: Vec3): void {
    const group = this.parts.get(name);
    if (!group) return;
    group.position.set(a.x, a.y, a.z);
  }

  private disposeContents(): void {
    for (const resource of this.disposables) resource.dispose();
    this.disposables.length = 0;
    this.root.clear();
    this.parts.clear();
  }
}

// ---------------------------------------------------------------------------
// ジオメトリ生成
// ---------------------------------------------------------------------------

/**
 * 下端半径 rBottom、上端半径 rTop の、なめらかに膨らむ胴パーツ。
 * 端は必要に応じて丸く閉じる（隣接パーツと重ねて継ぎ目を隠す）。
 */
function torsoGeometry(
  rBottom: number,
  rTop: number,
  height: number,
  closeBottom: boolean,
  closeTop: boolean,
  /** 中央のくびれ量。衣装は 0 にして、体側より確実に外側を通るようにする。 */
  pinch = 0.1,
): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [];
  const steps = 14;

  if (closeBottom) {
    // 半球状のキャップ
    for (let i = 4; i >= 1; i--) {
      const t = i / 4;
      const angle = (Math.PI / 2) * t;
      points.push(new THREE.Vector2(rBottom * Math.cos(angle), -rBottom * 0.55 * Math.sin(angle)));
    }
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // 中央がわずかにくびれる曲線
    const waist = 1 - pinch * Math.sin(Math.PI * t);
    const r = (rBottom + (rTop - rBottom) * smoothstep(t)) * waist;
    points.push(new THREE.Vector2(Math.max(0.004, r), t * height));
  }
  if (closeTop) {
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const angle = (Math.PI / 2) * t;
      points.push(new THREE.Vector2(rTop * Math.cos(angle), height + rTop * 0.5 * Math.sin(angle)));
    }
  }
  return new THREE.LatheGeometry(points, 26);
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function vecFromTo(a: Vec3, b: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(b.x - a.x, b.y - a.y, b.z - a.z);
}

function structureKeyOf(a: CharacterAppearance): string {
  return [
    a.headScale,
    a.legLength,
    a.shoulderWidth,
    a.limbThickness,
    a.build,
    a.hairStyle,
    a.outfit,
  ].join('|');
}

/** three.Color を経由しない軽量な明度調整（マテリアル生成時にのみ使う）。 */
function shadeHex(hex: string, amount: number): string {
  const color = new THREE.Color(hex);
  if (amount >= 0) color.lerp(new THREE.Color('#ffffff'), amount);
  else color.lerp(new THREE.Color('#000000'), -amount);
  return `#${color.getHexString()}`;
}
