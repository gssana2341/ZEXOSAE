// Aim help for shots. A shot that only just misses bends onto the target. The
// camera is never moved or slowed, so aiming stays entirely in the player's hands.
// Distances are metres off the crosshair at the target's range.

import { raycast, type GameMap, type V3 } from './map';
import type { Dummy } from './player';

export const AIM = {
  range: 90,
  /** A shot this close to a target bends onto it. A shot already hits within TUNING.shotRadius. */
  magnetRadius: 1.2,
  /** Keeps the help inside about 9 degrees, so a close target doesn't catch wild shots. */
  maxAngleTan: 0.16,
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

