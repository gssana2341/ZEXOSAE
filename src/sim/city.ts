// The neighbourhoods around the Spire district: a street grid of city blocks, each laid
// out its own way (a tower, a pair, four small buildings, a long block, a courtyard,
// a park or a car park), with cars parked along the kerbs. Built from a fixed seed,
// so every player gets the same city. No three.js in here.

import type { Box, BoxKind, BoxStyle, V3 } from './map';

/** Block centres sit on multiples of this. Roads run halfway between them. */
export const BLOCK = 56;
export const ROAD_WIDTH = 16;
export const SIDEWALK = 3;
/** How far from a block's centre its buildings may reach. */
const LOT = BLOCK / 2 - ROAD_WIDTH / 2 - SIDEWALK;
/** Grid cells from the centre. Inside INNER is the Spire district and its ring. */
const INNER = 2;
const OUTER = 7;
/** Roads closer to the middle than this run into the Spire district, which has its own streets. */
export const CITY_FROM = 130;

export const CAR_SIZE = { length: 4.4, width: 2, height: 1.5 };
/** Street lamp posts: thin, solid, and about two storeys tall. */
export const LAMP_HEIGHT = 6.4;
/** Traffic light poles: solid and a little lower than the lamps. */
export const SIGNAL_HEIGHT = 5;
const SIGNAL_POST = 0.3;
const LAMP_POST = 0.3;
/** Kerbside parking sits this far from a road's centre line. */
const PARKING_OFFSET = ROAD_WIDTH / 2 - 1.4;

export interface ParkedCar {
  x: number;
  z: number;
  /** The way the car points: along x or along z. */
  along: 'x' | 'z';
  /** Index into the car colours. */
  color: number;
}

export interface Tree {
  x: number;
  z: number;
  /** 1 is a full-size tree. */
  size: number;
}

/** A street lamp on a block's corner. Its arm reaches out over the road, away from the block. */
export interface Lamp {
  x: number;
  z: number;
  /** Which way the arm reaches, as a sign on each axis. */
  outX: number;
  outZ: number;
}

export interface Area {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: 'park' | 'parking';
}

/** Everything the street grid adds that isn't a building, for drawing it. */
export interface Scenery {
  cars: ParkedCar[];
  trees: Tree[];
  areas: Area[];
  lamps: Lamp[];
  /** Traffic light poles, on the two corners of each junction without a lamp. */
  signals: Array<{ x: number; z: number }>;
  /** Centre lines of the roads, the same set for both directions. */
  roads: number[];
}

export const CAR_COLOURS = 8;

type Layout = 'tower' | 'twin' | 'quad' | 'slab' | 'courtyard' | 'park' | 'parking';

/** A repeatable number in [0, 1) for a grid cell and a purpose. */
function hash(a: number, b: number, salt: number): number {
  let h = Math.imul(a * 73856093 ^ b * 19349663 ^ salt * 83492791, 0x5bd1e995);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function pick<T>(r: number, weighted: Array<[T, number]>): T {
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  let at = r * total;
  for (const [value, weight] of weighted) {
    at -= weight;
    if (at < 0) return value;
  }
  return weighted[weighted.length - 1][0];
}

/** Downtown blocks near the middle lean to towers, the outskirts to parks and low blocks. */
function layoutFor(ring: number, r: number): Layout {
  if (ring <= 4) {
    return pick(r, [['tower', 35], ['twin', 25], ['slab', 15], ['courtyard', 10], ['quad', 10], ['park', 5]]);
  }
  if (ring === 5) {
    return pick(r, [['tower', 15], ['twin', 20], ['quad', 20], ['slab', 15], ['courtyard', 10], ['park', 10], ['parking', 10]]);
  }
  return pick(r, [['tower', 6], ['twin', 15], ['quad', 25], ['slab', 15], ['courtyard', 9], ['park', 15], ['parking', 15]]);
}

/** Plain concrete never gets a building model, so the street grid sticks to these. */
const STYLES: BoxStyle[] = ['glass', 'brick', 'glass', 'brick', 'glass'];

export interface CityParts {
  boxes: Box[];
  scenery: Scenery;
  /** Roof spots for players to appear on, one per chosen block. */
  spawns: V3[];
}

/** Blocks a spawn is placed on. Forced to have a building. */
const SPAWN_CELLS = [
  [4, 0],
  [-4, 0],
  [0, 4],
  [0, -4],
  [4, 4],
  [-4, -4],
  [4, -4],
  [-4, 4],
];

export function buildCity(): CityParts {
  const boxes: Box[] = [];
  const spawns: V3[] = [];
  const scenery: Scenery = { cars: [], trees: [], areas: [], lamps: [], signals: [], roads: [] };

  const solid = (cx: number, cz: number, w: number, d: number, h: number, style: BoxStyle, y0 = 0): Box => {
    const box: Box = {
      min: { x: cx - w / 2, y: y0, z: cz - d / 2 },
      max: { x: cx + w / 2, y: y0 + h, z: cz + d / 2 },
      kind: 'building' as BoxKind,
      style,
    };
    boxes.push(box);
    return box;
  };
  const prop = (cx: number, cz: number, w: number, d: number, y0: number, y1: number) =>
    boxes.push({ min: { x: cx - w / 2, y: y0, z: cz - d / 2 }, max: { x: cx + w / 2, y: y1, z: cz + d / 2 }, kind: 'prop' });

  for (let gx = -OUTER; gx <= OUTER; gx += 1) {
    for (let gz = -OUTER; gz <= OUTER; gz += 1) {
      const ring = Math.max(Math.abs(gx), Math.abs(gz));
      if (ring <= INNER) continue;
      const cx = gx * BLOCK;
      const cz = gz * BLOCK;
      const r = (salt: number) => hash(gx, gz, salt);
      const style = (salt: number) => STYLES[Math.floor(r(salt) * STYLES.length)];
      // Lamps on two opposite corners of every block, on the pavement.
      const corner = BLOCK / 2 - ROAD_WIDTH / 2 - 0.8;
      for (const s of [-1, 1]) {
        const lamp = { x: cx + s * corner, z: cz + s * corner, outX: s, outZ: s };
        scenery.lamps.push(lamp);
        prop(lamp.x, lamp.z, LAMP_POST, LAMP_POST, 0, LAMP_HEIGHT);
      }
      const spawnHere = SPAWN_CELLS.some(([x, z]) => x === gx && z === gz);
      let layout = layoutFor(ring, r(1));
      if (spawnHere && (layout === 'park' || layout === 'parking')) layout = 'tower';

      const height = (lo: number, hi: number, salt: number) => Math.round(lo + (hi - lo) * r(salt));
      const tall = ring <= 4 ? 1 : ring === 5 ? 0.8 : 0.65;
      const built: Box[] = [];

      switch (layout) {
        case 'tower': {
          const w = 22 + Math.round(r(2) * 3) * 2;
          const d = 22 + Math.round(r(3) * 3) * 2;
          built.push(solid(cx, cz, w, d, height(70 * tall, 104 * tall, 4), r(5) < 0.6 ? 'glass' : 'brick'));
          break;
        }
        case 'twin': {
          const along = r(2) < 0.5;
          for (const s of [-1, 1]) {
            const h = height(30 * tall + 6, 72 * tall + 6, 3 + s);
            built.push(along ? solid(cx + s * 8.5, cz, 15, 30, h, style(5 + s)) : solid(cx, cz + s * 8.5, 30, 15, h, style(5 + s)));
          }
          break;
        }
        case 'quad': {
          let k = 0;
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              k += 1;
              built.push(solid(cx + sx * 8.5, cz + sz * 8.5, 14, 14, height(12, 46 * tall + 6, 10 + k), style(20 + k)));
            }
          }
          break;
        }
        case 'slab': {
          const along = r(2) < 0.5;
          const h = height(24, 46 * tall + 8, 3);
          built.push(along ? solid(cx - 9, cz, 15, 34, h, style(4)) : solid(cx, cz - 9, 34, 15, h, style(4)));
          for (const s of [-1, 1]) {
            const low = height(8, 16, 6 + s);
            built.push(along ? solid(cx + 9, cz + s * 9, 14, 14, low, style(8 + s)) : solid(cx + s * 9, cz + 9, 14, 14, low, style(8 + s)));
          }
          break;
        }
        case 'courtyard': {
          const h = height(18, 36, 3);
          const turn = Math.floor(r(2) * 4);
          // Three wings round an open yard that faces one street.
          const wings: Array<[number, number, number, number]> = [
            [0, -12, 34, 10],
            [-12, 3, 10, 20],
            [12, 3, 10, 20],
          ];
          for (const [x, z, w, d] of wings) {
            const [rx, rz, rw, rd] = turn % 2 === 0 ? [x, z * (turn === 0 ? 1 : -1), w, d] : [z * (turn === 1 ? 1 : -1), x, d, w];
            built.push(solid(cx + rx, cz + rz, rw, rd, h + Math.round(r(9 + rx) * 6), style(4)));
          }
          break;
        }
        case 'park': {
          scenery.areas.push({ x0: cx - LOT, z0: cz - LOT, x1: cx + LOT, z1: cz + LOT, kind: 'park' });
          for (let i = 0; i < 9; i += 1) {
            // Trees around the edge of the park, leaving its middle open.
            const angle = (i / 9) * Math.PI * 2 + r(30) * 0.5;
            const radius = 9 + r(31 + i) * 5;
            const tx = Math.round((cx + Math.cos(angle) * radius) * 2) / 2;
            const tz = Math.round((cz + Math.sin(angle) * radius) * 2) / 2;
            const size = 0.8 + r(40 + i) * 0.5;
            scenery.trees.push({ x: tx, z: tz, size });
            prop(tx, tz, 0.8 * size, 0.8 * size, 0, 2.6 * size);
            prop(tx, tz, 3.6 * size, 3.6 * size, 2.6 * size, 5.6 * size);
          }
          break;
        }
        case 'parking': {
          scenery.areas.push({ x0: cx - LOT, z0: cz - LOT, x1: cx + LOT, z1: cz + LOT, kind: 'parking' });
          // A small kiosk, and two rows of parked cars.
          built.push(solid(cx + LOT - 5, cz + LOT - 5, 8, 8, 5, 'brick'));
          for (const row of [-9, 3]) {
            for (let slot = -3; slot <= 2; slot += 1) {
              if (r(50 + row * 7 + slot) < 0.35) continue;
              const x = cx + slot * 3.2 - 2;
              const z = cz + row;
              scenery.cars.push({ x, z, along: 'z', color: Math.floor(r(70 + slot + row) * CAR_COLOURS) });
              prop(x, z, CAR_SIZE.width, CAR_SIZE.length, 0, CAR_SIZE.height);
            }
          }
          break;
        }
      }

      if (spawnHere && built.length) {
        const top = built.reduce((a, b) => (b.max.y - b.min.y > a.max.y - a.min.y ? b : a));
        spawns.push({ x: (top.min.x + top.max.x) / 2, y: top.max.y + 0.05, z: (top.min.z + top.max.z) / 2 });
      }
    }
  }

  // Roads run between the blocks. Cars park along the kerbs, in gaps between the junctions.
  for (let k = -OUTER - 1; k <= OUTER; k += 1) {
    const line = k * BLOCK + BLOCK / 2;
    scenery.roads.push(line);
    for (let j = -OUTER; j <= OUTER; j += 1) {
      const middle = j * BLOCK;
      for (const side of [-1, 1]) {
        for (let slot = -3; slot <= 3; slot += 1) {
          const along = middle + slot * 5.6;
          const across = line + side * PARKING_OFFSET;
          const salt = 200 + k * 31 + j * 17 + side * 7 + slot;
          for (const vertical of [true, false]) {
            const x = vertical ? across : along;
            const z = vertical ? along : across;
            if (Math.max(Math.abs(x), Math.abs(z)) < CITY_FROM) continue;
            if (Math.max(Math.abs(x), Math.abs(z)) > (OUTER + 0.4) * BLOCK) continue;
            if (hash(vertical ? k : j, vertical ? j : k, salt + (vertical ? 0 : 999)) > 0.16) continue;
            scenery.cars.push({ x, z, along: vertical ? 'z' : 'x', color: Math.floor(hash(k, j, salt + 5) * CAR_COLOURS) });
            const [w, d] = vertical ? [CAR_SIZE.width, CAR_SIZE.length] : [CAR_SIZE.length, CAR_SIZE.width];
            prop(x, z, w, d, 0, CAR_SIZE.height);
          }
        }
      }
    }
  }

  // Traffic lights at every junction of the grid.
  const corner = ROAD_WIDTH / 2 + 0.8;
  for (const lx of scenery.roads) {
    for (const lz of scenery.roads) {
      if (Math.max(Math.abs(lx), Math.abs(lz)) < CITY_FROM || Math.max(Math.abs(lx), Math.abs(lz)) > OUTER * BLOCK + 8) continue;
      for (const s of [-1, 1]) {
        const at = { x: lx + s * corner, z: lz - s * corner };
        scenery.signals.push(at);
        prop(at.x, at.z, SIGNAL_POST, SIGNAL_POST, 0, SIGNAL_HEIGHT);
      }
    }
  }

  return { boxes, scenery, spawns };
}
