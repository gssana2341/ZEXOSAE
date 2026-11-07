// The arena is built only from axis-aligned boxes. This keeps collision cheap
// and lets a future game server reuse this file without Three.js.

import { buildCity, LAMP_HEIGHT, type Scenery } from './city';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * ground: floor. building: solid. run: thin panel. beam: overhead web point.
 * ledge: platform. deck: walkable concrete. prop: low street object.
 * bound: invisible edge of the arena, which a web can't stick to.
 */
export type BoxKind = 'ground' | 'building' | 'run' | 'beam' | 'ledge' | 'deck' | 'prop' | 'bound';

/** How a building's walls are drawn. It has no effect on play. */
export type BoxStyle = 'glass' | 'brick' | 'concrete' | 'steel';

export interface Box {
  min: V3;
  max: V3;
  kind: BoxKind;
  style?: BoxStyle;
  /** The tallest tower has a regular facade and an open viewing roof. */
  landmark?: 'observation';
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
  /** Ground positions that launch the player upward. Nothing solid, so they can't block a run. */
  jumpPads: V3[];
  rings: V3[];
  patrols: Patrol[];
  /** Loose crates the web can fetch and throw. Nothing solid, so they never block a run. */
  crates: V3[];
  /** Roads, parks, parked cars and trees, for drawing. Their collision is already in boxes. */
  scenery?: Scenery;
}

export const RING_RADIUS = 4.5;
export const JUMP_PAD_RADIUS = 2.4;
/** The inner faces of the boundary walls. Past this, the player has left the arena. */
export const ARENA_LIMIT = 450;
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
  style?: BoxStyle,
): Box {
  return {
    min: v(cx - w / 2, y0, cz - d / 2),
    max: v(cx + w / 2, y1, cz + d / 2),
    kind,
    style,
  };
}

/**
 * The Spire district: a plaza with a central spire, ringed by a road, eight themed
 * blocks and a wall of tall buildings at the edge. Nothing but buildings stands here,
 * because every wall can be climbed and needs no extra ledges or panels.
 */
export function createArena(): GameMap {
  const boxes: Box[] = [];
  const add = (...b: Box[]) => boxes.push(...b);

  // Floor and the invisible limit.
  const width = ARENA_LIMIT * 2;
  add(block(0, 0, width, width, -4, 0, 'ground'));
  add(block(0, -ARENA_LIMIT - 2, width + 8, 4, 0, 150, 'bound'));
  add(block(0, ARENA_LIMIT + 2, width + 8, 4, 0, 150, 'bound'));
  add(block(-ARENA_LIMIT - 2, 0, 4, width + 8, 0, 150, 'bound'));
  add(block(ARENA_LIMIT + 2, 0, 4, width + 8, 0, 150, 'bound'));

  // Edge buildings, which frame the arena.
  const northHeights = [46, 62, 38, 70, 52, 44];
  const southHeights = [54, 40, 66, 36, 58, 48];
  northHeights.forEach((h, i) => { if (i !== 2 && i !== 3) add(block(-75 + i * 30, -81, 30, 18, 0, h, 'building', i % 2 ? 'glass' : 'brick')); });
  southHeights.forEach((h, i) => { if (i !== 2 && i !== 3) add(block(-75 + i * 30, 81, 30, 18, 0, h, 'building', i % 2 ? 'brick' : 'glass')); });
  [42, 60, 34, 56, 40, 64].forEach((h, i) => { if (i !== 2 && i !== 3) add(block(81, -60 + i * 24, 18, 24, 0, h, 'building', i % 2 ? 'glass' : 'brick')); });
  [58, 38, 50, 68, 36, 48].forEach((h, i) => { if (i !== 2 && i !== 3) add(block(-81, -60 + i * 24, 18, 24, 0, h, 'building', i % 2 ? 'brick' : 'glass')); });

  // A second district outside the old city walls, with streets through all four sides.
  for (const x of [-112, 112]) {
    for (const z of [-112, -56, 0, 56, 112]) {
      const height = 30 + ((Math.abs(x + z) / 8) % 4) * 8;
      add(block(x, z, 24, 24, 0, height, 'building', z % 112 === 0 ? 'glass' : 'brick'));
    }
  }
  for (const z of [-112, 112]) {
    for (const x of [-56, 0, 56]) {
      const height = 34 + Math.abs(x) / 7;
      add(block(x, z, 24, 24, 0, height, 'building', x === 0 ? 'glass' : 'brick'));
    }
  }

  // The street grid around the district: varied blocks, parks, car parks and parked cars.
  const city = buildCity();
  add(...city.boxes);
  // The central district has its own roads, so it needs lamps as well.
  for (const [x, z, outX, outZ] of [
    [-34, -34, 1, 1], [34, -34, -1, 1], [-34, 34, 1, -1], [34, 34, -1, -1],
    [-20, -34, 1, 1], [20, 34, -1, -1], [-34, 20, 1, -1], [34, -20, -1, 1],
  ]) {
    city.scenery.lamps.push({ x, z, outX, outZ });
    add(block(x, z, 0.3, 0.3, 0, LAMP_HEIGHT, 'prop'));
  }
  const outerSpawns = city.spawns;

  // A continuous, varied skyline forms the city edge, like the original district.
  const edge = ARENA_LIMIT - 15;
  for (let i = 0; i < 30; i += 1) {
    const along = -ARENA_LIMIT + 15 + i * 30;
    const north = 48 + ((i * 17 + 2) % 8) * 8;
    const south = 48 + ((i * 13 + 5) % 8) * 8;
    add(block(along, -edge, 30, 30, 0, north, 'building', i % 2 ? 'glass' : 'brick'));
    add(block(along, edge, 30, 30, 0, south, 'building', i % 2 ? 'brick' : 'glass'));
  }
  for (let i = 0; i < 28; i += 1) {
    const along = -ARENA_LIMIT + 45 + i * 30;
    const east = 48 + ((i * 19 + 1) % 8) * 8;
    const west = 48 + ((i * 11 + 4) % 8) * 8;
    add(block(edge, along, 30, 30, 0, east, 'building', i % 2 ? 'glass' : 'brick'));
    add(block(-edge, along, 30, 30, 0, west, 'building', i % 2 ? 'brick' : 'glass'));
  }

  // North-west: glass office tower.
  add(block(-48, -48, 26, 26, 0, 62, 'building', 'glass'));

  // North-east: brick block.
  add(block(48, -48, 26, 26, 0, 38, 'building', 'brick'));

  // South-east: twin towers, joined by a beam to swing from.
  add(block(41, 48, 12, 26, 0, 52, 'building', 'glass'));
  add(block(57, 48, 8, 26, 0, 46, 'building', 'glass'));
  add(block(50, 48, 6, 3, 30, 31.5, 'beam'));

  // South-west: stepped hotel, a staircase to the sky.
  add(block(-48, 48, 26, 26, 0, 14, 'building', 'brick'));
  add(block(-48, 48, 18, 18, 14, 28, 'building', 'brick'));
  add(block(-48, 48, 10, 10, 28, 42, 'building', 'brick'));

  // North: mall with a tunnel straight through it.
  add(block(-10, -48, 10, 22, 0, 22, 'building', 'glass'));
  add(block(10, -48, 10, 22, 0, 22, 'building', 'glass'));
  add(block(0, -48, 10, 22, 6.5, 22, 'building', 'glass'));

  // South: apartment block. Practice starts on this roof.
  add(block(0, 48, 30, 22, 0, 24, 'building', 'brick'));

  // East: open parking garage.
  add(block(48, 0, 22, 30, 5.5, 6, 'deck'));
  add(block(48, 0, 22, 30, 11.5, 12, 'deck'));
  add(block(48, 0, 22, 30, 17.5, 18, 'deck'));
  for (const x of [38.5, 48, 57.5]) {
    for (const z of [-14, 0, 14]) add(block(x, z, 1.5, 1.5, 0, 17.5, 'building', 'concrete'));
  }

  // West: stadium.
  add(block(-48, 0, 22, 30, 0, 26, 'building', 'concrete'));

  // The Spire, carrying a cross of beams out to a square halo over the ring road.
  // Every web point around the plaza is part of this one tidy frame.
  add(block(0, 0, 10, 10, 0, 5, 'building', 'concrete'));
  add(block(0, 0, 4, 4, 5, 34, 'building', 'steel'));
  add(block(0, 0, 60, 2, 34, 35.5, 'beam'));
  add(block(0, 0, 2, 60, 34, 35.5, 'beam'));
  add(block(0, -30, 62, 2, 34, 35.5, 'beam'));
  add(block(0, 30, 62, 2, 34, 35.5, 'beam'));
  add(block(-30, 0, 2, 62, 34, 35.5, 'beam'));
  add(block(30, 0, 2, 62, 34, 35.5, 'beam'));

  // Posts holding up the halo.
  for (const [x, z] of [[30, -30], [-30, -30], [30, 30], [-30, 30]]) {
    add(block(x, z, 1, 1, 0, 34, 'building', 'steel'));
  }

  const spawn = v(0, 24.05, 52);

  return {
    boxes,
    scenery: city.scenery,
    spawn,
    spawnYaw: 0,
    spawns: [
      spawn,
      v(-10, 24.05, 44),
      v(10, 24.05, 56),
      v(-10, 22.05, -52),
      v(10, 22.05, -44),
      v(0, 22.05, -56),
      v(50, 18.05, -9),
      v(44, 18.05, 9),
      v(-48, 26.05, 10),
      v(-48, 26.05, -11),
      v(-59, 14.05, 48),
      v(-55, 28.05, 48),
      v(-48, 42.05, 48),
      v(-48, 62.05, -48),
      v(41, 52.05, 48),
      v(57, 46.05, 48),
      v(40, 38.05, -52),
      v(42, 38.05, -42),
      v(66, 0.05, 13),
      v(-66, 0.05, 39),
      v(13, 0.05, 66),
      v(-13, 0.05, -66),
      v(28, 0.05, 28),
      v(-28, 0.05, -28),
      v(-28, 0.05, 28),
      v(28, 0.05, -28),
      v(-19, 0.05, 17),
      v(19, 0.05, -17),
      v(30, 0.05, 6),
      v(-30, 0.05, -6),
      v(-112, 30.05, -112),
      v(112, 30.05, 112),
      v(-136, 0.05, -80),
      v(136, 0.05, 80),
      v(-80, 0.05, 136),
      v(80, 0.05, -136),
      ...outerSpawns,
    ].map((pos) => ({ pos, yaw: Math.atan2(pos.x, pos.z) })),
    jumpPads: [v(-14, 0, 8), v(14, 0, -8)],
    rings: [
      v(0, 18, 31),
      v(23, 14, 21),
      v(21, 9, 0),
      v(22, 20, -22),
      v(0, 24, -31),
      v(-22, 16, -22),
      v(-21, 9, 0),
      v(-22, 18, 22),
      v(0, 12, 13),
    ],
    patrols: [
      { a: v(-10, 0, 14), b: v(10, 0, 14) },
      { a: v(10, 0, -14), b: v(-10, 0, -14) },
      { a: v(-10, 24, 50), b: v(10, 24, 50) },
      { a: v(-48, 26, -10), b: v(-48, 26, 10) },
      { a: v(48, 18, 10), b: v(48, 18, -10) },
      { a: v(-20, 0, 66), b: v(20, 0, 66) },
    ],
    crates: [
      v(-6, 0, 20),
      v(6, 0, -20),
      v(-17, 0, -2),
      v(17, 0, 2),
      v(-4, 24, 46),
      v(5, 24, 57),
      v(-44, 26, 4),
      v(44, 18, -4),
      v(26, 0, 66),
      v(-18, 0, -66),
    ],
  };
}

export interface RayHit {
  t: number;
  point: V3;
  box: Box;
}

// The enlarged city has many static boxes. Index them by street block so a short
// ray or collision only visits nearby buildings. Small test maps stay as-is.
const CELL_SIZE = 64;
const INDEX_FROM = 80;
interface SpatialIndex {
  boxes: Box[];
  count: number;
  cells: Map<string, number[]>;
}
const spatialIndices = new WeakMap<GameMap, SpatialIndex>();

function spatialIndex(map: GameMap): SpatialIndex | null {
  if (map.boxes.length < INDEX_FROM) return null;
  const existing = spatialIndices.get(map);
  if (existing && existing.boxes === map.boxes && existing.count === map.boxes.length) return existing;
  const cells = new Map<string, number[]>();
  map.boxes.forEach((box, i) => {
    const x0 = Math.floor(box.min.x / CELL_SIZE);
    const x1 = Math.floor(box.max.x / CELL_SIZE);
    const z0 = Math.floor(box.min.z / CELL_SIZE);
    const z1 = Math.floor(box.max.z / CELL_SIZE);
    for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) {
      const key = `${x},${z}`;
      const list = cells.get(key) ?? [];
      list.push(i);
      cells.set(key, list);
    }
  });
  const result = { boxes: map.boxes, count: map.boxes.length, cells };
  spatialIndices.set(map, result);
  return result;
}

/** Boxes touching a horizontal rectangle, in their original collision order. */
export function nearbyBoxes(map: GameMap, minX: number, minZ: number, maxX: number, maxZ: number): Box[] {
  const index = spatialIndex(map);
  if (!index || ![minX, minZ, maxX, maxZ].every(Number.isFinite)) return map.boxes;
  const x0 = Math.floor(Math.min(minX, maxX) / CELL_SIZE);
  const x1 = Math.floor(Math.max(minX, maxX) / CELL_SIZE);
  const z0 = Math.floor(Math.min(minZ, maxZ) / CELL_SIZE);
  const z1 = Math.floor(Math.max(minZ, maxZ) / CELL_SIZE);
  if ((x1 - x0 + 1) * (z1 - z0 + 1) > 64) return map.boxes;
  const found = new Set<number>();
  for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) {
    for (const i of index.cells.get(`${x},${z}`) ?? []) found.add(i);
  }
  return [...found].sort((a, b) => a - b).map((i) => map.boxes[i]);
}

/** Nearest box hit along a normalized ray, within maxDist. */
export function raycast(map: GameMap, o: V3, d: V3, maxDist: number): RayHit | null {
  let best: RayHit | null = null;
  let bestT = maxDist;
  const endX = o.x + d.x * maxDist;
  const endZ = o.z + d.z * maxDist;
  for (const box of nearbyBoxes(map, o.x, o.z, endX, endZ)) {
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
