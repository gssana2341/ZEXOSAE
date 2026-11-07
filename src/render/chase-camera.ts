// The third-person camera. It trails the player like it's on a soft spring: it falls
// back as speed builds, drifts over the shoulder and follows height changes slowly,
// so the view stays calm through the up and down of a swing. Only position lags.
// Where the camera points stays exactly under the player's control.

import type { V3 } from '../sim/map';

export interface ChaseInput {
  /** The point the camera looks past, around the player's head. */
  head: V3;
  yaw: number;
  pitch: number;
  speed: number;
  sideSpeed: number;
  swinging: boolean;
  dt: number;
  /** Free distance from a point along a direction, up to a limit. Stops the camera entering walls. */
  clearance: (from: V3, direction: V3, limit: number) => number;
}

export interface ChaseCamera {
  pos: V3;
  distance: number;
  roll: number;
  started: boolean;
}

export const CHASE = {
  /** Metres behind the head at rest, and the most speed can add. */
  baseDistance: 2.8,
  speedDistance: 0.04,
  maxSpeedDistance: 0.9,
  swingDistance: 0.35,
  shoulder: 0.75,
  lift: 0.55,
  swingLift: 0.7,
  /** How quickly the camera catches up. Lower is softer. */
  followRate: 14,
  /** Slower than sideways, so a swing's rise and fall doesn't bounce the view. */
  heightRate: 6,
  distanceRate: 2.5,
  /** The furthest the spring can stretch from where it wants to be. */
  maxLag: 1.6,
  /** The hard limit from the head, so the hero never shrinks on screen at top speed. */
  maxDistance: 4.4,
  wallGap: 0.35,
  leanPerSpeed: 0.0045,
  maxLean: 0.11,
} as const;

export function createChaseCamera(): ChaseCamera {
  return { pos: { x: 0, y: 0, z: 0 }, distance: CHASE.baseDistance, roll: 0, started: false };
}

/** Forgets the old position, for a respawn or switching views. */
export function resetChaseCamera(c: ChaseCamera): void {
  c.started = false;
}

export function stepChaseCamera(c: ChaseCamera, input: ChaseInput): V3 {
  const { head, yaw, pitch, speed, sideSpeed, swinging, dt, clearance } = input;
  const blend = (rate: number) => 1 - Math.exp(-rate * dt);

  const wantDistance =
    CHASE.baseDistance +
    Math.min(CHASE.maxSpeedDistance, speed * CHASE.speedDistance) +
    (swinging ? CHASE.swingDistance : 0);
  c.distance += (wantDistance - c.distance) * blend(CHASE.distanceRate);

  const cosPitch = Math.cos(pitch);
  const forward = { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  // Near the centre at speed, so the player stays readable against the direction of travel.
  const shoulder = CHASE.shoulder * (1 - Math.min(0.6, speed / 60));
  const lift = CHASE.lift + (swinging ? CHASE.swingLift : 0);

  const ideal = {
    x: head.x - forward.x * c.distance + right.x * shoulder,
    y: head.y - forward.y * c.distance + lift,
    z: head.z - forward.z * c.distance + right.z * shoulder,
  };

  if (!c.started) {
    c.pos = { ...ideal };
    c.roll = 0;
    c.started = true;
  } else {
    const side = blend(CHASE.followRate);
    c.pos.x += (ideal.x - c.pos.x) * side;
    c.pos.z += (ideal.z - c.pos.z) * side;
    c.pos.y += (ideal.y - c.pos.y) * blend(CHASE.heightRate);

    const dx = c.pos.x - ideal.x;
    const dy = c.pos.y - ideal.y;
    const dz = c.pos.z - ideal.z;
    const lag = Math.hypot(dx, dy, dz);
    if (lag > CHASE.maxLag) {
      const k = CHASE.maxLag / lag;
      c.pos = { x: ideal.x + dx * k, y: ideal.y + dy * k, z: ideal.z + dz * k };
    }
  }

  const wantRoll = Math.max(-CHASE.maxLean, Math.min(CHASE.maxLean, -sideSpeed * CHASE.leanPerSpeed));
  c.roll += (wantRoll - c.roll) * blend(5);

  // Walls win over the spring: the camera moves in at once, then eases back out.
  const dx = c.pos.x - head.x;
  const dy = c.pos.y - head.y;
  const dz = c.pos.z - head.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  const reach = Math.min(length, CHASE.maxDistance);
  const free = Math.max(0.2, clearance(head, direction, reach + CHASE.wallGap) - CHASE.wallGap);
  if (free >= length) return { ...c.pos };

  const distance = Math.min(free, reach);
  c.pos = {
    x: head.x + direction.x * distance,
    y: head.y + direction.y * distance,
    z: head.z + direction.z * distance,
  };
  return { ...c.pos };
}
