import { describe, expect, it } from 'vitest';
import { BLOCK, buildCity, CAR_SIZE, CITY_FROM, OBSERVATION_TOWER, ROAD_WIDTH } from '../src/sim/city';
import { createArena, raycast, type Box } from '../src/sim/map';
import { emptyInput, TUNING } from '../src/sim/player';
import { TICK, World } from '../src/sim/world';

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
  it('has a distinctive, walkable observation roof above the rest of the city', () => {
    const tower = map.boxes.find((box) => box.landmark === 'observation')!;
    expect(tower).toBeDefined();
    expect(tower.max.y).toBe(OBSERVATION_TOWER.height);
    const otherRoofs = map.boxes.filter((box) => box.kind === 'building' && box !== tower).map((box) => box.max.y);
    expect(tower.max.y).toBeGreaterThan(Math.max(...otherRoofs) + 50);
    const point = { x: OBSERVATION_TOWER.x, y: OBSERVATION_TOWER.height + 0.05, z: OBSERVATION_TOWER.z };
    expect(raycast(map, { ...point, y: point.y + 2 }, { x: 0, y: -1, z: 0 }, 4)?.box).toBe(tower);
    const world = new World(null, map);
    world.respawnAt(point, 0);
    for (let i = 0; i < 60; i += 1) world.step(emptyInput(), TICK);
    expect(world.player.pos.y).toBeCloseTo(point.y, 1);
  });

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
