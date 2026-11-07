// Player movement. Pure data in, pure data out, no rendering or DOM, so the
// same code can run on a future server. All speeds are metres per second.

import { AIM, dummyCenter, findAimTarget, viewForward } from './aim';
import type { Act, HitKind } from './hits';
import type { Team } from './game-modes';
import { MAX_HP } from './hits';
import { JUMP_PAD_RADIUS, nearbyBoxes, raycast, type Box, type GameMap, type RayHit, type V3 } from './map';
import {
  applyKnock,
  findPerch,
  hardLanding,
  holdLine,
  landPound,
  MOVES,
  pressFocus,
  pressWeb,
  startDodge,
  startPound,
  stepAttackHold,
  stepCharge,
  stepHang,
  stepMoveTimers,
  stepStrike,
  stepWebHold,
  stepZip,
  tryCrate,
  tryJumpMoves,
  tryMelee,
  type CrateSpot,
  type MoveContext,
  type Perch,
} from './moves';

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
  /** Upward cap. High enough for a jump pad, which is the fastest way up. */
  maxRiseSpeed: 50,
  jumpSpeed: 12.3,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,

  /** Full stick. Part of the way is a walk, down to a stroll. */
  runSpeed: 8,
  groundAccel: 70,
  groundFriction: 45,
  overspeedDecay: 5,
  airAccel: 16,
  /** Bleeds off speed above the run speed while airborne, in m/s per second. */
  airDrag: 2,
  /** Horizontal cap. Falling has its own cap, so a long drop can't eat forward speed. */
  maxSpeed: 40,

  /** Reaches about 29 metres, which clears every edge roof. */
  padLaunchSpeed: 46,
  padCooldown: 0.6,
  /** How far above a pad the feet can be and still set it off. */
  padReach: 0.6,

  stepHeight: 0.55,
  vaultHeight: 1.6,

  slideMinSpeed: 6,
  slideBoost: 3.5,
  slideFriction: 3,
  slideCooldown: 0.8,

  /** Speed along a wall that catches it without pressing toward it. */
  wallMinSpeed: 6,
  /** Anything shorter is a kerb or a beam, not a wall. */
  wallMinHeight: 2.5,
  /** Past this falling speed, a wall can't be caught. */
  wallGripFall: 26,
  wallGravityScale: 0.16,
  /** Speed the player works up to on their own. Anything above that is momentum. */
  wallClimbSpeed: 6,
  wallClimbAccel: 34,
  /** How quickly speed along a wall fades, per second. Low, so a fast run keeps going. */
  wallDrag: 0.8,
  /** Share of gravity that slows a rise up a wall. */
  wallRiseGravityScale: 0.5,
  /** With no input the player slips down at this speed. A wall never holds them still. */
  wallSlipSpeed: 3.5,
  wallSlipBrake: 40,
  /** Share of impact speed turned into a rise when hitting a wall head on. */
  wallFling: 0.55,
  wallFlingMax: 16,
  /** Hitting a wall this fast, straight on, is too hard to hold: the player bounces off dazed. */
  wallSlamSpeed: 26,
  /** Share of the hit that throws the player back off the wall. */
  wallSlamBounce: 0.3,
  wallSlamBounceMax: 9,
  /** How long a hard hit leaves the player unable to grab, web or dash. */
  wallSlamStun: 0.7,
  /** Share of air control left while dazed. */
  stunAirControl: 0.25,
  /** Pressing this far away from the wall lets go. */
  wallLetGo: 0.6,
  wallPushOff: 4,
  /** How far up the player has to look to start climbing from the ground. */
  wallLookUp: 0.3,
  /** The hop over the top of a wall. */
  wallMantleUp: 7,
  wallMantleIn: 5,
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

  /** Fast enough that there's almost no need to lead a target, even across the arena. */
  shotSpeed: 260,
  shotRange: 90,
  shotRadius: 1.1,
  shotCooldown: 0.28,

  /** How long a snare freezes its target. */
  snareTime: 1.2,
  snareCooldown: 2.5,
} as const;

/**
 * zip: flying to a ledge. hang: on a line, climbing it or letting it out.
 * strike: zipping at someone to kick them. pound: slamming straight down.
 */
export type Mode = 'ground' | 'air' | 'wall' | 'swing' | 'dash' | 'zip' | 'hang' | 'strike' | 'pound';

/** What the body is doing, as other players see it. */
export type PoseName = Mode | 'slide' | 'stun' | Act;

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
  /** Attack: a punch up close, a web shot otherwise. */
  shoot: boolean;
  snare: boolean;
  /** The web on someone, or onto a ledge or a line. */
  web: boolean;
  /** Heal, finish, or a trick in the air. */
  focus: boolean;
  /** Held. */
  swing: boolean;
  slide: boolean;
  shootHeld: boolean;
  webHeld: boolean;
  /** Lets a shot that just misses bend onto the target. */
  aimAssist: boolean;
  /** Widens aim help. 1 on a mouse, higher on touch screens. */
  aimScale: number;
  /** Where aim starts when the view isn't at the eyes, so the crosshair stays true in third person. */
  aimFrom: V3 | null;
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
    web: false,
    focus: false,
    swing: false,
    slide: false,
    shootHeld: false,
    webHeld: false,
    aimAssist: true,
    aimScale: 1,
    aimFrom: null,
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
  team?: Team;
  /** Teammates remain visible but cannot be targeted. */
  ally?: boolean;
  yaw?: number;
  anchor?: V3 | null;
  /** Where this target is aiming, if it is. Feeds the danger sense. */
  aim?: V3;
  /** What the other player is doing, which picks their animation. */
  mode?: PoseName;
  /** Physical movement, independent of the short action animation. */
  motion?: Mode;
  /** In practice: thrown through the air by a hit, until it lands. */
  vel?: V3;
  /** In practice: dazed by a hit for this long. */
  knockT?: number;
  /** In practice: stuck to a wall it was thrown into. */
  pinned?: boolean;
  /** In practice: walking back to its path after being knocked off it. */
  homing?: boolean;
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
  wallCdT: number;
  wallNormal: V3;
  impactSpeed: number;
  /** The hardest speed straight into a wall this tick. */
  slamSpeed: number;
  /** Time left dazed after slamming into a wall. */
  stunT: number;
  padCdT: number;
  aimFrom: V3 | null;

  anchor: V3 | null;
  ropeLen: number;
  ropeT: number;
  /** Where the web would attach if swing were pressed now. */
  anchorPreview: V3 | null;

  /** Time until the web can attach again after letting go by itself. */
  swingLatchT: number;

  shotCdT: number;
  snareCdT: number;
  healCdT: number;
  /** Time left frozen by an enemy snare. */
  snareT: number;
  /** The dummy a shot would bend onto if fired now. */
  targetPreview: number | null;

  hp: number;
  /** Earned by fighting and moving well. Spent to heal or finish someone. */
  focus: number;
  /** A short move the body is making, and for how much longer. */
  act: Act | null;
  actT: number;

  /** Where a web press would zip to or hang from. */
  perch: Perch | null;
  /** Just landed on a perch: a jump now launches off it. */
  perchT: number;
  zipTarget: V3 | null;
  zipT: number;
  /** Where a web line runs to, to draw it: a ledge, a line's top, someone being pulled. */
  webLine: V3 | null;
  webLineT: number;
  /** Hanging over a roof edge: the way back over it. */
  hangIn: V3 | null;

  charge: number;
  slideHeld: boolean;
  landT: number;
  landSpeed: number;
  dodgeT: number;
  dodgeJumpT: number;

  comboStep: number;
  comboT: number;
  attackCdT: number;
  attackBufT: number;
  attackHoldT: number;
  holdUsed: boolean;
  followT: number;
  sinceHitT: number;
  lastTarget: number | null;
  lastTargetPos: V3 | null;
  webTarget: number | null;
  webHoldT: number;
  webPending: boolean;
  spinT: number;
  spins: number;
  strikeId: number | null;
  strikeT: number;
  strikeSplash: boolean;
  poundFrom: number;
  tricks: number;
  trickT: number;
  trickKind: number;
  crateCdT: number;
}

export type GameEvent =
  | { type: 'shot'; origin: V3; dir: V3; snare: boolean }
  | { type: 'jump' }
  | { type: 'wallJump' }
  | { type: 'jumpPad'; index: number }
  | { type: 'land'; speed: number }
  | { type: 'slam'; speed: number }
  | { type: 'hitTarget'; target: number; kind: HitKind; knock: V3; stun: number; pin: boolean; power: number }
  | { type: 'perfect'; what: 'release' | 'dodge' | 'hit' | 'recover' }
  | { type: 'pointLaunch' }
  | { type: 'pound'; at: V3; radius: number }
  | { type: 'finisher' }
  | { type: 'trick'; kind: number }
  | { type: 'heal'; amount: number }
  | { type: 'pullCrate'; crate: number };

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
    wallCdT: 0,
    wallNormal: { x: 0, y: 0, z: 0 },
    impactSpeed: 0,
    slamSpeed: 0,
    stunT: 0,
    padCdT: 0,
    aimFrom: null,
    anchor: null,
    ropeLen: 0,
    ropeT: 0,
    anchorPreview: null,
    swingLatchT: 0,
    shotCdT: 0,
    snareCdT: 0,
    healCdT: 0,
    snareT: 0,
    targetPreview: null,
    hp: MAX_HP,
    focus: 0,
    act: null,
    actT: 0,
    perch: null,
    perchT: 0,
    zipTarget: null,
    zipT: 0,
    webLine: null,
    webLineT: 0,
    hangIn: null,
    charge: 0,
    slideHeld: false,
    landT: 0,
    landSpeed: 0,
    dodgeT: 0,
    dodgeJumpT: 0,
    comboStep: 0,
    comboT: 0,
    attackCdT: 0,
    attackBufT: 0,
    attackHoldT: 0,
    holdUsed: false,
    followT: 0,
    sinceHitT: Infinity,
    lastTarget: null,
    lastTargetPos: null,
    webTarget: null,
    webHoldT: 0,
    webPending: false,
    spinT: 0,
    spins: 0,
    strikeId: null,
    strikeT: 0,
    strikeSplash: false,
    poundFrom: 0,
    tricks: 0,
    trickT: 0,
    trickKind: 0,
    crateCdT: 0,
  };
}

export const horizontalSpeed = (p: Player): number => Math.hypot(p.vel.x, p.vel.z);
export const totalSpeed = (p: Player): number => Math.hypot(p.vel.x, p.vel.y, p.vel.z);

/** Where shots and webs start. */
function aimPoint(p: Player): V3 {
  return p.aimFrom ?? eyePosition(p);
}

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

function overlaps(p: Pick<Player, 'pos' | 'height'>, box: Box, height = p.height): boolean {
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

export function spaceIsFree(map: GameMap, p: Pick<Player, 'pos' | 'height'>, x: number, y: number, z: number, height: number): boolean {
  const probe = { ...p, pos: { x, y, z } };
  const r = TUNING.radius;
  return !nearbyBoxes(map, x - r, z - r, x + r, z + r).some((b) => overlaps(probe, b, height));
}

const EPS = 0.001;

interface MoveResult {
  landed: boolean;
  blocked: Box | null;
  /** Which way is out of the face that blocked the move. */
  normal: V3 | null;
}

/** Moves one axis at a time and stops at the first solid box. */
export function moveAndCollide(p: Player, map: GameMap, dt: number, canStep: boolean): MoveResult {
  const result: MoveResult = { landed: false, blocked: null, normal: null };
  const r = TUNING.radius;

  for (const axis of ['x', 'z', 'y'] as Axis[]) {
    const delta = p.vel[axis] * dt;
    if (delta === 0) continue;
    const before = p.pos[axis];
    p.pos[axis] += delta;

    const minX = (axis === 'x' ? Math.min(before, p.pos.x) : p.pos.x) - r;
    const maxX = (axis === 'x' ? Math.max(before, p.pos.x) : p.pos.x) + r;
    const minZ = (axis === 'z' ? Math.min(before, p.pos.z) : p.pos.z) - r;
    const maxZ = (axis === 'z' ? Math.max(before, p.pos.z) : p.pos.z) + r;
    for (const box of nearbyBoxes(map, minX, minZ, maxX, maxZ)) {
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
        p.slamSpeed = Math.max(p.slamSpeed, Math.abs(p.vel[axis]));
        p.vel[axis] = 0;
        result.blocked = box;
        result.normal = { x: axis === 'x' ? -Math.sign(delta) : 0, y: 0, z: axis === 'z' ? -Math.sign(delta) : 0 };
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

const WALL_REACH = 0.16;
const WALL_PROBES: V3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

export function isClimbable(box: Box): boolean {
  if (box.kind === 'ground' || box.kind === 'bound' || box.kind === 'prop') return false;
  return box.max.y - box.min.y >= TUNING.wallMinHeight;
}

/**
 * Which way is out of a climbable wall next to `pos`, or null with none in reach.
 * Other players only send their mode, so this is how their bodies find the wall they hold.
 */
export function climbWallNormal(map: GameMap, pos: V3, reach = 0.45): V3 | null {
  for (const dir of WALL_PROBES) {
    const probe = { pos: { x: pos.x + dir.x * reach, y: pos.y, z: pos.z + dir.z * reach }, height: TUNING.standHeight };
    const r = TUNING.radius;
    if (nearbyBoxes(map, probe.pos.x - r, probe.pos.z - r, probe.pos.x + r, probe.pos.z + r).some((b) => isClimbable(b) && overlaps(probe, b))) return { x: -dir.x, y: 0, z: -dir.z };
  }
  return null;
}

/**
 * The wall beside the player. Touching two at once, it picks the one they are heading
 * for, which is how a climb turns an inside corner. Otherwise it stays on the same face.
 */
function findClimbWall(p: Player, map: GameMap, wish: V3): WallContact | null {
  let best: WallContact | null = null;
  let bestScore = -Infinity;
  for (const dir of WALL_PROBES) {
    const probe = {
      ...p,
      pos: { x: p.pos.x + dir.x * WALL_REACH, y: p.pos.y, z: p.pos.z + dir.z * WALL_REACH },
    };
    const r = TUNING.radius;
    const box = nearbyBoxes(map, probe.pos.x - r, probe.pos.z - r, probe.pos.x + r, probe.pos.z + r).find((b) => isClimbable(b) && overlaps(probe, b));
    if (!box) continue;

    const current = dir.x === -p.wallNormal.x && dir.z === -p.wallNormal.z;
    const heading = (p.vel.x + wish.x * TUNING.wallClimbSpeed) * dir.x + (p.vel.z + wish.z * TUNING.wallClimbSpeed) * dir.z;
    const score = heading + (current ? 0.5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { box, normal: { x: -dir.x, y: 0, z: -dir.z } };
    }
  }
  return best;
}

/** Catches a wall if the player means to. Drifting past one without pressing toward it stays a fall. */
function tryGrabWall(p: Player, map: GameMap, wish: V3): void {
  const T = TUNING;
  const wall = findClimbWall(p, map, wish);
  if (!wall || p.vel.y < -T.wallGripFall) return;

  const n = wall.normal;
  const tx = -n.z;
  const tz = n.x;
  const along = p.vel.x * tx + p.vel.z * tz;
  const pressing = -(wish.x * n.x + wish.z * n.z) > 0.3;
  // The wall can be caught just before the hit, so speed still heading in counts too.
  const into = -(p.vel.x * n.x + p.vel.z * n.z);
  if (Math.max(p.slamSpeed, into) >= T.wallSlamSpeed) {
    slamWall(p, n, Math.max(p.slamSpeed, into));
    return;
  }
  const impact = Math.max(p.impactSpeed, into);
  const glancing = Math.abs(along) >= T.wallMinSpeed && impact > 0.5;
  const leaving = p.vel.x * n.x + p.vel.z * n.z > 1;
  if (leaving || (!pressing && !glancing)) return;

  p.mode = 'wall';
  p.sliding = false;
  p.wallNormal = n;
  if (Math.abs(along) > 2) {
    // Momentum lost to the impact is carried along the wall, so a slanted
    // approach doesn't punish the player for touching it.
    const carried = Math.min(T.wallSpeedCap, Math.max(Math.abs(along), impact * 0.85));
    const sign = along >= 0 ? 1 : -1;
    p.vel.x = tx * carried * sign;
    p.vel.z = tz * carried * sign;
    p.vel.y = Math.max(p.vel.y, 1.5);
  } else {
    // Head on, the same speed throws the player up the wall instead.
    p.vel.x = tx * along;
    p.vel.z = tz * along;
    p.vel.y = Math.max(p.vel.y, 0) + Math.min(T.wallFlingMax, impact * T.wallFling);
  }
}

/**
 * Too hard a hit to hold on: the player bounces back off the wall, loses their web and
 * is dazed for a moment, so a reckless line costs something.
 */
function slamWall(p: Player, n: V3, speed: number): void {
  const T = TUNING;
  // Whatever was still heading into the wall stops. Speed along it mostly goes too.
  const into = Math.max(0, -(p.vel.x * n.x + p.vel.z * n.z));
  const out = Math.min(T.wallSlamBounceMax, speed * T.wallSlamBounce);
  p.vel.x = (p.vel.x + n.x * into) * 0.35 + n.x * out;
  p.vel.z = (p.vel.z + n.z * into) * 0.35 + n.z * out;
  p.vel.y = Math.max(0, p.vel.y * 0.3) + 2;
  p.stunT = T.wallSlamStun;
  p.slamSpeed = 0;
  p.sliding = false;
  p.dashT = 0;
  enterAir(p);
  slams.push(speed);
}

/** Slams this tick, picked up as events once the tick has its event list. */
const slams: number[] = [];

/** Moves `value` toward `target`, but never slows momentum that is already past it. */
function steer(value: number, target: number, step: number): number {
  if (target > 0 && value >= target) return value;
  if (target < 0 && value <= target) return value;
  return value + Math.max(-step, Math.min(step, target - value));
}

/**
 * On a wall the player keeps their speed and steers it, rather than being held in place:
 * where they look decides the way, momentum fades slowly, and doing nothing slips them
 * down. Pushing into the wall while facing it is climbing up.
 */
function stepWallVelocity(p: Player, input: TickInput, dt: number): void {
  const T = TUNING;
  const n = p.wallNormal;
  const tx = -n.z;
  const tz = n.x;
  const look = viewForward(p.yaw, p.pitch);
  const rightX = Math.cos(p.yaw);
  const rightZ = -Math.sin(p.yaw);

  const forward = input.moveZ;
  const facing = Math.max(0, -(look.x * n.x + look.z * n.z));
  let along = forward * (look.x * tx + look.z * tz) + input.moveX * (rightX * tx + rightZ * tz);
  let up = forward * look.y;
  // Facing the wall, pushing forward means up, unless the player is looking down it.
  if (forward > 0 && look.y > -0.35) up += forward * facing;
  const amount = Math.hypot(along, up);
  if (amount > 1) {
    along /= amount;
    up /= amount;
  }

  // Pushing the way they are already going keeps a fast wall run alive.
  let side = p.vel.x * tx + p.vel.z * tz;
  if (along * side <= 0.3) side *= Math.exp(-T.wallDrag * dt);
  if (Math.abs(along) > 0.05) side = steer(side, along * T.wallClimbSpeed, T.wallClimbAccel * dt);

  let rise = p.vel.y;
  if (rise > 0) rise -= T.gravity * T.wallRiseGravityScale * dt;
  if (Math.abs(up) > 0.05) {
    rise = steer(rise, up * T.wallClimbSpeed, T.wallClimbAccel * dt);
  } else {
    rise -= T.gravity * T.wallGravityScale * dt;
    if (rise < -T.wallSlipSpeed) rise = Math.min(-T.wallSlipSpeed, rise + T.wallSlipBrake * dt);
  }

  p.vel.x = tx * side;
  p.vel.z = tz * side;
  p.vel.y = rise;
}

/** Past the top of a wall, a climb turns into a hop onto the roof. */
function leaveWall(p: Player, input: TickInput): void {
  const T = TUNING;
  if (p.vel.y > 1 && input.moveZ > 0.1) {
    p.vel.y = Math.max(p.vel.y, T.wallMantleUp);
    p.vel.x -= p.wallNormal.x * T.wallMantleIn;
    p.vel.z -= p.wallNormal.z * T.wallMantleIn;
  }
  p.wallCdT = T.wallCooldown;
  enterAir(p);
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
  const eye = aimPoint(p);
  const valid = (h: RayHit) => h.box.kind !== 'bound' && h.t > 3 && h.point.y > eye.y - 1;

  const direct = viewForward(p.yaw, p.pitch);
  const hit = raycast(map, eye, direct, TUNING.ropeRange);
  if (hit && valid(hit)) return hit.point;
  if (assist === 'off') return null;

  for (const ring of NEAR_RINGS) {
    for (let i = 0; i < NEAR_SPOKES; i += 1) {
      // Starts straight up: a point above the player is the most useful one.
      const angle = (i / NEAR_SPOKES) * Math.PI * 2;
      const pitch = p.pitch + Math.cos(angle) * ring;
      const yaw = p.yaw + (Math.sin(angle) * ring) / Math.max(0.3, Math.cos(p.pitch));
      const h = raycast(map, eye, viewForward(yaw, pitch), TUNING.ropeRange);
      if (h && valid(h)) return h.point;
    }
  }
  if (assist === 'near') return null;

  let best: V3 | null = null;
  let bestScore = -Infinity;
  for (const yawOffset of [0, -0.35, 0.35, -0.7, 0.7]) {
    for (const pitch of [0.5, 0.75, 1.0, 1.25]) {
      const dir = viewForward(p.yaw + yawOffset, pitch);
      const h = raycast(map, eye, dir, TUNING.ropeRange);
      if (!h || h.box.kind === 'bound' || h.t < 5 || h.point.y < eye.y + 3) continue;
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
  const origin = aimPoint(p);
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
  const control = p.stunT > 0 ? T.stunAirControl : 1;
  p.vel.x += wish.x * T.airAccel * control * dt;
  p.vel.z += wish.z * T.airAccel * control * dt;
  // Air control can steer, but it can never add speed above the run speed.
  const limit = Math.max(before - T.airDrag * dt, T.runSpeed);
  const after = horizontalSpeed(p);
  if (after > limit) {
    p.vel.x *= limit / after;
    p.vel.z *= limit / after;
  }
  p.vel.y -= T.gravity * (p.vel.y < 0 ? T.fallGravityScale : 1) * dt;
}

export function enterAir(p: Player): void {
  p.mode = 'air';
  p.anchor = null;
}

export function handPosition(p: Player): V3 {
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

/**
 * Letting go of the web. At the top of the arc, past the web point and still rising
 * a little, is the sweet spot: an extra push and some focus.
 */
export function releaseSwing(p: Player, events?: GameEvent[]): void {
  const s = totalSpeed(p);
  const a = p.anchor;
  if (a && s > 12) {
    const hand = handPosition(p);
    const past = (hand.x - a.x) * p.vel.x + (hand.z - a.z) * p.vel.z > 0;
    const top = p.vel.y > -1.5 && p.vel.y < 6 && hand.y < a.y;
    if (past && top) {
      const k = (s + MOVES.apexBoost) / s;
      p.vel.x *= k;
      p.vel.y = p.vel.y * k + MOVES.apexLift;
      p.vel.z *= k;
      p.focus = Math.min(MOVES.focusMax, p.focus + 0.15);
      events?.push({ type: 'perfect', what: 'release' });
      enterAir(p);
      return;
    }
  }
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
  p.vel.y = Math.max(-T.maxFallSpeed, Math.min(T.maxRiseSpeed, p.vel.y));
}

function tick(t: number, dt: number): number {
  return t > 0 ? Math.max(0, t - dt) : 0;
}

/** An enemy snare cuts the web and freezes the player in place. */
export function snarePlayer(p: Player): void {
  p.snareT = TUNING.snareTime;
  p.sliding = false;
  p.zipTarget = null;
  p.webLine = null;
  p.webPending = false;
  if (p.mode !== 'ground' && p.mode !== 'air' && p.mode !== 'wall') enterAir(p);
}

/** What the body shows to everyone: a move in progress wins over the plain mode. */
export function poseOf(p: Player): PoseName {
  if (p.stunT > 0) return 'stun';
  if (p.act) return p.act;
  return p.sliding ? 'slide' : p.mode;
}

/** Where this player's web runs, for drawing it: the swing point, or any other line. */
export function webLineOf(p: Player): V3 | null {
  return p.mode === 'swing' ? p.anchor : p.webLine;
}

/** Another player's hit, reported by the host. */
export function knockPlayer(p: Player, map: GameMap, knock: V3, stun: number, pin: boolean): void {
  applyKnock(p, map, knock, stun, pin);
}

/** Launches a player who is on a pad. Someone on a web is passing over it, not stepping on it. */
function checkJumpPads(p: Player, map: GameMap, events: GameEvent[]): void {
  const T = TUNING;
  if (p.padCdT > 0 || p.mode === 'swing' || p.vel.y > 0) return;

  map.jumpPads.forEach((pad, index) => {
    const above = p.pos.y - pad.y;
    if (above < -0.1 || above > T.padReach) return;
    if (Math.hypot(p.pos.x - pad.x, p.pos.z - pad.z) > JUMP_PAD_RADIUS) return;

    p.vel.y = T.padLaunchSpeed;
    p.mode = 'air';
    p.sliding = false;
    p.coyoteT = 0;
    p.jumpBufT = 0;
    p.padCdT = T.padCooldown;
    events.push({ type: 'jumpPad', index });
  });
}

// ---------------------------------------------------------------- main step

export interface StepExtras {
  /** Someone is about to land a hit. A dodge now is a perfect one. */
  threatened?: boolean;
  /** Loose crates the web can fetch. */
  crates?: CrateSpot[];
  online?: boolean;
}

const NO_WISH: V3 = { x: 0, y: 0, z: 0 };

export function stepPlayer(
  p: Player,
  input: TickInput,
  map: GameMap,
  dummies: Dummy[],
  dt: number,
  events: GameEvent[],
  extras: StepExtras = {},
): void {
  const T = TUNING;
  const ctx: MoveContext = { map, dummies, events, threatened: extras.threatened ?? false, crates: extras.crates ?? [], online: extras.online ?? false };

  p.yaw = input.yaw;
  p.pitch = input.pitch;
  p.aimFrom = input.aimFrom;
  p.impactSpeed = 0;
  p.slamSpeed = 0;
  p.stunT = tick(p.stunT, dt);
  p.coyoteT = tick(p.coyoteT, dt);
  p.jumpBufT = tick(p.jumpBufT, dt);
  p.slideCdT = tick(p.slideCdT, dt);
  p.dashCdT = tick(p.dashCdT, dt);
  p.wallCdT = tick(p.wallCdT, dt);
  p.shotCdT = tick(p.shotCdT, dt);
  p.snareT = tick(p.snareT, dt);
  p.padCdT = tick(p.padCdT, dt);
  p.snareCdT = tick(p.snareCdT, dt);
  p.perchT = tick(p.perchT, dt);
  stepMoveTimers(p, dt);
  if (p.stunT > 0) p.jumpBufT = 0;
  else if (input.jump) p.jumpBufT = T.jumpBuffer;
  p.swingLatchT = input.swing ? tick(p.swingLatchT, dt) : 0;
  const slidePressed = input.slide && !p.slideHeld;
  p.slideHeld = input.slide;

  if (p.snareT > 0) {
    // Frozen in place, even in mid-air. The camera can still look around.
    p.vel = { x: 0, y: 0, z: 0 };
    p.anchorPreview = null;
    p.targetPreview = null;
    p.perch = null;
    p.webPending = false;
    return;
  }

  const wish = wishDirection(p.yaw, input.moveX, input.moveZ);

  p.anchorPreview = p.mode === 'swing' ? p.anchor : findAnchor(p, map, input.webAssist);
  const target = input.aimAssist
    ? (findAimTarget(aimPoint(p), viewForward(p.yaw, p.pitch), map, dummies, AIM.magnetRadius * input.aimScale)?.dummy ?? null)
    : null;
  p.targetPreview = target ? target.id : null;
  p.perch = target ? null : findPerch(p, map);

  // --- fighting and the web

  const canAttack = p.stunT === 0 && p.mode !== 'strike' && p.mode !== 'pound';
  if (!canAttack) p.attackBufT = 0;
  const attack = input.shoot || (p.attackBufT > 0 && p.attackCdT === 0);
  const punched = canAttack && attack && tryMelee(p, ctx, target);
  if (punched || (canAttack && input.shoot)) p.webPending = false;
  if (canAttack && input.shoot && !punched && p.shotCdT === 0) {
    fire(p, target, false, events);
    p.shotCdT = T.shotCooldown;
  }
  stepAttackHold(p, input, ctx, dt);

  if (p.stunT === 0 && input.snare && !(target === null && tryCrate(p, ctx)) && p.snareCdT === 0) {
    fire(p, target, true, events);
    p.snareCdT = T.snareCooldown;
  }

  if (input.web && p.mode !== 'strike' && p.mode !== 'pound') pressWeb(p, ctx, target);
  if (input.focus) pressFocus(p, ctx, target);

  if (input.dash && p.dashCdT === 0 && p.stunT === 0 && p.mode !== 'strike' && p.mode !== 'pound') {
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
    p.zipTarget = null;
    p.webLine = null;
    p.webPending = false;
    p.hangIn = null;
    startDodge(p, ctx, wish);
  }

  const canStartSwing = p.mode !== 'swing' && p.mode !== 'dash' && p.mode !== 'strike' && p.mode !== 'pound';
  if (input.swing && p.swingLatchT === 0 && p.stunT === 0 && canStartSwing && p.anchorPreview) {
    p.webPending = false;
    p.zipTarget = null;
    p.hangIn = null;
    startSwing(p, p.anchorPreview);
    p.webLine = null;
  }

  if (p.mode === 'swing' && !input.swing) releaseSwing(p, events);

  // --- jump

  if (!tryJumpMoves(p, ctx)) {
    const canGroundJump = p.mode === 'ground' || (p.mode === 'air' && p.coyoteT > 0);
    if (p.jumpBufT > 0 && canGroundJump) {
      p.vel.y = T.jumpSpeed;
      p.jumpBufT = 0;
      p.coyoteT = 0;
      p.sliding = false;
      p.mode = 'air';
      events.push({ type: 'jump' });
    } else if (p.jumpBufT > 0 && p.mode === 'wall') {
      // Jump where the camera looks, but never back into the wall. Looking up makes
      // it a leap up the wall rather than away from it.
      const along = Math.max(horizontalSpeed(p), T.runSpeed);
      const look = viewForward(p.yaw, 0);
      const into = Math.min(0, look.x * p.wallNormal.x + look.z * p.wallNormal.z);
      const lx = look.x - p.wallNormal.x * into;
      const lz = look.z - p.wallNormal.z * into;
      const len = Math.hypot(lx, lz);
      const dirX = len > 0.2 ? lx / len : 0;
      const dirZ = len > 0.2 ? lz / len : 0;
      const upward = Math.max(0, Math.sin(p.pitch));
      const out = T.wallJumpOut * (1 - upward * 0.75);
      p.vel.x = dirX * along + p.wallNormal.x * out;
      p.vel.z = dirZ * along + p.wallNormal.z * out;
      p.vel.y = T.wallJumpUp * (1 + upward * 0.35);
      p.jumpBufT = 0;
      p.wallCdT = T.wallCooldown;
      p.mode = 'air';
      events.push({ type: 'wallJump' });
    }
  }

  // --- slam down, crouch-charge, slide

  if (slidePressed && (p.mode === 'air' || p.mode === 'dash') && startPound(p, map)) p.webPending = false;
  stepCharge(p, input, dt);

  const speedNow = horizontalSpeed(p);
  if (input.slide && p.mode === 'ground' && !p.sliding && speedNow >= T.slideMinSpeed) {
    p.sliding = true;
    p.charge = 0;
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

  // Resolve a pending web only after movement actions have had a chance to cancel it.
  stepWebHold(p, input, ctx, dt);

  // --- integrate velocity per mode

  switch (p.mode) {
    case 'ground':
      stepGroundVelocity(p, p.charge > 0 ? NO_WISH : wish, dt);
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

    case 'wall':
      if (wish.x * p.wallNormal.x + wish.z * p.wallNormal.z > T.wallLetGo) {
        p.vel.x += p.wallNormal.x * T.wallPushOff;
        p.vel.z += p.wallNormal.z * T.wallPushOff;
        p.wallCdT = T.wallCooldown;
        enterAir(p);
        stepAirVelocity(p, wish, dt);
      } else {
        stepWallVelocity(p, input, dt);
      }
      break;

    case 'swing':
      stepSwingVelocity(p, wish, dt);
      break;

    case 'zip':
      stepZip(p, dt);
      break;

    case 'strike':
      stepStrike(p, ctx, dt);
      break;

    case 'pound':
      p.vel = { x: 0, y: -MOVES.poundSpeed, z: 0 };
      break;

    case 'hang':
      stepHang(p, input, wishDirection(p.yaw, input.moveX, 0), map, dt);
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
      releaseSwing(p, events);
    }
  }

  if (p.mode === 'hang') {
    holdLine(p, (offset) => {
      const saved = { ...p.vel };
      p.vel = { x: offset.x / dt, y: offset.y / dt, z: offset.z / dt };
      moveAndCollide(p, map, dt, false);
      p.vel = saved;
    });
  }

  if (p.mode === 'zip' && p.zipTarget) {
    const t = p.zipTarget;
    const flat = Math.hypot(t.x - p.pos.x, t.z - p.pos.z);
    if (p.pos.y >= t.y - 0.1 && flat < MOVES.pointZipArrive) {
      // Step onto the ledge itself, not the air just short of it.
      if (spaceIsFree(map, p, t.x, t.y, t.z, T.standHeight)) p.pos = { ...t };
      else p.pos.y = Math.max(p.pos.y, t.y);
      p.mode = 'ground';
      p.vel = { x: 0, y: 0, z: 0 };
      p.zipTarget = null;
      p.webLine = null;
      p.perchT = MOVES.pointLaunchWindow;
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

  // Smashing into a wall mid-swing, mid-dash or mid-air is too hard to hold.
  const flying = p.mode === 'air' || p.mode === 'swing' || p.mode === 'dash';
  if (moved.normal && flying && p.slamSpeed >= T.wallSlamSpeed) {
    slamWall(p, moved.normal, p.slamSpeed);
  }
  for (const speed of slams.splice(0)) events.push({ type: 'slam', speed });

  checkJumpPads(p, map, events);

  // --- resolve ground and wall state

  if (moved.landed) {
    if (p.mode === 'pound') {
      landPound(p, ctx);
      events.push({ type: 'land', speed: fallSpeed });
    } else if (
      p.mode === 'air' ||
      p.mode === 'dash' ||
      p.mode === 'wall' ||
      p.mode === 'zip' ||
      // Still standing on the roof a line hangs over isn't the end of the line.
      (p.mode === 'hang' && p.anchor !== null && p.pos.y < p.anchor.y - 1.5)
    ) {
      if (fallSpeed > 12) events.push({ type: 'land', speed: fallSpeed });
      if (p.mode === 'air' || p.mode === 'dash') hardLanding(p, fallSpeed);
      p.mode = 'ground';
      p.zipTarget = null;
      p.webLine = null;
      p.hangIn = null;
    }
    if (p.mode === 'ground') p.coyoteT = T.coyoteTime;
  } else if (wasGround && p.mode === 'ground') {
    p.mode = 'air';
    p.coyoteT = T.coyoteTime;
  }

  const lookingUpAWall = p.mode === 'ground' && moved.blocked && input.moveZ > 0.2 && p.pitch > T.wallLookUp;
  if (p.wallCdT === 0 && p.stunT === 0 && ((p.mode === 'air' && p.pos.y > 0.8) || lookingUpAWall)) {
    tryGrabWall(p, map, wish);
    for (const speed of slams.splice(0)) events.push({ type: 'slam', speed });
  } else if (p.mode === 'wall') {
    const wall = findClimbWall(p, map, wish);
    if (wall) p.wallNormal = wall.normal;
    else leaveWall(p, input);
  }
}
