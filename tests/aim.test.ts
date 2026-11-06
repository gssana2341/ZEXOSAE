import { describe, expect, it } from 'vitest';
import { AIM, findAimTarget, viewForward } from '../src/sim/aim';
import { createArena, type V3 } from '../src/sim/map';
import type { Dummy } from '../src/sim/player';

const map = createArena();
const eye: V3 = { x: 0, y: 5, z: 20 };

function target(x: number, z = 0, y = 4): Dummy {
  return { id: 1, pos: { x, y, z }, hp: 1, snareT: 0, respawnT: 0, phase: 0, dir: 1 };
}

describe('finding a target', () => {
  it('measures how far the crosshair is from the target', () => {
    const hit = findAimTarget(eye, viewForward(0, 0), map, [target(1)], 5);
    expect(hit?.offset).toBeCloseTo(1, 1);
  });

  it('ignores targets behind the player', () => {
    expect(findAimTarget(eye, viewForward(Math.PI, 0), map, [target(0)], 5)).toBeNull();
  });

  it('ignores targets behind a wall', () => {
    const behindPanel = target(0, -30 - 6);
    const low = { x: 0, y: 5, z: -20 };
    expect(findAimTarget(low, viewForward(0, 0), map, [behindPanel], 5)).toBeNull();
  });

  it('does not reach far from the crosshair', () => {
    expect(findAimTarget(eye, viewForward(0, 0), map, [target(2)], AIM.magnetRadius)).toBeNull();
  });

  it('caps the help on a close target, so it cannot catch wild shots', () => {
    const close = target(1, 17);
    expect(findAimTarget(eye, viewForward(0, 0), map, [close], AIM.magnetRadius)).toBeNull();
  });
});
