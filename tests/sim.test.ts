import { describe, expect, it } from 'vitest';
import { ARENA_FLOOR, ARENA_LIMIT } from '../src/sim/map';
import { createTestArena } from './test-map';
import { TICK, World } from '../src/sim/world';
import { HITS, MAX_HP } from '../src/sim/hits';
import { climbWallNormal, emptyInput, horizontalSpeed, snarePlayer, totalSpeed, TUNING, type TickInput, type WebAssist } from '../src/sim/player';

const testWorld = () => new World(null, createTestArena());

function run(world: World, seconds: number, input: Partial<TickInput> | ((t: number) => Partial<TickInput>)) {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i += 1) {
    const extra = typeof input === 'function' ? input(i * TICK) : input;
    world.step({ ...emptyInput(), yaw: world.player.yaw, pitch: world.player.pitch, ...extra }, TICK);
  }
}

/** Puts the player on open ground in the plaza. */
function onPlaza(yaw = 0): World {
  const w = testWorld();
  w.player.pos = { x: 0, y: 0.5, z: 8 };
  w.player.yaw = yaw;
  run(w, 0.3, {});
  return w;
}

describe('ground movement', () => {
  it('lands on the spawn roof without falling through', () => {
    const w = testWorld();
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
    const w = testWorld();
    w.player.pos = { x: 14, y: 0.05, z: 42 };
    w.player.yaw = 0;
    run(w, 1.6, { moveZ: 1 });
    expect(w.player.pos.z).toBeLessThan(36);
  });
});

describe('walls', () => {
  it('never lets a fast player pass through a thin panel', () => {
    const w = testWorld();
    w.player.pos = { x: 20, y: 6, z: 0 };
    w.player.vel = { x: TUNING.maxSpeed, y: 0, z: 0 };
    w.player.mode = 'air';
    run(w, 0.5, {});
    expect(w.player.pos.x).toBeLessThan(30);
  });

  it('wall-runs along a panel, then wall-jumps off it', () => {
    const w = testWorld();
    w.player.pos = { x: 28.9, y: 7, z: 10 };
    w.player.vel = { x: 3, y: 2, z: -13 };
    w.player.mode = 'air';
    run(w, 0.2, {});
    expect(w.player.mode).toBe('wall');
    const zBefore = w.player.pos.z;
    const yBefore = w.player.pos.y;
    run(w, 0.3, {});
    expect(w.player.pos.z).toBeLessThan(zBefore - 2.5);
    expect(w.player.pos.y).toBeGreaterThan(yBefore - 1);

    run(w, 0.1, (t) => ({ jump: t === 0 }));
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.x).toBeLessThan(-5);
    expect(w.player.vel.y).toBeGreaterThan(5);
  });

  it('holds a wall run at speed while pushing along it', () => {
    const w = testWorld();
    w.player.pos = { x: 28.9, y: 7, z: 10 };
    w.player.vel = { x: 3, y: 2, z: -13 };
    w.player.mode = 'air';
    run(w, 0.2, { moveZ: 1 });
    expect(w.player.mode).toBe('wall');
    const speed = -w.player.vel.z;
    run(w, 0.3, { moveZ: 1 });
    expect(-w.player.vel.z).toBeGreaterThan(speed - 0.5);
  });

  it('a wall run slows and slips away instead of holding on', () => {
    const w = testWorld();
    w.player.pos = { x: 28.9, y: 9, z: 12 };
    w.player.vel = { x: 3, y: 2, z: -7 };
    w.player.mode = 'air';
    run(w, 0.15, {});
    expect(w.player.mode).toBe('wall');
    run(w, 6, {});
    expect(w.player.mode).not.toBe('wall');
  });
});

describe('climbing', () => {
  // The north face of the apartment block, seen from the plaza side.
  const FACE_Z = 37;
  const FACING = Math.PI;

  function atWall(y = 6, input: Partial<TickInput> = { moveZ: 1, yaw: FACING }): World {
    const w = new World();
    w.player.pos = { x: 0, y, z: FACE_Z - TUNING.radius - 0.3 };
    w.player.yaw = FACING;
    w.player.vel = { x: 0, y: 0, z: 2 };
    w.player.mode = 'air';
    run(w, 0.2, input);
    return w;
  }

  it('catches any building wall when pressing toward it', () => {
    expect(atWall().player.mode).toBe('wall');
  });

  it('climbs up a wall at its own pace', () => {
    const w = atWall();
    const y = w.player.pos.y;
    run(w, 1, { moveZ: 1, yaw: FACING });
    expect(w.player.pos.y).toBeGreaterThan(y + 4);
    expect(w.player.vel.y).toBeLessThanOrEqual(TUNING.wallClimbSpeed + 6);
  });

  it('goes where the player looks along the wall', () => {
    const w = atWall();
    const x = w.player.pos.x;
    run(w, 0.8, { moveZ: 1, yaw: FACING + Math.PI / 2 - 0.3 });
    expect(Math.abs(w.player.pos.x - x)).toBeGreaterThan(3);
    expect(w.player.mode).toBe('wall');
  });

  it('strafes along the wall', () => {
    const w = atWall();
    const x = w.player.pos.x;
    run(w, 0.6, { moveX: 1, yaw: FACING });
    expect(Math.abs(w.player.pos.x - x)).toBeGreaterThan(2);
  });

  it('climbs down when looking down', () => {
    const w = atWall(12);
    run(w, 0.3, { moveZ: 1, yaw: FACING });
    const y = w.player.pos.y;
    run(w, 1, { moveZ: 1, yaw: FACING, pitch: -1.2 });
    expect(w.player.pos.y).toBeLessThan(y - 3);
  });

  it('never holds a player still: doing nothing slips them down', () => {
    const w = atWall(14);
    run(w, 0.5, {});
    const y = w.player.pos.y;
    run(w, 1, {});
    expect(w.player.pos.y).toBeLessThan(y - 1.5);
    expect(w.player.vel.y).toBeGreaterThanOrEqual(-TUNING.wallSlipSpeed - 0.5);
  });

  it('turns a fast head-on hit into a rise up the wall', () => {
    const slow = atWall();
    const w = new World();
    w.player.pos = { x: 0, y: 6, z: FACE_Z - 6 };
    w.player.yaw = FACING;
    w.player.vel = { x: 0, y: 0, z: 20 };
    w.player.mode = 'air';
    run(w, 0.4, { moveZ: 1, yaw: FACING });
    expect(w.player.mode).toBe('wall');
    expect(w.player.vel.y).toBeGreaterThan(slow.player.vel.y + 4);
  });

  function slamInto(mode: 'air' | 'swing' | 'dash'): World {
    const w = new World();
    w.player.pos = { x: 0, y: 6, z: FACE_Z - 4 };
    w.player.yaw = FACING;
    w.player.vel = { x: 0, y: 0, z: TUNING.wallSlamSpeed + 6 };
    w.player.mode = mode;
    if (mode === 'swing') {
      w.player.anchor = { x: 0, y: 30, z: FACE_Z - 4 };
      w.player.ropeLen = 24;
    }
    if (mode === 'dash') w.player.dashT = 1;
    return w;
  }

  it('bounces off a wall hit too hard to hold, dazed', () => {
    const w = slamInto('air');
    const slams: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      w.step({ ...emptyInput(), moveZ: 1, yaw: FACING }, TICK);
      for (const e of w.events) if (e.type === 'slam') slams.push(e.speed);
      w.events.length = 0;
    }
    expect(slams).toHaveLength(1);
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.z).toBeLessThan(0);
    expect(w.player.stunT).toBeGreaterThan(0);
  });

  it('loses the web when swinging into a wall too hard', () => {
    const w = slamInto('swing');
    run(w, 0.3, { moveZ: 1, yaw: FACING, swing: true });
    expect(w.player.anchor).toBeNull();
    expect(w.player.stunT).toBeGreaterThan(0);
  });

  it('cannot grab, web or dash while dazed, then recovers', () => {
    const w = slamInto('air');
    run(w, 0.3, { moveZ: 1, yaw: FACING });
    run(w, 0.1, { moveZ: 1, yaw: FACING, swing: true, dash: true, pitch: 0.6, webAssist: 'wide' });
    expect(w.player.mode).toBe('air');
    expect(w.player.anchor).toBeNull();
    run(w, TUNING.wallSlamStun, {});
    expect(w.player.stunT).toBe(0);
  });

  it('falls straight past a wall when not pressing toward it', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 20, z: FACE_Z - TUNING.radius - 0.05 };
    w.player.vel = { x: 0, y: -4, z: 0 };
    w.player.mode = 'air';
    run(w, 0.4, {});
    expect(w.player.mode).toBe('air');
  });

  it('cannot catch a wall when falling too fast', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 23, z: FACE_Z - TUNING.radius - 0.05 };
    w.player.yaw = FACING;
    w.player.vel = { x: 0, y: -TUNING.wallGripFall - 4, z: 0 };
    w.player.mode = 'air';
    run(w, 0.1, { moveZ: 1, yaw: FACING });
    expect(w.player.mode).toBe('air');
  });

  it('lets go when pushing away', () => {
    const w = atWall();
    run(w, 0.1, { moveZ: -1, yaw: FACING });
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.z).toBeLessThan(-2);
  });

  it('hops over the top onto the roof', () => {
    const w = atWall(18);
    run(w, 2.5, { moveZ: 1, yaw: FACING });
    expect(w.player.pos.y).toBeGreaterThan(23.9);
    expect(w.player.pos.z).toBeGreaterThan(FACE_Z);
    expect(w.player.mode).toBe('ground');
  });

  it('starts from the ground by looking up and walking in', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 0.05, z: FACE_Z - 2 };
    w.player.yaw = FACING;
    run(w, 1, { moveZ: 1, yaw: FACING, pitch: 0.7 });
    expect(w.player.mode).toBe('wall');
    expect(w.player.pos.y).toBeGreaterThan(1);
  });

  it('stays on the ground when walking into a wall without looking up', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 0.05, z: FACE_Z - 2 };
    w.player.yaw = FACING;
    run(w, 1, { moveZ: 1, yaw: FACING });
    expect(w.player.mode).toBe('ground');
  });

  it('leaps up the wall when jumping and looking up', () => {
    const flat = atWall();
    run(flat, 0.05, (t) => ({ jump: t === 0, yaw: FACING }));
    const up = atWall();
    run(up, 0.05, (t) => ({ jump: t === 0, yaw: FACING, pitch: 1.2 }));
    expect(up.player.vel.y).toBeGreaterThan(flat.player.vel.y + 2);
    expect(Math.abs(up.player.vel.z)).toBeLessThan(Math.abs(flat.player.vel.z));
  });

  it('can shoot a web straight off a wall', () => {
    const w = atWall();
    run(w, 0.1, { swing: true, yaw: 0, pitch: 0.6, webAssist: 'wide' });
    expect(w.player.mode).toBe('swing');
  });

  it('finds the wall another player is holding', () => {
    const w = atWall();
    expect(climbWallNormal(w.map, w.player.pos)?.z).toBe(-1);
    expect(climbWallNormal(w.map, { x: 0, y: 6, z: 20 })).toBeNull();
  });

  it('cannot climb the invisible edge of the arena', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 75, z: -20 };
    w.map.boxes.length = 0;
    w.map.boxes.push({ min: { x: -5, y: 0, z: -22 }, max: { x: 5, y: 90, z: -20.4 }, kind: 'bound' });
    w.player.vel = { x: 0, y: 0, z: -3 };
    w.player.mode = 'air';
    run(w, 0.2, { moveZ: 1 });
    expect(w.player.mode).toBe('air');
  });
});

describe('web pull', () => {
  /** In the plaza at height, looking up at the crossing beam. */
  function underBeam(pitch = 0.9): World {
    const w = testWorld();
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
    const w = testWorld();
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
    const w = testWorld();
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
    const w = testWorld();
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
    const w = testWorld();
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
    const w = testWorld();
    w.player.pos = { x: 0, y: 30, z: 20 };
    w.player.vel = { x: 0, y: 0, z: -18 };
    w.player.mode = 'air';
    run(w, 0.5, { moveZ: 1, yaw: Math.PI / 2 });
    expect(w.player.vel.x).toBeLessThan(-12);
    expect(horizontalSpeed(w.player)).toBeGreaterThan(16);
  });

  it('falls from the spawn roof in about a second', () => {
    const w = testWorld();
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
    const w = testWorld();
    w.player.pos = { x: -40, y: 70, z: 20 };
    w.player.vel = { x: 30, y: -10, z: 0 };
    w.player.mode = 'air';
    run(w, 1.2, {});
    expect(w.player.vel.y).toBeLessThan(-40);
    expect(w.player.vel.x).toBeGreaterThan(26);
  });

  it('loses speed slowly in the air, down to run speed at the lowest', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 80, z: 40 };
    w.player.vel = { x: 0, y: 30, z: -14 };
    w.player.mode = 'air';
    run(w, 0.5, {});
    expect(horizontalSpeed(w.player)).toBeLessThan(14);
    expect(horizontalSpeed(w.player)).toBeGreaterThan(TUNING.runSpeed);
  });

  it('turns less sharply at high speed', () => {
    const turnedAt = (speed: number) => {
      const w = testWorld();
      w.player.pos = { x: 0, y: 44, z: 40 };
      w.player.vel = { x: 0, y: 8, z: -speed };
      w.player.mode = 'air';
      run(w, 0.2, { moveZ: 1, yaw: Math.PI / 2 });
      return Math.atan2(-w.player.vel.x, -w.player.vel.z);
    };
    expect(turnedAt(36)).toBeLessThan(turnedAt(15) * 0.7);
  });

  it('does not turn while forward is not held, so you can look back and shoot', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 30, z: 20 };
    w.player.vel = { x: 0, y: 0, z: -18 };
    w.player.mode = 'air';
    run(w, 0.5, { yaw: Math.PI });
    expect(w.player.vel.z).toBeLessThan(-16);
    expect(Math.abs(w.player.vel.x)).toBeLessThan(0.01);
  });

  it('wall-jumps toward the camera', () => {
    const w = testWorld();
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
    const w = testWorld();
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

  it('a shot takes a quarter of the HP, standing still or moving', () => {
    for (const speed of [0, 8, 30]) {
      const w = facingDummy(speed);
      run(w, 0.3, shootOnce);
      expect(w.dummies[0].hp).toBe(MAX_HP - HITS.shot.damage);
    }
  });

  it('four shots are a KO', () => {
    const w = facingDummy();
    run(w, 1.4, (t) => ({ shoot: Math.round(t / TICK) % 18 === 0, aimAssist: false }));
    expect(w.kos).toBe(1);
    expect(w.dummies[0].respawnT).toBeGreaterThan(0);
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
    expect(w.dummies[0].hp).toBe(MAX_HP);
  });

  it('bends onto a target it would just miss when aim help is on', () => {
    const near = facingDummy();
    near.player.yaw = 0.12;
    run(near, 0.4, (t) => ({ shoot: t === 0, aimAssist: false }));
    expect(near.dummies[0].hp).toBe(MAX_HP);

    const helped = facingDummy();
    helped.player.yaw = 0.12;
    run(helped, 0.4, (t) => ({ shoot: t === 0, aimAssist: true }));
    expect(helped.dummies[0].hp).toBeLessThan(MAX_HP);
  });

  it('reaches a moving target far away almost at once', () => {
    const w = facingDummy();
    const flight = 60 / TUNING.shotSpeed;
    expect(flight).toBeLessThan(0.25);
    run(w, TICK, (t) => ({ shoot: t === 0, aimAssist: false }));
    expect(w.shots.length + w.kos).toBeGreaterThan(0);
  });

  it('still misses a clearly bad shot with aim help on', () => {
    const w = facingDummy();
    w.player.yaw = 0.3;
    run(w, 0.4, (t) => ({ shoot: t === 0, aimAssist: true }));
    expect(w.dummies[0].hp).toBe(MAX_HP);
  });

  it('is stopped by a wall', () => {
    const w = testWorld();
    const d = w.dummies[0];
    d.pos = { x: 0, y: 3.5, z: 26 };
    w.map.patrols[0] = { a: d.pos, b: d.pos };
    w.player.pos = { x: 0, y: 3.1, z: 34 };
    w.player.yaw = 0;
    w.player.pitch = 0;
    run(w, 0.4, shootOnce);
    expect(w.dummies[0].hp).toBe(MAX_HP);
    expect(w.shots.length).toBe(0);
  });

  it('respects the fire rate', () => {
    const w = facingDummy();
    run(w, 0.1, () => ({ shoot: true, aimAssist: false }));
    expect(w.player.shotCdT).toBeGreaterThan(0);
    expect(w.shots.length).toBeLessThanOrEqual(1);
  });

  it('snare stops a dummy dead, then lets it go', () => {
    const w = testWorld();
    const d = w.dummies[1];
    w.player.pos = { x: 0, y: 0.05, z: 0 };
    d.snareT = TUNING.snareTime;
    const held = { ...d.pos };
    run(w, TUNING.snareTime - 0.1, {});
    expect(d.pos).toEqual(held);
    run(w, 0.5, {});
    expect(d.pos).not.toEqual(held);
  });

  it('snare hits without hurting', () => {
    const w = facingDummy();
    run(w, 0.2, (t) => ({ snare: t === 0, aimAssist: false }));
    expect(w.dummies[0].snareT).toBeGreaterThan(0);
    expect(w.dummies[0].hp).toBe(MAX_HP);
  });
});

describe('jump pads', () => {
  function onPad(index = 0) {
    const w = testWorld();
    const pad = w.map.jumpPads[index];
    w.player.pos = { x: pad.x, y: 0.05, z: pad.z };
    return w;
  }

  it('there are two, away from spawn points and walls', () => {
    const { jumpPads, spawns, boxes } = testWorld().map;
    expect(jumpPads).toHaveLength(2);
    for (const pad of jumpPads) {
      for (const { pos } of spawns) {
        expect(Math.hypot(pos.x - pad.x, pos.y - pad.y, pos.z - pad.z)).toBeGreaterThan(5);
      }
      // Nothing overhead for the whole flight.
      const blocked = boxes.some(
        (b) =>
          b.max.y > 0.5 &&
          b.min.y < 40 &&
          pad.x + 3 > b.min.x &&
          pad.x - 3 < b.max.x &&
          pad.z + 3 > b.min.z &&
          pad.z - 3 < b.max.z,
      );
      expect(blocked).toBe(false);
    }
  });

  it.each([0, 1])('pad %i throws the player above the edge roofs', (index) => {
    const w = onPad(index);
    let top = 0;
    run(w, 1.5, () => {
      top = Math.max(top, w.player.pos.y);
      return {};
    });
    expect(top).toBeGreaterThan(28);
    expect(w.events.some((e) => e.type === 'jumpPad' && e.index === index)).toBe(true);
  });

  it('keeps forward speed, so a run carries over the pad', () => {
    const w = onPad();
    w.player.vel = { x: 15, y: 0, z: 0 };
    w.player.mode = 'ground';
    run(w, 0.1, { yaw: -Math.PI / 2, moveZ: 1 });
    expect(w.player.vel.x).toBeGreaterThan(10);
    expect(w.player.vel.y).toBeGreaterThan(30);
  });

  it('sets off when landing on it from above', () => {
    const w = onPad();
    w.player.pos.y = 8;
    w.player.mode = 'air';
    run(w, 1, {});
    expect(w.events.some((e) => e.type === 'jumpPad')).toBe(true);
  });

  it('does nothing beside the pad', () => {
    const w = testWorld();
    const pad = w.map.jumpPads[0];
    w.player.pos = { x: pad.x + 4, y: 0.05, z: pad.z };
    run(w, 0.3, {});
    expect(w.events.some((e) => e.type === 'jumpPad')).toBe(false);
    expect(w.player.mode).toBe('ground');
  });

  it('is not set off from a web passing low overhead', () => {
    const w = onPad();
    w.player.mode = 'swing';
    w.player.anchor = { x: 0, y: 40, z: 0 };
    w.player.ropeLen = 40;
    run(w, 0.05, { swing: true, aimAssist: false });
    expect(w.events.some((e) => e.type === 'jumpPad')).toBe(false);
  });

  it('does not launch a frozen player', () => {
    const w = onPad();
    snarePlayer(w.player);
    run(w, 0.3, {});
    expect(w.events.some((e) => e.type === 'jumpPad')).toBe(false);
  });

  it('launches online too, with no server involved', () => {
    const w = onPad();
    w.setOnline(true);
    run(w, 0.2, {});
    expect(w.player.pos.y).toBeGreaterThan(5);
  });
});

describe('frozen by a snare', () => {
  function frozen(pos = { x: 0, y: 0.05, z: 8 }) {
    const w = testWorld();
    w.player.pos = { ...pos };
    run(w, 0.1, {});
    snarePlayer(w.player);
    return w;
  }

  it('cannot move, jump, dash, swing or shoot', () => {
    const w = frozen();
    const at = { ...w.player.pos };
    run(w, TUNING.snareTime - 0.1, (t) => ({
      moveZ: 1,
      jump: true,
      dash: true,
      swing: true,
      shoot: t === 0,
      pitch: 1,
    }));
    expect(w.player.pos).toEqual(at);
    expect(w.player.mode).not.toBe('swing');
    expect(w.shots).toHaveLength(0);
  });

  it('hangs in mid-air instead of falling', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 30, z: 8 };
    w.player.vel = { x: 10, y: -20, z: 0 };
    w.player.mode = 'air';
    snarePlayer(w.player);
    run(w, TUNING.snareTime - 0.1, {});
    expect(w.player.pos.y).toBe(30);
    expect(w.player.pos.x).toBe(0);
  });

  it('can still look around', () => {
    const w = frozen();
    run(w, 0.1, { yaw: 1.2, pitch: 0.4 });
    expect(w.player.yaw).toBe(1.2);
    expect(w.player.pitch).toBe(0.4);
  });

  it('thaws on time and can move again', () => {
    const w = frozen();
    const z = w.player.pos.z;
    run(w, TUNING.snareTime + 0.4, { moveZ: 1 });
    expect(w.player.snareT).toBe(0);
    expect(w.player.pos.z).toBeLessThan(z - 1);
  });

  it('drops the web when frozen', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 14, z: 22 };
    w.player.mode = 'air';
    run(w, 0.05, { swing: true, pitch: 0.9, aimAssist: false });
    expect(w.player.mode).toBe('swing');
    snarePlayer(w.player);
    expect(w.player.anchor).toBeNull();
  });
});

describe('leaving the arena', () => {
  const outside = (w: World) =>
    Math.abs(w.player.pos.x) > ARENA_LIMIT || Math.abs(w.player.pos.z) > ARENA_LIMIT || w.player.pos.y < ARENA_FLOOR;

  it.each([
    ['over the east wall', { x: ARENA_LIMIT + 0.5, y: 120, z: 0 }],
    ['over the west wall', { x: -ARENA_LIMIT - 0.5, y: 120, z: 0 }],
    ['over the north wall', { x: 0, y: 120, z: -ARENA_LIMIT - 0.5 }],
    ['over the south wall', { x: 0, y: 120, z: ARENA_LIMIT + 0.5 }],
    ['through the floor', { x: 0, y: -9, z: 0 }],
  ])('comes back from %s', (_name, pos) => {
    const w = testWorld();
    w.player.pos = pos;
    w.player.mode = 'air';
    run(w, TICK, {});
    expect(outside(w)).toBe(false);
    expect(w.events.some((e) => e.type === 'outOfBounds')).toBe(true);
  });

  it('practice goes back to the start and restarts the lap', () => {
    const w = testWorld();
    w.ringIndex = 3;
    w.lapRunning = true;
    w.player.pos = { x: ARENA_LIMIT + 5, y: 120, z: 0 };
    run(w, TICK, {});
    expect(w.player.pos.z).toBeCloseTo(w.map.spawn.z, 1);
    expect(w.ringIndex).toBe(0);
    expect(w.lapRunning).toBe(false);
  });

  it('online returns to a spawn point away from other players', () => {
    for (let i = 0; i < 40; i += 1) {
      const w = testWorld();
      w.setOnline(true);
      const near = w.map.spawns[0].pos;
      w.dummies = [{ id: 7, pos: { ...near }, hp: 1, snareT: 0, respawnT: 0, phase: 0, dir: 1 }];
      w.respawnAt({ x: ARENA_LIMIT + 5, y: 120, z: 0 }, 0);
      w.step(emptyInput(), TICK);
      const p = w.player.pos;
      expect(w.map.spawns.some((s) => s.pos.x === p.x && s.pos.z === p.z)).toBe(true);
      expect(Math.hypot(p.x - near.x, p.y - near.y, p.z - near.z)).toBeGreaterThanOrEqual(30);
    }
  });

  it('does not touch a player inside the arena, even on top of a tower', () => {
    const w = testWorld();
    w.player.pos = { x: 48, y: 62.05, z: 48 };
    run(w, 0.5, {});
    expect(w.player.pos.x).toBe(48);
    expect(w.events.some((e) => e.type === 'outOfBounds')).toBe(false);
  });

  it('survives wild play without ever ending a tick outside', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const w = testWorld();
      w.setOnline(true);
      const spawn = w.map.spawns[seed % w.map.spawns.length];
      w.respawnAt(spawn.pos, spawn.yaw);

      let yaw = spawn.yaw;
      let pitch = 0.5;
      let swing = false;
      let swap = 0;
      for (let i = 0; i < 60 * 30; i += 1) {
        if (random() < 0.03) {
          yaw += (random() - 0.5) * 3;
          pitch = random() * 1.5 - 0.2;
        }
        swap -= 1;
        if (swap <= 0) {
          swing = !swing;
          swap = swing ? 30 + random() * 150 : 10 + random() * 60;
        }
        w.step({ ...emptyInput(), yaw, pitch, moveZ: 1, swing, jump: random() < 0.03, dash: random() < 0.01, webAssist: 'near' }, TICK);
        expect(outside(w)).toBe(false);
      }
    }
  }, 30000);
});

describe('course', () => {

  it('times a lap through every ring in order', () => {
    const w = testWorld();
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
    const w = testWorld();
    const ring = w.map.rings[3];
    w.player.pos = { x: ring.x, y: ring.y - 1, z: ring.z };
    run(w, 0.05, {});
    expect(w.ringIndex).toBe(0);
  });

  it('no ring sits inside solid geometry', () => {
    const w = testWorld();
    for (const r of w.map.rings) {
      const inside = w.map.boxes.some(
        (b) =>
          r.x > b.min.x && r.x < b.max.x && r.y > b.min.y && r.y < b.max.y && r.z > b.min.z && r.z < b.max.z,
      );
      expect(inside).toBe(false);
    }
  });
});
