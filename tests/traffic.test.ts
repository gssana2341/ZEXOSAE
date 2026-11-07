import { describe, expect, it } from 'vitest';
import { lightFor, LIGHT_CYCLE, Traffic } from '../src/render/traffic';

describe('traffic lights', () => {
  it('never gives both roads at a junction a green at once', () => {
    for (let t = 0; t < LIGHT_CYCLE * 2; t += 0.1) {
      expect(lightFor(true, t) === 'green' && lightFor(false, t) === 'green').toBe(false);
      expect(lightFor(true, t) !== 'red' && lightFor(false, t) !== 'red').toBe(false);
    }
  });

  it('gives each road its turn', () => {
    const seen = new Set<string>();
    for (let t = 0; t < LIGHT_CYCLE; t += 0.1) seen.add(`${lightFor(true, t)}/${lightFor(false, t)}`);
    expect(seen).toContain('green/red');
    expect(seen).toContain('red/green');
  });
});

describe('traffic', () => {
  /** One road along z, crossed by roads at z = -50, 0 and 50. */
  function street(perLane: number): Traffic {
    return new Traffic([-50, 0, 50], [100], 120, 8, perLane);
  }

  it('stops at the line on red and waits there', () => {
    const t = street(1);
    const car = t.cars.find((c) => t.lanes[c.lane].vertical && t.lanes[c.lane].dir === 1)!;
    car.s = -40;
    car.speed = 10;
    // North-south red for the next few seconds.
    const red = 10;
    for (let i = 0; i < 300; i += 1) t.step(1 / 60, red);
    expect(car.speed).toBeLessThan(0.1);
    // Stopped just short of the junction at z = 0.
    expect(car.s).toBeLessThan(-9);
    expect(car.s).toBeGreaterThan(-16);
  });

  it('goes again on green', () => {
    const t = street(1);
    const car = t.cars.find((c) => t.lanes[c.lane].vertical && t.lanes[c.lane].dir === 1)!;
    car.s = -40;
    for (let i = 0; i < 300; i += 1) t.step(1 / 60, 10);
    const waiting = car.s;
    for (let i = 0; i < 180; i += 1) t.step(1 / 60, 1);
    expect(car.s).toBeGreaterThan(waiting + 10);
  });

  it('keeps its distance from the car in front', () => {
    const t = street(5);
    for (let i = 0; i < 2000; i += 1) t.step(1 / 30, i / 30);
    for (let lane = 0; lane < t.lanes.length; lane += 1) {
      const cars = t.cars.filter((c) => c.lane === lane && Math.abs(c.s) < 115).sort((a, b) => a.s - b.s);
      for (let i = 1; i < cars.length; i += 1) expect(cars[i].s - cars[i - 1].s).toBeGreaterThan(4.4);
    }
  });

  it('places cars on the left of the road, facing the way they drive', () => {
    const t = street(1);
    const north = t.cars.find((c) => t.lanes[c.lane].vertical && t.lanes[c.lane].dir === 1)!;
    const south = t.cars.find((c) => t.lanes[c.lane].vertical && t.lanes[c.lane].dir === -1)!;
    expect(t.place(north, 3.4).x).toBeCloseTo(100 - 3.4);
    expect(t.place(south, 3.4).x).toBeCloseTo(100 + 3.4);
    expect(t.place(north, 3.4).yaw).toBe(0);
  });
});
