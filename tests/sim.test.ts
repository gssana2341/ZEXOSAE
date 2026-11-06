import { describe, expect, it } from 'vitest';
import { TICK, World } from '../src/sim/world';
import { emptyInput, horizontalSpeed, totalSpeed, TUNING, type TickInput, type WebAssist } from '../src/sim/player';

function run(world: World, seconds: number, input: Partial<TickInput> | ((t: number) => Partial<TickInput>)) {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i += 1) {
    const extra = typeof input === 'function' ? input(i * TICK) : input;
    world.step({ ...emptyInput(), yaw: world.player.yaw, pitch: world.player.pitch, ...extra }, TICK);
  }
}

/** Puts the player on open ground in the plaza. */
function onPlaza(yaw = 0): World {
  const w = new World();
  w.player.pos = { x: 0, y: 0.5, z: 8 };
  w.player.yaw = yaw;
  run(w, 0.3, {});
  return w;
}

describe('ground movement', () => {
  it('lands on the spawn roof without falling through', () => {
    const w = new World();
    run(w, 1, {});
    expect(w.player.mode).toBe('ground');
    expect(w.player.pos.y).toBeCloseTo(24, 1);
  });

  it('reaches run speed and does not exceed it', () => {
    const w = onPlaza(Math.PI / 2);
    run(w, 0.6, { moveZ: 1 });
    expect(horizontalSpeed(w.player)).toBeCloseTo(TUNING.runSpeed, 0);
  });

  it('jumps about two metres', () => {
    const w = onPlaza();
    let top = 0;
    run(w, 1, (t) => {
      top = Math.max(top, w.player.pos.y);
      return { jump: t === 0 };
    });
    expect(top).toBeGreaterThan(1.8);
    expect(top).toBeLessThan(2.6);
    expect(w.player.mode).toBe('ground');
  });

  it('slide adds speed once and ends when released', () => {
    const w = onPlaza(Math.PI / 2);
    run(w, 0.5, { moveZ: 1 });
    run(w, 0.1, { moveZ: 1, slide: true });
    expect(w.player.sliding).toBe(true);
    expect(horizontalSpeed(w.player)).toBeGreaterThan(TUNING.runSpeed + 2);
    run(w, 0.1, { moveZ: 1 });
    expect(w.player.sliding).toBe(false);
  });

  it('auto-vaults a low ledge', () => {
    const w = new World();
    w.player.pos = { x: 14, y: 0.05, z: 42 };
    w.player.yaw = 0;
    run(w, 1.2, { moveZ: 1 });
    expect(w.player.pos.z).toBeLessThan(36);
  });
});

describe('walls', () => {
  it('never lets a fast player pass through a thin panel', () => {
    const w = new World();
    w.player.pos = { x: 20, y: 6, z: 0 };
    w.player.vel = { x: TUNING.maxSpeed, y: 0, z: 0 };
    w.player.mode = 'air';
    run(w, 0.5, {});
    expect(w.player.pos.x).toBeLessThan(30);
  });

  it('wall-runs along a panel, then wall-jumps off it', () => {
    const w = new World();
    w.player.pos = { x: 28.9, y: 7, z: 10 };
    w.player.vel = { x: 3, y: 2, z: -13 };
    w.player.mode = 'air';
    run(w, 0.2, {});
    expect(w.player.mode).toBe('wall');
    const zBefore = w.player.pos.z;
    const yBefore = w.player.pos.y;
    run(w, 0.3, {});
    expect(w.player.pos.z).toBeLessThan(zBefore - 3);
    expect(w.player.pos.y).toBeGreaterThan(yBefore - 1);

    run(w, 0.1, (t) => ({ jump: t === 0 }));
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.x).toBeLessThan(-5);
    expect(w.player.vel.y).toBeGreaterThan(5);
  });

  it('wall-run ends on its own', () => {
    const w = new World();
    w.player.pos = { x: 28.9, y: 9, z: 12 };
    w.player.vel = { x: 3, y: 2, z: -7 };
    w.player.mode = 'air';
    run(w, 0.15, {});
    expect(w.player.mode).toBe('wall');
    run(w, TUNING.wallMaxTime + 1.5, {});
    expect(w.player.mode).not.toBe('wall');
  });
});

describe('web pull', () => {
  /** In the plaza at height, looking up at the crossing beam. */
  function underBeam(pitch = 0.9): World {
    const w = new World();
    w.player.pos = { x: 0, y: 14, z: 22 };
    w.player.yaw = 0;
    w.player.pitch = pitch;
    w.player.mode = 'air';
    return w;
  }

  it('lands exactly on the crosshair', () => {
    const w = underBeam();
    run(w, 0.02, { aimAssist: false });
    const a = w.player.anchorPreview!;
    const eye = w.player.pos.y + TUNING.standEye;
    const angle = Math.atan2(a.y - eye, w.player.pos.z - a.z);
    expect(angle).toBeCloseTo(0.9, 1);
  });

  it('finds nothing when aiming at open sky without assist', () => {
    const w = new World();
    w.player.pos = { x: 20, y: 14, z: 10 };
    w.player.yaw = Math.PI;
    w.player.pitch = 1.4;
    run(w, 0.02, { aimAssist: false });
    expect(w.player.anchorPreview).toBeNull();
  });

  it('pulls the player up instead of letting them hang', () => {
    const w = underBeam();
    const start = w.player.pos.y;
    run(w, 0.7, { swing: true, aimAssist: false });
    expect(w.player.pos.y).toBeGreaterThan(start + 8);
    expect(w.player.vel.y).toBeGreaterThan(8);
  });

  it('lifts a player standing on the ground', () => {
    const w = onPlaza();
    w.player.pitch = 1.2;
    run(w, 0.6, { swing: true, aimAssist: false });
    expect(w.player.pos.y).toBeGreaterThan(3);
  });

  it('lets go near the point, then holding the button can catch again', () => {
    const w = underBeam(0.6);
    let released = false;
    run(w, 3, () => {
      released ||= w.player.swingLatchT > 0;
      return { swing: true, aimAssist: false };
    });
    expect(released).toBe(true);
  });

  it('does not let go early while still heading for the point', () => {
    const w = underBeam(0.6);
    let shortest = Infinity;
    run(w, 3, () => {
      const a = w.player.anchor;
      if (a && w.player.mode === 'swing') {
        shortest = Math.min(shortest, Math.hypot(w.player.pos.x - a.x, w.player.pos.y + 1.2 - a.y, w.player.pos.z - a.z));
      }
      return { swing: true, aimAssist: false };
    });
    expect(shortest).toBeLessThan(TUNING.ropeFlingDistance + 1);
  });

  it('stretches under a hard fall instead of stopping dead, and stays within its limit', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 30, z: 6 };
    w.player.pitch = 1.45;
    w.player.mode = 'air';
    run(w, 0.02, { swing: true, aimAssist: false });
    expect(w.player.mode).toBe('swing');
    const anchor = w.player.anchor!;
    w.player.vel = { x: 0, y: -40, z: 0 };
    w.player.ropeLen = Math.hypot(w.player.pos.x - anchor.x, w.player.pos.y + 1.2 - anchor.y, w.player.pos.z - anchor.z) - 1;
    w.step({ ...emptyInput(), yaw: 0, pitch: 1.45, swing: true, aimAssist: false }, TICK);
    expect(w.player.vel.y).toBeLessThan(-30);

    let worst = 0;
    run(w, 1, () => {
      const a = w.player.anchor;
      if (a) worst = Math.max(worst, Math.hypot(w.player.pos.x - a.x, w.player.pos.y + 1.2 - a.y, w.player.pos.z - a.z) - w.player.ropeLen);
      return { swing: true, pitch: 1.45, aimAssist: false };
    });
    expect(worst).toBeLessThan(TUNING.ropeStretch + 1);
  });

  /** Web point found from a spot, with the given help. */
  function anchorFrom(x: number, y: number, z: number, yaw: number, pitch: number, webAssist: WebAssist) {
    const w = new World();
    w.player.pos = { x, y, z };
    w.player.mode = 'air';
    run(w, TICK, { yaw, pitch, webAssist });
    return w.player.anchorPreview;
  }

  it('catches a beam when the crosshair just misses it', () => {
    expect(anchorFrom(12, 14, 12, 0.6, 1.2, 'off')).toBeNull();
    expect(anchorFrom(12, 14, 12, 0.6, 1.2, 'near')).not.toBeNull();
  });

  it('near help stays near the crosshair, and only touch reaches further', () => {
    expect(anchorFrom(20, 14, 10, Math.PI, 1.4, 'near')).toBeNull();
    expect(anchorFrom(20, 14, 10, Math.PI, 1.4, 'wide')).not.toBeNull();
  });

  it('steers with the camera while on the web', () => {
    const straight = underBeam();
    const turned = underBeam();
    run(straight, 0.5, { swing: true, aimAssist: false });
    run(turned, 0.02, { swing: true, aimAssist: false });
    run(turned, 0.48, { swing: true, aimAssist: false, yaw: -Math.PI / 2, pitch: 0 });
    expect(turned.player.vel.x).toBeGreaterThan(straight.player.vel.x + 4);
  });

  it('a jump, then a pull from the roof builds real speed', () => {
    const w = new World();
    run(w, 0.2, {});
    run(w, 0.7, (t) => ({ moveZ: 1, jump: t > 0.55 && t < 0.57 }));
    let top = 0;
    run(w, 1.2, () => {
      top = Math.max(top, totalSpeed(w.player));
      return { swing: true, pitch: 0.6, aimAssist: false };
    });
    expect(top).toBeGreaterThan(20);
  });
});

describe('mouse flight', () => {
  it('bends the flight path toward the camera and keeps the speed', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 30, z: 20 };
    w.player.vel = { x: 0, y: 0, z: -18 };
    w.player.mode = 'air';
    run(w, 0.5, { moveZ: 1, yaw: Math.PI / 2 });
    expect(w.player.vel.x).toBeLessThan(-12);
    expect(horizontalSpeed(w.player)).toBeGreaterThan(16);
  });

  it('falls from the spawn roof in about a second', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 24, z: 22 };
    w.player.mode = 'air';
    let time = 0;
    while ((w.player.mode as string) !== 'ground' && time < 3) {
      run(w, TICK, {});
      time += TICK;
    }
    expect(time).toBeLessThan(1.15);
  });

  it('falls faster than it rises', () => {
    const w = onPlaza();
    run(w, TICK, { jump: true });
    let up = 0;
    while (w.player.vel.y > 0) {
      run(w, TICK, {});
      up += TICK;
    }
    let down = 0;
    while (w.player.mode !== 'ground') {
      run(w, TICK, {});
      down += TICK;
    }
    expect(down).toBeLessThan(up);
  });

  it('a long fall does not take away forward speed', () => {
    const w = new World();
    w.player.pos = { x: -40, y: 70, z: 20 };
    w.player.vel = { x: 30, y: -10, z: 0 };
    w.player.mode = 'air';
    run(w, 1.2, {});
    expect(w.player.vel.y).toBeLessThan(-40);
    expect(w.player.vel.x).toBeGreaterThan(26);
  });

  it('loses speed slowly in the air, down to run speed at the lowest', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 80, z: 40 };
    w.player.vel = { x: 0, y: 30, z: -14 };
    w.player.mode = 'air';
    run(w, 0.5, {});
    expect(horizontalSpeed(w.player)).toBeLessThan(14);
    expect(horizontalSpeed(w.player)).toBeGreaterThan(TUNING.runSpeed);
  });

  it('turns less sharply at high speed', () => {
    const turnedAt = (speed: number) => {
      const w = new World();
      w.player.pos = { x: 0, y: 44, z: 40 };
      w.player.vel = { x: 0, y: 8, z: -speed };
      w.player.mode = 'air';
      run(w, 0.2, { moveZ: 1, yaw: Math.PI / 2 });
      return Math.atan2(-w.player.vel.x, -w.player.vel.z);
    };
    expect(turnedAt(36)).toBeLessThan(turnedAt(15) * 0.7);
  });

  it('does not turn while forward is not held, so you can look back and shoot', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 30, z: 20 };
    w.player.vel = { x: 0, y: 0, z: -18 };
    w.player.mode = 'air';
    run(w, 0.5, { yaw: Math.PI });
    expect(w.player.vel.z).toBeLessThan(-16);
    expect(Math.abs(w.player.vel.x)).toBeLessThan(0.01);
  });

  it('wall-jumps toward the camera', () => {
    const w = new World();
    w.player.pos = { x: 28.9, y: 7, z: 10 };
    w.player.vel = { x: 3, y: 2, z: -13 };
    w.player.mode = 'air';
    run(w, 0.2, {});
    expect(w.player.mode).toBe('wall');
    run(w, 0.05, (t) => ({ jump: t === 0, yaw: Math.PI / 2 }));
    expect(w.player.vel.x).toBeLessThan(-14);
    expect(Math.abs(w.player.vel.z)).toBeLessThan(2);
  });
});

describe('web shot', () => {
  /** Stands still in front of dummy 0, which is frozen so the aim is exact. */
  function facingDummy(power = 0): World {
    const w = new World();
    const d = w.dummies[0];
    w.map.patrols[0] = { a: { ...d.pos }, b: { ...d.pos } };
    w.player.pos = { x: d.pos.x, y: 0.05, z: d.pos.z + 14 };
    w.player.yaw = 0;
    w.player.pitch = -Math.atan2(0.62, 14);
    w.player.vel = { x: 0, y: 0, z: -power };
    w.player.mode = 'air';
    return w;
  }
  const shootOnce = (t: number) => ({ shoot: t === 0, aimAssist: false });

  it('does not move the player', () => {
    const w = facingDummy();
    const z = w.player.pos.z;
    run(w, 0.4, shootOnce);
    expect(Math.abs(w.player.pos.z - z)).toBeLessThan(0.01);
  });

  it('one hit is a KO, standing still or moving', () => {
    for (const speed of [0, 8, 30]) {
      const w = facingDummy(speed);
      run(w, 0.3, shootOnce);
      expect(w.kos).toBe(1);
      expect(w.dummies[0].respawnT).toBeGreaterThan(0);
    }
  });

  it('a hit refunds the dash', () => {
    const w = facingDummy();
    w.player.dashCdT = 1;
    run(w, 0.2, shootOnce);
    expect(w.player.dashCdT).toBe(0);
  });

  it('misses when the crosshair is off target with aim help off', () => {
    const w = facingDummy();
    w.player.yaw = 0.2;
    run(w, 0.4, shootOnce);
    expect(w.dummies[0].hp).toBe(1);
  });

  it('bends onto a target it would just miss when aim help is on', () => {
    const near = facingDummy();
    near.player.yaw = 0.075;
    run(near, 0.4, (t) => ({ shoot: t === 0, aimAssist: false }));
    expect(near.dummies[0].hp).toBe(1);

    const helped = facingDummy();
    helped.player.yaw = 0.075;
    run(helped, 0.4, (t) => ({ shoot: t === 0, aimAssist: true }));
    expect(helped.dummies[0].respawnT).toBeGreaterThan(0);
  });

  it('still misses a clearly bad shot with aim help on', () => {
    const w = facingDummy();
    w.player.yaw = 0.15;
    run(w, 0.4, (t) => ({ shoot: t === 0, aimAssist: true }));
    expect(w.dummies[0].hp).toBe(1);
  });

  it('is stopped by a wall', () => {
    const w = new World();
    const d = w.dummies[0];
    d.pos = { x: 0, y: 3.5, z: 26 };
    w.map.patrols[0] = { a: d.pos, b: d.pos };
    w.player.pos = { x: 0, y: 3.1, z: 34 };
    w.player.yaw = 0;
    w.player.pitch = 0;
    run(w, 0.4, shootOnce);
    expect(w.dummies[0].hp).toBe(1);
    expect(w.shots.length).toBe(0);
  });

  it('respects the fire rate', () => {
    const w = facingDummy();
    run(w, 0.1, () => ({ shoot: true, aimAssist: false }));
    expect(w.player.shotCdT).toBeGreaterThan(0);
    expect(w.shots.length).toBeLessThanOrEqual(1);
  });

  it('snare slows the dummy without hurting it', () => {
    const w = facingDummy();
    run(w, 0.2, (t) => ({ snare: t === 0, aimAssist: false }));
    expect(w.dummies[0].snareT).toBeGreaterThan(0);
    expect(w.dummies[0].hp).toBe(1);
  });
});

describe('course', () => {

  it('times a lap through every ring in order', () => {
    const w = new World();
    for (const ring of w.map.rings) {
      w.player.pos = { x: ring.x, y: ring.y - 1, z: ring.z };
      w.player.vel = { x: 0, y: 0, z: 0 };
      w.player.mode = 'air';
      run(w, 0.1, {});
    }
    expect(w.bestLap).not.toBeNull();
    expect(w.bestLap!).toBeGreaterThan(0.5);
    expect(w.ringIndex).toBe(0);
    expect(w.lapRunning).toBe(false);
  });

  it('ignores rings taken out of order', () => {
    const w = new World();
    const ring = w.map.rings[3];
    w.player.pos = { x: ring.x, y: ring.y - 1, z: ring.z };
    run(w, 0.05, {});
    expect(w.ringIndex).toBe(0);
  });

  it('no ring sits inside solid geometry', () => {
    const w = new World();
    for (const r of w.map.rings) {
      const inside = w.map.boxes.some(
        (b) =>
          r.x > b.min.x && r.x < b.max.x && r.y > b.min.y && r.y < b.max.y && r.z > b.min.z && r.z < b.max.z,
      );
      expect(inside).toBe(false);
    }
  });
});
