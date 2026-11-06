// Everything drawn in 3D. It reads the simulation but never changes it.

import * as THREE from 'three';
import { bodyPose, type BodyPose } from './body-pose';
import { RING_RADIUS, type Box, type BoxKind, type GameMap, type V3 } from '../sim/map';
import { eyePosition, totalSpeed, type Dummy, type Player } from '../sim/player';
import type { World } from '../sim/world';
import type { Quality, Settings } from '../settings';

const KIND_COLORS: Record<BoxKind, string[]> = {
  ground: ['#59657a'],
  building: ['#c6d1e2', '#b5c4dc', '#d5cfc3', '#a9b8d0'],
  run: ['#1fd6c4'],
  beam: ['#ff8a2b'],
  ledge: ['#f5c842'],
};

const SKY = '#a8d4f0';
const UP = new THREE.Vector3(0, 1, 0);
const GRID_METRES = 4;
const MAX_SHOTS = 12;
const MAX_OTHER_PLAYERS = 15;
const SHOT_LENGTH = 7;

const QUALITY: Record<Quality, { pixelRatio: number; shadow: number }> = {
  low: { pixelRatio: 1, shadow: 0 },
  medium: { pixelRatio: 1.5, shadow: 1024 },
  high: { pixelRatio: 2, shadow: 2048 },
};

function gridTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(16, 24, 40, 0.26)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The whole arena as one mesh and one draw call, with a grid that stays a fixed size in metres. */
function buildArena(map: GameMap): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  const axes: Array<['x' | 'y' | 'z', 'x' | 'y' | 'z', 'x' | 'y' | 'z']> = [
    ['x', 'y', 'z'],
    ['y', 'z', 'x'],
    ['z', 'x', 'y'],
  ];

  map.boxes.forEach((box: Box, i) => {
    const palette = KIND_COLORS[box.kind];
    color.set(palette[i % palette.length]);

    for (const [n, u, v] of axes) {
      for (const sign of [1, -1]) {
        const plane = sign > 0 ? box.max[n] : box.min[n];
        const corners: Array<[number, number]> = [
          [box.min[u], box.min[v]],
          [box.max[u], box.min[v]],
          [box.max[u], box.max[v]],
          [box.min[u], box.max[v]],
        ];
        if (sign < 0) corners.reverse();

        const base = positions.length / 3;
        for (const [cu, cv] of corners) {
          const p: V3 = { x: 0, y: 0, z: 0 };
          p[n] = plane;
          p[u] = cu;
          p[v] = cv;
          positions.push(p.x, p.y, p.z);
          normals.push(n === 'x' ? sign : 0, n === 'y' ? sign : 0, n === 'z' ? sign : 0);
          uvs.push(cu / GRID_METRES, cv / GRID_METRES);
          // Darken the base of tall blocks so they read as grounded without real occlusion.
          const shade = box.kind === 'building' && n !== 'y' && p.y === box.min.y ? 0.62 : 1;
          colors.push(color.r * shade, color.g * shade, color.b * shade);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshLambertMaterial({ map: gridTexture(), vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  /** The end of the limb, where a web leaves the hand. */
  tip: THREE.Object3D;
}

interface DummyView {
  group: THREE.Group;
  /** Tips the whole body. Pivots at the chest, so it hangs naturally from a web. */
  rig: THREE.Group;
  armLeft: Limb;
  armRight: Limb;
  legLeft: Limb;
  legRight: Limb;
  pose: BodyPose;
  lastPos: THREE.Vector3;
  velocity: THREE.Vector3;
  wrap: THREE.Mesh;
  web: THREE.Mesh;
}

const RIG_HEIGHT = 1.2;
/** A bigger jump than this in one frame is a respawn, not movement. */
const TELEPORT_DISTANCE = 6;

function buildLimb(
  parent: THREE.Object3D,
  x: number,
  y: number,
  width: number,
  length: number,
  upperMaterial: THREE.Material,
  lowerMaterial: THREE.Material,
): Limb {
  const segment = (material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, width * 1.15), material);
    mesh.position.y = -length / 2;
    return mesh;
  };

  const upper = new THREE.Group();
  upper.position.set(x, y, 0);
  upper.add(segment(upperMaterial));

  const lower = new THREE.Group();
  lower.position.y = -length;
  lower.add(segment(lowerMaterial));
  upper.add(lower);

  const tip = new THREE.Object3D();
  tip.position.y = -length;
  lower.add(tip);

  parent.add(upper);
  return { upper, lower, tip };
}

function buildDummy(): DummyView {
  const group = new THREE.Group();
  const rig = new THREE.Group();
  rig.position.y = RIG_HEIGHT;
  group.add(rig);

  const body = new THREE.MeshLambertMaterial({ color: '#e5484d' });
  const dark = new THREE.MeshLambertMaterial({ color: '#23293a' });

  const part = (w: number, h: number, d: number, y: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.y = y - RIG_HEIGHT;
    rig.add(mesh);
  };
  part(0.62, 0.72, 0.34, 1.12, body);
  part(0.42, 0.4, 0.42, 1.68, dark);

  const shoulder = 1.42 - RIG_HEIGHT;
  const hip = 0.76 - RIG_HEIGHT;
  const armLeft = buildLimb(rig, -0.42, shoulder, 0.17, 0.36, body, dark);
  const armRight = buildLimb(rig, 0.42, shoulder, 0.17, 0.36, body, dark);
  const legLeft = buildLimb(rig, -0.17, hip, 0.22, 0.38, dark, dark);
  const legRight = buildLimb(rig, 0.17, hip, 0.22, 0.38, dark, dark);

  const wrap = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 2.0, 0.8),
    new THREE.MeshBasicMaterial({ color: '#b8ecff', transparent: true, opacity: 0.6 }),
  );
  wrap.position.y = 1;
  wrap.visible = false;
  group.add(wrap);

  const web = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: '#ffffff' }),
  );
  web.visible = false;

  return {
    group,
    rig,
    armLeft,
    armRight,
    legLeft,
    legRight,
    pose: bodyPose({ speed: 0, forwardSpeed: 0, verticalSpeed: 0, rope: null, time: 0 }),
    lastPos: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    wrap,
    web,
  };
}

function armMesh(sleeve: THREE.Material, glove: THREE.Material, renderOrder: number): THREE.Group {
  const arm = new THREE.Group();
  const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.5), sleeve);
  forearm.position.z = 0.12;
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.085, 0.1), glove);
  hand.position.z = -0.17;
  forearm.renderOrder = renderOrder;
  hand.renderOrder = renderOrder + 1;
  arm.add(forearm, hand);
  return arm;
}

const REST_RIGHT = new THREE.Vector3(0.34, -0.36, -0.62);
const REST_LEFT = new THREE.Vector3(-0.34, -0.36, -0.62);

export class GameView {
  readonly camera = new THREE.PerspectiveCamera(90, 1, 0.05, 420);

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight('#fff4e0', 2.4);
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringNext = new THREE.MeshBasicMaterial({ color: '#ff8a2b' });
  private readonly ringIdle = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28 });
  private readonly dummies: DummyView[] = [];
  private readonly web: THREE.Mesh;
  private readonly armRight: THREE.Group;
  private readonly armLeft: THREE.Group;
  private readonly shots: THREE.Mesh[] = [];
  private readonly shotMaterials: THREE.Material[];

  private readonly hand = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  private smoothEye = 1.62;
  private roll = 0;
  private fovBoost = 0;
  private time = 0;
  private kick = 0;

  constructor(
    canvas: HTMLCanvasElement,
    map: GameMap,
    private readonly settings: Settings,
    antialias: boolean,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The arena never moves, so its shadows are drawn once rather than every frame.
    this.renderer.shadowMap.autoUpdate = false;

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 90, 300);
    this.scene.add(new THREE.HemisphereLight('#dff0ff', '#6b7488', 1.5));

    this.sun.position.set(70, 130, 50);
    this.sun.shadow.camera.left = -100;
    this.sun.shadow.camera.right = 100;
    this.sun.shadow.camera.top = 100;
    this.sun.shadow.camera.bottom = -100;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);

    this.scene.add(buildArena(map));

    const ringGeometry = new THREE.TorusGeometry(RING_RADIUS - 0.6, 0.16, 8, 40);
    map.rings.forEach((pos, i) => {
      const ring = new THREE.Mesh(ringGeometry, this.ringIdle);
      ring.position.set(pos.x, pos.y, pos.z);
      const next = map.rings[(i + 1) % map.rings.length];
      ring.lookAt(next.x, next.y, next.z);
      this.rings.push(ring);
      this.scene.add(ring);
    });

    for (let i = 0; i < Math.max(map.patrols.length, MAX_OTHER_PLAYERS); i += 1) {
      const d = buildDummy();
      this.dummies.push(d);
      this.scene.add(d.group, d.web);
    }

    this.web = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    );
    this.web.visible = false;
    this.scene.add(this.web);

    const shotGeometry = new THREE.BoxGeometry(0.05, 0.05, SHOT_LENGTH);
    this.shotMaterials = [
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      new THREE.MeshBasicMaterial({ color: '#1fd6c4' }),
    ];
    for (let i = 0; i < MAX_SHOTS; i += 1) {
      const mesh = new THREE.Mesh(shotGeometry, this.shotMaterials[0]);
      mesh.visible = false;
      this.shots.push(mesh);
      this.scene.add(mesh);
    }

    // Arms draw on top of the world so they never clip into walls.
    const overlay = (color: string) => new THREE.MeshLambertMaterial({ color, depthTest: false });
    const sleeve = overlay('#20283c');
    const glove = overlay('#1fd6c4');
    this.armRight = armMesh(sleeve, glove, 10);
    this.armLeft = armMesh(sleeve, glove, 12);
    this.armRight.position.copy(REST_RIGHT);
    this.armLeft.position.copy(REST_LEFT);
    this.camera.add(this.armRight, this.armLeft);
    this.camera.add(new THREE.PointLight('#ffffff', 1.2, 2));
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
  }

  applySettings(): void {
    const q = QUALITY[this.settings.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
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
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Kicks the firing arm back for a moment. */
  recoil(): void {
    this.kick = 1;
  }

  /** Slow orbit of the plaza behind the main menu. */
  renderMenu(world: World, dt: number): void {
    this.time += dt;
    const a = this.time * 0.07;
    this.camera.position.set(Math.sin(a) * 34, 30, Math.cos(a) * 34);
    this.camera.lookAt(0, 16, 0);
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.armLeft.visible = false;
    this.armRight.visible = false;
    this.web.visible = false;
    this.syncWorld(world, dt);
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

    this.camera.rotation.set(pitch, yaw, this.roll);

    const speed = totalSpeed(p);
    const boostTarget = Math.min(reduce ? 4 : 20, Math.max(0, speed - 11) * (reduce ? 0.15 : 0.7));
    this.fovBoost += (boostTarget - this.fovBoost) * blend(6);
    this.camera.fov = this.settings.fov + this.fovBoost;
    this.camera.updateProjectionMatrix();

    this.armLeft.visible = true;
    this.armRight.visible = true;
    this.poseArms(p, speed, blend(14));
    this.camera.updateMatrixWorld(true);
    this.syncWorld(world, dt);
    this.drawWeb(p);
    this.drawShots(world);
    this.renderer.render(this.scene, this.camera);
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
    this.rings.forEach((ring, i) => {
      ring.visible = !world.online;
      ring.material = i === world.ringIndex ? this.ringNext : this.ringIdle;
      if (i === world.ringIndex) ring.scale.setScalar(1 + Math.sin(this.time * 5) * 0.04);
      else ring.scale.setScalar(1);
    });

    this.dummies.forEach((view, i) => {
      const d = world.dummies[i];
      view.group.visible = d !== undefined && d.respawnT === 0;
      view.web.visible = view.group.visible && !!d.anchor;
      if (!view.group.visible) return;

      view.group.position.set(d.pos.x, d.pos.y, d.pos.z);
      view.wrap.visible = d.snareT > 0;
      this.animateBody(view, d, dt);

      if (d.anchor) {
        view.group.updateMatrixWorld(true);
        const from = view.armRight.tip.getWorldPosition(this.hand);
        const to = this.tmp.set(d.anchor.x, d.anchor.y, d.anchor.z);
        view.web.position.copy(from).lerp(to, 0.5);
        view.web.scale.set(0.05, 0.05, from.distanceTo(to));
        view.web.lookAt(to);
      }
    });
  }

  private animateBody(view: DummyView, d: Dummy, dt: number): void {
    if (dt <= 0) return;

    const moved = this.tmp.copy(view.group.position).sub(view.lastPos);
    view.lastPos.copy(view.group.position);
    if (moved.length() > TELEPORT_DISTANCE) moved.set(0, 0, 0);
    // Positions arrive in steps online, so velocity is smoothed before it drives the body.
    view.velocity.lerp(moved.divideScalar(dt), 1 - Math.exp(-10 * dt));

    const speed = Math.hypot(view.velocity.x, view.velocity.z);
    if (d.yaw !== undefined) view.group.rotation.y = d.yaw;
    else if (speed > 0.5) view.group.rotation.y = Math.atan2(-view.velocity.x, -view.velocity.z);

    const yaw = view.group.rotation.y;
    const local = this.tmp.copy(view.velocity).applyAxisAngle(UP, -yaw);
    const forwardSpeed = -local.z;

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

  private drawWeb(p: Player): void {
    const anchor = p.mode === 'swing' ? p.anchor : null;
    this.web.visible = anchor !== null;
    if (!anchor) return;

    const target = this.tmp.set(anchor.x, anchor.y, anchor.z);
    this.armRight.getWorldPosition(this.hand);
    const length = this.hand.distanceTo(target);
    this.web.position.copy(this.hand).lerp(target, 0.5);
    this.web.scale.set(0.02, 0.02, length);
    this.web.lookAt(target);
  }

  private drawShots(world: World): void {
    this.shots.forEach((mesh, i) => {
      const shot = world.shots[i];
      mesh.visible = shot !== undefined;
      if (!shot) return;
      mesh.material = this.shotMaterials[shot.snare ? 1 : 0];
      mesh.position.set(shot.pos.x, shot.pos.y, shot.pos.z);
      mesh.lookAt(shot.pos.x + shot.dir.x, shot.pos.y + shot.dir.y, shot.pos.z + shot.dir.z);
    });
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
