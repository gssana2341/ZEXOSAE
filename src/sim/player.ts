// Player movement. Pure data in, pure data out, no rendering or DOM, so the
// same code can run on a future server. All speeds are metres per second.

import { AIM, dummyCenter, findAimTarget, viewForward } from './aim';
import { raycast, type Box, type GameMap, type V3 } from './map';

export { dummyCenter, viewForward };

export const TUNING = {
  radius: 0.4,
  standHeight: 1.8,
  slideHeight: 1.0,
  standEye: 1.62,
  slideEye: 0.8,

  gravity: 36,
  /** Extra weight on the way down, so jumps rise quickly and drop hard rather than float. */
  fallGravityScale: 1.3,
  maxFallSpeed: 60,
  jumpSpeed: 12.3,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,

  runSpeed: 11,
  groundAccel: 70,
  groundFriction: 45,
  overspeedDecay: 5,
  airAccel: 16,
  /** Bleeds off speed above the run speed while airborne, in m/s per second. */
  airDrag: 2,
  /** Horizontal cap. Falling has its own cap, so a long drop can't eat forward speed. */
  maxSpeed: 40,

  stepHeight: 0.55,
  vaultHeight: 1.6,

  slideMinSpeed: 6,
  slideBoost: 3.5,
  slideFriction: 3,
  slideCooldown: 0.8,

  wallMinSpeed: 6,
  wallMaxTime: 1.9,
  wallGravityScale: 0.16,
  wallAccel: 6,
  wallSpeedCap: 21,
  wallJumpOut: 8,
  wallJumpUp: 12.5,
  wallCooldown: 0.3,

  dashTime: 0.14,
  dashSpeed: 22,
  dashCooldown: 1.0,

  ropeRange: 70,
  ropeMin: 4,
  ropeHandHeight: 1.2,
  /** Instant tug toward the web point when it attaches. */
  pullStart: 8,
  /** Stronger than gravity, so a web above the player lifts them. */
  pullAccel: 56,
  pullMaxSpeed: 32,
  /** The web carries most of the weight while it pulls. */
  swingGravityScale: 0.55,
  reelSpeed: 13,
  /** The web lets go this close to its point, so the player flies past it. */
  ropeDetach: 2.2,
  /** Inside this distance, the web also lets go once the player is moving away from its point. */
  ropeFlingDistance: 6,
  /** How far the web can stretch past its length before it stops giving. */
  ropeStretch: 5,
  /** Pull back per metre of stretch, in m/s per second. */
  ropeSpring: 34,
  /** How quickly a stretched web soaks up outward speed. Lower is bouncier. */
  ropeDamping: 4,
  /** After letting go by itself, holding the button attaches again this soon. */
  ropeReattach: 0.3,
  /** Sideways push from where the camera looks while on the web. */
  lookSteer: 18,
  swingStrafe: 8,
  swingReleaseBoost: 2.5,

  /** How fast the mouse can bend the flight path while holding forward, in radians per second. */
  airTurnRate: 2.4,
  /** Above this speed the turn rate falls off, so fast flight carries more weight. */
  airTurnFullSpeed: 18,

  shotSpeed: 120,
  shotRange: 90,
  shotRadius: 0.8,
  shotCooldown: 0.28,

  /** How long a snare freezes its target. */
  snareTime: 1.2,
  snareCooldown: 2.5,
} as const;

export type Mode = 'ground' | 'air' | 'wall' | 'swing' | 'dash';

export type WebAssist = 'off' | 'near' | 'wide';

export interface TickInput {
  /** Strafe, -1 left to 1 right. */
  moveX: number;
  /** Forward, -1 back to 1 forward. */
  moveZ: number;
  yaw: number;
  pitch: number;
  /** Edge-triggered: true for the one tick the action was pressed. */
  jump: boolean;
  dash: boolean;
  shoot: boolean;
  snare: boolean;
  /** Held. */
  swing: boolean;
  slide: boolean;
  /** Lets a shot that just misses bend onto the target. */
  aimAssist: boolean;
  /** Widens aim help. 1 on a mouse, higher on touch screens. */
  aimScale: number;
  /** off: exact crosshair only. near: also just around it. wide: also anywhere ahead, for touch. */
  webAssist: WebAssist;
}

export function emptyInput(): TickInput {
  return {
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    dash: false,
    shoot: false,
    snare: false,
    swing: false,
    slide: false,
    aimAssist: true,
    aimScale: 1,
    webAssist: 'off',
  };
}

export interface Dummy {
  id: number;
  pos: V3;
  hp: number;
  snareT: number;
  respawnT: number;
  phase: number;
  dir: 1 | -1;
  /** Online only: the other player this target stands for. */
  name?: string;
  yaw?: number;
  anchor?: V3 | null;
  /** Where this target is aiming, if it is. Feeds the danger sense. */
  aim?: V3;
}

export interface Player {
  pos: V3;
  vel: V3;
  yaw: number;
  pitch: number;
  mode: Mode;
  height: number;
  sliding: boolean;

  coyoteT: number;
  jumpBufT: number;
  slideCdT: number;
  dashT: number;
  dashCdT: number;
  wallT: number;
  wallCdT: number;
  wallNormal: V3;
  wallTangent: V3;
  lastWall: Box | null;
  impactSpeed: number;

  anchor: V3 | null;
  ropeLen: number;
  ropeT: number;
  /** Where the web would attach if swing were pressed now. */
  anchorPreview: V3 | null;

  /** Time until the web can attach again after letting go by itself. */
  swingLatchT: number;

  shotCdT: number;
  snareCdT: number;
  /** Time left frozen by an enemy snare. */
  snareT: number;
  /** The dummy a shot would bend onto if fired now. */
  targetPreview: number | null;
}

export type GameEvent =
  | { type: 'shot'; origin: V3; dir: V3; snare: boolean }
  | { type: 'jump' }
  | { type: 'wallJump' }
  | { type: 'land'; speed: number };

export function createPlayer(pos: V3, yaw: number): Player {
  return {
    pos: { ...pos },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    mode: 'air',
    height: TUNING.standHeight,
    sliding: false,
    coyoteT: 0,
    jumpBufT: 0,
    slideCdT: 0,
    dashT: 0,
    dashCdT: 0,
    wallT: 0,
    wallCdT: 0,
    wallNormal: { x: 0, y: 0, z: 0 },
    wallTangent: { x: 0, y: 0, z: 0 },
    lastWall: null,
    impactSpeed: 0,
    anchor: null,
    ropeLen: 0,
    ropeT: 0,
    anchorPreview: null,
    swingLatchT: 0,
    shotCdT: 0,
    snareCdT: 0,
    snareT: 0,
    targetPreview: null,
  };
}

export const horizontalSpeed = (p: Player): number => Math.hypot(p.vel.x, p.vel.z);
export const totalSpeed = (p: Player): number => Math.hypot(p.vel.x, p.vel.y, p.vel.z);

export function eyePosition(p: Player): V3 {
  const eye = p.sliding ? TUNING.slideEye : TUNING.standEye;
  return { x: p.pos.x, y: p.pos.y + eye, z: p.pos.z };
}

function wishDirection(yaw: number, moveX: number, moveZ: number): V3 {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const x = -sin * moveZ + cos * moveX;
  const z = -cos * moveZ - sin * moveX;
  const len = Math.hypot(x, z);
  // Analog sticks may ask for less than full speed, so only clamp above 1.
  return len > 1 ? { x: x / len, y: 0, z: z / len } : { x, y: 0, z };
}

// ---------------------------------------------------------------- collision

type Axis = 'x' | 'y' | 'z';

function overlaps(p: Player, box: Box, height = p.height): boolean {
  const r = TUNING.radius;
  return (
    p.pos.x + r > box.min.x &&
    p.pos.x - r < box.max.x &&
    p.pos.y + height > box.min.y &&
    p.pos.y < box.max.y &&
    p.pos.z + r > box.min.z &&
    p.pos.z - r < box.max.z
  );
}

function spaceIsFree(map: GameMap, p: Player, x: number, y: number, z: number, height: number): boolean {
  const probe = { ...p, pos: { x, y, z } };
  return !map.boxes.some((b) => overlaps(probe, b, height));
}

const EPS = 0.001;

interface MoveResult {
  landed: boolean;
  blocked: Box | null;
}

/** Moves one axis at a time and stops at the first solid box. */
function moveAndCollide(p: Player, map: GameMap, dt: number, canStep: boolean): MoveResult {
  const result: MoveResult = { landed: false, blocked: null };
  const r = TUNING.radius;

  for (const axis of ['x', 'z', 'y'] as Axis[]) {
    const delta = p.vel[axis] * dt;
    if (delta === 0) continue;
    p.pos[axis] += delta;

    for (const box of map.boxes) {
      if (!overlaps(p, box)) continue;

      if (axis !== 'y') {
        const rise = box.max.y - p.pos.y;
        if (
          canStep &&
          rise > 0 &&
          rise <= TUNING.stepHeight &&
          spaceIsFree(map, p, p.pos.x, box.max.y + EPS, p.pos.z, p.height)
        ) {
          p.pos.y = box.max.y + EPS;
          continue;
        }
        p.pos[axis] = delta > 0 ? box.min[axis] - r - EPS : box.max[axis] + r + EPS;
        p.impactSpeed = Math.max(p.impactSpeed, horizontalSpeed(p));
        p.vel[axis] = 0;
        result.blocked = box;
      } else if (delta > 0) {
        p.pos.y = box.min.y - p.height - EPS;
        p.vel.y = 0;
      } else {
        p.pos.y = box.max.y + EPS;
        p.vel.y = 0;
        result.landed = true;
      }
    }
  }
  return result;
}

interface WallContact {
  box: Box;
  normal: V3;
}

function findRunWall(p: Player, map: GameMap): WallContact | null {
  const reach = 0.16;
  const probes: V3[] = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ];
  for (const dir of probes) {
    const probe = {
      ...p,
      pos: { x: p.pos.x + dir.x * reach, y: p.pos.y, z: p.pos.z + dir.z * reach },
    };
    for (const box of map.boxes) {
      if (box.kind === 'run' && overlaps(probe, box)) {
        return { box, normal: { x: -dir.x, y: 0, z: -dir.z } };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ aiming

/** Rings of directions around the crosshair, tightest first, in radians. */
const NEAR_RINGS = [0.07, 0.14, 0.22, 0.3];
const NEAR_SPOKES = 8;

/**
 * The web lands on the crosshair if it can. Otherwise, with assist, it takes the
 * closest point around it, so a near miss on a beam still catches.
 */
export function findAnchor(p: Player, map: GameMap, assist: WebAssist): V3 | null {
  const eye = eyePosition(p);
  const valid = (point: V3, t: number) => t > 3 && point.y > eye.y - 1;

  const direct = viewForward(p.yaw, p.pitch);
  const hit = raycast(map, eye, direct, TUNING.ropeRange);
  if (hit && valid(hit.point, hit.t)) return hit.point;
  if (assist === 'off') return null;

  for (const ring of NEAR_RINGS) {
    for (let i = 0; i < NEAR_SPOKES; i += 1) {
      // Starts straight up: a point above the player is the most useful one.
      const angle = (i / NEAR_SPOKES) * Math.PI * 2;
      const pitch = p.pitch + Math.cos(angle) * ring;
      const yaw = p.yaw + (Math.sin(angle) * ring) / Math.max(0.3, Math.cos(p.pitch));
      const h = raycast(map, eye, viewForward(yaw, pitch), TUNING.ropeRange);
      if (h && valid(h.point, h.t)) return h.point;
    }
  }
  if (assist === 'near') return null;

  let best: V3 | null = null;
  let bestScore = -Infinity;
  for (const yawOffset of [0, -0.35, 0.35, -0.7, 0.7]) {
    for (const pitch of [0.5, 0.75, 1.0, 1.25]) {
      const dir = viewForward(p.yaw + yawOffset, pitch);
      const h = raycast(map, eye, dir, TUNING.ropeRange);
      if (!h || h.t < 5 || h.point.y < eye.y + 3) continue;
      // Favour points ahead of the player at a comfortable rope length.
      const score = -Math.abs(yawOffset) * 14 - Math.abs(h.t - 24) * 0.5 - Math.abs(pitch - 0.8) * 8;
      if (score > bestScore) {
        bestScore = score;
        best = h.point;
      }
    }
  }
  return best;
}

function fire(p: Player, target: Dummy | null, snare: boolean, events: GameEvent[]): void {
  const origin = eyePosition(p);
  let dir = viewForward(p.yaw, p.pitch);
  if (target) {
    const c = dummyCenter(target);
    const len = Math.hypot(c.x - origin.x, c.y - origin.y, c.z - origin.z) || 1;
    dir = { x: (c.x - origin.x) / len, y: (c.y - origin.y) / len, z: (c.z - origin.z) / len };
  }
  events.push({ type: 'shot', origin, dir, snare });
}

// --------------------------------------------------------------- mode steps

function stepGroundVelocity(p: Player, wish: V3, dt: number): void {
  const T = TUNING;
  const speed = horizontalSpeed(p);

  if (p.sliding) {
    const next = Math.max(0, speed - T.slideFriction * dt);
    if (speed > 0) {
      p.vel.x *= next / speed;
      p.vel.z *= next / speed;
    }
    return;
  }

  const wishLen = Math.hypot(wish.x, wish.z);
  if (wishLen < 0.01) {
    const next = Math.max(0, speed - T.groundFriction * dt);
    if (speed > 0) {
      p.vel.x *= next / speed;
      p.vel.z *= next / speed;
    }
    return;
  }

  if (speed > T.runSpeed) {
    // Keep earned speed, but let the player steer it and bleed it off slowly.
    const next = Math.max(T.runSpeed, speed - T.overspeedDecay * dt);
    const steer = Math.min(1, 8 * dt);
    const nx = p.vel.x / speed + (wish.x / wishLen - p.vel.x / speed) * steer;
    const nz = p.vel.z / speed + (wish.z / wishLen - p.vel.z / speed) * steer;
    const len = Math.hypot(nx, nz) || 1;
    p.vel.x = (nx / len) * next;
    p.vel.z = (nz / len) * next;
    return;
  }

  const tx = wish.x * T.runSpeed;
  const tz = wish.z * T.runSpeed;
  const dx = tx - p.vel.x;
  const dz = tz - p.vel.z;
  const diff = Math.hypot(dx, dz);
  const step = Math.min(diff, T.groundAccel * dt);
  if (diff > 0) {
    p.vel.x += (dx / diff) * step;
    p.vel.z += (dz / diff) * step;
  }
}

/** Holding forward lets the mouse bend the flight path without changing the speed. */
function turnTowardLook(p: Player, dt: number): void {
  const speed = horizontalSpeed(p);
  if (speed < 2) return;
  const current = Math.atan2(-p.vel.x, -p.vel.z);
  let diff = p.yaw - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const limit = TUNING.airTurnRate * Math.min(1, TUNING.airTurnFullSpeed / speed) * dt;
  const next = current + Math.max(-limit, Math.min(limit, diff));
  p.vel.x = -Math.sin(next) * speed;
  p.vel.z = -Math.cos(next) * speed;
}

function stepAirVelocity(p: Player, wish: V3, dt: number): void {
  const T = TUNING;
  const before = horizontalSpeed(p);
  p.vel.x += wish.x * T.airAccel * dt;
  p.vel.z += wish.z * T.airAccel * dt;
  // Air control can steer, but it can never add speed above the run speed.
  const limit = Math.max(before - T.airDrag * dt, T.runSpeed);
  const after = horizontalSpeed(p);
  if (after > limit) {
    p.vel.x *= limit / after;
    p.vel.z *= limit / after;
  }
  p.vel.y -= T.gravity * (p.vel.y < 0 ? T.fallGravityScale : 1) * dt;
}

function enterAir(p: Player): void {
  p.mode = 'air';
  p.anchor = null;
}

function handPosition(p: Player): V3 {
  return { x: p.pos.x, y: p.pos.y + TUNING.ropeHandHeight, z: p.pos.z };
}

function startSwing(p: Player, anchor: V3): void {
  const T = TUNING;
  p.mode = 'swing';
  p.sliding = false;
  p.anchor = { ...anchor };
  p.ropeT = 0;
  const hand = handPosition(p);
  const dx = anchor.x - hand.x;
  const dy = anchor.y - hand.y;
  const dz = anchor.z - hand.z;
  p.ropeLen = Math.hypot(dx, dy, dz);
  const len = p.ropeLen || 1;
  p.vel.x += (dx / len) * T.pullStart;
  p.vel.y += (dy / len) * T.pullStart;
  p.vel.z += (dz / len) * T.pullStart;
}

/** The web reels in and pulls the player toward its point, while the camera steers sideways. */
function stepSwingVelocity(p: Player, wish: V3, dt: number): void {
  const T = TUNING;
  const a = p.anchor;
  if (!a) return;

  p.ropeT += dt;
  const hand = handPosition(p);
  const dx = a.x - hand.x;
  const dy = a.y - hand.y;
  const dz = a.z - hand.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const n = { x: dx / dist, y: dy / dist, z: dz / dist };

  // Only the part of the view across the web steers, so it can't cancel the pull.
  const look = viewForward(p.yaw, p.pitch);
  const along = look.x * n.x + look.y * n.y + look.z * n.z;
  p.vel.x += (look.x - n.x * along) * T.lookSteer * dt + wish.x * T.swingStrafe * dt;
  p.vel.y += (look.y - n.y * along) * T.lookSteer * dt;
  p.vel.z += (look.z - n.z * along) * T.lookSteer * dt + wish.z * T.swingStrafe * dt;

  const inward = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
  if (inward < T.pullMaxSpeed) {
    const add = Math.min(T.pullAccel * dt, T.pullMaxSpeed - inward);
    p.vel.x += n.x * add;
    p.vel.y += n.y * add;
    p.vel.z += n.z * add;
  }

  p.vel.y -= T.gravity * T.swingGravityScale * dt;
  p.ropeLen = Math.max(T.ropeMin, Math.min(p.ropeLen, dist) - T.reelSpeed * dt);
}

function releaseSwing(p: Player): void {
  const s = totalSpeed(p);
  if (s > 8) {
    const k = (s + TUNING.swingReleaseBoost) / s;
    p.vel.x *= k;
    p.vel.y *= k;
    p.vel.z *= k;
  }
  enterAir(p);
}

/** True once the player is clearly moving away from the web point. */
function isFlyingPast(p: Player, dist: number): boolean {
  const a = p.anchor;
  if (!a) return false;
  const hand = handPosition(p);
  const inward =
    (p.vel.x * (a.x - hand.x) + p.vel.y * (a.y - hand.y) + p.vel.z * (a.z - hand.z)) / (dist || 1);
  return inward < -totalSpeed(p) * 0.15;
}

/** Stretches like elastic past the rope length, up to a hard limit. Returns the hand's distance from the web point. */
function applyRope(p: Player, map: GameMap, dt: number): number {
  const T = TUNING;
  const a = p.anchor;
  if (!a) return Infinity;

  const hand = handPosition(p);
  const dx = hand.x - a.x;
  const dy = hand.y - a.y;
  const dz = hand.z - a.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= p.ropeLen || dist < 0.001) return dist;

  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const stretch = dist - p.ropeLen;

  const outward = p.vel.x * nx + p.vel.y * ny + p.vel.z * nz;
  const soak = outward > 0 ? outward * (1 - Math.exp(-T.ropeDamping * dt)) : 0;
  const pull = T.ropeSpring * stretch * dt + soak;
  p.vel.x -= nx * pull;
  p.vel.y -= ny * pull;
  p.vel.z -= nz * pull;

  const excess = stretch - T.ropeStretch;
  if (excess <= 0) return dist;

  // Past the limit it behaves like a solid line: cancel the outward speed and pull
  // back through collision, so the web can't drag the player inside a building.
  const left = p.vel.x * nx + p.vel.y * ny + p.vel.z * nz;
  if (left > 0) {
    p.vel.x -= nx * left;
    p.vel.y -= ny * left;
    p.vel.z -= nz * left;
  }
  const saved = { ...p.vel };
  p.vel = { x: (-nx * excess) / dt, y: (-ny * excess) / dt, z: (-nz * excess) / dt };
  moveAndCollide(p, map, dt, false);
  p.vel = saved;
  return dist - excess;
}

function clampSpeed(p: Player): void {
  const T = TUNING;
  const s = horizontalSpeed(p);
  if (s > T.maxSpeed) {
    p.vel.x *= T.maxSpeed / s;
    p.vel.z *= T.maxSpeed / s;
  }
  p.vel.y = Math.max(-T.maxFallSpeed, Math.min(T.maxSpeed, p.vel.y));
}

function tick(t: number, dt: number): number {
  return t > 0 ? Math.max(0, t - dt) : 0;
}

/** An enemy snare cuts the web and freezes the player in place. */
export function snarePlayer(p: Player): void {
  p.snareT = TUNING.snareTime;
  p.sliding = false;
  if (p.mode === 'swing' || p.mode === 'dash') enterAir(p);
}

// ---------------------------------------------------------------- main step

export function stepPlayer(
  p: Player,
  input: TickInput,
  map: GameMap,
  dummies: Dummy[],
  dt: number,
  events: GameEvent[],
): void {
  const T = TUNING;

  p.yaw = input.yaw;
  p.pitch = input.pitch;
  p.impactSpeed = 0;
  p.coyoteT = tick(p.coyoteT, dt);
  p.jumpBufT = tick(p.jumpBufT, dt);
  p.slideCdT = tick(p.slideCdT, dt);
  p.dashCdT = tick(p.dashCdT, dt);
  p.wallCdT = tick(p.wallCdT, dt);
  p.shotCdT = tick(p.shotCdT, dt);
  p.snareT = tick(p.snareT, dt);
  p.snareCdT = tick(p.snareCdT, dt);
  if (input.jump) p.jumpBufT = T.jumpBuffer;
  p.swingLatchT = input.swing ? tick(p.swingLatchT, dt) : 0;

  if (p.snareT > 0) {
    // Frozen in place, even in mid-air. The camera can still look around.
    p.vel = { x: 0, y: 0, z: 0 };
    p.anchorPreview = null;
    p.targetPreview = null;
    return;
  }

  const wish = wishDirection(p.yaw, input.moveX, input.moveZ);

  p.anchorPreview = p.mode === 'swing' ? p.anchor : findAnchor(p, map, input.webAssist);
  const target = input.aimAssist
    ? (findAimTarget(eyePosition(p), viewForward(p.yaw, p.pitch), map, dummies, AIM.magnetRadius * input.aimScale)?.dummy ?? null)
    : null;
  p.targetPreview = target ? target.id : null;

  // --- actions that change mode

  if (input.shoot && p.shotCdT === 0) {
    fire(p, target, false, events);
    p.shotCdT = T.shotCooldown;
  }
  if (input.snare && p.snareCdT === 0) {
    fire(p, target, true, events);
    p.snareCdT = T.snareCooldown;
  }

  if (input.dash && p.dashCdT === 0) {
    const flatLen = Math.hypot(wish.x, wish.z);
    const f = viewForward(p.yaw, 0);
    const dirX = flatLen > 0.1 ? wish.x / flatLen : f.x;
    const dirZ = flatLen > 0.1 ? wish.z / flatLen : f.z;
    const speed = Math.max(T.dashSpeed, horizontalSpeed(p));
    p.vel.x = dirX * speed;
    p.vel.z = dirZ * speed;
    p.vel.y = Math.max(0, p.vel.y);
    p.mode = 'dash';
    p.dashT = T.dashTime;
    p.dashCdT = T.dashCooldown;
    p.sliding = false;
    p.anchor = null;
  }

  if (input.swing && p.swingLatchT === 0 && p.mode !== 'swing' && p.mode !== 'dash' && p.anchorPreview) {
    startSwing(p, p.anchorPreview);
  }

  if (p.mode === 'swing' && !input.swing) releaseSwing(p);

  // --- jump

  const canGroundJump = p.mode === 'ground' || (p.mode === 'air' && p.coyoteT > 0);
  if (p.jumpBufT > 0 && canGroundJump) {
    p.vel.y = T.jumpSpeed;
    p.jumpBufT = 0;
    p.coyoteT = 0;
    p.sliding = false;
    p.mode = 'air';
    events.push({ type: 'jump' });
  } else if (p.jumpBufT > 0 && p.mode === 'wall') {
    // Jump where the camera looks, but never back into the wall.
    const along = Math.max(horizontalSpeed(p), T.runSpeed);
    const look = viewForward(p.yaw, 0);
    const into = Math.min(0, look.x * p.wallNormal.x + look.z * p.wallNormal.z);
    const lx = look.x - p.wallNormal.x * into;
    const lz = look.z - p.wallNormal.z * into;
    const len = Math.hypot(lx, lz);
    const dirX = len > 0.2 ? lx / len : p.wallTangent.x;
    const dirZ = len > 0.2 ? lz / len : p.wallTangent.z;
    p.vel.x = dirX * along + p.wallNormal.x * T.wallJumpOut;
    p.vel.z = dirZ * along + p.wallNormal.z * T.wallJumpOut;
    p.vel.y = T.wallJumpUp;
    p.jumpBufT = 0;
    p.wallCdT = T.wallCooldown;
    p.mode = 'air';
    events.push({ type: 'wallJump' });
  }

  // --- slide

  const speedNow = horizontalSpeed(p);
  if (input.slide && p.mode === 'ground' && !p.sliding && speedNow >= T.slideMinSpeed) {
    p.sliding = true;
    if (p.slideCdT === 0) {
      const k = (speedNow + T.slideBoost) / speedNow;
      p.vel.x *= k;
      p.vel.z *= k;
      p.slideCdT = T.slideCooldown;
    }
  }
  if (p.sliding) {
    const wantsUp = !input.slide || speedNow < 3 || p.mode !== 'ground';
    if (wantsUp && spaceIsFree(map, p, p.pos.x, p.pos.y, p.pos.z, T.standHeight)) {
      p.sliding = false;
    }
  }
  p.height = p.sliding ? T.slideHeight : T.standHeight;

  // --- integrate velocity per mode

  switch (p.mode) {
    case 'ground':
      stepGroundVelocity(p, wish, dt);
      p.vel.y -= T.gravity * dt;
      break;

    case 'air':
      stepAirVelocity(p, wish, dt);
      if (input.moveZ > 0.1) turnTowardLook(p, dt);
      break;

    case 'dash':
      p.vel.y = Math.max(0, p.vel.y - T.gravity * dt);
      p.dashT -= dt;
      if (p.dashT <= 0) enterAir(p);
      break;

    case 'wall': {
      p.wallT += dt;
      const along = p.vel.x * p.wallTangent.x + p.vel.z * p.wallTangent.z;
      const next = Math.min(T.wallSpeedCap, along + T.wallAccel * dt);
      const keep = Math.max(next, along);
      p.vel.x = p.wallTangent.x * keep;
      p.vel.z = p.wallTangent.z * keep;
      p.vel.y -= T.gravity * T.wallGravityScale * dt;
      break;
    }

    case 'swing':
      stepSwingVelocity(p, wish, dt);
      break;
  }

  clampSpeed(p);

  // --- move

  const wasGround = p.mode === 'ground';
  const fallSpeed = -p.vel.y;
  const moved = moveAndCollide(p, map, dt, wasGround);

  if (p.mode === 'swing') {
    const dist = applyRope(p, map, dt);
    if (dist < T.ropeDetach || (dist < T.ropeFlingDistance && isFlyingPast(p, dist))) {
      p.swingLatchT = T.ropeReattach;
      releaseSwing(p);
    }
  }

  // Auto-vault low ledges when running into them.
  if (
    moved.blocked &&
    (p.mode === 'ground' || p.mode === 'air') &&
    input.moveZ > 0.2 &&
    p.vel.y < 4
  ) {
    const top = moved.blocked.max.y;
    const rise = top - p.pos.y;
    if (rise > 0 && rise <= T.vaultHeight && spaceIsFree(map, p, p.pos.x, top + EPS, p.pos.z, p.height)) {
      p.vel.y = Math.sqrt(2 * T.gravity * (rise + 0.4));
      p.mode = 'air';
      p.coyoteT = 0;
    }
  }

  // --- resolve ground and wall state

  if (moved.landed) {
    if (p.mode === 'air' || p.mode === 'dash' || p.mode === 'wall') {
      if (fallSpeed > 12) events.push({ type: 'land', speed: fallSpeed });
      p.mode = 'ground';
      p.lastWall = null;
    }
    if (p.mode === 'ground') p.coyoteT = T.coyoteTime;
  } else if (wasGround && p.mode === 'ground') {
    p.mode = 'air';
    p.coyoteT = T.coyoteTime;
  }

  if (p.mode === 'air' && p.wallCdT === 0 && p.pos.y > 0.8) {
    const wall = findRunWall(p, map);
    if (wall && wall.box !== p.lastWall) {
      const tx = -wall.normal.z;
      const tz = wall.normal.x;
      const along = p.vel.x * tx + p.vel.z * tz;
      // Momentum lost to the impact is carried into the run, so a slanted
      // approach doesn't punish the player for touching the wall.
      const carried = Math.max(Math.abs(along), Math.abs(along) > 2 ? p.impactSpeed * 0.85 : 0);
      if (carried >= T.wallMinSpeed && p.vel.y > -18) {
        const sign = along >= 0 ? 1 : -1;
        p.mode = 'wall';
        p.wallT = 0;
        p.wallNormal = wall.normal;
        p.wallTangent = { x: tx * sign, y: 0, z: tz * sign };
        p.lastWall = wall.box;
        p.vel.x = p.wallTangent.x * carried;
        p.vel.z = p.wallTangent.z * carried;
        p.vel.y = Math.max(p.vel.y, 1.5);
      }
    }
  } else if (p.mode === 'wall') {
    const wall = findRunWall(p, map);
    if (!wall || p.wallT > T.wallMaxTime) {
      p.wallCdT = T.wallCooldown;
      enterAir(p);
    }
  }
}
