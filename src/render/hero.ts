// The animated hero: a skinned model that plays real motion clips. Each player has
// their own copy, sharing one set of geometry and clips. The block character from
// character.ts stays in place until this has loaded, or if it can't load.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { Bend, LimbPose, Side } from './body-pose';
import { PALETTES } from './character';
import type { Act } from '../sim/hits';

const HERO_URL = '/models/hero/hero.glb';
const HERO_HEIGHT = 1.85;
/** Pivots at the chest, so the body hangs from a web instead of swinging from its feet. */
const CHEST_HEIGHT = 1.2;
const CROSS_FADE = 0.07;
/** Clips that play through once and hold their last pose. */
const ONCE_CLIPS = new Set([
  'ClimbLedge',
  'Jump_Land',
  'Hit_Stomach',
  'Punch_Jab',
  'Punch_Cross',
  'Kick',
  'Spell_Simple_Shoot',
  'BackFlip',
  'Dodge_Left',
  'Dodge_Right',
  'Roll',
]);

export interface HeroAsset {
  scene: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  map: THREE.Texture | null;
  scale: number;
}

export async function loadHero(): Promise<HeroAsset> {
  const gltf = await new GLTFLoader().loadAsync(HERO_URL);
  let map: THREE.Texture | null = null;
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) map = (o.material as THREE.MeshStandardMaterial).map;
  });
  const height = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).y;
  return {
    scene: gltf.scene,
    clips: new Map(gltf.animations.map((clip) => [clip.name, clip])),
    map,
    scale: height > 0 ? HERO_HEIGHT / height : 1,
  };
}

const materials = new Map<number, THREE.Material>();

function materialFor(asset: HeroAsset, palette: number): THREE.Material {
  let material = materials.get(palette);
  if (!material) {
    material = new THREE.MeshLambertMaterial({ map: asset.map, color: PALETTES[palette].suit });
    materials.set(palette, material);
  }
  return material;
}

export class HeroBody {
  /** Tip this to lean the whole body. */
  readonly root = new THREE.Group();
  private readonly mesh: THREE.SkinnedMesh;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentKey: string | null = null;

  private readonly arms: { right: HeroArm; left: HeroArm };
  private readonly joints: Record<LimbName, LimbJoints>;
  private limbWeight = 0;

  private readonly parentTurn = new THREE.Quaternion();
  private readonly boneTurn = new THREE.Quaternion();
  private readonly frame = new THREE.Quaternion();
  private readonly aim = new THREE.Quaternion();
  private readonly localDirection = new THREE.Vector3();
  private readonly want = new THREE.Vector3();
  private readonly now = new THREE.Vector3();
  private readonly gripShoulder = new THREE.Vector3();
  private readonly gripElbow = new THREE.Vector3();
  private readonly gripWrist = new THREE.Vector3();
  private readonly gripTo = new THREE.Vector3();
  private readonly gripPole = new THREE.Vector3();
  private readonly gripBack = new THREE.Vector3();
  private readonly gripElbowAt = new THREE.Vector3();
  private readonly gripHandAt = new THREE.Vector3();
  private readonly gripDir = new THREE.Vector3();
  private readonly gripIdentity = new THREE.Quaternion();

  constructor(private readonly asset: HeroAsset) {
    const model = clone(asset.scene);
    model.scale.setScalar(asset.scale);
    // The model faces +z, and the game's forward is -z.
    model.rotation.y = Math.PI;
    model.position.y = -CHEST_HEIGHT;
    this.root.position.y = CHEST_HEIGHT;
    this.root.add(model);

    let found: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) found = o;
    });
    if (!found) throw new Error('The hero has no skinned mesh');
    this.mesh = found;
    // Animated limbs reach outside the model's resting bounds.
    this.mesh.frustumCulled = false;

    const bone = (name: string) => {
      const node = model.getObjectByName(name);
      if (!node) throw new Error(`The hero has no bone called ${name}`);
      return node;
    };
    const heroArm = (tag: string): HeroArm => {
      const lower = bone(`lowerarm_${tag}`);
      return {
        upper: bone(`upperarm_${tag}`),
        lower,
        // Webs leave the grip, not the wrist.
        hand: bone(`middle_01_${tag}`),
        axis: lower.position.clone().normalize(),
        wrist: bone(`hand_${tag}`),
        lowerAxis: bone(`hand_${tag}`).position.clone().normalize(),
        straightElbow: lower.quaternion.clone(),
        reach: 0,
        grip: 0,
        direction: new THREE.Vector3(0, 1, 0),
      };
    };
    this.arms = { right: heroArm('r'), left: heroArm('l') };

    const limb = (upperName: string, lowerName: string, endName: string): LimbJoints => {
      const upper = bone(upperName);
      const lower = bone(lowerName);
      return {
        upper,
        lower,
        upperAxis: lower.position.clone().normalize(),
        lowerAxis: bone(endName).position.clone().normalize(),
        upperDirection: new THREE.Vector3(0, -1, 0),
        lowerDirection: new THREE.Vector3(0, -1, 0),
        held: false,
      };
    };
    this.joints = {
      legRight: limb('thigh_r', 'calf_r', 'foot_r'),
      legLeft: limb('thigh_l', 'calf_l', 'foot_l'),
      armRight: limb('upperarm_r', 'lowerarm_r', 'hand_r'),
      armLeft: limb('upperarm_l', 'lowerarm_l', 'hand_l'),
    };

    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of asset.clips) {
      const action = this.mixer.clipAction(clip);
      if (ONCE_CLIPS.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
  }

  setPalette(palette: number): void {
    this.mesh.material = materialFor(this.asset, palette);
  }

  play(clip: string, timeScale: number, duration?: number, key = clip): void {
    const next = this.actions.get(clip);
    if (!next) return;
    next.setEffectiveTimeScale(duration ? next.getClip().duration / duration : timeScale);
    if (next === this.current && key === this.currentKey) return;

    next.reset().play();
    if (this.current && next !== this.current) next.crossFadeFrom(this.current, CROSS_FADE, false);
    this.current = next;
    this.currentKey = key;
  }

  /** A frozen hero stops mid-pose, which is what sells the ice. */
  update(dt: number, frozen: boolean): void {
    this.mixer.update(frozen ? 0 : dt);
  }

  /** Where a web leaves this hand. */
  handOf(side: Side): THREE.Object3D {
    return (side === 1 ? this.arms.right : this.arms.left).hand;
  }

  /**
   * Holds a whole-body shape over the clip, easing in and out of it. Null lets the clip
   * show again. Call this before reachFor, so a web arm wins over the shape.
   */
  holdLimbs(pose: LimbPose | null, dt: number): void {
    const ease = 1 - Math.exp(-16 * dt);
    this.limbWeight += ((pose ? 1 : 0) - this.limbWeight) * (1 - Math.exp(-12 * dt));
    if (this.limbWeight < 0.01) return;

    this.root.updateWorldMatrix(true, true);
    const frame = this.root.getWorldQuaternion(this.frame);

    for (const name of LIMB_NAMES) {
      const joints = this.joints[name];
      const bent: Bend | null = pose ? pose[name] : null;
      if (bent) {
        joints.upperDirection.lerp(this.now.copy(bent.upper), joints.held ? ease : 1).normalize();
        joints.lowerDirection.lerp(this.now.copy(bent.lower), joints.held ? ease : 1).normalize();
      }
      // An arm with nothing to hold fades back to its clip along with everything else.
      joints.held = bent !== null || (pose === null && joints.held);
      if (!joints.held) continue;
      this.turnBone(joints.upper, joints.upperAxis, joints.upperDirection, frame);
      this.turnBone(joints.lower, joints.lowerAxis, joints.lowerDirection, frame);
    }
  }

  /** Swings a bone the shortest way to a direction, so it keeps the clip's twist. */
  private turnBone(bone: THREE.Object3D, axis: THREE.Vector3, direction: THREE.Vector3, frame: THREE.Quaternion): void {
    bone.parent!.getWorldQuaternion(this.parentTurn);
    bone.getWorldQuaternion(this.boneTurn);
    this.now.copy(axis).applyQuaternion(this.boneTurn);
    this.want.copy(direction).applyQuaternion(frame);
    this.aim.setFromUnitVectors(this.now, this.want).multiply(this.boneTurn);
    this.aim.premultiply(this.parentTurn.invert());
    bone.quaternion.slerp(this.aim, this.limbWeight);
    bone.updateWorldMatrix(false, true);
  }

  /**
   * Holds an arm out along a web. Clips can't know where the web is, so this bends the
   * arm after the clip has posed the body. Null lets the arm go.
   */
  /**
   * Puts a hand on a point in the world, bending the elbow out to the side to fit the
   * distance, as a hand closes on a rope. Null lets the arm go. Call after reachFor.
   */
  gripAt(side: Side, point: THREE.Vector3 | null, dt: number): void {
    const arm = side === 1 ? this.arms.right : this.arms.left;
    arm.grip += ((point ? 1 : 0) - arm.grip) * (1 - Math.exp(-(point ? 18 : 12) * dt));
    if (arm.grip < 0.01 || !point) return;

    this.root.updateWorldMatrix(true, true);
    const shoulder = arm.upper.getWorldPosition(this.gripShoulder);
    const elbow = arm.lower.getWorldPosition(this.gripElbow);
    const wrist = arm.wrist.getWorldPosition(this.gripWrist);
    const a = shoulder.distanceTo(elbow);
    const b = elbow.distanceTo(wrist);

    const toTarget = this.gripTo.copy(point).sub(shoulder);
    const d = Math.min(a + b - 0.001, Math.max(Math.abs(a - b) + 0.001, toTarget.length()));
    toTarget.normalize();
    // Elbows bend straight out to the side, so the forearms never cross the head.
    const right = this.gripPole.set(1, 0, 0).applyQuaternion(this.root.getWorldQuaternion(this.frame));
    const pole = right.multiplyScalar(side).addScaledVector(this.gripBack.set(0, 0, 1).applyQuaternion(this.frame), -0.15);
    pole.addScaledVector(toTarget, -pole.dot(toTarget)).normalize();
    const cos = (a * a + d * d - b * b) / (2 * a * d);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const elbowAt = this.gripElbowAt.copy(shoulder).addScaledVector(toTarget, a * cos).addScaledVector(pole, a * sin);
    const handAt = this.gripHandAt.copy(shoulder).addScaledVector(toTarget, d);

    const identity = this.gripIdentity;
    this.turnBoneTo(arm.upper, arm.axis, this.gripDir.copy(elbowAt).sub(shoulder).normalize(), identity, arm.grip);
    this.turnBoneTo(arm.lower, arm.lowerAxis, this.gripDir.copy(handAt).sub(elbowAt).normalize(), identity, arm.grip);
  }

  /** Swings a bone the shortest way to a world direction, by `weight`. */
  private turnBoneTo(bone: THREE.Object3D, axis: THREE.Vector3, direction: THREE.Vector3, frame: THREE.Quaternion, weight: number): void {
    bone.parent!.getWorldQuaternion(this.parentTurn);
    bone.getWorldQuaternion(this.boneTurn);
    this.now.copy(axis).applyQuaternion(this.boneTurn);
    this.want.copy(direction).applyQuaternion(frame);
    this.aim.setFromUnitVectors(this.now, this.want).multiply(this.boneTurn);
    this.aim.premultiply(this.parentTurn.invert());
    bone.quaternion.slerp(this.aim, weight);
    bone.updateWorldMatrix(false, true);
  }

  reachFor(side: Side, direction: THREE.Vector3 | null, dt: number): void {
    const arm = side === 1 ? this.arms.right : this.arms.left;
    if (direction) arm.direction.copy(direction);
    arm.reach += ((direction ? 1 : 0) - arm.reach) * (1 - Math.exp(-(direction ? 20 : 12) * dt));
    if (arm.reach < 0.01) return;

    this.root.updateWorldMatrix(true, true);
    arm.upper.parent!.getWorldQuaternion(this.parentTurn);
    this.localDirection.copy(arm.direction).applyQuaternion(this.parentTurn.invert());
    this.aim.setFromUnitVectors(arm.axis, this.localDirection);
    arm.upper.quaternion.slerp(this.aim, arm.reach);
    arm.lower.quaternion.slerp(arm.straightElbow, arm.reach);
    arm.upper.updateWorldMatrix(false, true);
  }
}

interface HeroArm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  axis: THREE.Vector3;
  wrist: THREE.Object3D;
  /** Which way the forearm runs, from elbow to wrist, in its own frame. */
  lowerAxis: THREE.Vector3;
  straightElbow: THREE.Quaternion;
  reach: number;
  /** How much a grip on a point holds the arm, eased in and out. */
  grip: number;
  direction: THREE.Vector3;
}

type LimbName = 'legRight' | 'legLeft' | 'armRight' | 'armLeft';
const LIMB_NAMES: LimbName[] = ['legRight', 'legLeft', 'armRight', 'armLeft'];

interface LimbJoints {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  upperAxis: THREE.Vector3;
  lowerAxis: THREE.Vector3;
  /** Eased, so that a change of shape flows instead of snapping. */
  upperDirection: THREE.Vector3;
  lowerDirection: THREE.Vector3;
  held: boolean;
}

/** A direction for each arm segment, in the camera's own frame: x right, y up, z back. */
export interface ArmPose {
  rightUpper: THREE.Vector3;
  rightLower: THREE.Vector3;
  leftUpper: THREE.Vector3;
  leftLower: THREE.Vector3;
  /** How closed each hand is, from 0 open to 1 a fist. */
  gripRight: number;
  gripLeft: number;
}

const arm = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

const ARM_BONE = /^(upperarm|lowerarm|hand|index|middle|pinky|ring|thumb)_/;

/**
 * The triangles that belong to the arms and hands, leaving out the rest of the body.
 * A triangle stays when each of its corners mostly follows an arm bone.
 */
export function armTriangles(geometry: THREE.BufferGeometry, boneNames: string[]): number[] {
  const index = geometry.index!;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');

  const followsArm = (vertex: number) => {
    let strongest = 0;
    let bone = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.getComponent(vertex, slot);
      if (weight > strongest) {
        strongest = weight;
        bone = skinIndex.getComponent(vertex, slot);
      }
    }
    return ARM_BONE.test(boneNames[bone] ?? '');
  };

  const kept: number[] = [];
  for (let i = 0; i + 2 < index.count; i += 3) {
    const corners = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (corners.every(followsArm)) kept.push(...corners);
  }
  return kept;
}

/** Bends a bone so that `axis` points along a world direction. */
function pointBone(bone: THREE.Object3D, axis: THREE.Vector3, direction: THREE.Vector3): void {
  const parentTurn = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.setFromUnitVectors(axis, direction.clone().applyQuaternion(parentTurn));
  bone.updateWorldMatrix(false, true);
}

/**
 * The player's own arms in first person: the same model and suit as everyone sees, cut
 * down to just the arms so the body can't block the view. Arms are posed directly,
 * because in first person they have to show the aim and the web rather than play a clip.
 */
export class FirstPersonArms {
  readonly root = new THREE.Group();

  private readonly hands: { right: THREE.Object3D; left: THREE.Object3D };
  private readonly fingers: { right: FingerJoint[]; left: FingerJoint[] };
  private readonly grip = { right: -1, left: -1 };
  private readonly mesh: THREE.SkinnedMesh;
  private readonly pose: ArmPose = {
    rightUpper: arm(0.14, -0.02, -1),
    rightLower: arm(-0.04, 0.45, -0.89),
    leftUpper: arm(-0.14, -0.02, -1),
    leftLower: arm(0.04, 0.45, -0.89),
    gripRight: 0,
    gripLeft: 0,
  };
  private readonly upperRight: THREE.Object3D;
  private readonly lowerRight: THREE.Object3D;
  private readonly upperLeft: THREE.Object3D;
  private readonly lowerLeft: THREE.Object3D;
  private readonly axes: THREE.Vector3[];

  constructor(private readonly asset: HeroAsset) {
    const model = clone(asset.scene);
    model.scale.setScalar(asset.scale);
    model.rotation.y = Math.PI;
    this.root.add(model);
    model.updateWorldMatrix(true, true);

    const bone = (name: string) => {
      const node = model.getObjectByName(name);
      if (!node) throw new Error(`The hero has no bone called ${name}`);
      return node;
    };

    let found: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) found = o;
    });
    if (!found) throw new Error('The hero has no skinned mesh');
    this.mesh = found;
    this.mesh.frustumCulled = false;

    const armsOnly = this.mesh.geometry.clone();
    armsOnly.setIndex(armTriangles(armsOnly, this.mesh.skeleton.bones.map((b) => b.name)));
    this.mesh.geometry = armsOnly;

    this.upperRight = bone('upperarm_r');
    this.lowerRight = bone('lowerarm_r');
    this.upperLeft = bone('upperarm_l');
    this.lowerLeft = bone('lowerarm_l');
    this.hands = { right: bone('middle_01_r'), left: bone('middle_01_l') };
    this.fingers = { right: fingerJoints(bone, 'r'), left: fingerJoints(bone, 'l') };
    this.axes = [
      this.lowerRight.position.clone().normalize(),
      bone('hand_r').position.clone().normalize(),
      this.lowerLeft.position.clone().normalize(),
      bone('hand_l').position.clone().normalize(),
    ];

    // Shoulders below the eye and just behind it, so the arms reach in from the bottom
    // corners and the hands sit close and large.
    const shoulder = this.upperRight.getWorldPosition(new THREE.Vector3());
    model.position.set(0, -shoulder.y - 0.3, 0.01);
  }

  setPalette(palette: number): void {
    this.mesh.material = materialFor(this.asset, palette);
  }

  handOf(side: Side): THREE.Object3D {
    return side === 1 ? this.hands.right : this.hands.left;
  }

  /** Eases the arms toward a pose. */
  update(want: ArmPose, ease: number): void {
    const pose = this.pose;
    pose.rightUpper.lerp(want.rightUpper, ease).normalize();
    pose.rightLower.lerp(want.rightLower, ease).normalize();
    pose.leftUpper.lerp(want.leftUpper, ease).normalize();
    pose.leftLower.lerp(want.leftLower, ease).normalize();

    this.root.updateWorldMatrix(true, true);
    pointBone(this.upperRight, this.axes[0], pose.rightUpper);
    pointBone(this.lowerRight, this.axes[1], pose.rightLower);
    pointBone(this.upperLeft, this.axes[2], pose.leftUpper);
    pointBone(this.lowerLeft, this.axes[3], pose.leftLower);

    this.closeHand('right', want.gripRight, ease);
    this.closeHand('left', want.gripLeft, ease);
  }

  private closeHand(side: 'right' | 'left', want: number, ease: number): void {
    const grip = this.grip[side] < 0 ? want : this.grip[side] + (want - this.grip[side]) * ease;
    if (Math.abs(grip - this.grip[side]) < 0.002) return;
    this.grip[side] = grip;
    for (const joint of this.fingers[side]) {
      joint.bone.quaternion.copy(joint.rest).multiply(curl.setFromAxisAngle(joint.axis, joint.bend * grip));
    }
  }
}

interface FingerJoint {
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  /** The knuckle's hinge, in the bone's own frame. */
  axis: THREE.Vector3;
  bend: number;
}

const curl = new THREE.Quaternion();
const KNUCKLE_BEND = [1.0, 1.35, 0.9];

/** Every finger hinges across the palm, so one axis from the knuckles serves them all. */
function fingerJoints(bone: (name: string) => THREE.Object3D, tag: string): FingerJoint[] {
  const at = (name: string) => bone(name).getWorldPosition(new THREE.Vector3());
  const hinge = at(`index_01_${tag}`).sub(at(`pinky_01_${tag}`)).normalize();
  if (tag === 'l') hinge.negate();

  const joints: FingerJoint[] = [];
  for (const finger of ['index', 'middle', 'ring', 'pinky']) {
    KNUCKLE_BEND.forEach((bend, i) => {
      const node = bone(`${finger}_0${i + 1}_${tag}`);
      const turn = node.getWorldQuaternion(new THREE.Quaternion()).invert();
      joints.push({
        bone: node,
        rest: node.quaternion.clone(),
        axis: hinge.clone().applyQuaternion(turn).normalize(),
        bend,
      });
    });
  }
  return joints;
}

export interface ArmMoment {
  mode: string;
  /** The web's direction in camera space, when there is one. */
  web: THREE.Vector3 | null;
  webSide: Side;
  twoHands: boolean;
  stride: number;
  /** A shot's kick, from 1 fading to 0, and the hand it left. */
  kick: number;
  kickSide: Side;
  action?: Act | null;
  /** Progress through the current short action, from 0 to 1. */
  actionProgress?: number;
}

const RELAXED_GRIP = 0.28;

function pair(upper: THREE.Vector3, lower: THREE.Vector3, side: Side) {
  return side === 1 ? { upper, lower } : { upper: flip(upper), lower: flip(lower) };
}
const flip = (v: THREE.Vector3) => new THREE.Vector3(-v.x, v.y, v.z);

/** The arm that holds a web: nearly straight, with the elbow dropped so it doesn't look stiff. */
function webArm(web: THREE.Vector3, side: Side) {
  return { upper: web.clone().add(new THREE.Vector3(side * 0.16, -0.24, 0)).normalize(), lower: web.clone() };
}

/** The first-person rig, in camera space: the right shoulder, and the two arm lengths to the knuckles. */
const FP_SHOULDER = new THREE.Vector3(0.216, -0.3, 0.076);
const FP_UPPER = 0.255;
const FP_LOWER = 0.366;
/** How far up the web, from between the shoulders, the hands close on it. */
const FP_GRIP_REACH = 0.5;
/** The lower fist sits this far below the upper one on the line. */
const FP_GRIP_SPACING = 0.1;

/** Bends an arm so its hand lands on a point, elbow out and down. */
export function reachArm(target: THREE.Vector3, side: Side) {
  const shoulder = FP_SHOULDER.clone().setX(FP_SHOULDER.x * side);
  const toward = target.clone().sub(shoulder);
  const most = FP_UPPER + FP_LOWER - 0.01;
  const least = Math.abs(FP_UPPER - FP_LOWER) + 0.01;
  const d = THREE.MathUtils.clamp(toward.length(), least, most);
  const u = toward.normalize();
  const cos = THREE.MathUtils.clamp((FP_UPPER * FP_UPPER + d * d - FP_LOWER * FP_LOWER) / (2 * FP_UPPER * d), -1, 1);
  const pole = new THREE.Vector3(side, -1, 0.3);
  pole.sub(u.clone().multiplyScalar(u.dot(pole))).normalize();
  const elbow = shoulder
    .clone()
    .addScaledVector(u, FP_UPPER * cos)
    .addScaledVector(pole, FP_UPPER * Math.sqrt(1 - cos * cos));
  const hand = shoulder.clone().addScaledVector(u, d);
  return { upper: elbow.clone().sub(shoulder).normalize(), lower: hand.sub(elbow).normalize() };
}

/**
 * Both hands on one web: the fists close on the line one above the other, the web's
 * own hand on top, as on a rope.
 */
function twoHandWebArm(web: THREE.Vector3, side: Side, top: Side) {
  // Up the line, but kept out in front where it can be seen, even when the anchor is
  // overhead or off to the side.
  const along = web.clone();
  along.z = Math.min(along.z, -0.6);
  along.normalize();
  const grip = new THREE.Vector3(0, FP_SHOULDER.y, FP_SHOULDER.z).addScaledVector(along, FP_GRIP_REACH);
  if (side !== top) grip.addScaledVector(along, -FP_GRIP_SPACING);
  return reachArm(grip, side);
}

/** A punch: a short wind back, a fast straight strike to the middle of the view, then home. */
function punchCurve(t: number): number {
  if (t < 0.2) return -(t / 0.2) * 0.35;
  if (t < 0.45) return -0.35 + ((t - 0.2) / 0.25) * 1.35;
  return Math.max(0, 1 - (t - 0.45) / 0.55);
}

/** The arm pose for what the player is doing. Written for the right arm, then mirrored. */
export function armPoseFor(m: ArmMoment): ArmPose {
  const swing = Math.sin(m.stride) * 0.22;
  const punchSide: Side | null = m.action === 'jab' ? -1 : m.action === 'cross' || m.action === 'finisher' ? 1 : null;
  const punch = punchSide === null ? 0 : punchCurve(Math.max(0, Math.min(1, m.actionProgress ?? 0)));

  const restFor = (side: Side) => {
    if (side === punchSide && punch !== 0) {
      // Out to the centre of the view, forearm level: the fist lands right under the crosshair.
      const p = Math.max(0, punch);
      const back = Math.max(0, -punch);
      return pair(
        arm(0.14 - p * 0.13 + back * 0.08, 0.02 + p * 0.1 - back * 0.1, -1 + back * 0.4),
        arm(-0.04 - p * 0.1, 0.45 - p * 0.42 + back * 0.2, -1),
        side,
      );
    }
    const kick = m.kickSide === side ? m.kick : 0;
    if (kick > 0 && m.mode !== 'swing') {
      // A web shot: the arm snaps out toward the crosshair and the hand opens.
      return pair(arm(0.14 - kick * 0.12, -0.02 + kick * 0.14, -1), arm(-0.04 - kick * 0.1, 0.45 - kick * 0.38, -1), side);
    }
    if (m.mode === 'dash') return pair(arm(0.22, -0.12, -1), arm(0.02, 0.3, -0.95), side);
    if (m.mode === 'air' || m.mode === 'swing') {
      return pair(arm(0.3 - kick * 0.2, 0.06 + kick * 0.1, -0.95), arm(0.06 - kick * 0.14, 0.55 - kick * 0.15, -0.83), side);
    }
    // Shooting throws the hand out toward the crosshair.
    return pair(
      arm(0.14 - kick * 0.1, -0.02 + side * swing * 0.4 + kick * 0.1, -1),
      arm(-0.04 - kick * 0.14, 0.45 - kick * 0.1, -0.89),
      side,
    );
  };

  if (m.mode === 'wall' && !m.web) {
    // Hand over hand, palms open against the wall.
    const s = Math.sin(m.stride);
    const reach = (k: number, side: Side) =>
      pair(arm(0.2, 0.3 + k * 0.4, -1), arm(0.02, 0.8 + k * 0.5, -0.7), side);
    const right = reach(s, 1);
    const left = reach(-s, -1);
    return {
      rightUpper: right.upper,
      rightLower: right.lower,
      leftUpper: left.upper,
      leftLower: left.lower,
      gripRight: 0.15,
      gripLeft: 0.15,
    };
  }

  const holding = (side: Side) => m.web !== null && (m.twoHands || m.webSide === side);
  const onWeb = (side: Side) => (m.twoHands ? twoHandWebArm(m.web!, side, m.webSide) : webArm(m.web!, side));
  const right = holding(1) ? onWeb(1) : restFor(1);
  const left = holding(-1) ? onWeb(-1) : restFor(-1);
  const gripOf = (side: Side) => {
    if (holding(side)) return 1;
    if (side === punchSide) return 1;
    if (m.kickSide === side && m.kick > 0) return 0.1;
    return m.mode === 'dash' ? 0.8 : RELAXED_GRIP;
  };

  return {
    rightUpper: right.upper,
    rightLower: right.lower,
    leftUpper: left.upper,
    leftLower: left.lower,
    gripRight: gripOf(1),
    gripLeft: gripOf(-1),
  };
}
