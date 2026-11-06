// Aim help. The closer the crosshair gets to a target, the slower the mouse turns,
// and very close it holds on for a moment. Distances are metres off the crosshair
// at the target's range, so a far target needs a more exact aim in degrees.

import { raycast, type GameMap, type V3 } from './map';
import type { Dummy } from './player';

export const AIM = {
  range: 90,
  /** A shot this close to a target bends onto it. A shot already hits within TUNING.shotRadius. */
  magnetRadius: 1.2,
  /** Inside this distance the mouse starts to slow. */
  slowRadius: 3,
  /** Inside this distance the crosshair holds on for a moment. */
  lockRadius: 1.1,
  /** Keeps all of the above inside about 9 degrees, so a close target doesn't grab the whole screen. */
  maxAngleTan: 0.16,
  /** Mouse speed right on the target, as a fraction of normal. */
  slowestLook: 0.45,
  /** Mouse speed during a lock. */
  lockLook: 0.3,
  lockTime: 0.35,
  /** Wait between locks, so holding the crosshair on a target isn't an aimbot. */
  lockCooldown: 0.9,
  /** Moving the mouse this far (radians) breaks a lock early. */
  lockBreakMotion: 0.06,
  lockFollowRate: 12,
  /** The fastest a lock can turn the camera, in radians per second. */
  lockMaxTurn: 1.4,
} as const;

export function viewForward(yaw: number, pitch: number): V3 {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

export function dummyCenter(d: Dummy): V3 {
  return { x: d.pos.x, y: d.pos.y + 1, z: d.pos.z };
}

export interface AimTarget {
  dummy: Dummy;
  /** Metres between the crosshair's line and the target. */
  offset: number;
}

/** The visible target nearest the crosshair's line, within `radius` metres of it. */
export function findAimTarget(
  eye: V3,
  forward: V3,
  map: GameMap,
  dummies: Dummy[],
  radius: number,
): AimTarget | null {
  let best: AimTarget | null = null;

  for (const d of dummies) {
    if (d.respawnT > 0) continue;
    const c = dummyCenter(d);
    const dx = c.x - eye.x;
    const dy = c.y - eye.y;
    const dz = c.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    const along = dx * forward.x + dy * forward.y + dz * forward.z;
    if (along <= 0 || dist > AIM.range) continue;

    const offset = Math.sqrt(Math.max(0, dist * dist - along * along));
    if (offset > Math.min(radius, along * AIM.maxAngleTan)) continue;
    if (best && offset >= best.offset) continue;
    if (raycast(map, eye, { x: dx / dist, y: dy / dist, z: dz / dist }, dist)) continue;
    best = { dummy: d, offset };
  }
  return best;
}

export interface AimState {
  lockId: number | null;
  lockT: number;
  cooldownT: number;
  motion: number;
}

export function createAimState(): AimState {
  return { lockId: null, lockT: 0, cooldownT: 0, motion: 0 };
}

export interface AimResult {
  yaw: number;
  pitch: number;
  /** Multiplies the player's look speed. */
  lookScale: number;
}

function endLock(s: AimState): void {
  if (s.lockId === null) return;
  s.lockId = null;
  s.cooldownT = AIM.lockCooldown;
}

/**
 * Runs once per frame on the player's own game.
 * `motion` is how far the player moved the view since the last frame, in radians.
 * `scale` widens every radius, for touch screens.
 */
export function stepAim(
  s: AimState,
  yaw: number,
  pitch: number,
  eye: V3,
  map: GameMap,
  dummies: Dummy[],
  dt: number,
  motion: number,
  scale: number,
): AimResult {
  s.cooldownT = Math.max(0, s.cooldownT - dt);

  const slowRadius = AIM.slowRadius * scale;
  const near = findAimTarget(eye, viewForward(yaw, pitch), map, dummies, slowRadius);
  if (!near) {
    endLock(s);
    return { yaw, pitch, lookScale: 1 };
  }

  if (s.lockId === null && s.cooldownT === 0 && near.offset < AIM.lockRadius * scale) {
    s.lockId = near.dummy.id;
    s.lockT = AIM.lockTime;
    s.motion = 0;
  }

  if (s.lockId !== null) {
    s.lockT -= dt;
    s.motion += motion;
    if (near.dummy.id !== s.lockId || s.lockT <= 0 || s.motion > AIM.lockBreakMotion) {
      endLock(s);
    } else {
      const c = dummyCenter(near.dummy);
      const dx = c.x - eye.x;
      const dy = c.y - eye.y;
      const dz = c.z - eye.z;
      const wantYaw = Math.atan2(-dx, -dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const yawDiff = Math.atan2(Math.sin(wantYaw - yaw), Math.cos(wantYaw - yaw));
      const follow = 1 - Math.exp(-AIM.lockFollowRate * dt);
      const limit = AIM.lockMaxTurn * dt;
      const clamp = (v: number) => Math.max(-limit, Math.min(limit, v));
      return {
        yaw: yaw + clamp(yawDiff * follow),
        pitch: pitch + clamp((wantPitch - pitch) * follow),
        lookScale: AIM.lockLook,
      };
    }
  }

  const closeness = near.offset / slowRadius;
  return { yaw, pitch, lookScale: AIM.slowestLook + (1 - AIM.slowestLook) * closeness };
}
