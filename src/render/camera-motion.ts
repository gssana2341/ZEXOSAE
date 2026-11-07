// Gives the first-person view some body: a footstep bob, a dip on landing, a lean
// into turns and a tremble at high speed. It only moves the camera's position and
// roll, never where it points, so the crosshair always shows the true aim.

export interface CameraMotionInput {
  /** Speed along the ground, in metres per second. */
  speed: number;
  /** Speed toward the camera's right. */
  sideSpeed: number;
  /** Total speed, in metres per second. */
  totalSpeed: number;
  onGround: boolean;
  swinging: boolean;
  dt: number;
}

export interface CameraOffset {
  /** Metres to the camera's right and up. */
  x: number;
  y: number;
  /** Radians of camera roll. */
  roll: number;
}

export interface CameraMotion {
  stridePhase: number;
  strideAmount: number;
  lean: number;
  dip: number;
  dipSpeed: number;
  time: number;
}

const BOB_HEIGHT = 0.055;
const BOB_SWAY = 0.04;
const BOB_ROLL = 0.008;
/** Steps per metre of running, as radians of stride. */
const STRIDE_RATE = 0.85;
const LEAN_GROUND = 0.0035;
const LEAN_AIR = 0.008;
const MAX_LEAN = 0.15;
const DIP_SPRING = 110;
const DIP_DAMPING = 15;
const MAX_DIP = 0.5;
/** Above this speed the view starts to tremble from the wind. */
const TREMBLE_SPEED = 22;
const TREMBLE_RANGE = 18;
const TREMBLE_SIZE = 0.016;

/** Speed widens the view; a fast dive adds a stronger perspective stretch. */
export function speedFovBoost(speed: number, fallSpeed: number, thirdPerson: boolean, reduceMotion: boolean, enabled: boolean): number {
  if (!enabled) return 0;
  const cap = reduceMotion ? 4 : thirdPerson ? 14 : 20;
  const rate = reduceMotion ? 0.15 : thirdPerson ? 0.45 : 0.7;
  const movement = Math.min(cap, Math.max(0, speed - 11) * rate);
  const dive = reduceMotion ? 0 : Math.min(thirdPerson ? 16 : 18, Math.max(0, fallSpeed - 12) * 0.55);
  return movement + dive;
}

/** Fast widening during a dive, followed by a softer return when speed drops. */
export function stepFovBoost(current: number, target: number, fallSpeed: number, dt: number, reduceMotion: boolean): number {
  const rate = !reduceMotion && fallSpeed > 12 && target > current ? 15 : 6;
  return current + (target - current) * (1 - Math.exp(-rate * Math.max(0, dt)));
}

export function createCameraMotion(): CameraMotion {
  return { stridePhase: 0, strideAmount: 0, lean: 0, dip: 0, dipSpeed: 0, time: 0 };
}

/** Called on a hard landing. A longer fall pushes the view further down. */
export function landCamera(m: CameraMotion, fallSpeed: number): void {
  m.dipSpeed -= Math.min(7, fallSpeed * 0.16);
}

export function stepCameraMotion(m: CameraMotion, input: CameraMotionInput): CameraOffset {
  const { dt, speed, sideSpeed, totalSpeed, onGround, swinging } = input;
  m.time += dt;
  const blend = (rate: number) => 1 - Math.exp(-rate * dt);

  // Footsteps fade in and out, so the view never snaps when starting or stopping.
  const running = onGround && speed > 1;
  m.strideAmount += ((running ? Math.min(1, speed / 8) : 0) - m.strideAmount) * blend(10);
  if (running) m.stridePhase += speed * STRIDE_RATE * dt;

  const lean = -sideSpeed * (onGround ? LEAN_GROUND : LEAN_AIR);
  const swingExtra = swinging ? 1.5 : 1;
  const wantLean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, lean * swingExtra));
  m.lean += (wantLean - m.lean) * blend(7);

  // A spring, so a landing dips and settles instead of jumping back.
  m.dipSpeed += (-DIP_SPRING * m.dip - DIP_DAMPING * m.dipSpeed) * dt;
  m.dip = Math.max(-MAX_DIP, Math.min(MAX_DIP, m.dip + m.dipSpeed * dt));

  // Smooth waves rather than random numbers. Randomness each frame reads as stutter.
  const wind = Math.max(0, Math.min(1, (totalSpeed - TREMBLE_SPEED) / TREMBLE_RANGE));
  const trembleX = Math.sin(m.time * 17) * 0.6 + Math.sin(m.time * 26) * 0.4;
  const trembleY = Math.sin(m.time * 21 + 1) * 0.6 + Math.sin(m.time * 31) * 0.4;

  return {
    x: Math.sin(m.stridePhase) * BOB_SWAY * m.strideAmount + trembleX * TREMBLE_SIZE * wind,
    y: Math.sin(m.stridePhase * 2) * BOB_HEIGHT * m.strideAmount + m.dip + trembleY * TREMBLE_SIZE * wind,
    roll: m.lean + Math.sin(m.stridePhase) * BOB_ROLL * m.strideAmount,
  };
}
