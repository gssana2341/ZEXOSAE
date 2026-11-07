// Everything drawn in 3D. It reads the simulation but never changes it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildArena, FOG_COLOR, SUN_DIRECTION } from './arena';
import {
  bodyPose,
  clipFor,
  LAND_TIME,
  LEDGE_TIME,
  type ClipMode,
  RELEASE_TIME,
  hangLimbs,
  diveAmount,
  diveLimbs,
  diveTilt,
  releaseLimbs,
  releaseTurn,
  swingLimbs,
  swingAnchor,
  trackSwing,
  usesBothHands,
  type BodyPose,
  type LimbPose,
  type Side,
} from './body-pose';
import { createCameraMotion, landCamera, speedFovBoost, stepCameraMotion, stepFovBoost } from './camera-motion';
import { createChaseCamera, resetChaseCamera, stepChaseCamera } from './chase-camera';
import type { FirstPersonArms, HeroBody } from './hero';
import { buildCharacter, paintCharacter, paletteFor, PALETTES, type CharacterView } from './character';
import { WebLine, WebPuffs } from './web-line';
import { Streets } from './streets';
import { Lighting } from './lighting';
import { pixelRatioFor, QUALITY, yieldToBrowser } from './performance';
import { preloadScenes } from './preload';
import { shotVisualTip } from './shot-visual';
import { ARENA_LIMIT, JUMP_PAD_RADIUS, raycast, RING_RADIUS, type GameMap, type V3 } from '../sim/map';
import type { HitKind } from '../sim/hits';
import { CONTROL_POINT, type Team } from '../sim/game-modes';
import { ACT_TIME } from '../sim/moves';
import { climbWallNormal, eyePosition, poseOf, totalSpeed, TUNING, webLineOf, type Dummy, type Player } from '../sim/player';
import type { Shot, World } from '../sim/world';
import type { Settings } from '../settings';

const UP = new THREE.Vector3(0, 1, 0);
const MAX_SHOTS = 12;
/** Web strands behind shots that can show at once, flying or fading. */
const MAX_STRANDS = 8;
/**
 * The closest the world camera draws. Depth precision runs out far away, and
 * the nearer this is, the sooner: at 0.15 m, distant roofs flickered. The arms
 * have their own camera, so nothing the player needs is this close.
 */
const NEAR_PLANE = 0.3;
const MAX_FLYING_CRATES = 4;
/** A dive turns feet first when the ground is less than this many seconds away. */
const LAND_LOOKAHEAD = 0.5;
const DOWN = new THREE.Vector3(0, -1, 0);
/** Two hands on a swinging web: measured up the web from just over the shoulders. */
const SWING_GRIP_HEIGHT = 1.45;
const SWING_GRIP_HIGH = 0.72;
const SWING_GRIP_LOW = 0.5;
/** The view starts to tremble past this falling speed, and reaches full strength this much faster. */
const SHAKE_FROM = 14;
const SHAKE_RANGE = 26;
/** The most the camera moves when shaking, in metres. */
const SHAKE_SIZE = 0.07;
/** Where the hands hold a line, in metres above the feet: one above the head, one higher. */
const GRIP_LOW = 1.98;
const GRIP_HIGH = 2.18;
/** How far in front of the face the line passes. */
const GRIP_AHEAD = 0.14;
const CRATE_SIZE = 0.8;
/** How long a ground pound's shockwave takes to spread and fade. */
const POUND_TIME = 0.45;
const MAX_OTHER_PLAYERS = 15;
const SHOT_LENGTH = 7;

/** A bigger jump than this in one frame is a respawn, not movement. */
const TELEPORT_DISTANCE = 6;

function armMesh(sleeve: THREE.Material, trim: THREE.Material, glove: THREE.Material, glow: THREE.Material, renderOrder: number): THREE.Group {
  const arm = new THREE.Group();
  const piece = (w: number, h: number, d: number, z: number, y: number, material: THREE.Material, order: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(0, y, z);
    mesh.renderOrder = renderOrder + order;
    arm.add(mesh);
  };
  piece(0.07, 0.07, 0.5, 0.12, 0, sleeve, 0);
  piece(0.085, 0.085, 0.1, -0.03, 0, trim, 1);
  piece(0.02, 0.022, 0.05, -0.03, 0.05, glow, 2);
  piece(0.09, 0.085, 0.1, -0.17, 0, glove, 2);
  return arm;
}

/** The suit colour of the player's own arms and body. */
const OWN_PALETTE = 1;

const REST_RIGHT = new THREE.Vector3(0.34, -0.36, -0.62);
const REST_LEFT = new THREE.Vector3(-0.34, -0.36, -0.62);

/** A wide lens would shrink the hero on screen, so third person stays tighter than first. */
const THIRD_PERSON_FOV = 72;

interface ShotView {
  tail: THREE.Mesh;
  head: THREE.Mesh;
  net: THREE.Mesh;
}

/** A flat net: two rings joined by spokes. */
function buildNetGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(0.75, 0.035, 4, 18),
    new THREE.TorusGeometry(0.38, 0.03, 4, 14),
  ];
  for (let i = 0; i < 4; i += 1) {
    parts.push(new THREE.BoxGeometry(1.5, 0.05, 0.05).rotateZ((i / 4) * Math.PI));
  }
  return mergeGeometries(parts.map((part) => part.toNonIndexed().deleteAttribute('uv') as THREE.BufferGeometry))!;
}

/** The turn from one angle to another, going the short way round. */
const shortestTurn = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Faster than this along a wall, a character runs on it instead of climbing. */
const WALL_RUN_SPEED = 7;
/** Above this speed, letting go of a web turns into a move instead of just dropping. */
const FLIP_SPEED = 14;
const WEB_COLOR = '#ffffff';
const OWN_WEB_WIDTH = 0.026;
const OTHER_WEB_WIDTH = 0.045;

/** A small gold crown that can sit on the ground or float above its holder. */
function buildCrown(): THREE.Group {
  const group = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: '#ffd34e', emissive: '#a45e00', emissiveIntensity: 0.35, metalness: 0.55, roughness: 0.3 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.075, 8, 28), gold);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  const point = new THREE.ConeGeometry(0.13, 0.34, 5);
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2;
    const spike = new THREE.Mesh(point, gold);
    spike.position.set(Math.cos(angle) * 0.32, 0.17, Math.sin(angle) * 0.32);
    group.add(spike);
  }
  return group;
}

export class GameView {
  readonly camera = new THREE.PerspectiveCamera(90, 1, NEAR_PLANE, 2600);
  /** All city and character assets are ready before the player enters the game. */
  readonly ready: Promise<void>;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight('#ffd2a0', 3);
  private readonly hemi = new THREE.HemisphereLight('#dbe2ff', '#a08088', 2.4);
  private lighting!: Lighting;
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringNext = new THREE.MeshBasicMaterial({ color: '#ff8a2b' });
  private readonly crown = buildCrown();
  private readonly controlRing = new THREE.Mesh(
    new THREE.TorusGeometry(CONTROL_POINT.radius, 0.18, 8, 64),
    new THREE.MeshBasicMaterial({ color: '#47dfff' }),
  );
  private readonly dummies: CharacterView[] = [];
  private readonly padRings: THREE.InstancedMesh;
  private readonly padFlash: number[] = [];
  private readonly padMatrix = new THREE.Matrix4();
  private readonly padPosition = new THREE.Vector3();
  private readonly padScale = new THREE.Vector3();
  private readonly padRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private readonly padColor = new THREE.Color();
  private readonly puffs = new WebPuffs();
  private streets: Streets | null = null;
  private trafficShown: string | null = null;
  /** Only watching a room: the camera follows another player and this body is hidden. */
  watching = false;
  private readonly gripPoint = new THREE.Vector3();
  /** Strands behind web shots, reused. */
  private readonly strands: Array<{ web: WebLine; shot: Shot | null; origin: THREE.Vector3; tip: THREE.Vector3; side: Side | null }> = [];
  private readonly crateMeshes: THREE.Mesh[] = [];
  private readonly flyingCrates: THREE.Mesh[] = [];
  private readonly shockwave: THREE.Mesh;
  private shockT = 0;
  private readonly armRight: THREE.Group;
  private readonly armLeft: THREE.Group;
  private readonly shots: ShotView[] = [];
  private readonly shotMaterials: THREE.Material[];

  private readonly hand = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private webFired = false;
  private shotPuff = false;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly viewFrustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly characterBounds = new THREE.Sphere(new THREE.Vector3(), 4);

  private smoothEye = 1.62;
  private roll = 0;
  private fovBoost = 0;
  private readonly motion = createCameraMotion();
  private readonly chase = createChaseCamera();
  /** The player's own body, seen in third person. */
  private readonly self = buildCharacter();
  private readonly selfDummy: Dummy = { id: 0, pos: { x: 0, y: 0, z: 0 }, hp: 1, snareT: 0, respawnT: 0, phase: 0, dir: 1 };
  private readonly map: GameMap;
  private bodyYaw = 0;

  /** First-person arms draw in their own scene, on top, so they can never clip into a wall. */
  private readonly armScene = new THREE.Scene();
  private readonly armCamera = new THREE.PerspectiveCamera(68, 1, 0.02, 8);
  private arms: FirstPersonArms | null = null;
  private stride = 0;
  private time = 0;
  private kick = 0;
  private kickSide: Side = 1;
  private armPoseFor: typeof import('./hero').armPoseFor | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    map: GameMap,
    private readonly settings: Settings,
    antialias: boolean,
    private readonly loadingMessage: (message: string) => void = () => undefined,
  ) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The arena never moves, so its shadows are drawn once rather than every frame.
    this.renderer.shadowMap.autoUpdate = false;

    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.Fog(FOG_COLOR, 220, 1100);
    this.scene.add(this.hemi);

    this.sun.position.copy(SUN_DIRECTION).multiplyScalar(850);
    this.sun.shadow.camera.left = -ARENA_LIMIT - 20;
    this.sun.shadow.camera.right = ARENA_LIMIT + 20;
    this.sun.shadow.camera.top = ARENA_LIMIT + 20;
    this.sun.shadow.camera.bottom = -ARENA_LIMIT - 20;
    this.sun.shadow.camera.far = 1800;
    this.sun.shadow.bias = -0.0006;
    // One shadow texel covers about a metre of this city. Without pushing the lookup out
    // along the surface normal, tall walls catch their own shadow in bands that shimmer
    // as the camera moves.
    this.sun.shadow.normalBias = 0.9;
    this.scene.add(this.sun);

    const arena = buildArena(map);
    this.scene.add(arena.group);
    this.lighting = new Lighting(this.scene, this.sun, this.hemi, this.renderer);
    this.scene.add(this.lighting.group);
    this.lighting.lit.windows.push(arena.windows);
    this.lighting.lit.far.push(arena.far);
    this.lighting.lit.clouds.push(arena.clouds);
    this.lighting.lit.land.push(arena.land);
    if (map.scenery) {
      this.streets = new Streets(map.scenery);
      this.scene.add(this.streets.group);
      this.lighting.lit.lamps.push((on) => this.streets?.setLights(on));
    }

    const ringGeometry = new THREE.TorusGeometry(RING_RADIUS - 0.6, 0.16, 8, 40);
    const makeRings = (points: V3[], destination: THREE.Mesh[]) => points.forEach((pos, i) => {
      const ring = new THREE.Mesh(ringGeometry, this.ringNext);
      ring.position.set(pos.x, pos.y, pos.z);
      const next = points[(i + 1) % points.length];
      ring.lookAt(next.x, next.y, next.z);
      destination.push(ring);
      this.scene.add(ring);
    });
    makeRings(map.rings, this.rings);
    this.crown.visible = false;
    this.scene.add(this.crown);
    this.controlRing.rotation.x = Math.PI / 2;
    this.controlRing.position.set(CONTROL_POINT.x, CONTROL_POINT.y + 0.08, CONTROL_POINT.z);
    this.scene.add(this.controlRing);

    const padBase = new THREE.CylinderGeometry(JUMP_PAD_RADIUS, JUMP_PAD_RADIUS, 0.14, 28);
    const padMaterial = new THREE.MeshBasicMaterial({ color: '#ff4fd8' });
    const padRing = new THREE.TorusGeometry(JUMP_PAD_RADIUS - 0.5, 0.11, 8, 28);
    const bases = new THREE.InstancedMesh(padBase, padMaterial, Math.max(1, map.jumpPads.length));
    bases.count = map.jumpPads.length;
    this.padRings = new THREE.InstancedMesh(padRing, new THREE.MeshBasicMaterial({
      color: '#ffffff', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    }), Math.max(1, map.jumpPads.length));
    this.padRings.count = map.jumpPads.length;
    this.padRings.frustumCulled = false;
    this.padRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const [i, pad] of map.jumpPads.entries()) {
      this.padMatrix.makeTranslation(pad.x, pad.y + 0.07, pad.z);
      bases.setMatrixAt(i, this.padMatrix);
      this.padMatrix.compose(this.padPosition.set(pad.x, pad.y + 0.2, pad.z), this.padRotation, this.padScale.setScalar(1));
      this.padRings.setMatrixAt(i, this.padMatrix);
      this.padRings.setColorAt(i, this.padColor.setRGB(1, 1, 1));
      this.padFlash.push(0);
    }
    this.padRings.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(bases, this.padRings);

    for (let i = 0; i < Math.max(map.patrols.length, MAX_OTHER_PLAYERS); i += 1) {
      const d = buildCharacter();
      // Prepare every suit colour now, so another player joining cannot compile it mid-match.
      paintCharacter(d, i % PALETTES.length);
      this.dummies.push(d);
      this.scene.add(d.group, d.web.group);
    }

    this.scene.add(this.puffs.group);
    for (let i = 0; i < MAX_STRANDS; i += 1) {
      const web = new WebLine();
      this.strands.push({ web, shot: null, origin: new THREE.Vector3(), tip: new THREE.Vector3(), side: null });
      this.scene.add(web.group);
    }

    // Loose crates: wooden boxes the web can fetch and throw.
    const crateGeometry = new THREE.BoxGeometry(CRATE_SIZE, CRATE_SIZE, CRATE_SIZE);
    const crateMaterial = new THREE.MeshLambertMaterial({ color: '#c9893f' });
    for (let i = 0; i < map.crates.length; i += 1) {
      const mesh = new THREE.Mesh(crateGeometry, crateMaterial);
      mesh.castShadow = false;
      this.crateMeshes.push(mesh);
      this.scene.add(mesh);
    }
    for (let i = 0; i < MAX_FLYING_CRATES; i += 1) {
      const mesh = new THREE.Mesh(crateGeometry, crateMaterial);
      mesh.visible = false;
      this.flyingCrates.push(mesh);
      this.scene.add(mesh);
    }

    this.shockwave = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.shockwave.visible = false;
    this.scene.add(this.shockwave);

    // Thick at the head, drawn out to nothing behind it.
    const tailGeometry = new THREE.ConeGeometry(0.075, SHOT_LENGTH, 6).rotateX(-Math.PI / 2).translate(0, 0, -SHOT_LENGTH / 2);
    const headGeometry = new THREE.IcosahedronGeometry(0.15, 0);
    const netGeometry = buildNetGeometry();
    this.shotMaterials = [
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      new THREE.MeshBasicMaterial({ color: '#1fd6c4' }),
    ];
    for (let i = 0; i < MAX_SHOTS; i += 1) {
      const tail = new THREE.Mesh(tailGeometry, this.shotMaterials[0]);
      const head = new THREE.Mesh(headGeometry, this.shotMaterials[0]);
      const net = new THREE.Mesh(netGeometry, this.shotMaterials[1]);
      tail.add(head, net);
      tail.visible = false;
      this.shots.push({ tail, head, net });
      this.scene.add(tail);
    }

    // Arms draw on top of the world so they never clip into walls.
    const overlay = (color: string) => new THREE.MeshLambertMaterial({ color, depthTest: false });
    const sleeve = overlay('#20283c');
    const trim = overlay('#e6eefc');
    const glove = overlay('#2a7de1');
    const glow = new THREE.MeshBasicMaterial({ color: '#37e6ff', depthTest: false });
    this.armRight = armMesh(sleeve, trim, glove, glow, 10);
    this.armLeft = armMesh(sleeve, trim, glove, glow, 14);
    this.armRight.position.copy(REST_RIGHT);
    this.armLeft.position.copy(REST_LEFT);
    this.camera.add(this.armRight, this.armLeft);

    this.armScene.add(this.armCamera);
    this.armScene.add(new THREE.HemisphereLight('#dbe2ff', '#a08088', 2.4));
    const armSun = new THREE.DirectionalLight('#ffd2a0', 2);
    armSun.position.set(-1, 2, 1);
    this.armScene.add(armSun);

    paintCharacter(this.self, OWN_PALETTE);
    this.self.group.visible = false;
    this.scene.add(this.self.group, this.self.web.group);
    this.camera.add(new THREE.PointLight('#ffffff', 1.2, 2));
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    this.ready = this.prepare(map, arena.placeholders);
  }

  private async prepare(map: GameMap, placeholders: THREE.Object3D[]): Promise<void> {
    await Promise.all([this.loadCity(map, placeholders), this.loadHeroes()]);
    this.loadingMessage('เกือบพร้อมแล้ว กำลังเตรียมฉากทั้งหมด…');
    await preloadScenes(this.renderer, [
      { scene: this.scene, camera: this.camera },
      { scene: this.armScene, camera: this.armCamera },
    ]);
  }

  /** Swaps the block characters for the animated hero before the game starts. */
  private async loadHeroes(): Promise<void> {
    const { FirstPersonArms, HeroBody, armPoseFor, loadHero, setHeroNightLight } = await import('./hero');
    this.lighting.lit.lamps.push(setHeroNightLight);
    this.lighting.refresh();
    this.armPoseFor = armPoseFor;
    const asset = await loadHero();
    for (const [i, view] of [this.self, ...this.dummies].entries()) {
      const hero = new HeroBody(asset);
      hero.setPalette(view.palette);
      view.group.add(hero.root);
      view.rig.visible = false;
      view.hero = hero;
      if (i % 3 === 2) await yieldToBrowser();
    }

    const arms = new FirstPersonArms(asset);
    arms.setPalette(OWN_PALETTE);
    this.armCamera.add(arms.root);
    this.arms = arms;
  }

  /** Swaps in the complete Kenney city before the loading screen closes. */
  private async loadCity(map: GameMap, placeholders: THREE.Object3D[]): Promise<void> {
    const { loadKenneyCity } = await import('./kenney');
    const { city, far, glassMaterials, farMaterial } = await loadKenneyCity(map, this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(city, far);
    this.lighting.lit.glass.push(...glassMaterials);
    this.lighting.lit.far.push(farMaterial);
    this.lighting.refresh();
    for (const mesh of placeholders) mesh.visible = false;
    this.renderer.shadowMap.needsUpdate = true;
  }

  applySettings(): void {
    this.lighting.set(this.settings.timeOfDay);
    if (this.streets && this.settings.traffic !== this.trafficShown) {
      this.trafficShown = this.settings.traffic;
      this.streets.setTraffic(this.settings.traffic);
    }
    this.streets?.setGlow(this.settings.cityGlow);
    const q = QUALITY[this.settings.quality];
    const shadows = q.shadow > 0;
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(q.shadow, q.shadow);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.renderer.shadowMap.needsUpdate = true;
    }
    // Lighting programs depend on whether shadows are on.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).needsUpdate = true;
    });
    this.resize();
  }

  private resize(): void {
    this.renderer.setPixelRatio(pixelRatioFor(this.settings.quality, window.devicePixelRatio || 1, window.innerWidth, window.innerHeight));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Makes a pad's ring burst upward when someone is launched. */
  flashPad(index: number): void {
    this.padFlash[index] = 1;
  }

  /** In third person, shots and webs start at the camera, so they land on the crosshair. */
  aimFrom(): V3 | null {
    if (!this.settings.thirdPerson) return null;
    const { x, y, z } = this.camera.position;
    return { x, y, z };
  }

  /** Call after a teleport or a view switch, so the camera doesn't glide across the map. */
  cameraChanged(): void {
    resetChaseCamera(this.chase);
  }

  /** Dips the view after a hard landing. */
  land(fallSpeed: number): void {
    if (!this.settings.reduceMotion) landCamera(this.motion, fallSpeed);
  }

  /** A hard hit on a wall jolts the view harder than any landing. */
  slam(speed: number): void {
    if (this.settings.reduceMotion) return;
    landCamera(this.motion, speed * 1.5);
    this.roll += Math.min(0.2, speed * 0.006) * (Math.random() < 0.5 ? -1 : 1);
  }

/**
   * Diving fast, the whole view trembles, harder the faster the drop, like wind
   * buffeting a camera. Swinging and running stay steady. Smooth noise rather than
   * random jumps, so it never jerks.
   */
  private shakeWhileDiving(fallSpeed: number): void {
    const k = Math.min(1, Math.max(0, (fallSpeed - SHAKE_FROM) / SHAKE_RANGE));
    if (k === 0) return;
    const t = this.time;
    const wobble = (a: number, b: number, c: number) => Math.sin(t * a) * 0.5 + Math.sin(t * b + 1.3) * 0.3 + Math.sin(t * c + 2.1) * 0.2;
    const size = k * k * SHAKE_SIZE;
    const right = this.tmp.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = this.tmp2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.addScaledVector(right, wobble(31, 47, 67) * size).addScaledVector(up, wobble(37, 53, 71) * size);
    this.camera.rotateZ(wobble(23, 41, 59) * size * 0.25);
    this.camera.updateMatrixWorld(true);
  }

  /** A landed hit: a hand thrown out, and the bigger hits shake the view. */
  punch(kind: HitKind): void {
    this.recoil();
    this.shotPuff = false;
    if (this.settings.reduceMotion) return;
    const heavy = kind === 'heavy' || kind === 'launch' || kind === 'throw' || kind === 'strike' || kind === 'finisher';
    landCamera(this.motion, heavy ? 14 : 5);
  }

  /** A perfect dodge: the view pinches in for a beat, then breathes out. */
  slowFlash(): void {
    if (!this.settings.reduceMotion) this.fovBoost -= 8;
  }

  /** A burst of speed from a zip: the view widens for a beat. */
  burst(): void {
    if (!this.settings.reduceMotion) this.fovBoost += 5;
  }

  /** A ground pound's landing: a ring spreads over the floor, and the view jolts. */
  pound(at: V3, radius: number): void {
    this.shockwave.position.set(at.x, at.y + 0.08, at.z);
    this.shockwave.userData.radius = radius;
    this.shockT = POUND_TIME;
    if (!this.settings.reduceMotion) landCamera(this.motion, 30);
  }

  /** Throws a hand out for a moment. Shots take turns, and a hand on a web stays there. */
  recoil(): void {
    const swing = this.self.swing;
    const onWeb = swing.anchor !== null;
    this.kickSide = onWeb ? (-swing.side as Side) : (-this.kickSide as Side);
    this.kick = 1;
    this.shotPuff = true;
  }

  /** Slow orbit of the plaza behind the main menu. */
  renderMenu(world: World, dt: number): void {
    this.time += dt;
    const a = this.time * 0.07;
    this.self.group.visible = false;
    this.camera.position.set(Math.sin(a) * 30, 22, Math.cos(a) * 30);
    this.camera.lookAt(0, 20, 0);
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.armLeft.visible = false;
    this.armRight.visible = false;
    this.self.web.clear();
    this.camera.updateMatrixWorld(true);
    this.syncWorld(world, dt);
    this.streets?.update();
    this.lighting.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  renderGame(world: World, prevPos: V3, alpha: number, yaw: number, pitch: number, dt: number): void {
    this.time += dt;
    const p = world.player;
    const reduce = this.settings.reduceMotion;
    const blend = (rate: number) => 1 - Math.exp(-rate * dt);

    const eyeTarget = eyePosition(p).y - p.pos.y;
    this.smoothEye += (eyeTarget - this.smoothEye) * blend(16);

    this.camera.position.set(
      prevPos.x + (p.pos.x - prevPos.x) * alpha,
      prevPos.y + (p.pos.y - prevPos.y) * alpha + this.smoothEye,
      prevPos.z + (p.pos.z - prevPos.z) * alpha,
    );

    let rollTarget = 0;
    if (p.mode === 'wall' && !reduce) {
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      // Lean away from the wall.
      rollTarget = (p.wallNormal.x * rightX + p.wallNormal.z * rightZ) * -0.18;
    }
    this.roll += (rollTarget - this.roll) * blend(9);

    const sideSpeed = p.vel.x * Math.cos(yaw) - p.vel.z * Math.sin(yaw);
    const offset = stepCameraMotion(this.motion, {
      speed: Math.hypot(p.vel.x, p.vel.z),
      sideSpeed,
      totalSpeed: totalSpeed(p),
      onGround: p.mode === 'ground' && !p.sliding,
      swinging: p.mode === 'swing',
      dt,
    });
    const sway = this.settings.reduceMotion ? 0 : 1;

    const third = this.settings.thirdPerson || this.watching;
    if (third) {
      const head = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
      const body = this.self;
      body.group.position.set(head.x, head.y - this.smoothEye, head.z);
      const eased = stepChaseCamera(this.chase, {
        head,
        yaw,
        pitch,
        speed: this.settings.speedZoom ? totalSpeed(p) : 0,
        sideSpeed,
        swinging: p.mode === 'swing',
        dt,
        clearance: (from, direction, limit) => raycast(this.map, from, direction, limit)?.t ?? limit,
      });
      this.camera.position.set(eased.x, eased.y, eased.z);
      this.camera.rotation.set(pitch, yaw, this.chase.roll * sway);
    } else {
      this.camera.rotation.set(pitch, yaw, this.roll + offset.roll * sway);
      // Moves the camera along its own right and up, so the sway follows the view.
      this.camera.position.x += Math.cos(yaw) * offset.x * sway;
      this.camera.position.z -= Math.sin(yaw) * offset.x * sway;
      this.camera.position.y += offset.y * sway;
    }

    const speed = totalSpeed(p);
    // A fast dive widens quickly and naturally stretches the view toward its edges.
    const fallSpeed = p.mode === 'air' || p.mode === 'pound' ? Math.max(0, -p.vel.y) : 0;
    const boostTarget = speedFovBoost(speed, fallSpeed, third, reduce, this.settings.speedZoom);
    this.fovBoost = stepFovBoost(this.fovBoost, boostTarget, fallSpeed, dt, reduce);
    const baseFov = third ? Math.min(this.settings.fov, THIRD_PERSON_FOV) : this.settings.fov;
    this.camera.fov = Math.min(130, baseFov + this.fovBoost);
    this.camera.updateProjectionMatrix();
    if (!reduce && this.settings.screenShake) this.shakeWhileDiving(p.mode === 'air' || p.mode === 'pound' ? -p.vel.y : 0);

    const blocks = !third && !this.arms;
    this.armLeft.visible = blocks;
    this.armRight.visible = blocks;
    if (blocks) this.poseArms(p, speed, blend(14));
    this.camera.updateMatrixWorld(true);
    this.syncWorld(world, dt);
    this.syncSelf(p, third, yaw, dt, world.myTeam);
    this.arms?.setPalette(world.myTeam === 'red' ? 0 : OWN_PALETTE);
    if (!third) this.poseFirstPersonArms(p, speed, blend(13), dt);
    this.drawWeb(p, dt);
    this.drawShotStrands(world, third, dt);
    this.drawShots(world);
    this.streets?.update();
    this.lighting.update(dt);
    this.drawCrates(world, dt);
    this.puffs.update(this.camera, dt);

    this.renderer.render(this.scene, this.camera);
    if (!third && this.arms) {
      this.armCamera.aspect = this.camera.aspect;
      this.armCamera.updateProjectionMatrix();
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.armScene, this.armCamera);
      this.renderer.autoClear = true;
    }
  }

  /** Shows the player's own body in third person, facing where they're heading. */
  private syncSelf(p: Player, third: boolean, yaw: number, dt: number, team: Team | undefined): void {
    const view = this.self;
    if (this.watching) {
      view.group.visible = false;
      view.web.clear();
      return;
    }
    const pose = poseOf(p);
    const anchor = swingAnchor(webLineOf(p), p.mode, pose);
    const canFlip = p.mode === 'air' && pose === 'air' && p.snareT === 0;
    this.webFired = trackSwing(view.swing, anchor, canFlip && totalSpeed(p) > FLIP_SPEED, dt);
    if (!anchor && !canFlip) view.swing.release = -1;

    const nearCamera = this.camera.position.distanceTo(view.group.position) < 1.1;
    view.group.visible = third && !nearCamera;
    if (!third) return;

    // Moving fast, the body follows its path. Otherwise, it turns to where the camera looks.
    const flat = Math.hypot(p.vel.x, p.vel.z);
    const climbing = p.mode === 'wall' && flat <= WALL_RUN_SPEED;
    const heading = climbing
      ? Math.atan2(p.wallNormal.x, p.wallNormal.z)
      : p.act && p.act !== 'trick' && p.act !== 'charge'
        ? yaw
      : flat > 4
        ? Math.atan2(-p.vel.x, -p.vel.z)
        : yaw;
    const turn = Math.atan2(Math.sin(heading - this.bodyYaw), Math.cos(heading - this.bodyYaw));
    this.bodyYaw += turn * (1 - Math.exp(-10 * dt));

    const d = this.selfDummy;
    d.pos = { x: view.group.position.x, y: view.group.position.y, z: view.group.position.z };
    d.yaw = this.bodyYaw;
    d.anchor = webLineOf(p);
    d.mode = poseOf(p);
    d.motion = p.mode;
    d.snareT = p.snareT;
    paintCharacter(view, team === 'red' ? 0 : OWN_PALETTE);
    const aim = this.kick > 0 ? this.camera.getWorldDirection(this.aim) : null;
    this.animateBody(view, d, dt, aim);
    this.kick = Math.max(0, this.kick - dt * 5);
  }

  private poseFirstPersonArms(p: Player, speed: number, ease: number, dt: number): void {
    if (!this.arms || !this.armPoseFor) return;
    const onGround = p.mode === 'ground' && !p.sliding;
    if (onGround && !this.settings.reduceMotion) this.stride += speed * 0.85 * dt;
    if ((p.mode === 'wall' || p.mode === 'hang') && !this.settings.reduceMotion) this.stride += totalSpeed(p) * 1.1 * dt;

    const swing = this.self.swing;
    let web: THREE.Vector3 | null = null;
    const line = webLineOf(p);
    if (line && p.mode !== 'hang') {
      web = new THREE.Vector3(line.x, line.y, line.z)
        .sub(this.camera.position)
        .normalize()
        .applyQuaternion(this.camera.quaternion.clone().invert());
    }
    const moment = {
      mode: p.mode === 'hang' ? 'wall' : p.mode,
      web,
      webSide: swing.side,
      twoHands: p.mode === 'swing' && usesBothHands(swing.style),
      stride: this.stride,
      kick: this.kick,
      kickSide: this.kickSide,
      action: p.act,
      actionProgress: p.act ? 1 - p.actT / ACT_TIME[p.act] : 0,
    };
    this.arms.update(this.armPoseFor(moment), ease);
    // Slower than the third-person body, so the snap of a shot reads in first person.
    this.kick = Math.max(0, this.kick - dt * 3.5);
  }

  /** Where the web leaves the player's hand, in world space. */
  private webStart(third: boolean, side: Side, out: THREE.Vector3): THREE.Vector3 {
    if (third && this.self.hero) return this.self.hero.handOf(side).getWorldPosition(out);
    if (!third && this.arms) {
      this.armCamera.updateWorldMatrix(true, true);
      this.arms.handOf(side).getWorldPosition(out);
      // The arms have their own lens, so match the spot on screen rather than the distance.
      const lens =
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) /
        Math.tan(THREE.MathUtils.degToRad(this.armCamera.fov / 2));
      out.x *= lens;
      out.y *= lens;
      return out.applyMatrix4(this.camera.matrixWorld);
    }
    return (side === 1 ? this.armRight : this.armLeft).localToWorld(out.set(0, 0, -0.2));
  }

  private poseArms(p: Player, speed: number, k: number): void {
    const run = p.mode === 'ground' && !p.sliding && speed > 1;
    const bob = run && !this.settings.reduceMotion ? Math.sin(this.time * (8 + speed * 0.6)) * 0.035 : 0;

    const right = this.tmp.copy(REST_RIGHT);
    const left = this.tmp2.copy(REST_LEFT);
    right.y += bob;
    left.y -= bob;
    let rightPitch = 0.1;
    let leftPitch = 0.1;

    switch (p.mode) {
      case 'swing':
        right.set(0.2, 0.02, -0.5);
        rightPitch = 1.15;
        left.set(-0.3, -0.42, -0.38);
        break;
      case 'dash':
        right.set(0.36, -0.4, -0.36);
        left.set(-0.36, -0.4, -0.36);
        leftPitch = rightPitch = -0.3;
        break;
      case 'air':
        right.y += 0.05;
        left.y += 0.05;
        leftPitch = rightPitch = 0.35;
        break;
      case 'wall':
        leftPitch = rightPitch = 0.5;
        break;
    }

    // The free arm fires, so a shot during a swing comes from the left hand.
    const firing = p.mode === 'swing' ? left : right;
    firing.z += this.kick * 0.16;
    firing.y += this.kick * 0.03;
    this.kick = Math.max(0, this.kick - 0.2);

    this.armRight.position.lerp(right, k);
    this.armLeft.position.lerp(left, k);
    this.armRight.rotation.x += (rightPitch - this.armRight.rotation.x) * k;
    this.armLeft.rotation.x += (leftPitch - this.armLeft.rotation.x) * k;
  }

  private syncWorld(world: World, dt: number): void {
    this.viewFrustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    world.map.jumpPads.forEach((pad, i) => {
      this.padFlash[i] = Math.max(0, this.padFlash[i] - dt * 2.5);
      // The ring keeps rising to show which way the pad throws.
      const rise = (this.time * 0.8 + i * 0.5) % 1;
      this.padPosition.set(pad.x, pad.y + 0.2 + rise * 2.4 + this.padFlash[i] * 3, pad.z);
      this.padScale.setScalar(1 + this.padFlash[i] * 0.6);
      this.padRings.setMatrixAt(i, this.padMatrix.compose(this.padPosition, this.padRotation, this.padScale));
      const brightness = Math.max(1 - rise, this.padFlash[i]);
      this.padRings.setColorAt(i, this.padColor.setRGB(brightness, brightness, brightness));
    });
    this.padRings.instanceMatrix.needsUpdate = true;
    if (this.padRings.instanceColor) this.padRings.instanceColor.needsUpdate = true;

    this.rings.forEach((ring, i) => {
      ring.visible = !world.online && i === world.ringIndex;
      ring.scale.setScalar(1 + Math.sin(this.time * 5) * 0.04);
    });
    this.crown.visible = world.online && world.gameMode === 'crown' && world.crown !== null && (!world.crownMine || this.settings.thirdPerson);
    if (this.crown.visible && world.crown) {
      this.crown.position.set(world.crown.x, world.crown.y + Math.sin(this.time * 3) * 0.08, world.crown.z);
      this.crown.rotation.y += dt * 1.3;
    }
    this.controlRing.visible = world.online && world.gameMode === 'control';

    this.dummies.forEach((view, i) => {
      const d = world.dummies[i];
      if (!d || d.respawnT !== 0) {
        view.group.visible = false;
        view.web.clear();
        return;
      }

      paintCharacter(view, d.team ? (d.team === 'red' ? 0 : 1) : paletteFor(d.name === undefined ? null : d.id));
      view.group.position.set(d.pos.x, d.pos.y, d.pos.z);
      // Keep animating off-screen players so their web and pose are ready when they reappear.
      this.characterBounds.center.set(d.pos.x, d.pos.y + 1, d.pos.z);
      view.group.visible = this.viewFrustum.intersectsSphere(this.characterBounds);
      view.wrap.visible = d.snareT > 0;
      const motion = d.motion ?? d.mode;
      const anchor = swingAnchor(d.anchor ?? null, d.motion, d.mode);
      const canFlip = motion === 'air' && (d.mode === 'air' || d.mode === undefined) && d.snareT === 0;
      trackSwing(view.swing, anchor, canFlip && view.velocity.length() > FLIP_SPEED, dt);
      if (!anchor && !canFlip) view.swing.release = -1;
      // Other players only send their mode, so find the wall they're on to face it.
      const wall = motion === 'wall' ? climbWallNormal(world.map, d.pos) : null;
      this.animateBody(view, d, dt, null, wall && Math.atan2(wall.x, wall.z));

      view.group.updateMatrixWorld(true);
      const hand = view.hero?.handOf(motion === 'hang' ? view.ropeTop : view.swing.side) ?? view.armRight.tip;
      view.web.update(hand.getWorldPosition(this.hand), d.anchor ?? null, this.camera, dt, OTHER_WEB_WIDTH);
    });
  }

  /**
   * `aim` throws the free hand that way for a moment, for the player's own shots.
   * `wallYaw` faces a climbing body into its wall.
   */
  private animateBody(
    view: CharacterView,
    d: Dummy,
    dt: number,
    aim: THREE.Vector3 | null = null,
    wallYaw: number | null = null,
  ): void {
    if (dt <= 0) return;

    const moved = this.tmp.copy(view.group.position).sub(view.lastPos);
    view.lastPos.copy(view.group.position);
    if (moved.length() > TELEPORT_DISTANCE) moved.set(0, 0, 0);
    // Positions arrive in steps online, so velocity is smoothed before it drives the body.
    view.velocity.lerp(moved.divideScalar(dt), 1 - Math.exp(-10 * dt));

    const speed = Math.hypot(view.velocity.x, view.velocity.z);
    const motion = d.motion ?? d.mode;
    const climbing = motion === 'wall' && speed <= WALL_RUN_SPEED;
    const heading = Math.atan2(-view.velocity.x, -view.velocity.z);
    const other = d.name !== undefined;
    if (climbing && wallYaw !== null) {
      view.group.rotation.y = wallYaw;
    } else if (d.yaw !== undefined) {
      // Other players face where they look, but run the way they go, as everyone sees
      // their own hero do. Their yaw arrives in steps, so it eases.
      const running = other && speed > 4 && (motion === 'ground' || motion === 'air') && d.mode === motion;
      const facing = running ? heading : d.yaw;
      const turn = shortestTurn(facing - view.group.rotation.y);
      view.group.rotation.y += other ? turn * (1 - Math.exp(-12 * dt)) : turn;
    } else if (speed > 0.5) {
      view.group.rotation.y = heading;
    }

    const yaw = view.group.rotation.y;
    const local = this.tmp.copy(view.velocity).applyAxisAngle(UP, -yaw);
    const forwardSpeed = -local.z;
    const sideSpeed = local.x;
    const clipMode = this.climbMove(view, d, climbing, yaw, dt);

    let rope: { x: number; y: number; z: number } | null = null;
    if (d.anchor) {
      const dir = this.tmp2
        .set(d.anchor.x - d.pos.x, d.anchor.y - d.pos.y - 1.4, d.anchor.z - d.pos.z)
        .normalize()
        .applyAxisAngle(UP, -yaw);
      rope = { x: dir.x, y: dir.y, z: dir.z };
    }

    const want = bodyPose({ speed, forwardSpeed, verticalSpeed: view.velocity.y, rope, time: this.time });
    const k = 1 - Math.exp(-14 * dt);
    const pose = view.pose;
    for (const joint of Object.keys(pose) as Array<keyof BodyPose>) {
      pose[joint] += (want[joint] - pose[joint]) * k;
    }

    if (view.hero) {
      const choice = clipFor({ mode: clipMode, speed, verticalSpeed: view.velocity.y, forwardSpeed, sideSpeed });
      view.hero.play(choice.clip, choice.timeScale, choice.duration, clipMode);
      view.hero.update(dt, d.snareT > 0);
      this.moveHero(view, view.hero, d, pose, dt, aim);
      return;
    }

    view.rig.rotation.set(pose.pitch, 0, pose.roll);
    view.armLeft.upper.rotation.x = pose.armLeft;
    view.armRight.upper.rotation.x = pose.armRight;
    view.armLeft.lower.rotation.x = pose.elbowLeft;
    view.armRight.lower.rotation.x = pose.elbowRight;
    view.legLeft.upper.rotation.x = pose.legLeft;
    view.legRight.upper.rotation.x = pose.legRight;
    view.legLeft.lower.rotation.x = pose.kneeLeft;
    view.legRight.lower.rotation.x = pose.kneeRight;
  }

  /**
   * Tells a climb from a wall run, and spots the pull-up over the top: leaving a wall
   * going up and in toward where it was. A jump off the wall goes away from it instead.
   */
  private climbMove(view: CharacterView, d: Dummy, climbing: boolean, yaw: number, dt: number): ClipMode | undefined {
    const motion = d.motion ?? d.mode;
    if (climbing) {
      view.offWall = 0;
      view.wallYaw = yaw;
    } else if (motion !== 'wall') {
      view.offWall += dt;
    }

    if (motion !== 'air' && motion !== 'ground') view.ledge = 0;
    else if (view.ledge > 0) view.ledge = Math.max(0, view.ledge - dt);
    else if (motion === 'air' && view.offWall < 0.25 && view.velocity.y > 2.5) {
      const intoWall = -this.tmp2.copy(view.velocity).applyAxisAngle(UP, -view.wallYaw).z;
      if (intoWall > 1.5) view.ledge = LEDGE_TIME;
    }

    // A hard drop onto the feet crouches into the landing, unless already running on.
    const landed = motion === 'ground' && (view.lastMode === 'air' || view.lastMode === 'stun');
    view.lastMode = motion;
    if (motion !== 'ground') view.land = 0;
    else if (view.land > 0) view.land = Math.max(0, view.land - dt);
    else if (landed && view.velocity.y < -8 && Math.hypot(view.velocity.x, view.velocity.z) < 4) view.land = LAND_TIME;

    if (d.mode !== undefined && d.mode !== motion) return d.mode;
    if (view.ledge > 0) return 'ledge';
    if (view.land > 0) return 'land';
    return climbing ? 'climb' : d.mode;
  }

  /** Everything a clip can't know about: the web, the shape on it, and the move after it. */
  private moveHero(
    view: CharacterView,
    hero: HeroBody,
    d: Dummy,
    pose: BodyPose,
    dt: number,
    aim: THREE.Vector3 | null,
  ): void {
    const swing = view.swing;
    const motion = d.motion ?? d.mode;
    const moving = swing.release >= 0;
    const turn = moving ? releaseTurn(swing.kind, swing.release / RELEASE_TIME) : null;

    // Clips carry their own lean. Only a web or a move after one tips the body.
    // Hanging on a line, the body hangs straight under it.
    const hanging = motion === 'hang' && d.anchor !== null && d.anchor !== undefined;
    const lean = d.anchor && (motion === 'swing' || motion === 'zip' || motion === 'strike');

    // A fast free fall tips the body over, head first along the fall.
    const fall = -view.velocity.y;
    const free = (motion === 'air' || motion === undefined) && !d.anchor && !moving && d.snareT === 0;
    // Close to the ground the body rights itself, feet first, ready to land: never a
    // header into the pavement.
    const ground = free && fall > 0 ? raycast(this.map, { x: d.pos.x, y: d.pos.y + 0.2, z: d.pos.z }, DOWN, fall * LAND_LOOKAHEAD + 2) : null;
    const diving = free && !ground ? diveAmount(fall) : 0;
    view.dive += (diving - view.dive) * (1 - Math.exp(-(diving > view.dive ? 4 : 14) * dt));
    const forward = -this.tmp2.copy(view.velocity).applyAxisAngle(UP, -view.group.rotation.y).z;
    const dive = view.dive > 0.01 ? diveTilt(fall, forward) * view.dive : 0;

    const want = { x: lean ? pose.pitch : turn?.pitch ?? dive, y: turn?.spin ?? 0, z: lean ? pose.roll : 0 };
    const k = 1 - Math.exp(-20 * dt);
    const tilt = view.tilt;
    tilt.x += shortestTurn(want.x - tilt.x) * k;
    tilt.y += shortestTurn(want.y - tilt.y) * k;
    tilt.z += shortestTurn(want.z - tilt.z) * k;
    hero.root.rotation.set(tilt.x, tilt.y, tilt.z);

    const frozen = d.snareT > 0;
    let limbs: LimbPose | null = null;
    // A line held while flying shapes the whole body. Climbing one, the clip does.
    const flying = motion === 'swing' || motion === 'zip' || motion === 'strike' || motion === undefined;
    if (d.anchor && flying) {
      const rise = view.velocity.y / 14;
      limbs = swingLimbs({ style: swing.style, side: swing.side, rise, age: swing.age, time: this.time });
    } else if (hanging) {
      const climb = Math.abs(view.velocity.y);
      view.ropePhase += climb * (Math.PI / 0.5) * dt;
      limbs = hangLimbs(view.ropePhase, Math.min(1, climb / 2));
    } else if (moving && swing.release < RELEASE_TIME * 0.82) {
      limbs = releaseLimbs(swing.kind);
    } else if (view.dive > 0.3) {
      limbs = diveLimbs(this.time);
    }
    hero.holdLimbs(frozen ? null : limbs, dt);

    if (hanging) {
      // Both hands on the line, one above the other, swapping as the body climbs.
      const a = d.anchor!;
      const rope = this.tmp2.set(d.pos.x - a.x, d.pos.y + TUNING.ropeHandHeight - a.y, d.pos.z - a.z);
      const length = rope.length();
      rope.normalize();
      view.ropeTop = Math.sin(view.ropePhase) >= 0 ? 1 : -1;
      // Hands above the head and just in front of the face, so no arm crosses it.
      const yaw = view.group.rotation.y;
      for (const side of [1, -1] as const) {
        const height = side === view.ropeTop ? GRIP_HIGH : GRIP_LOW;
        const grip = this.gripPoint
          .set(a.x, a.y, a.z)
          .addScaledVector(rope, Math.max(0.2, length - (height - TUNING.ropeHandHeight)));
        grip.x -= Math.sin(yaw) * GRIP_AHEAD;
        grip.z -= Math.cos(yaw) * GRIP_AHEAD;
        hero.reachFor(side, null, dt);
        hero.gripAt(side, frozen ? null : grip, dt);
      }
      return;
    }
    for (const side of [1, -1] as const) hero.gripAt(side, null, dt);

    const web = d.anchor
      ? this.tmp2.set(d.anchor.x - d.pos.x, d.anchor.y - d.pos.y - 1.4, d.anchor.z - d.pos.z).normalize()
      : null;
    const twoHands = (motion === 'swing' && limbs?.twoHands === true) || hanging;
    if (twoHands && d.anchor && !frozen) {
      const a = d.anchor;
      const rope = this.tmp2.set(d.pos.x - a.x, d.pos.y + SWING_GRIP_HEIGHT - a.y, d.pos.z - a.z);
      const length = rope.length();
      rope.normalize();
      for (const side of [1, -1] as const) {
        const along = side === swing.side ? SWING_GRIP_HIGH : SWING_GRIP_LOW;
        hero.reachFor(side, null, dt);
        hero.gripAt(side, this.gripPoint.set(a.x, a.y, a.z).addScaledVector(rope, Math.max(0.2, length - along)), dt);
      }
      return;
    }
    const shooter = web ? (-swing.side as Side) : this.kickSide;
    for (const side of [1, -1] as const) {
      const holding = web && (side === swing.side || twoHands);
      hero.reachFor(side, holding ? web : side === shooter ? aim : null, dt);
    }
  }

  private drawWeb(p: Player, dt: number): void {
    const third = this.settings.thirdPerson;
    const anchor = webLineOf(p);
    const side = p.mode === 'hang' ? this.self.ropeTop : this.self.swing.side;
    if (anchor) this.webStart(third, side, this.hand);
    this.self.web.update(this.hand, anchor, this.camera, dt, OWN_WEB_WIDTH);
    if (this.webFired) this.puffs.fire(this.hand, WEB_COLOR);

    if (this.shotPuff) {
      this.shotPuff = false;
      this.puffs.fire(this.webStart(third, this.kickSide, this.tmp), WEB_COLOR);
    }
  }

  /**
   * Each web shot pulls a strand out behind it, from the hand to the shot. When the
   * shot lands or runs out, the strand stays a moment, drops and fades.
   */
  private drawShotStrands(world: World, third: boolean, dt: number): void {
    const live = world.shots.filter((shot) => !shot.snare && !shot.crate);
    for (const shot of live) {
      if (this.strands.some((s) => s.shot === shot)) continue;
      const free = this.strands.find((s) => !s.shot && !s.web.group.visible) ?? this.strands.find((s) => !s.shot);
      if (!free) continue;
      free.shot = shot;
      if (shot.ghost) {
        free.side = null;
        free.origin.set(shot.pos.x - shot.dir.x * shot.travelled, shot.pos.y - shot.dir.y * shot.travelled, shot.pos.z - shot.dir.z * shot.travelled);
      } else {
        free.side = this.kickSide;
      }
    }
    for (const s of this.strands) {
      if (s.shot && !live.includes(s.shot)) s.shot = null;
      if (s.shot) {
        let fromHand = s.side !== null;
        if (s.side !== null) this.webStart(third, s.side, s.origin);
        else if (s.shot.shooter !== undefined) {
          const index = world.dummies.findIndex((player) => player.id === s.shot!.shooter);
          const remote = this.dummies[index];
          if (remote && world.dummies[index]?.respawnT === 0) {
            const side: Side = world.dummies[index].anchor ? -remote.swing.side as Side : 1;
            const hand = remote.hero?.handOf(side) ?? (side === 1 ? remote.armRight.tip : remote.armLeft.tip);
            hand.getWorldPosition(s.origin);
            fromHand = true;
          }
        }
        shotVisualTip(s.shot, s.origin, s.tip, fromHand);
      }
      s.web.update(s.origin, s.shot ? s.tip : null, this.camera, dt, s.shot?.ghost ? OTHER_WEB_WIDTH * 0.6 : OWN_WEB_WIDTH * 0.7, true);
    }
  }

  private drawShots(world: World): void {
    const webs = world.shots.filter((shot) => !shot.crate);
    const crates = world.shots.filter((shot) => shot.crate);
    this.flyingCrates.forEach((mesh, i) => {
      const shot = crates[i];
      mesh.visible = shot !== undefined;
      if (!shot) return;
      mesh.position.set(shot.pos.x, shot.pos.y, shot.pos.z);
      mesh.rotation.set(this.time * 9, this.time * 7, 0);
    });

    this.shots.forEach(({ tail, head, net }, i) => {
      const shot = webs[i];
      tail.visible = shot !== undefined;
      if (!shot) return;
      const material = this.shotMaterials[shot.snare ? 1 : 0];
      tail.material = material;
      head.material = material;
      head.visible = !shot.snare;
      net.visible = shot.snare;
      const strand = this.strands.find((s) => s.shot === shot);
      if (strand) tail.position.copy(strand.tip);
      else tail.position.set(shot.pos.x, shot.pos.y, shot.pos.z);
      tail.lookAt(tail.position.x + shot.dir.x, tail.position.y + shot.dir.y, tail.position.z + shot.dir.z);
      const length = strand && !shot.ghost ? strand.tip.distanceTo(strand.origin) : shot.travelled;
      tail.scale.z = Math.min(1, Math.max(0.01, length / SHOT_LENGTH));
      head.scale.z = 1 / tail.scale.z;
      net.scale.z = 1 / tail.scale.z;
      if (shot.snare) {
        // A snare opens as it flies, and spins like a thrown net.
        net.rotation.z = this.time * 11;
        const size = Math.min(1.5, 0.35 + shot.travelled / 16);
        net.scale.set(size, size, size / tail.scale.z);
      }
    });
  }

  private drawCrates(world: World, dt: number): void {
    const crates = world.crates;
    this.crateMeshes.forEach((mesh, i) => {
      const crate = crates[i];
      mesh.visible = crate !== undefined;
      if (!crate) return;
      // Fading out before it goes home: it shrinks away rather than popping.
      const size = crate.state === 'gone' ? Math.max(0.01, crate.t / 0.6) : 1;
      mesh.scale.setScalar(size);
      mesh.position.set(crate.pos.x, crate.pos.y + (CRATE_SIZE / 2) * size, crate.pos.z);
      mesh.rotation.set(crate.spin * 0.7, (i * 0.7) % Math.PI + crate.spin, 0);
    });
    if (this.streets) {
      for (const thing of world.pickups) {
        if (thing.car === undefined) continue;
        this.streets.placeCar(thing.car, thing.state === 'idle' ? null : thing.pos, thing.spin, thing.state === 'gone' ? Math.max(0.01, thing.t / 0.6) : 1);
      }
    }

    this.shockT = Math.max(0, this.shockT - dt);
    this.shockwave.visible = this.shockT > 0;
    if (this.shockT > 0) {
      const k = 1 - this.shockT / POUND_TIME;
      this.shockwave.scale.setScalar(0.3 + k * (this.shockwave.userData.radius as number));
      (this.shockwave.material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }
  }

  /** Screen position of a world point in CSS pixels. `behind` means it is outside the view cone. */
  toScreen(point: V3): { x: number; y: number; behind: boolean } {
    const v = this.tmp2.set(point.x, point.y, point.z).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
      behind: v.z > 1,
    };
  }
}
