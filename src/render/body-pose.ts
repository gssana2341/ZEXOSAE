// Works out how a character's body should bend from how it is moving. Angles are
// radians around the joint's sideways axis. A positive limb angle swings forward,
// and an arm at about PI points straight up.

export interface BodyState {
  /** Ground speed, in metres per second. */
  speed: number;
  /** Speed in the direction the body faces. Negative is moving backward. */
  forwardSpeed: number;
  verticalSpeed: number;
  /** Direction from the hand to the web point, in the body's own frame. Null when not on a web. */
  rope: { x: number; y: number; z: number } | null;
  time: number;
}

export interface BodyPose {
  /** Whole body tipping forward or back, and to the side. */
  pitch: number;
  roll: number;
  armLeft: number;
  armRight: number;
  elbowLeft: number;
  elbowRight: number;
  legLeft: number;
  legRight: number;
  kneeLeft: number;
  kneeRight: number;
}

const MAX_TIP = 1.15;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/** Above this vertical speed, the character counts as jumping or falling. */
const AIRBORNE_SPEED = 2;
const RUN_SPEED = 1;

function swinging(s: BodyState, rope: NonNullable<BodyState['rope']>): BodyPose {
  // The body hangs along the web, with the legs trailing behind the swing.
  const trail = clamp(-s.forwardSpeed * 0.03, -0.9, 0.9);
  const sway = Math.sin(s.time * 3.2) * 0.12;
  return {
    pitch: clamp(Math.atan2(rope.z, rope.y), -MAX_TIP, MAX_TIP),
    roll: clamp(-Math.atan2(rope.x, rope.y), -MAX_TIP, MAX_TIP),
    armRight: 3.0,
    elbowRight: 0.1,
    armLeft: -0.5 + trail * 0.5 + sway,
    elbowLeft: 0.9,
    legLeft: 0.85 + trail + sway,
    kneeLeft: -1.35,
    legRight: 0.15 + trail - sway,
    kneeRight: -0.45,
  };
}

function running(s: BodyState): BodyPose {
  const phase = s.time * (6 + s.speed * 0.7);
  const stride = Math.min(1, s.speed / 11) * 0.95;
  const swing = Math.sin(phase);
  return {
    pitch: -Math.min(0.38, s.speed * 0.022),
    roll: 0,
    armLeft: -swing * stride,
    armRight: swing * stride,
    elbowLeft: 0.9,
    elbowRight: 0.9,
    legLeft: swing * stride,
    legRight: -swing * stride,
    kneeLeft: -Math.max(0, -Math.cos(phase)) * 1.3 * stride - 0.15,
    kneeRight: -Math.max(0, Math.cos(phase)) * 1.3 * stride - 0.15,
  };
}

function airborne(s: BodyState): BodyPose {
  if (s.verticalSpeed > 0) {
    return {
      pitch: -0.12,
      roll: 0,
      armLeft: 0.7,
      armRight: -0.5,
      elbowLeft: 0.7,
      elbowRight: 0.7,
      legLeft: 0.75,
      legRight: -0.25,
      kneeLeft: -1.1,
      kneeRight: -0.5,
    };
  }
  // Falling: arms flail upward, faster as the drop gets harder.
  const flail = Math.sin(s.time * (8 + Math.min(10, -s.verticalSpeed * 0.3))) * 0.3;
  return {
    pitch: 0.1,
    roll: flail * 0.2,
    armLeft: 2.3 + flail,
    armRight: 2.3 - flail,
    elbowLeft: 0.3,
    elbowRight: 0.3,
    legLeft: 0.3 - flail,
    legRight: -0.2 + flail,
    kneeLeft: -0.5,
    kneeRight: -0.7,
  };
}

function standing(s: BodyState): BodyPose {
  const breath = Math.sin(s.time * 1.8) * 0.04;
  return {
    pitch: 0,
    roll: 0,
    armLeft: breath,
    armRight: -breath,
    elbowLeft: 0.2,
    elbowRight: 0.2,
    legLeft: 0,
    legRight: 0,
    kneeLeft: 0,
    kneeRight: 0,
  };
}

export function bodyPose(s: BodyState): BodyPose {
  if (s.rope) return swinging(s, s.rope);
  if (Math.abs(s.verticalSpeed) > AIRBORNE_SPEED) return airborne(s);
  if (s.speed > RUN_SPEED) return running(s);
  return standing(s);
}

/** A direction in the body's own frame: x right, y up, z back. */
export interface Dir {
  x: number;
  y: number;
  z: number;
}

/** Where the two halves of an arm or leg point. */
export interface Bend {
  upper: Dir;
  lower: Dir;
}

/** A full-body shape held on top of a clip. A null arm is left to the clip or the web. */
export interface LimbPose {
  legRight: Bend;
  legLeft: Bend;
  armRight: Bend | null;
  armLeft: Bend | null;
  /** Both hands hold the web. */
  twoHands: boolean;
}

export type Side = 1 | -1;

const dir = (x: number, y: number, z: number): Dir => {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
};
const bend = (ux: number, uy: number, uz: number, lx: number, ly: number, lz: number): Bend => ({
  upper: dir(ux, uy, uz),
  lower: dir(lx, ly, lz),
});

/** Each swing shape, written for a web in the right hand. The other side is its mirror. */
const SWING_SHAPES: Array<{ near: Bend; far: Bend; free: Bend | null }> = [
  {
    // Reach: long, one leg a step ahead of the other, free arm out for balance.
    near: bend(0.12, -1, -0.12, 0.08, -0.85, 0.55),
    far: bend(-0.12, -1, 0.35, -0.08, -0.7, 0.85),
    free: bend(-0.75, -0.55, -0.1, -0.55, -0.2, -0.6),
  },
  {
    // Knee: the near knee driven up, free arm across the chest.
    near: bend(0.14, -0.25, -1, 0.1, -1, 0.12),
    far: bend(-0.12, -1, 0.25, -0.1, -0.6, 0.85),
    free: bend(-0.6, -0.2, -0.75, 0.45, 0.35, -0.8),
  },
  {
    // Haul: both hands on the web, knees pulled in.
    near: bend(0.12, -0.6, -0.75, 0.1, -1, 0.4),
    far: bend(-0.12, -0.75, -0.55, -0.1, -0.95, 0.55),
    free: null,
  },
  {
    // Stride: legs split wide, free arm thrown out for balance.
    near: bend(0.12, -0.7, -0.7, 0.12, -1, -0.25),
    far: bend(-0.12, -0.65, 0.75, -0.06, -0.25, 1),
    free: bend(-1, -0.05, 0.25, -1, 0.25, 0.3),
  },
];

export const SWING_STYLES = SWING_SHAPES.length;

/** True for the shapes that hold the web with both hands. */
export const usesBothHands = (style: number) => SWING_SHAPES[style % SWING_STYLES].free === null;

const mirror = (b: Bend): Bend => ({
  upper: { ...b.upper, x: -b.upper.x },
  lower: { ...b.lower, x: -b.lower.x },
});

/** Pushes a limb forward or back, which is how the legs follow the swing's arc. */
function shift(b: Bend, z: number): Bend {
  return {
    upper: dir(b.upper.x, b.upper.y, b.upper.z + z),
    lower: dir(b.lower.x, b.lower.y, b.lower.z + z),
  };
}

export interface SwingMoment {
  style: number;
  side: Side;
  /** From -1 falling hard to 1 rising hard. */
  rise: number;
  /** Seconds on this web. */
  age: number;
  time: number;
}

/** The body's shape on a web. Legs lead on the way up and trail on the way down. */
export function swingLimbs(m: SwingMoment): LimbPose {
  const shape = SWING_SHAPES[m.style % SWING_STYLES];
  // Grabbing a web snaps the knees up for a moment.
  const snap = Math.max(0, 1 - m.age / 0.3) * 0.5;
  const sway = Math.sin(m.time * 3.2) * 0.1;
  const legs = -clamp(m.rise, -1, 1) * 0.35 - snap;
  const near = shift(shape.near, legs + sway);
  const far = shift(shape.far, legs - sway);
  const free = shape.free && shift(shape.free, sway * 0.6);

  return m.side === 1
    ? { legRight: near, legLeft: far, armRight: null, armLeft: free, twoHands: !free }
    : {
        legRight: mirror(far),
        legLeft: mirror(near),
        armRight: free && mirror(free),
        armLeft: null,
        twoHands: !free,
      };
}

/** Seconds a move after letting go of a web lasts. */
export const RELEASE_TIME = 0.75;
export const RELEASE_MOVES = 3;

const both = (right: Bend): { right: Bend; left: Bend } => ({ right, left: mirror(right) });

const RELEASE_SHAPES = [
  // Flip: curled up tight.
  { legs: both(bend(0.12, 0.1, -1, 0.1, -1, 0.1)), arms: both(bend(0.5, -0.6, -0.6, -0.3, 0.2, -0.9)) },
  // Corkscrew: long and narrow, to spin fast.
  { legs: both(bend(0.03, -1, 0.05, 0.03, -1, 0.1)), arms: both(bend(0.25, -1, 0.1, -0.1, -0.9, -0.2)) },
  // Star: wide open.
  { legs: both(bend(0.45, -1, 0.1, 0.4, -1, 0.25)), arms: both(bend(1, 0.35, 0.1, 1, 0.5, 0.05)) },
];

export function releaseLimbs(kind: number): LimbPose {
  const shape = RELEASE_SHAPES[kind % RELEASE_MOVES];
  return {
    legRight: shape.legs.right,
    legLeft: shape.legs.left,
    armRight: shape.arms.right,
    armLeft: shape.arms.left,
    twoHands: false,
  };
}

/** How the whole body turns through a move. `t` runs from 0 to 1. */
export function releaseTurn(kind: number, t: number): { pitch: number; spin: number } {
  const eased = 1 - (1 - t) ** 3;
  switch (kind % RELEASE_MOVES) {
    case 0:
      return { pitch: -Math.PI * 2 * eased, spin: 0 };
    case 1:
      return { pitch: -0.5 * Math.sin(Math.PI * t), spin: Math.PI * 2 * eased };
    default:
      return { pitch: -0.4 * Math.sin(Math.PI * t), spin: 0 };
  }
}

/**
 * Hanging on a line: legs together and loose, one knee a little ahead. Climbing it, the
 * knees take turns drawing up, as feet would hunt for a grip. `effort` is 0 still, 1 climbing.
 */
export function hangLimbs(phase: number, effort: number): LimbPose {
  const s = Math.sin(phase) * effort;
  const leg = (k: number) => ({
    upper: dir(0.06, -1, -0.12 - k * 0.6),
    lower: dir(0.02, -1, 0.28 + k * 0.5),
  });
  return {
    legRight: leg(0.15 + Math.max(0, s)),
    legLeft: mirror(leg(Math.max(0, -s))),
    armRight: null,
    armLeft: null,
    twoHands: true,
  };
}

/** What a character's webs have been doing, so each one can look different from the last. */
export interface SwingTrack {
  anchor: Dir | null;
  webs: number;
  moves: number;
  side: Side;
  style: number;
  age: number;
  /** Seconds into a move after letting go, or below zero when there is none. */
  release: number;
  kind: number;
}

export function createSwingTrack(): SwingTrack {
  return { anchor: null, webs: 0, moves: 0, side: -1, style: 0, age: 0, release: -1, kind: 0 };
}

/**
 * Follows a character's web from frame to frame. Hands alternate with each new web, and
 * the shapes rotate so the same one doesn't keep landing on the same hand.
 * Returns true on the frame a new web starts.
 */
export function trackSwing(t: SwingTrack, anchor: Dir | null, fast: boolean, dt: number): boolean {
  const last = t.anchor;
  const fresh =
    anchor !== null &&
    (!last || Math.abs(anchor.x - last.x) + Math.abs(anchor.y - last.y) + Math.abs(anchor.z - last.z) > 0.01);

  if (fresh) {
    t.side = t.side === 1 ? -1 : 1;
    t.style = (t.webs + Math.floor(t.webs / SWING_STYLES)) % SWING_STYLES;
    t.webs += 1;
    t.age = 0;
    t.release = -1;
  } else if (anchor) {
    t.age += dt;
  } else if (last && fast) {
    t.kind = t.moves % RELEASE_MOVES;
    t.moves += 1;
    t.release = 0;
  } else if (t.release >= 0) {
    t.release += dt;
    if (t.release >= RELEASE_TIME) t.release = -1;
  }

  t.anchor = anchor && { x: anchor.x, y: anchor.y, z: anchor.z };
  return fresh;
}

/** Short-lived webs from casts and zips are not swing ropes. */
export function swingAnchor(anchor: Dir | null, motion: Mode | undefined, pose: PoseName | undefined): Dir | null {
  if (motion !== undefined) return motion === 'swing' ? anchor : null;
  // Older peers may not send motion; keep their ordinary swing animation working.
  return pose === 'swing' || pose === undefined ? anchor : null;
}

export type PoseMode = PoseName;

/**
 * What the body is doing, as the clips see it. A slow wall is a climb, and a climb that
 * ends going up and in is a pull-up over the ledge. A hard drop ends in a landing.
 * The view tells these apart.
 */
export type ClipMode = PoseMode | 'climb' | 'ledge' | 'land';

export interface ClipChoice {
  clip: string;
  timeScale: number;
  /** Fit one-shot clips to the simulation action, rather than cutting them short. */
  duration?: number;
}

/** Above this speed along a wall, the hero runs on it instead of climbing. */
const SPRINT_SPEED = 7;

/**
 * How fast each clip's feet carry the body at normal speed, in metres a second, measured
 * from the pack's root motion. Playing a clip at speed / pace keeps the feet from sliding.
 */
const PACE: Record<string, number> = {
  Walk_Loop: 1,
  Jog_Fwd_Loop: 5.45,
  Jog_Fwd_R_Loop: 6.16,
  Jog_Right_Loop: 3.27,
  Jog_Bwd_R_Loop: 4.62,
  Jog_Bwd_Loop: 3.27,
  Jog_Bwd_L_Loop: 4.62,
  Jog_Left_Loop: 3.27,
  Jog_Fwd_L_Loop: 6.16,
  Sprint_Loop: 8.39,
};
/** Each eighth of a turn from straight ahead, clockwise, has its own jog. */
const JOG_DIRECTIONS = [
  'Jog_Fwd_Loop',
  'Jog_Fwd_R_Loop',
  'Jog_Right_Loop',
  'Jog_Bwd_R_Loop',
  'Jog_Bwd_Loop',
  'Jog_Bwd_L_Loop',
  'Jog_Left_Loop',
  'Jog_Fwd_L_Loop',
];
/** Slower than this, the body stands. */
const STAND_SPEED = 0.4;
/** Up to this, straight ahead is a walk. */
const WALK_SPEED = 1.8;
/** From this, straight ahead is a sprint. */
const SPRINT_FROM = 6.3;

/** How long the crouch after a hard landing lasts. */
export const LAND_TIME = 0.32;
/** How long the doubled-over moment after a hard hit lasts. */
const STUN_CLIP_RATE = 1;

/**
 * Walks, jogs and sprints, picked for the way the body moves relative to where it faces,
 * so a strafe steps sideways and backing up steps back.
 */
function groundClip(speed: number, forward: number, side: number): ClipChoice {
  if (speed < STAND_SPEED) return { clip: 'Idle_Loop', timeScale: 1 };
  const eighth = Math.round(Math.atan2(side, forward) / (Math.PI / 4));
  let clip = JOG_DIRECTIONS[(eighth + 8) % 8];
  let min = 0.45;
  let max = 1.6;
  if (clip === 'Jog_Fwd_Loop' && speed < WALK_SPEED) {
    clip = 'Walk_Loop';
    max = WALK_SPEED;
  } else if (clip === 'Jog_Fwd_Loop' && speed > SPRINT_FROM) {
    clip = 'Sprint_Loop';
    min = 0.7;
  }
  return { clip, timeScale: Math.min(max, Math.max(min, speed / PACE[clip])) };
}

/** How fast the climbing clips carry the body at normal speed, in metres a second. */
const CLIMB_PACE = { up: 0.92, side: 1.05 };
/** Slower than this on a wall, the hands just hold on. */
const CLIMB_STILL = 0.5;
/** Climbs faster than this look frantic, so past it the hands slide a little instead. */
const MAX_CLIMB_RATE = 3.2;
/** How long the pull-up over a ledge lasts. */
export const LEDGE_TIME = 0.5;
const LEDGE_CLIP_LENGTH = 0.63;

/** Picks a climbing clip for the way the body moves across the wall. Positive `side` is to its right. */
function climbClip(up: number, side: number): ClipChoice {
  const rate = (speed: number, pace: number) => Math.min(MAX_CLIMB_RATE, Math.max(0.6, speed / pace));
  if (Math.hypot(up, side) < CLIMB_STILL) return { clip: 'Climb_Idle_Loop', timeScale: 1 };
  if (Math.abs(side) > Math.abs(up)) {
    return { clip: side > 0 ? 'Climb_Right_Loop' : 'Climb_Left_Loop', timeScale: rate(Math.abs(side), CLIMB_PACE.side) };
  }
  return { clip: up > 0 ? 'Climb_Up_Loop' : 'Climb_Down_Loop', timeScale: rate(Math.abs(up), CLIMB_PACE.up) };
}

/**
 * Picks the motion clip for how a character is moving. Without a mode, it reads the movement.
 * `forwardSpeed` and `sideSpeed` are how fast the body moves ahead and to its own right,
 * which pick the way it steps and climbs. Without them, it moves the way it faces.
 */
export function clipFor(s: {
  mode?: ClipMode;
  speed: number;
  verticalSpeed: number;
  forwardSpeed?: number;
  sideSpeed?: number;
}): ClipChoice {
  const action = (clip: string, act: Act): ClipChoice => ({ clip, timeScale: 1, duration: ACT_TIME[act] });
  switch (s.mode) {
    case 'swing':
      return { clip: 'NinjaJump_Idle_Loop', timeScale: 1 };
    case 'slide':
      return { clip: 'Slide_Loop', timeScale: 1 };
    case 'dash':
      return { clip: 'Roll', timeScale: 1, duration: TUNING.dashTime };
    case 'climb':
      return climbClip(s.verticalSpeed, s.sideSpeed ?? 0);
    case 'ledge':
      return { clip: 'ClimbLedge', timeScale: LEDGE_CLIP_LENGTH / LEDGE_TIME };
    case 'land':
      return { clip: 'Jump_Land', timeScale: 1, duration: LAND_TIME };
    case 'stun':
      return { clip: 'Hit_Stomach', timeScale: STUN_CLIP_RATE };
    case 'zip':
    case 'strike':
    case 'pound':
      return { clip: 'NinjaJump_Idle_Loop', timeScale: 1 };
    case 'hang':
      // Upright and still, so the arms on the line and the legs below set the shape.
      return { clip: 'Idle_Loop', timeScale: 0.6 };
    case 'jab':
      return action('Punch_Jab', 'jab');
    case 'cross':
      return action('Punch_Cross', 'cross');
    case 'kick':
    case 'launch':
      return action('Kick', s.mode);
    case 'finisher':
      return action('Punch_Cross', 'finisher');
    case 'cast':
    case 'heal':
      return action('Spell_Simple_Shoot', s.mode);
    case 'trick':
      return action('BackFlip', 'trick');
    case 'charge':
      return { clip: 'Crouch_Idle_Loop', timeScale: 1 };
    case 'dodgeL':
      return action('Dodge_Left', 'dodgeL');
    case 'dodgeR':
      return action('Dodge_Right', 'dodgeR');
    case 'wall':
      // Fast along a wall is a run. Slower, it's a climb.
      return s.speed > SPRINT_SPEED ? { clip: 'Sprint_Loop', timeScale: 1.2 } : climbClip(s.verticalSpeed, s.sideSpeed ?? 0);
  }

  const airborne = s.mode === 'air' || (s.mode === undefined && Math.abs(s.verticalSpeed) > AIRBORNE_SPEED);
  if (airborne) {
    return { clip: s.verticalSpeed > 0 ? 'Jump_Loop' : 'NinjaJump_Idle_Loop', timeScale: 1 };
  }
  return groundClip(s.speed, s.forwardSpeed ?? s.speed, s.sideSpeed ?? 0);
}

import { ACT_TIME } from '../sim/moves';
import { TUNING, type Mode, type PoseName } from '../sim/player';
import type { Act } from '../sim/hits';
