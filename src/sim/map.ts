// The arena is built only from axis-aligned boxes. This keeps collision cheap
// and lets a future game server reuse this file without Three.js.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** ground: floor. building: solid. run: wall-runnable. beam: overhead web point. ledge: low platform. */
export type BoxKind = 'ground' | 'building' | 'run' | 'beam' | 'ledge';

export interface Box {
  min: V3;
  max: V3;
  kind: BoxKind;
}

export interface Patrol {
  a: V3;
  b: V3;
}

export interface SpawnPoint {
  pos: V3;
  yaw: number;
}

export interface GameMap {
  boxes: Box[];
  spawn: V3;
  spawnYaw: number;
  /** Online spawn points, all facing the plaza. */
  spawns: SpawnPoint[];
  rings: V3[];
  patrols: Patrol[];
}

export const RING_RADIUS = 4.5;
/** The inner faces of the boundary walls. Past this, the player has left the arena. */
export const ARENA_LIMIT = 90;
/** Below this, the player has fallen out of the arena. */
export const ARENA_FLOOR = -8;

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

function block(
  cx: number,
  cz: number,
  w: number,
  d: number,
  y0: number,
  y1: number,
  kind: BoxKind,
): Box {
  return {
    min: v(cx - w / 2, y0, cz - d / 2),
    max: v(cx + w / 2, y1, cz + d / 2),
    kind,
  };
}

export function createArena(): GameMap {
  const boxes: Box[] = [];
  const add = (...b: Box[]) => boxes.push(...b);

  // Floor and boundary.
  add(block(0, 0, 184, 184, -4, 0, 'ground'));
  add(block(0, -92, 184, 4, 0, 90, 'building'));
  add(block(0, 92, 184, 4, 0, 90, 'building'));
  add(block(-92, 0, 4, 184, 0, 90, 'building'));
  add(block(92, 0, 4, 184, 0, 90, 'building'));

  // Corner towers, each with a runnable strip on the two faces toward the plaza.
  const towers: Array<[number, number, number]> = [
    [-48, -48, 58],
    [48, -48, 52],
    [48, 48, 62],
    [-48, 48, 48],
  ];
  for (const [x, z, h] of towers) {
    add(block(x, z, 26, 26, 0, h, 'building'));
    const faceX = x > 0 ? x - 13.2 : x + 13.2;
    const faceZ = z > 0 ? z - 13.2 : z + 13.2;
    add(block(faceX, z, 0.4, 20, 4, h - 8, 'run'));
    add(block(x, faceZ, 20, 0.4, 4, h - 8, 'run'));
  }

  // Edge buildings. The south roof is the spawn point.
  add(block(0, -62, 34, 20, 0, 28, 'building'));
  add(block(0, 62, 34, 20, 0, 24, 'building'));
  add(block(62, 0, 20, 34, 0, 32, 'building'));
  add(block(-62, 0, 20, 34, 0, 26, 'building'));

  // Low platforms for climbing back up from the street.
  add(block(24, 24, 10, 10, 0, 8, 'ledge'));
  add(block(-24, 24, 10, 10, 0, 12, 'ledge'));
  add(block(24, -24, 10, 10, 0, 12, 'ledge'));
  add(block(-24, -24, 10, 10, 0, 8, 'ledge'));
  add(block(14, 34, 6, 6, 0, 1.2, 'ledge'));
  add(block(-14, -34, 6, 6, 0, 1.2, 'ledge'));

  // Freestanding wall-run panels around the plaza.
  add(block(30, 0, 1.2, 26, 3, 12, 'run'));
  add(block(-30, 0, 1.2, 26, 3, 12, 'run'));
  add(block(0, 30, 26, 1.2, 3, 12, 'run'));
  add(block(0, -30, 26, 1.2, 3, 12, 'run'));

  // Overhead beams: the crossing gives a web point above the plaza.
  add(block(0, 0, 124, 2, 40, 41.5, 'beam'));
  add(block(0, 0, 2, 124, 46, 47.5, 'beam'));
  // Sky bridges between towers give web points around the outer loop.
  add(block(0, -48, 72, 3, 34, 35.5, 'beam'));
  add(block(0, 48, 72, 3, 34, 35.5, 'beam'));
  add(block(48, 0, 3, 72, 34, 35.5, 'beam'));
  add(block(-48, 0, 3, 72, 34, 35.5, 'beam'));

  return {
    boxes,
    spawn: v(0, 24.05, 60),
    spawnYaw: 0,
    spawns: [
      // Edge roofs.
      v(0, 24.05, 60),
      v(-12, 24.05, 66),
      v(12, 24.05, 56),
      v(0, 28.05, -62),
      v(-12, 28.05, -56),
      v(12, 28.05, -66),
      v(62, 32.05, 0),
      v(66, 32.05, -12),
      v(58, 32.05, 12),
      v(-62, 26.05, 0),
      v(-66, 26.05, 12),
      v(-58, 26.05, -12),
      // Corner towers.
      v(-48, 58.05, -48),
      v(48, 52.05, -48),
      v(48, 62.05, 48),
      v(-48, 48.05, 48),
      // Platforms.
      v(24, 8.05, 24),
      v(-24, 8.05, -24),
      v(-24, 12.05, 24),
      v(24, 12.05, -24),
      // Street level, in the plaza and the outer lanes.
      v(16, 0.05, 8),
      v(-16, 0.05, -8),
      v(8, 0.05, -16),
      v(-8, 0.05, 16),
      v(40, 0.05, 18),
      v(-40, 0.05, -18),
      v(18, 0.05, -42),
      v(-18, 0.05, 42),
    ].map((pos) => ({ pos, yaw: Math.atan2(pos.x, pos.z) })),
    rings: [
      v(0, 20, 38),
      v(30, 14, 30),
      v(34, 8, 0),
      v(28, 18, -30),
      v(0, 22, -38),
      v(-30, 16, -30),
      v(-34, 8, 0),
      v(-30, 18, 30),
      v(0, 10, 0),
    ],
    patrols: [
      { a: v(-12, 0, 12), b: v(12, 0, 12) },
      { a: v(12, 0, -12), b: v(-12, 0, -12) },
      { a: v(-12, 28, -62), b: v(12, 28, -62) },
      { a: v(62, 32, -12), b: v(62, 32, 12) },
      { a: v(-62, 26, 12), b: v(-62, 26, -12) },
      { a: v(22, 8, 24), b: v(26, 8, 24) },
    ],
  };
}

export interface RayHit {
  t: number;
  point: V3;
  box: Box;
}

/** Nearest box hit along a normalized ray, within maxDist. */
export function raycast(map: GameMap, o: V3, d: V3, maxDist: number): RayHit | null {
  let best: RayHit | null = null;
  let bestT = maxDist;
  for (const box of map.boxes) {
    let tMin = 0;
    let tMax = bestT;
    let missed = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      const dir = d[axis];
      if (Math.abs(dir) < 1e-8) {
        if (o[axis] < box.min[axis] || o[axis] > box.max[axis]) {
          missed = true;
          break;
        }
        continue;
      }
      const a = (box.min[axis] - o[axis]) / dir;
      const b = (box.max[axis] - o[axis]) / dir;
      tMin = Math.max(tMin, Math.min(a, b));
      tMax = Math.min(tMax, Math.max(a, b));
      if (tMin > tMax) {
        missed = true;
        break;
      }
    }
    if (!missed && tMin > 0 && tMin < bestT) {
      bestT = tMin;
      best = {
        t: tMin,
        point: v(o.x + d.x * tMin, o.y + d.y * tMin, o.z + d.z * tMin),
        box,
      };
    }
  }
  return best;
}
