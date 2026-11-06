import { describe, expect, it } from 'vitest';
import { AIM, createAimState, findAimTarget, stepAim, viewForward } from '../src/sim/aim';
import { createArena, type V3 } from '../src/sim/map';
import type { Dummy } from '../src/sim/player';

const map = createArena();
const eye: V3 = { x: 0, y: 5, z: 20 };
const dt = 1 / 60;

function target(x: number, z = 0, y = 4): Dummy {
  return { id: 1, pos: { x, y, z }, hp: 2, snareT: 0, respawnT: 0, phase: 0, dir: 1 };
}

const step = (s = createAimState(), d = target(0), yaw = 0, motion = 0, scale = 1) =>
  stepAim(s, yaw, 0, eye, map, [d], dt, motion, scale);

describe('finding a target', () => {
  it('measures how far the crosshair is from the target', () => {
    const hit = findAimTarget(eye, viewForward(0, 0), map, [target(2)], 5);
    expect(hit?.offset).toBeCloseTo(2, 1);
  });

  it('ignores targets behind the player', () => {
    expect(findAimTarget(eye, viewForward(Math.PI, 0), map, [target(0)], 5)).toBeNull();
  });

  it('ignores targets behind a wall', () => {
    const behindPanel = target(0, -30 - 6);
    const low = { x: 0, y: 5, z: -20 };
    expect(findAimTarget(low, viewForward(0, 0), map, [behindPanel], 5)).toBeNull();
  });

  it('caps the help on a close target, so it cannot grab the whole screen', () => {
    const close = target(2, 15);
    expect(findAimTarget(eye, viewForward(0, 0), map, [close], AIM.slowRadius)).toBeNull();
  });
});

describe('mouse slowdown', () => {
  it('leaves the mouse alone away from any target', () => {
    expect(step(createAimState(), target(15)).lookScale).toBe(1);
  });

  it('slows more the closer the crosshair gets', () => {
    const lockedOut = () => ({ ...createAimState(), cooldownT: 5 });
    const far = step(lockedOut(), target(2.6)).lookScale;
    const near = step(lockedOut(), target(1.3)).lookScale;
    expect(far).toBeLessThan(1);
    expect(near).toBeLessThan(far);
  });
});

describe('short lock', () => {
  /** A target walking sideways, with the view following whatever stepAim says. */
  function track(s: ReturnType<typeof createAimState>, seconds: number, speed = 5) {
    const d = target(0.2);
    let yaw = 0;
    for (let t = 0; t < seconds; t += dt) {
      d.pos.x += speed * dt;
      yaw = stepAim(s, yaw, 0, eye, map, [d], dt, 0, 1).yaw;
    }
    return { yaw, d };
  }

  it('holds on to a moving target for a moment', () => {
    const s = createAimState();
    const { yaw, d } = track(s, 0.25);
    expect(s.lockId).toBe(1);
    const wanted = Math.atan2(-d.pos.x, 20);
    expect(Math.abs(yaw - wanted)).toBeLessThan(0.05);
  });

  it('lets go by itself, then cannot lock again straight away', () => {
    const s = createAimState();
    track(s, AIM.lockTime + 0.1);
    expect(s.lockId).toBeNull();
    expect(s.cooldownT).toBeGreaterThan(0);
    step(s, target(0));
    expect(s.lockId).toBeNull();
  });

  it('is not an aimbot: a fast target gets away', () => {
    const { yaw, d } = track(createAimState(), 0.3, 40);
    const wanted = Math.atan2(-d.pos.x, 20);
    expect(Math.abs(yaw - wanted)).toBeGreaterThan(0.1);
  });

  it('breaks when the player moves the mouse away', () => {
    const s = createAimState();
    step(s);
    expect(s.lockId).toBe(1);
    step(s, target(0), 0, AIM.lockBreakMotion + 0.01);
    expect(s.lockId).toBeNull();
  });

  it('never locks from outside the lock radius', () => {
    const s = createAimState();
    step(s, target(AIM.lockRadius + 0.3));
    expect(s.lockId).toBeNull();
  });

  it('reaches further on touch screens', () => {
    const s = createAimState();
    step(s, target(AIM.lockRadius + 0.3), 0, 0, 1.5);
    expect(s.lockId).toBe(1);
  });
});
