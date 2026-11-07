import { describe, expect, it } from 'vitest';
import {
  CHASE,
  createChaseCamera,
  resetChaseCamera,
  stepChaseCamera,
  type ChaseInput,
} from '../src/render/chase-camera';

const dt = 1 / 60;
const open: ChaseInput['clearance'] = (_from, _dir, limit) => limit;

const input = (extra: Partial<ChaseInput>): ChaseInput => ({
  head: { x: 0, y: 2, z: 0 },
  yaw: 0,
  pitch: 0,
  speed: 0,
  sideSpeed: 0,
  swinging: false,
  dt,
  clearance: open,
  ...extra,
});

function settle(extra: Partial<ChaseInput>, seconds = 4, c = createChaseCamera()) {
  let pos = stepChaseCamera(c, input(extra));
  for (let t = 0; t < seconds; t += dt) pos = stepChaseCamera(c, input(extra));
  return { c, pos };
}

describe('third-person camera', () => {
  it('sits behind, above and over the shoulder', () => {
    const { pos } = settle({});
    expect(pos.z).toBeGreaterThan(2.5);
    expect(pos.y).toBeGreaterThan(2);
    expect(pos.x).toBeGreaterThan(0.3);
  });

  it('stays behind wherever the player looks', () => {
    const { pos } = settle({ yaw: Math.PI / 2 });
    expect(pos.x).toBeGreaterThan(2.5);
  });

  it('falls back as speed builds, and further on a web', () => {
    const still = settle({}).c.distance;
    const fast = settle({ speed: 30 }).c.distance;
    const swinging = settle({ speed: 30, swinging: true }).c.distance;
    expect(fast).toBeGreaterThan(still + 0.7);
    expect(swinging).toBeGreaterThan(fast + 0.25);
  });

  it('eases its distance instead of snapping', () => {
    const { c } = settle({});
    const before = c.distance;
    stepChaseCamera(c, input({ speed: 40, swinging: true }));
    expect(c.distance - before).toBeLessThan(0.2);
  });

  it('trails behind a fast player, like a spring', () => {
    const c = createChaseCamera();
    let z = 0;
    stepChaseCamera(c, input({ head: { x: 0, y: 2, z } }));
    let gap = 0;
    for (let i = 0; i < 90; i += 1) {
      z -= 30 * dt;
      const pos = stepChaseCamera(c, input({ head: { x: 0, y: 2, z }, speed: 30 }));
      gap = pos.z - z;
    }
    expect(gap).toBeGreaterThan(CHASE.baseDistance + 0.8);
  });

  it('keeps the hero close even on a web at top speed', () => {
    const c = createChaseCamera();
    let z = 0;
    let furthest = 0;
    stepChaseCamera(c, input({}));
    for (let i = 0; i < 180; i += 1) {
      z -= 40 * dt;
      const head = { x: 0, y: 20 + Math.sin(i / 15) * 8, z };
      const pos = stepChaseCamera(c, input({ head, speed: 40, swinging: true }));
      furthest = Math.max(furthest, Math.hypot(pos.x - head.x, pos.y - head.y, pos.z - head.z));
    }
    expect(furthest).toBeLessThanOrEqual(CHASE.maxDistance + 0.01);
  });

  it('never stretches past its limit', () => {
    const c = createChaseCamera();
    stepChaseCamera(c, input({}));
    const pos = stepChaseCamera(c, input({ head: { x: 0, y: 2, z: -500 } }));
    expect(Math.abs(pos.z + 500)).toBeLessThan(CHASE.baseDistance + CHASE.maxLag + 1);
  });

  it('smooths the rise and fall of a swing more than sideways movement', () => {
    const swing = (axis: 'x' | 'y') => {
      const c = createChaseCamera();
      const travel: number[] = [];
      for (let t = 0; t < 4; t += dt) {
        const wave = Math.sin(t * 3) * 6;
        const pos = stepChaseCamera(
          c,
          input({ head: { x: axis === 'x' ? wave : 0, y: 10 + (axis === 'y' ? wave : 0), z: 0 } }),
        );
        if (t > 1) travel.push(pos[axis]);
      }
      return Math.max(...travel) - Math.min(...travel);
    };
    expect(swing('y')).toBeLessThan(swing('x') * 0.95);
  });

  it('moves in at once when a wall blocks it', () => {
    const { c } = settle({});
    const pos = stepChaseCamera(c, input({ clearance: () => 1.2 }));
    expect(Math.hypot(pos.x, pos.y - 2, pos.z)).toBeLessThan(1);
  });

  it('never ends up on the far side of a wall', () => {
    const { pos } = settle({ clearance: () => 0.1 });
    expect(Math.hypot(pos.x, pos.y - 2, pos.z)).toBeLessThan(0.3);
  });

  it('leans gently into sideways speed, within a limit', () => {
    expect(settle({ sideSpeed: 12 }).c.roll).toBeLessThan(0);
    expect(Math.abs(settle({ sideSpeed: 200 }).c.roll)).toBeLessThanOrEqual(CHASE.maxLean + 0.001);
  });

  it('jumps straight to the player after a respawn', () => {
    const { c } = settle({});
    resetChaseCamera(c);
    const pos = stepChaseCamera(c, input({ head: { x: 200, y: 2, z: 200 } }));
    expect(Math.hypot(pos.x - 200, pos.z - 200)).toBeLessThan(CHASE.baseDistance + 2);
  });
});
