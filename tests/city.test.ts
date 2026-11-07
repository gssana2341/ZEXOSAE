import { describe, expect, it } from 'vitest';
import { BLOCK, buildCity, CAR_SIZE, CITY_FROM, ROAD_WIDTH } from '../src/sim/city';
import { createArena, type Box } from '../src/sim/map';
import { TUNING } from '../src/sim/player';

const city = buildCity();
const map = createArena();

/** True when the box reaches into the asphalt of a road. */
function onRoad(box: Box): boolean {
  return city.scenery.roads.some((line) => {
    const lo = line - ROAD_WIDTH / 2 + 0.01;
    const hi = line + ROAD_WIDTH / 2 - 0.01;
    return (box.max.x > lo && box.min.x < hi) || (box.max.z > lo && box.min.z < hi);
  });
}

describe('the street grid', () => {
  it('is the same city for every player', () => {
    expect(JSON.stringify(buildCity())).toBe(JSON.stringify(city));
  });

  it('keeps every building off the roads', () => {
    for (const box of city.boxes.filter((b) => b.kind === 'building')) expect(onRoad(box)).toBe(false);
  });

  it('lays out its blocks in many different ways', () => {
    const shapes = new Set<string>();
    for (let gx = -7; gx <= 7; gx += 1) {
      for (let gz = -7; gz <= 7; gz += 1) {
        if (Math.max(Math.abs(gx), Math.abs(gz)) <= 2) continue;
        const inBlock = city.boxes.filter(
          (b) => b.kind === 'building' && Math.abs((b.min.x + b.max.x) / 2 - gx * BLOCK) < BLOCK / 2 && Math.abs((b.min.z + b.max.z) / 2 - gz * BLOCK) < BLOCK / 2,
        );
        shapes.add(`${inBlock.length}`);
      }
    }
    expect(shapes.size).toBeGreaterThanOrEqual(4);
    expect(city.scenery.areas.some((a) => a.kind === 'park')).toBe(true);
    expect(city.scenery.areas.some((a) => a.kind === 'parking')).toBe(true);
    const heights = city.boxes.filter((b) => b.kind === 'building').map((b) => Math.round(b.max.y / 10));
    expect(new Set(heights).size).toBeGreaterThanOrEqual(6);
  });

  it('parks cars along the kerbs, low enough to vault, never in a junction', () => {
    expect(city.scenery.cars.length).toBeGreaterThan(80);
    expect(CAR_SIZE.height).toBeLessThan(TUNING.vaultHeight);
    for (const car of city.scenery.cars) {
      const inJunction =
        city.scenery.roads.some((l) => Math.abs(car.x - l) < ROAD_WIDTH / 2) &&
        city.scenery.roads.some((l) => Math.abs(car.z - l) < ROAD_WIDTH / 2);
      expect(inJunction).toBe(false);
    }
  });

  it('leaves the Spire district to its own streets', () => {
    for (const box of city.boxes) {
      const middle = { x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 };
      expect(Math.max(Math.abs(middle.x), Math.abs(middle.z))).toBeGreaterThan(CITY_FROM - 20);
    }
  });

  it('nothing in the city overlaps anything else', () => {
    const solid = map.boxes.filter((b) => b.kind === 'building' || b.kind === 'prop');
    const overlap = (a: Box, b: Box) =>
      a.min.x < b.max.x - 0.01 && a.max.x > b.min.x + 0.01 &&
      a.min.y < b.max.y - 0.01 && a.max.y > b.min.y + 0.01 &&
      a.min.z < b.max.z - 0.01 && a.max.z > b.min.z + 0.01;
    const clashes: string[] = [];
    for (let i = 0; i < solid.length; i += 1) {
      for (let j = i + 1; j < solid.length; j += 1) {
        if (overlap(solid[i], solid[j])) clashes.push(JSON.stringify([solid[i].min, solid[j].min]));
      }
    }
    expect(clashes).toEqual([]);
  });
});
