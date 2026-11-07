import type { Box, BoxKind, GameMap, V3 } from '../src/sim/map';

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

/** The original arena, kept so physics tests have fixed, simple geometry. */
export function createTestArena(): GameMap {
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
    jumpPads: [v(-14, 0, 8), v(14, 0, -8)],
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
    crates: [],
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
