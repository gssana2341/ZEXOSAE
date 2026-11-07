import { describe, expect, it } from 'vitest';
import { createArena, nearbyBoxes, raycast, type GameMap, type RayHit, type V3 } from '../src/sim/map';

/** Straight scan of all boxes, used to check the indexed raycast. */
function scan(map: GameMap, origin: V3, direction: V3, limit: number): RayHit | null {
  let best: RayHit | null = null;
  let bestT = limit;
  for (const box of map.boxes) {
    let near = 0;
    let far = bestT;
    let missed = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      const d = direction[axis];
      if (Math.abs(d) < 1e-8) {
        if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) { missed = true; break; }
      } else {
        const a = (box.min[axis] - origin[axis]) / d;
        const b = (box.max[axis] - origin[axis]) / d;
        near = Math.max(near, Math.min(a, b));
        far = Math.min(far, Math.max(a, b));
        if (near > far) { missed = true; break; }
      }
    }
    if (!missed && near > 0 && near < bestT) {
      bestT = near;
      best = { box, t: near, point: { x: origin.x + direction.x * near, y: origin.y + direction.y * near, z: origin.z + direction.z * near } };
    }
  }
  return best;
}

describe('large-city spatial index', () => {
  it('returns every intersecting box in the original order near cell boundaries', () => {
    const map = createArena();
    for (const x of [-449, -128, -64.01, -64, -0.01, 0, 63.99, 64, 128, 449]) {
      for (const z of [-449, -64, 0, 64, 449]) {
        const actual = nearbyBoxes(map, x - 1, z - 1, x + 1, z + 1);
        const touching = map.boxes.filter((b) => b.min.x <= x + 1 && b.max.x >= x - 1 && b.min.z <= z + 1 && b.max.z >= z - 1);
        const selected = actual.filter((b) => touching.includes(b));
        expect(selected).toEqual(touching);
      }
    }
  });

  it('matches an exhaustive scan for web, combat and camera rays throughout the city', () => {
    const map = createArena();
    let seed = 48179;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 1500; i += 1) {
      const origin = { x: random() * 920 - 460, y: random() * 150 + 0.1, z: random() * 920 - 460 };
      const yaw = random() * Math.PI * 2;
      const pitch = random() * Math.PI - Math.PI / 2;
      const direction = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
      const limit = i % 17 === 0 ? 1000 : 1 + random() * 100;
      const expected = scan(map, origin, direction, limit);
      const actual = raycast(map, origin, direction, limit);
      expect(actual?.box, `ray ${i}`).toBe(expected?.box);
      if (expected) expect(actual?.t, `ray ${i}`).toBeCloseTo(expected.t, 8);
    }
  });
});
