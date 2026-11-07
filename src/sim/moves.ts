// Everything the web and fists do beyond a plain swing: zips, perches, hanging on a
// line, charged jumps, hard landings, dodges and the fight moves. Pure simulation,
// like player.ts, which calls into here once per tick.

import { dummyCenter, findAimTarget, viewForward } from './aim';
import type { Act, HitKind } from './hits';
import { MAX_HP } from './hits';
import { nearbyBoxes, raycast, type GameMap, type V3 } from './map';
import {
  enterAir,
  eyePosition,
  handPosition,
  horizontalSpeed,
  isClimbable,
  releaseSwing,
  spaceIsFree,
  TUNING,
  type Dummy,
  type GameEvent,
  type Player,
  type TickInput,
} from './player';

export const MOVES = {
  // Zipping to a ledge and pushing off it.
  perchRange: 60,
  perchMinDistance: 5,
  pointZipSpeed: 34,
  /** The pull starts at this speed and builds at this rate. */
  pointZipStart: 12,
  pointZipAccel: 70,
  /** The longest a zip can take before giving up. */
  pointZipTime: 2.5,
  /** Close enough to count as arrived. */
  pointZipArrive: 1.6,
  /** Arriving, the player hops over the edge with this much speed carried on. */
  pointZipCarry: 7,
  pointZipHop: 3.5,
  pointLaunchSpeed: 26,
  pointLaunchUp: 11,
  /** Just after landing on a perch, a jump still launches off it. */
  pointLaunchWindow: 0.3,

  // Hanging on a line: from a beam overhead, or down over a roof edge.
  rappelSpeed: 6,
  hangMin: 1.2,
  hangMax: 45,
  hangSwing: 10,
  hangDamping: 0.6,
  /** Looking this far down at a roof edge drops over it on a line. */
  rappelLookDown: -0.45,

  // Crouch to charge a jump.
  chargeTime: 0.8,
  chargeBoost: 0.9,
  chargeMin: 0.15,

  // A hard landing slows the player, unless they jump straight out of it.
  hardLanding: 28,
  landLag: 0.35,
  landKeep: 0.35,
  recoverUp: 1.1,
  recoverKeep: 0.9,

  // Letting go of a web at the top of the arc.
  apexBoost: 4,
  apexLift: 2,
  jumpRelease: 6,

  // Dodges.
  dodgeSafe: 0.25,
  perfectDodgeSafe: 0.9,
  perfectDodgeSpeed: 1.15,
  dodgeJumpWindow: 0.25,
  dodgeJumpKeep: 1.1,

  // Fists and feet.
  meleeRange: 3.2,
  comboWindow: 0.7,
  attackCooldown: 0.22,
  heavyCooldown: 0.36,
  attackBuffer: 0.2,
  holdTime: 0.3,
  lungeStop: 1.4,
  lungeSpeed: 12,
  airFollowRange: 9,
  airFollowSpeed: 24,
  airFollowWindow: 1.2,
  jumpAwayWindow: 0.45,
  perfectHitWindow: 0.12,

  // The web on another player.
  webRange: 35,
  webHold: 0.22,
  strikeSpeed: 32,
  strikeReach: 1.6,
  strikeTime: 1,
  strikeSplash: 3,

  // The elastic web on someone or something.
  /** Shorter than this, a press is a tap: one tug in. */
  tetherTap: 0.18,
  /** The longest anything can be held on the web. */
  tetherTime: 3.5,
  /** Held things hang this far out along the view. */
  tetherHold: 5.5,
  tugEvery: 0.1,
  /** Pull speed per metre of stretch, and the most it can be. */
  tugSpring: 3.2,
  tugMax: 22,
  yankSpeed: 18,
  flingSpeed: 18,
  wallPounceRange: 25,
  spinWindow: 0.6,
  spinMax: 3,

  // Slamming down from above.
  poundMinHeight: 3,
  poundSpeed: 38,

  // Focus, earned by fighting and moving well.
  focusMax: 3,
  finisherCost: 2,
  healCost: 1,
  healAmount: 35,
  healCooldown: 3,
  trickTime: 0.6,
  tricksPerJump: 3,

  crateRange: 45,
  crateCooldown: 1,
} as const;

/** Focus earned for each thing done well. */
const FOCUS = {
  hit: 0.1,
  airHit: 0.2,
  perfectHit: 0.08,
  perfectDodge: 0.5,
  perfectRelease: 0.15,
  recover: 0.1,
  trick: 0.15,
  pound: 0.2,
  strike: 0.15,
} as const;

/** How long each act shows on the body. */
export const ACT_TIME: Record<Act, number> = {
  jab: 0.25,
  cross: 0.25,
  kick: 0.35,
  launch: 0.4,
  strike: 0.4,
  cast: 0.3,
  pound: 0.4,
  finisher: 0.5,
  trick: 0.6,
  charge: 0.1,
  hang: 0.1,
  zip: 0.3,
  dodgeL: 0.35,
  dodgeR: 0.35,
  heal: 0.6,
};

/** Something loose the web can grab: a crate or a parked car. */
export interface CrateSpot {
  id: number;
  pos: V3;
  /** How far off the crosshair still catches it, in metres. */
  size: number;
}

export interface MoveContext {
  map: GameMap;
  dummies: Dummy[];
  events: GameEvent[];
  /** Someone is about to land a hit on the player. A dodge now is a perfect one. */
  threatened: boolean;
  crates: CrateSpot[];
  online: boolean;
}

/** Where a web press would take the player: up onto a ledge, or onto a line under a beam. */
export interface Perch {
  point: V3;
  hang: boolean;
}

function tick(t: number, dt: number): number {
  return t > 0 ? Math.max(0, t - dt) : 0;
}

function setAct(p: Player, act: Act): void {
  p.act = act;
  p.actT = ACT_TIME[act];
}

function gainFocus(p: Player, amount: number): void {
  p.focus = Math.min(MOVES.focusMax, p.focus + amount);
}

function flatDir(from: V3, to: V3): V3 {
  const x = to.x - from.x;
  const z = to.z - from.z;
  const len = Math.hypot(x, z);
  return len > 0.001 ? { x: x / len, y: 0, z: z / len } : { x: 0, y: 0, z: 0 };
}

function dirTo(from: V3, to: V3): { dir: V3; dist: number } {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  const dist = Math.hypot(x, y, z);
  return { dir: dist > 0.001 ? { x: x / dist, y: y / dist, z: z / dist } : { x: 0, y: 0, z: 0 }, dist };
}

const chest = (p: Player): V3 => ({ x: p.pos.x, y: p.pos.y + 1, z: p.pos.z });

/** Height above whatever is under the player, up to 50 metres. */
export function heightAboveGround(p: Player, map: GameMap): number {
  const hit = raycast(map, { x: p.pos.x, y: p.pos.y + 0.1, z: p.pos.z }, { x: 0, y: -1, z: 0 }, 50);
  return hit ? hit.t - 0.1 : 50;
}

const airborne = (p: Player): boolean => p.mode === 'air' || p.mode === 'dash' || p.mode === 'swing';

function hitTarget(
  p: Player,
  ctx: MoveContext,
  d: Dummy,
  kind: HitKind,
  knock: V3,
  stun: number,
  pin = false,
  power = 1,
): void {
  ctx.events.push({ type: 'hitTarget', target: d.id, kind, knock, stun, pin, power });
  p.sinceHitT = 0;
  p.lastTarget = d.id;
  p.lastTargetPos = { ...d.pos };
}

function findTarget(ctx: MoveContext, id: number | null): Dummy | null {
  if (id === null) return null;
  return ctx.dummies.find((d) => d.id === id && d.respawnT === 0) ?? null;
}

// ------------------------------------------------------------------ timers

/** Counts down every move's clock. Called once per tick before anything acts. */
export function stepMoveTimers(p: Player, dt: number): void {
  p.attackCdT = tick(p.attackCdT, dt);
  p.attackBufT = tick(p.attackBufT, dt);
  p.comboT = tick(p.comboT, dt);
  p.followT = tick(p.followT, dt);
  p.spinT = tick(p.spinT, dt);
  p.dodgeT = tick(p.dodgeT, dt);
  p.dodgeJumpT = tick(p.dodgeJumpT, dt);
  p.landT = tick(p.landT, dt);
  p.trickT = tick(p.trickT, dt);
  p.crateCdT = tick(p.crateCdT, dt);
  p.healCdT = tick(p.healCdT, dt);
  p.sinceHitT += dt;
  p.actT = tick(p.actT, dt);
  if (p.actT === 0) p.act = null;
  p.webLineT = tick(p.webLineT, dt);
  if (p.webLineT === 0 && p.mode !== 'zip' && p.mode !== 'hang' && p.mode !== 'strike') p.webLine = null;

  // Anything that holds the player up gives the mid-air tricks back.
  if (p.mode === 'ground' || p.mode === 'wall' || p.mode === 'swing' || p.mode === 'hang') {
    p.tricks = 0;
  }
}

// ------------------------------------------------------------------ perches

/**
 * What a web press would do with no one in its sights. A wall or roof means zipping up
 * onto its top edge. The underside of a beam means hanging from it.
 */
export function findPerch(p: Player, map: GameMap): Perch | null {
  const eye = p.aimFrom ?? eyePosition(p);
  const hit = raycast(map, eye, viewForward(p.yaw, p.pitch), MOVES.perchRange);
  if (!hit || hit.t < MOVES.perchMinDistance) return null;
  const box = hit.box;
  if (box.kind === 'bound' || box.kind === 'ground') return null;

  if (Math.abs(hit.point.y - box.min.y) < 0.05 && box.min.y > eye.y) {
    return { point: hit.point, hang: true };
  }
  if (!isClimbable(box) && box.kind !== 'beam') return null;

  const inset = 0.6;
  const point = {
    x: clampInto(hit.point.x, box.min.x, box.max.x, inset),
    y: box.max.y,
    z: clampInto(hit.point.z, box.min.z, box.max.z, inset),
  };
  if (point.y < eye.y - 8) return null;
  if (!spaceIsFree(map, p, point.x, point.y + 0.05, point.z, TUNING.standHeight)) return null;
  return { point, hang: false };
}

function clampInto(v: number, min: number, max: number, inset: number): number {
  if (max - min <= inset * 2) return (min + max) / 2;
  return Math.max(min + inset, Math.min(max - inset, v));
}

/** The edge of whatever the player stands on, just past it in the way they look. */
function findEdge(p: Player, map: GameMap): { point: V3; out: V3 } | null {
  const f = viewForward(p.yaw, 0);
  const supported = (x: number, z: number) =>
    nearbyBoxes(map, x, z, x, z).some(
      (b) =>
        b.kind !== 'bound' &&
        x >= b.min.x &&
        x <= b.max.x &&
        z >= b.min.z &&
        z <= b.max.z &&
        b.max.y <= p.pos.y + 0.1 &&
        b.max.y >= p.pos.y - 0.6,
    );
  for (let s = 0.3; s <= 3.5; s += 0.25) {
    const x = p.pos.x + f.x * s;
    const z = p.pos.z + f.z * s;
    if (!supported(x, z)) {
      // A drop worth hanging over, not a step down.
      const below = raycast(map, { x, y: p.pos.y - 0.2, z }, { x: 0, y: -1, z: 0 }, 4);
      if (below) return null;
      return { point: { x, y: p.pos.y + 0.1, z }, out: f };
    }
  }
  return null;
}

// ------------------------------------------------------------------ zips

function startPointZip(p: Player, point: V3): void {
  p.mode = 'zip';
  p.sliding = false;
  p.anchor = null;
  p.zipTarget = { x: point.x, y: point.y + 0.05, z: point.z };
  p.zipT = MOVES.pointZipTime;
  p.webLine = { ...point };
  setAct(p, 'zip');
}

/** Flies straight at the ledge. Hitting its wall on the way, the climb carries on up the face. */
export function stepZip(p: Player, dt: number): void {
  const t = p.zipTarget;
  p.zipT -= dt;
  if (!t || p.zipT <= 0) {
    p.zipTarget = null;
    p.webLine = null;
    enterAir(p);
    return;
  }
  // Aim above the ledge while it's far off and settle onto it as it nears, so the
  // path bows upward like a pull on a line rather than running dead straight.
  const flat = Math.hypot(t.x - p.pos.x, t.z - p.pos.z);
  const aim = { x: t.x, y: t.y + 1.2 + Math.min(4, flat * 0.08), z: t.z };
  const { dir, dist } = dirTo(p.pos, aim);
  // Picks up speed after the pull starts, and eases off just before the ledge.
  const elapsed = MOVES.pointZipTime - p.zipT;
  const speed = Math.min(MOVES.pointZipSpeed, MOVES.pointZipStart + elapsed * MOVES.pointZipAccel, MOVES.pointZipCarry + dist * 2.2);
  p.vel = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };
}

// ------------------------------------------------------------------ hanging

function startHang(p: Player, anchor: V3, length: number, edgeIn: V3 | null): void {
  p.mode = 'hang';
  p.sliding = false;
  p.anchor = { ...anchor };
  p.webLine = { ...anchor };
  p.ropeLen = Math.max(MOVES.hangMin, Math.min(MOVES.hangMax, length));
  p.hangIn = edgeIn;
  setAct(p, 'hang');
}

/** On a line: forward climbs it, back lets more out, sideways swings. */
export function stepHang(p: Player, input: TickInput, sideWish: V3, map: GameMap, dt: number): void {
  p.ropeLen = Math.max(MOVES.hangMin, Math.min(MOVES.hangMax, p.ropeLen - input.moveZ * MOVES.rappelSpeed * dt));
  p.vel.x += sideWish.x * MOVES.hangSwing * dt;
  p.vel.z += sideWish.z * MOVES.hangSwing * dt;
  p.vel.y -= TUNING.gravity * dt;
  const keep = Math.exp(-MOVES.hangDamping * dt);
  p.vel.x *= keep;
  p.vel.y *= keep;
  p.vel.z *= keep;
  setAct(p, 'hang');

  // At the top of a line hung over an edge, climbing on pulls the player back over it.
  if (p.hangIn && p.anchor && p.ropeLen <= MOVES.hangMin + 0.05 && input.moveZ > 0.3) {
    const over = { x: p.anchor.x - p.hangIn.x * 0.9, y: p.anchor.y + 0.5, z: p.anchor.z - p.hangIn.z * 0.9 };
    const floor = raycast(map, over, { x: 0, y: -1, z: 0 }, 1.5);
    const top = { ...over, y: floor ? floor.point.y + 0.001 : p.anchor.y };
    if (spaceIsFree(map, p, top.x, top.y, top.z, TUNING.standHeight)) {
      p.pos = top;
      // A touch of downward speed, so this tick's move finds the floor.
      p.vel = { x: 0, y: -1, z: 0 };
      p.mode = 'ground';
      p.anchor = null;
      p.webLine = null;
      p.hangIn = null;
    }
  }
}

/** Keeps the hand on the line: never further from its point than the line is long. */
export function holdLine(p: Player, correct: (offset: V3) => void): void {
  const a = p.anchor;
  if (!a) return;
  const hand = handPosition(p);
  const { dir, dist } = dirTo(a, hand);
  if (dist <= p.ropeLen) return;
  const outward = p.vel.x * dir.x + p.vel.y * dir.y + p.vel.z * dir.z;
  if (outward > 0) {
    p.vel.x -= dir.x * outward;
    p.vel.y -= dir.y * outward;
    p.vel.z -= dir.z * outward;
  }
  const excess = dist - p.ropeLen;
  correct({ x: -dir.x * excess, y: -dir.y * excess, z: -dir.z * excess });
}

// ------------------------------------------------------------------ jumping

/**
 * Every move a jump press can mean, most specific first. Returns true if the press was
 * used, so the plain ground and wall jumps don't also fire.
 */
export function tryJumpMoves(p: Player, ctx: MoveContext): boolean {
  if (p.jumpBufT <= 0 || p.stunT > 0) return false;
  const T = TUNING;
  const used = () => {
    p.jumpBufT = 0;
    p.coyoteT = 0;
    p.sliding = false;
    return true;
  };

  if (p.mode === 'swing') {
    releaseSwing(p, ctx.events);
    p.vel.y += MOVES.jumpRelease;
    p.swingLatchT = T.ropeReattach;
    ctx.events.push({ type: 'jump' });
    return used();
  }

  if (p.mode === 'zip' || (p.perchT > 0 && (p.mode === 'ground' || p.mode === 'air'))) {
    const t = p.zipTarget ?? p.pos;
    const f = p.mode === 'zip' ? flatDir(p.pos, t) : viewForward(p.yaw, 0);
    const dir = Math.hypot(f.x, f.z) > 0.1 ? f : viewForward(p.yaw, 0);
    p.vel = { x: dir.x * MOVES.pointLaunchSpeed, y: MOVES.pointLaunchUp, z: dir.z * MOVES.pointLaunchSpeed };
    p.zipTarget = null;
    p.webLine = null;
    p.perchT = 0;
    enterAir(p);
    ctx.events.push({ type: 'pointLaunch' });
    return used();
  }

  if (p.mode === 'hang') {
    p.vel.y = Math.max(p.vel.y, 0) + 8;
    p.webLine = null;
    p.hangIn = null;
    enterAir(p);
    ctx.events.push({ type: 'jump' });
    return used();
  }

  if (p.sinceHitT < MOVES.jumpAwayWindow && p.lastTargetPos && p.mode !== 'wall') {
    const away = flatDir(p.lastTargetPos, p.pos);
    p.vel = { x: away.x * 9, y: 11, z: away.z * 9 };
    p.sinceHitT = Infinity;
    enterAir(p);
    setAct(p, 'trick');
    ctx.events.push({ type: 'jump' });
    return used();
  }

  if (p.dodgeJumpT > 0 && (p.mode === 'dash' || p.mode === 'ground')) {
    const k = MOVES.dodgeJumpKeep;
    p.vel.x *= k;
    p.vel.z *= k;
    p.vel.y = T.jumpSpeed;
    p.dodgeJumpT = 0;
    p.dashT = 0;
    enterAir(p);
    ctx.events.push({ type: 'jump' });
    return used();
  }

  if (p.mode === 'ground' && p.landT > 0) {
    const flat = horizontalSpeed(p);
    const want = p.landSpeed * MOVES.recoverKeep;
    if (flat > 0.1 && want > flat) {
      p.vel.x *= want / flat;
      p.vel.z *= want / flat;
    }
    p.vel.y = T.jumpSpeed * MOVES.recoverUp;
    p.landT = 0;
    p.mode = 'air';
    gainFocus(p, FOCUS.recover);
    ctx.events.push({ type: 'perfect', what: 'recover' });
    return used();
  }

  if (p.mode === 'ground' && p.charge >= MOVES.chargeMin) {
    p.vel.y = T.jumpSpeed * (1 + p.charge * MOVES.chargeBoost);
    p.charge = 0;
    p.mode = 'air';
    ctx.events.push({ type: 'jump' });
    return used();
  }

  return false;
}

/** Crouching still charges a bigger jump. */
export function stepCharge(p: Player, input: TickInput, dt: number): void {
  const charging = p.mode === 'ground' && input.slide && !p.sliding && horizontalSpeed(p) < TUNING.slideMinSpeed;
  if (charging) {
    p.charge = Math.min(1, p.charge + dt / MOVES.chargeTime);
    setAct(p, 'charge');
  } else {
    p.charge = Math.max(0, p.charge - dt * 3);
  }
}

/** Landing hard knocks the speed out of the player, unless they jump out of it in time. */
export function hardLanding(p: Player, fallSpeed: number): void {
  if (fallSpeed < MOVES.hardLanding) return;
  p.landSpeed = horizontalSpeed(p);
  p.landT = MOVES.landLag;
  p.vel.x *= MOVES.landKeep;
  p.vel.z *= MOVES.landKeep;
}

// ------------------------------------------------------------------ dodging

/** A dash is a dodge. Right before a hit lands, it's a perfect one. */
export function startDodge(p: Player, ctx: MoveContext, wish: V3): void {
  const perfect = ctx.threatened;
  p.dodgeT = perfect ? MOVES.perfectDodgeSafe : MOVES.dodgeSafe;
  p.dodgeJumpT = MOVES.dodgeJumpWindow;
  if (perfect) {
    p.vel.x *= MOVES.perfectDodgeSpeed;
    p.vel.z *= MOVES.perfectDodgeSpeed;
    gainFocus(p, FOCUS.perfectDodge);
    ctx.events.push({ type: 'perfect', what: 'dodge' });
  }
  const right = { x: Math.cos(p.yaw), z: -Math.sin(p.yaw) };
  const side = wish.x * right.x + wish.z * right.z;
  if (Math.abs(side) > 0.5) setAct(p, side > 0 ? 'dodgeR' : 'dodgeL');
}

// ------------------------------------------------------------------ fighting

/** Someone close enough to punch: whoever is in the crosshair, else the nearest one ahead. */
function targetVisible(p: Player, map: GameMap, d: Dummy): boolean {
  const from = chest(p);
  const { dir, dist } = dirTo(from, dummyCenter(d));
  return dist < 0.001 || !raycast(map, from, dir, dist);
}

export function findMeleeTarget(p: Player, map: GameMap, dummies: Dummy[], range: number, preferred: Dummy | null): Dummy | null {
  const body = chest(p);
  const reach = (d: Dummy) => dirTo(body, dummyCenter(d)).dist;
  if (preferred && preferred.respawnT === 0 && reach(preferred) <= range && targetVisible(p, map, preferred)) return preferred;

  const f = viewForward(p.yaw, 0);
  let best: Dummy | null = null;
  let bestScore = Infinity;
  for (const d of dummies) {
    if (d.respawnT > 0) continue;
    const { dir, dist } = dirTo(body, dummyCenter(d));
    if (dist > range) continue;
    if (!targetVisible(p, map, d)) continue;
    const flat = Math.hypot(dir.x, dir.z) || 1;
    const facing = (dir.x * f.x + dir.z * f.z) / flat;
    if (dist > 1.8 && facing < 0.3) continue;
    const score = dist - facing * 1.5;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * The attack button, near someone. Taps run a four-hit combo whose last hit sends them
 * flying. In the air, hits keep both players up. From a wall, it pounces.
 * Returns false when no one is close, so the press becomes a web shot instead.
 */
export function tryMelee(p: Player, ctx: MoveContext, aimed: Dummy | null): boolean {
  if (p.stunT > 0) return false;

  if (p.mode === 'wall') {
    const target = findMeleeTarget(p, ctx.map, ctx.dummies, MOVES.wallPounceRange, aimed);
    if (!target) return false;
    startStrike(p, target, true);
    return true;
  }

  const inAir = airborne(p) || p.mode === 'zip' || p.mode === 'hang';
  const range = inAir && p.followT > 0 ? MOVES.airFollowRange : MOVES.meleeRange;
  const target = findMeleeTarget(p, ctx.map, ctx.dummies, range, aimed);
  if (!target) return false;
  if (p.attackCdT > 0) {
    p.attackBufT = MOVES.attackBuffer;
    return true;
  }

  if (p.mode === 'swing') releaseSwing(p, ctx.events);
  if (p.mode === 'zip' || p.mode === 'hang') enterAir(p);
  p.attackBufT = 0;

  if (p.sinceHitT < MOVES.perfectHitWindow) {
    gainFocus(p, FOCUS.perfectHit);
    ctx.events.push({ type: 'perfect', what: 'hit' });
  }

  const step = p.comboT > 0 ? (p.comboStep + 1) % 4 : 0;
  p.comboStep = step;
  p.comboT = MOVES.comboWindow;
  const last = step === 3;
  p.attackCdT = last ? MOVES.heavyCooldown : MOVES.attackCooldown;

  const body = chest(p);
  const { dir, dist } = dirTo(body, dummyCenter(target));
  const flat = flatDir(body, dummyCenter(target));
  // Close the gap, so a combo sticks.
  if (dist > MOVES.lungeStop) {
    const fast = inAir && dist > MOVES.meleeRange;
    const speed = Math.min(fast ? MOVES.airFollowSpeed : MOVES.lungeSpeed, (dist - MOVES.lungeStop) / 0.08);
    p.vel.x = (fast ? dir.x : flat.x) * speed;
    p.vel.z = (fast ? dir.z : flat.z) * speed;
    if (fast) p.vel.y = dir.y * speed;
  } else if (inAir) {
    p.vel.x *= 0.3;
    p.vel.z *= 0.3;
  }
  if (inAir) {
    p.vel.y = Math.max(p.vel.y, 2);
    p.mode = 'air';
  }

  let knock: V3;
  let stun: number;
  if (inAir) {
    knock = last ? { x: flat.x * 16, y: 5, z: flat.z * 16 } : { x: flat.x * 2, y: 4.5, z: flat.z * 2 };
    stun = last ? 0.7 : 0.5;
  } else {
    knock = last ? { x: flat.x * 14, y: 6, z: flat.z * 14 } : { x: flat.x * 3, y: 0, z: flat.z * 3 };
    stun = last ? 0.7 : 0.35;
  }
  hitTarget(p, ctx, target, last ? 'heavy' : 'melee', knock, stun);
  setAct(p, (['jab', 'cross', 'jab', 'kick'] as const)[step]);
  gainFocus(p, inAir ? FOCUS.airHit : FOCUS.hit);
  p.holdUsed = false;
  return true;
}

/** Holding the attack button after a hit: a launcher on the ground, a big kick in the air. */
export function stepAttackHold(p: Player, input: TickInput, ctx: MoveContext, dt: number): void {
  if (!input.shootHeld) {
    p.attackHoldT = 0;
    p.holdUsed = false;
    return;
  }
  if (p.stunT > 0 || p.mode === 'strike' || p.mode === 'pound') {
    p.attackHoldT = 0;
    p.holdUsed = true;
    return;
  }
  p.attackHoldT += dt;
  if (p.holdUsed || p.attackHoldT < MOVES.holdTime || p.sinceHitT > MOVES.holdTime + 0.3) return;
  const target = findTarget(ctx, p.lastTarget);
  if (!target || dirTo(chest(p), dummyCenter(target)).dist > MOVES.meleeRange + 1 || !targetVisible(p, ctx.map, target)) return;
  p.holdUsed = true;

  const flat = flatDir(p.pos, target.pos);
  if (p.mode === 'ground') {
    hitTarget(p, ctx, target, 'launch', { x: flat.x, y: 15, z: flat.z }, 1.1);
    p.vel = { x: 0, y: 13.5, z: 0 };
    p.mode = 'air';
    p.followT = MOVES.airFollowWindow;
    setAct(p, 'launch');
  } else {
    hitTarget(p, ctx, target, 'heavy', { x: flat.x * 10, y: 11, z: flat.z * 10 }, 0.8);
    setAct(p, 'kick');
  }
  gainFocus(p, FOCUS.airHit);
  p.comboT = 0;
}

/** Zips at someone and kicks them. From a wall it also knocks back anyone near them. */
function startStrike(p: Player, target: Dummy, splash: boolean): void {
  p.mode = 'strike';
  p.sliding = false;
  p.anchor = null;
  p.strikeId = target.id;
  p.strikeT = MOVES.strikeTime;
  p.strikeSplash = splash;
  p.webLine = dummyCenter(target);
  setAct(p, 'strike');
}

export function stepStrike(p: Player, ctx: MoveContext, dt: number): void {
  const target = findTarget(ctx, p.strikeId);
  p.strikeT -= dt;
  if (!target || p.strikeT <= 0 || !targetVisible(p, ctx.map, target)) {
    p.webLine = null;
    enterAir(p);
    return;
  }
  const aim = dummyCenter(target);
  p.webLine = aim;
  const { dir, dist } = dirTo(chest(p), aim);
  if (dist > MOVES.strikeReach) {
    p.vel = { x: dir.x * MOVES.strikeSpeed, y: dir.y * MOVES.strikeSpeed, z: dir.z * MOVES.strikeSpeed };
    return;
  }

  const flat = flatDir(p.pos, target.pos);
  hitTarget(p, ctx, target, 'strike', { x: flat.x * 12, y: 5, z: flat.z * 12 }, 0.6);
  if (p.strikeSplash) {
    for (const d of ctx.dummies) {
      if (d === target || d.respawnT > 0) continue;
      if (dirTo(target.pos, d.pos).dist > MOVES.strikeSplash) continue;
      const out = flatDir(target.pos, d.pos);
      ctx.events.push({ type: 'hitTarget', target: d.id, kind: 'strike', knock: { x: out.x * 10, y: 5, z: out.z * 10 }, stun: 0.5, pin: false, power: 1 });
    }
  }
  p.vel = { x: -flat.x * 5, y: 8, z: -flat.z * 5 };
  p.webLine = null;
  p.strikeId = null;
  enterAir(p);
  setAct(p, 'kick');
  gainFocus(p, FOCUS.strike);
}

/**
 * The web button. With someone in its sights a tap zips in for a kick and a hold
 * yanks them in, or throws them if they're already close. With no one, it zips onto
 * a ledge, hangs from a beam, or drops over a roof edge on a line.
 */
export function pressWeb(p: Player, ctx: MoveContext, aimed: Dummy | null): void {
  if (p.stunT > 0) return;

  const eye = p.aimFrom ?? eyePosition(p);
  const enemy =
    aimed ??
    findMeleeTarget(p, ctx.map, ctx.dummies, MOVES.meleeRange + 0.6, null) ??
    findAimTarget(eye, viewForward(p.yaw, p.pitch), ctx.map, ctx.dummies, 3)?.dummy ??
    null;
  if (enemy && dirTo(eye, dummyCenter(enemy)).dist <= MOVES.webRange) {
    p.webTarget = enemy.id;
    p.webHoldT = 0;
    p.tugT = -1;
    p.webPending = true;
    setAct(p, 'cast');
    return;
  }

  const thing = aimPickup(p, ctx);
  if (thing) {
    p.holding = thing.id;
    p.webHoldT = 0;
    p.webLine = { ...thing.pos };
    setAct(p, 'cast');
    ctx.events.push({ type: 'grab', pickup: thing.id });
    return;
  }

  if (p.mode === 'hang') {
    p.webLine = null;
    p.hangIn = null;
    enterAir(p);
    return;
  }

  if (p.mode === 'ground' && p.pitch < MOVES.rappelLookDown) {
    const edge = findEdge(p, ctx.map);
    if (edge) {
      startHang(p, edge.point, 1.6, edge.out);
      // A quick step off the edge, so the line takes the weight at once.
      p.vel = { x: edge.out.x * 6, y: 0, z: edge.out.z * 6 };
      p.mode = 'hang';
      return;
    }
  }

  const perch = p.perch;
  if (!perch) return;
  if (perch.hang) {
    startHang(p, perch.point, dirTo(handPosition(p), perch.point).dist, null);
  } else {
    startPointZip(p, perch.point);
  }
}

/** Where something held on the web hangs: a few metres out along the view, a little above the hands. */
export function holdPoint(p: Player): V3 {
  const eye = eyePosition(p);
  const look = viewForward(p.yaw, p.pitch);
  return { x: eye.x + look.x * MOVES.tetherHold, y: eye.y + look.y * MOVES.tetherHold - 0.4, z: eye.z + look.z * MOVES.tetherHold };
}

/**
 * The web on someone, while the button is down. A quick tap tugs them in toward the
 * player. Held, they hang on the web like on a stretched rope: they ease toward a
 * point out in front, faster the further off they are, so the camera drags them
 * about. Letting go flings them the way the camera looks.
 */
export function stepWebHold(p: Player, input: TickInput, ctx: MoveContext, dt: number): void {
  if (p.holding !== null) {
    stepHeldThing(p, input, ctx, dt);
    return;
  }
  if (!p.webPending) return;
  const target = findTarget(ctx, p.webTarget);
  if (!target || p.stunT > 0 || dirTo(chest(p), dummyCenter(target)).dist > MOVES.webRange + 10 || !targetVisible(p, ctx.map, target)) {
    p.webPending = false;
    return;
  }
  p.webHoldT += dt;
  p.webLine = dummyCenter(target);
  p.webLineT = 0.3;

  const toward = flatDir(target.pos, p.pos);
  if (!input.webHeld || p.webHoldT > MOVES.tetherTime) {
    p.webPending = false;
    if (p.webHoldT < MOVES.tetherTap) {
      // A tap: one firm tug in, easing off as they come close.
      const dist = dirTo(chest(p), dummyCenter(target)).dist;
      const pull = Math.min(MOVES.yankSpeed, dist * 1.3);
      hitTarget(p, ctx, target, 'yank', { x: toward.x * pull, y: airborne(p) ? 9 : 4, z: toward.z * pull }, 0.6);
    } else {
      // Let go of a held web: a fling the way the camera looks, into a wall if there is one.
      const look = viewForward(p.yaw, p.pitch);
      const fling = MOVES.flingSpeed;
      hitTarget(p, ctx, target, 'throw', { x: look.x * fling, y: Math.max(4, look.y * fling + 4), z: look.z * fling }, 1, true);
    }
    setAct(p, 'cast');
    return;
  }
  if (p.webHoldT < MOVES.tetherTap || p.webHoldT - p.tugT < MOVES.tugEvery) return;
  p.tugT = p.webHoldT;
  const hold = holdPoint(p);
  const at = dummyCenter(target);
  const { dir, dist } = dirTo(at, hold);
  // Elastic: a long stretch pulls hard, a short one barely at all.
  const speed = Math.min(MOVES.tugMax, dist * MOVES.tugSpring);
  ctx.events.push({
    type: 'hitTarget',
    target: target.id,
    kind: 'tug',
    knock: { x: dir.x * speed, y: dir.y * speed + 1.5, z: dir.z * speed },
    stun: MOVES.tugEvery * 3,
    pin: false,
    power: 1,
  });
}

/** A crate or a car on the web. The world moves it: this only keeps the line on it and lets go. */
function stepHeldThing(p: Player, input: TickInput, ctx: MoveContext, dt: number): void {
  const id = p.holding!;
  const thing = ctx.crates.find((c) => c.id === id);
  p.webHoldT += dt;
  if (!thing || p.stunT > 0) {
    p.holding = null;
    return;
  }
  p.webLine = { ...thing.pos };
  p.webLineT = 0.3;
  if (input.webHeld && p.webHoldT < MOVES.tetherTime) return;
  const look = viewForward(p.yaw, p.pitch);
  const fling = MOVES.flingSpeed;
  ctx.events.push({ type: 'letGo', pickup: id, fling: { x: look.x * fling, y: look.y * fling + 3, z: look.z * fling } });
  p.holding = null;
  setAct(p, 'cast');
}

/** Slams straight down. The higher it starts, the wider and harder the landing. */
export function startPound(p: Player, map: GameMap): boolean {
  if (p.stunT > 0 || heightAboveGround(p, map) < MOVES.poundMinHeight) return false;
  p.mode = 'pound';
  p.anchor = null;
  p.poundFrom = p.pos.y;
  p.vel = { x: 0, y: -MOVES.poundSpeed, z: 0 };
  setAct(p, 'pound');
  return true;
}

export function landPound(p: Player, ctx: MoveContext): void {
  const drop = Math.max(0, p.poundFrom - p.pos.y);
  const power = Math.min(1, Math.max(0.3, drop / 30));
  const radius = 3 + Math.min(6, drop * 0.15);
  let landed = false;
  for (const d of ctx.dummies) {
    if (d.respawnT > 0) continue;
    if (Math.hypot(d.pos.x - p.pos.x, d.pos.z - p.pos.z) > radius || Math.abs(d.pos.y - p.pos.y) > 3) continue;
    const out = flatDir(p.pos, d.pos);
    const push = 4 + 10 * power;
    ctx.events.push({ type: 'hitTarget', target: d.id, kind: 'pound', knock: { x: out.x * push, y: 7, z: out.z * push }, stun: 0.8, pin: false, power });
    landed = true;
  }
  if (landed) {
    p.sinceHitT = 0;
    gainFocus(p, FOCUS.pound);
  }
  ctx.events.push({ type: 'pound', at: { ...p.pos }, radius });
  p.mode = 'ground';
  p.vel = { x: 0, y: 0, z: 0 };
}

/**
 * The focus button. Close to someone with enough focus: a finisher. In the air: a trick,
 * which earns focus. Otherwise focus heals.
 */
export function pressFocus(p: Player, ctx: MoveContext, aimed: Dummy | null): void {
  if (p.stunT > 0) return;
  const target = findMeleeTarget(p, ctx.map, ctx.dummies, MOVES.meleeRange + 0.5, aimed);
  if (target && p.focus >= MOVES.finisherCost) {
    const flat = flatDir(p.pos, target.pos);
    hitTarget(p, ctx, target, 'finisher', { x: flat.x * 20, y: 10, z: flat.z * 20 }, 1.3);
    p.focus -= MOVES.finisherCost;
    setAct(p, 'finisher');
    ctx.events.push({ type: 'finisher' });
    return;
  }
  if (p.mode === 'air' && heightAboveGround(p, ctx.map) > 2) {
    if (p.tricks >= MOVES.tricksPerJump || p.trickT > 0) return;
    p.trickKind = p.tricks % 3;
    p.tricks += 1;
    p.trickT = MOVES.trickTime;
    gainFocus(p, FOCUS.trick);
    setAct(p, 'trick');
    ctx.events.push({ type: 'trick', kind: p.trickKind });
    return;
  }
  if ((p.mode === 'ground' || p.mode === 'wall') && p.focus >= MOVES.healCost && p.hp < MAX_HP && (!ctx.online || p.healCdT === 0)) {
    p.focus -= MOVES.healCost;
    if (ctx.online) p.healCdT = MOVES.healCooldown;
    setAct(p, 'heal');
    ctx.events.push({ type: 'heal', amount: MOVES.healAmount });
  }
}

/** A crate or a parked car in the crosshair, for the web to grab. */
export function aimPickup(p: Player, ctx: MoveContext): CrateSpot | null {
  if (p.crateCdT > 0 || p.stunT > 0 || !ctx.crates.length) return null;
  const eye = p.aimFrom ?? eyePosition(p);
  const f = viewForward(p.yaw, p.pitch);
  let best: CrateSpot | null = null;
  let bestT: number = MOVES.crateRange;
  for (const c of ctx.crates) {
    const ox = c.pos.x - eye.x;
    const oy = c.pos.y + 0.4 - eye.y;
    const oz = c.pos.z - eye.z;
    const t = ox * f.x + oy * f.y + oz * f.z;
    if (t <= 0 || t > bestT) continue;
    const miss = Math.hypot(ox - f.x * t, oy - f.y * t, oz - f.z * t);
    if (miss > c.size + t * 0.02) continue;
    // Stop short of the thing itself: a parked car has a solid box of its own.
    if (raycast(ctx.map, eye, f, Math.max(0.5, t - c.size - 0.6))) continue;
    best = c;
    bestT = t;
  }
  if (best) p.crateCdT = MOVES.crateCooldown;
  return best;
}

/**
 * Another player's hit moves this one: thrown, yanked or knocked about, and dazed.
 * A dodge in progress shrugs it off. A throw into a nearby wall sticks them to it.
 */
export function applyKnock(p: Player, map: GameMap, knock: V3, stun: number, pin: boolean): void {
  if (p.dodgeT > 0) return;
  p.vel = { ...knock };
  p.stunT = Math.max(p.stunT, stun);
  p.sliding = false;
  p.zipTarget = null;
  p.webLine = null;
  p.webPending = false;
  p.hangIn = null;
  p.strikeId = null;
  enterAir(p);
  if (pin && nearWall(p, map)) p.snareT = TUNING.snareTime;
}

/** True with a wall within reach of the player's side. */
export function nearWall(p: Player, map: GameMap, reach = 2.5): boolean {
  for (const dir of [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ]) {
    const hit = raycast(map, { x: p.pos.x, y: p.pos.y + 1, z: p.pos.z }, dir, reach);
    if (hit && hit.box.kind !== 'ground' && hit.box.kind !== 'bound') return true;
  }
  return false;
}

/** Heal for the practice ground. Online, the host decides. */
export function healPlayer(p: Player, amount: number): void {
  p.hp = Math.min(MAX_HP, p.hp + amount);
}
