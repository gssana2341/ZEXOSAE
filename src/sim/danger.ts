// Danger sense: when an enemy with a clear line holds their aim on the player,
// the screen edge on that side lights up, so there's a moment to dodge.

import { raycast, type GameMap, type V3 } from './map';
import { TUNING, viewForward, type Dummy, type Player } from './player';

export const DANGER = {
  range: 70,
  /** How close to the player, in metres, an enemy's aim must pass. */
  aimRadius: 2.2,
  /** Aim must stay on the player this long, so a passing sweep doesn't flash. */
  holdTime: 0.1,
  /** Brightness of a warning from the far end of the range. It reaches 1 up close. */
  farStrength: 0.55,
  riseRate: 16,
  fallRate: 5,
} as const;

export interface DangerState {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** How long each enemy has held their aim on the player, by id. */
  held: Map<number, number>;
}

export function createDanger(): DangerState {
  return { top: 0, right: 0, bottom: 0, left: 0, held: new Map() };
}

function isAimedAt(d: Dummy, target: V3, map: GameMap): boolean {
  if (!d.aim || d.respawnT > 0) return false;

  const eye = { x: d.pos.x, y: d.pos.y + TUNING.standEye, z: d.pos.z };
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  const along = dx * d.aim.x + dy * d.aim.y + dz * d.aim.z;
  if (dist > DANGER.range || dist < 0.01 || along <= 0) return false;

  const offset = Math.sqrt(Math.max(0, dist * dist - along * along));
  if (offset > DANGER.aimRadius) return false;
  return !raycast(map, eye, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
}

export function stepDanger(s: DangerState, p: Player, dummies: Dummy[], map: GameMap, dt: number): void {
  const target = { x: p.pos.x, y: p.pos.y + p.height / 2, z: p.pos.z };
  const forward = viewForward(p.yaw, 0);
  const rightX = Math.cos(p.yaw);
  const rightZ = -Math.sin(p.yaw);

  const want = { top: 0, right: 0, bottom: 0, left: 0 };
  const seen = new Set<number>();

  for (const d of dummies) {
    if (!isAimedAt(d, target, map)) continue;

    seen.add(d.id);
    const held = (s.held.get(d.id) ?? 0) + dt;
    s.held.set(d.id, held);
    if (held < DANGER.holdTime) continue;

    const dx = d.pos.x - p.pos.x;
    const dz = d.pos.z - p.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const front = (dx * forward.x + dz * forward.z) / dist;
    const side = (dx * rightX + dz * rightZ) / dist;
    const near = 1 - Math.min(1, dist / DANGER.range);
    const strength = DANGER.farStrength + (1 - DANGER.farStrength) * near;

    want.top = Math.max(want.top, front * strength);
    want.bottom = Math.max(want.bottom, -front * strength);
    want.right = Math.max(want.right, side * strength);
    want.left = Math.max(want.left, -side * strength);
  }

  for (const id of s.held.keys()) {
    if (!seen.has(id)) s.held.delete(id);
  }

  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const rate = want[edge] > s[edge] ? DANGER.riseRate : DANGER.fallRate;
    s[edge] += (want[edge] - s[edge]) * (1 - Math.exp(-rate * dt));
  }
}
