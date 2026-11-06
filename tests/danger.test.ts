import { describe, expect, it } from 'vitest';
import { createDanger, DANGER, stepDanger } from '../src/sim/danger';
import { createArena, type V3 } from '../src/sim/map';
import { createPlayer, emptyInput, TUNING, type Dummy } from '../src/sim/player';
import { TICK, World } from '../src/sim/world';

const map = createArena();

/** An enemy at `pos`, aiming straight at `at`. */
function shooter(pos: V3, at: V3, id = 1): Dummy {
  const eye = pos.y + TUNING.standEye;
  const dx = at.x - pos.x;
  const dy = at.y - eye;
  const dz = at.z - pos.z;
  const len = Math.hypot(dx, dy, dz);
  return {
    id,
    pos,
    hp: 2,
    snareT: 0,
    respawnT: 0,
    phase: 0,
    dir: 1,
    aim: { x: dx / len, y: dy / len, z: dz / len },
  };
}

const me = { x: 0, y: 0.05, z: 10 };
const myChest = { x: 0, y: 0.95, z: 10 };

function sense(dummies: Dummy[], seconds = 0.4, pos = me, yaw = 0) {
  const s = createDanger();
  const p = createPlayer(pos, yaw);
  for (let t = 0; t < seconds; t += TICK) stepDanger(s, p, dummies, map, TICK);
  return s;
}

describe('direction', () => {
  it('lights the top edge for an enemy in front', () => {
    const s = sense([shooter({ x: 0, y: 0, z: -5 }, myChest)]);
    expect(s.top).toBeGreaterThan(0.4);
    expect(s.bottom).toBe(0);
  });

  it('lights the bottom edge for an enemy behind', () => {
    const s = sense([shooter({ x: 0, y: 0, z: 24 }, myChest)]);
    expect(s.bottom).toBeGreaterThan(0.4);
    expect(s.top).toBe(0);
  });

  it('lights the left and right edges for enemies to the sides', () => {
    expect(sense([shooter({ x: -15, y: 0, z: 10 }, myChest)]).left).toBeGreaterThan(0.4);
    expect(sense([shooter({ x: 15, y: 0, z: 10 }, myChest)]).right).toBeGreaterThan(0.4);
  });

  it('follows the camera: turning right moves a front enemy to the left edge', () => {
    const s = sense([shooter({ x: 0, y: 0, z: -5 }, myChest)], 0.4, me, -Math.PI / 2);
    expect(s.left).toBeGreaterThan(0.4);
    expect(s.top).toBeLessThan(0.01);
  });

  it('shows two enemies at once', () => {
    const s = sense([
      shooter({ x: -15, y: 0, z: 10 }, myChest, 1),
      shooter({ x: 15, y: 0, z: 10 }, myChest, 2),
    ]);
    expect(s.left).toBeGreaterThan(0.4);
    expect(s.right).toBeGreaterThan(0.4);
  });

  it('is brighter for a close enemy', () => {
    const near = sense([shooter({ x: 0, y: 0, z: 2 }, myChest)], 1);
    const far = sense([shooter({ x: 0, y: 0, z: -18 }, myChest)], 1);
    expect(near.top).toBeGreaterThan(far.top);
  });
});

describe('when it stays quiet', () => {
  const total = (s: ReturnType<typeof sense>) => s.top + s.right + s.bottom + s.left;

  it('ignores an enemy aiming somewhere else', () => {
    expect(total(sense([shooter({ x: 0, y: 0, z: -5 }, { x: 15, y: 1, z: 10 })]))).toBe(0);
  });

  it('ignores an enemy aiming the other way', () => {
    const d = shooter({ x: 0, y: 0, z: -5 }, myChest);
    d.aim = { x: 0, y: 0, z: -1 };
    expect(total(sense([d]))).toBe(0);
  });

  it('ignores an enemy behind a wall', () => {
    const pos = { x: 0, y: 6, z: -22 };
    const chest = { x: 0, y: 6.9, z: -22 };
    expect(total(sense([shooter({ x: 0, y: 6, z: -36 }, chest)], 0.4, pos))).toBe(0);
  });

  it('ignores an enemy out of range', () => {
    const pos = { x: 0, y: 30, z: 0 };
    const chest = { x: 0, y: 30.9, z: 0 };
    expect(total(sense([shooter({ x: 0, y: 30, z: 80 }, chest)], 0.4, pos))).toBe(0);
  });

  it('ignores a KO enemy', () => {
    const d = shooter({ x: 0, y: 0, z: -5 }, myChest);
    d.respawnT = 1;
    expect(total(sense([d]))).toBe(0);
  });

  it('ignores a quick sweep across the player', () => {
    expect(total(sense([shooter({ x: 0, y: 0, z: -5 }, myChest)], DANGER.holdTime / 2))).toBe(0);
  });

  it('fades out after the enemy looks away', () => {
    const d = shooter({ x: 0, y: 0, z: -5 }, myChest);
    const s = createDanger();
    const p = createPlayer(me, 0);
    for (let t = 0; t < 0.4; t += TICK) stepDanger(s, p, [d], map, TICK);
    const lit = s.top;
    d.aim = undefined;
    for (let t = 0; t < 1; t += TICK) stepDanger(s, p, [d], map, TICK);
    expect(s.top).toBeLessThan(lit * 0.05);
  });
});

describe('practice mode', () => {
  it('dummies take turns aiming, so the warning can be practised', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 0.05, z: 0 };
    let peak = 0;
    for (let i = 0; i < 8 / TICK; i += 1) {
      w.step(emptyInput(), TICK);
      peak = Math.max(peak, w.danger.top, w.danger.right, w.danger.bottom, w.danger.left);
    }
    expect(peak).toBeGreaterThan(0.3);
  });

  it('a new life starts with no warning', () => {
    const w = new World();
    w.danger.top = 1;
    w.respawnAt({ x: 0, y: 1, z: 0 }, 0);
    expect(w.danger.top).toBe(0);
  });
});
