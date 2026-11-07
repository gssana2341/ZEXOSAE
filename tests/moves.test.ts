import { describe, expect, it } from 'vitest';
import { HITS, MAX_HP } from '../src/sim/hits';
import { MOVES } from '../src/sim/moves';
import { emptyInput, horizontalSpeed, knockPlayer, TUNING, type TickInput } from '../src/sim/player';
import { TICK, World, type WorldEvent } from '../src/sim/world';
import { createTestArena } from './test-map';

function testWorld(): World {
  return new World(null, createTestArena());
}

/** Runs the world, collecting every event on the way. */
function run(
  w: World,
  seconds: number,
  input: Partial<TickInput> | ((tick: number) => Partial<TickInput>) = {},
): WorldEvent[] {
  const events: WorldEvent[] = [];
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i += 1) {
    const extra = typeof input === 'function' ? input(i) : input;
    w.step({ ...emptyInput(), yaw: w.player.yaw, pitch: w.player.pitch, ...extra }, TICK);
    events.push(...w.events);
    w.events.length = 0;
  }
  return events;
}

const once = (input: Partial<TickInput>) => (tick: number) => (tick === 0 ? input : {});

/** Pins every dummy in place, so a fight test isn't chasing a patrol. */
function holdDummies(w: World): void {
  w.dummies.forEach((d, i) => {
    w.map.patrols[i] = { a: { ...d.pos }, b: { ...d.pos } };
  });
}

/** The player on the plaza floor, a few metres from dummy 0, facing it. */
function besideDummy(gap = 2): World {
  const w = testWorld();
  holdDummies(w);
  const d = w.dummies[0];
  w.player.pos = { x: d.pos.x, y: 0.05, z: d.pos.z + gap };
  w.player.yaw = 0;
  w.player.pitch = 0;
  run(w, 0.1);
  return w;
}

describe('web swing release', () => {
  function swinging(vy: number): World {
    const w = testWorld();
    const p = w.player;
    p.pos = { x: 0, y: 20, z: 8 };
    p.vel = { x: 0, y: vy, z: 18 };
    p.mode = 'swing';
    p.anchor = { x: 0, y: 40, z: 0 };
    p.ropeLen = Math.hypot(18.8, 8);
    return w;
  }

  it('lets go at the top of the arc with an extra push', () => {
    const top = swinging(2);
    const events = run(top, TICK, { swing: false });
    expect(events.some((e) => e.type === 'perfect' && e.what === 'release')).toBe(true);

    const early = swinging(-8);
    const none = run(early, TICK, { swing: false });
    expect(none.some((e) => e.type === 'perfect')).toBe(false);
    expect(Math.hypot(top.player.vel.x, top.player.vel.z)).toBeGreaterThan(18);
    expect(top.player.focus).toBeGreaterThan(0);
  });

  it('jumps off the web with a hop', () => {
    const w = swinging(-8);
    run(w, TICK, { swing: true, jump: true });
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.y).toBeGreaterThan(-8 + MOVES.jumpRelease - 2);
  });
});

describe('zips', () => {
  it('does not launch a second time when jump is pressed in mid-air', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 0.05, z: 0 };
    w.player.mode = 'ground';
    w.player.vel = { x: 0, y: 0, z: 0 };
    w.player.yaw = 0;
    expect(run(w, TICK, { jump: true }).some((e) => e.type === 'jump')).toBe(true);
    run(w, 0.3);
    const before = w.player.vel.y;
    const events = run(w, TICK, { jump: true });
    expect(events.some((e) => e.type === 'jump')).toBe(false);
    expect(w.player.mode).toBe('air');
    expect(horizontalSpeed(w.player)).toBeLessThan(0.1);
    expect(w.player.vel.y).toBeLessThan(before);
    expect(w.player.webLine).toBeNull();
  });

  function facingWall(): World {
    const w = testWorld();
    w.player.pos = { x: 15, y: 0.05, z: 34 };
    w.player.yaw = Math.PI;
    w.player.pitch = 0.3;
    run(w, 0.1, { aimAssist: false });
    return w;
  }

  it('shows the ledge a web press would zip to', () => {
    const w = facingWall();
    expect(w.player.perch?.hang).toBe(false);
    expect(w.player.perch?.point.y).toBeCloseTo(24);
  });

  it('zips onto the ledge and stands on it', () => {
    const w = facingWall();
    run(w, TICK, { web: true, aimAssist: false });
    expect(w.player.mode).toBe('zip');
    run(w, 2.5, { aimAssist: false });
    expect(w.player.mode).toBe('ground');
    expect(w.player.pos.y).toBeCloseTo(24, 0);
  });

  it('launches off the end of a zip', () => {
    const w = facingWall();
    run(w, TICK, { web: true, aimAssist: false });
    run(w, 0.3, { aimAssist: false });
    const events = run(w, TICK, { jump: true, aimAssist: false });
    expect(events.some((e) => e.type === 'pointLaunch')).toBe(true);
    expect(w.player.mode).toBe('air');
    expect(horizontalSpeed(w.player)).toBeGreaterThan(MOVES.pointLaunchSpeed - 3);
  });
});

describe('hanging on a line', () => {
  function underBeam(): World {
    const w = testWorld();
    w.player.pos = { x: 0, y: 20, z: 3 };
    w.player.mode = 'air';
    w.player.yaw = 0;
    w.player.pitch = 1.45;
    run(w, TICK, { aimAssist: false });
    return w;
  }

  it('hangs from the underside of a beam', () => {
    const w = underBeam();
    expect(w.player.perch?.hang).toBe(true);
    run(w, TICK, { web: true, aimAssist: false });
    expect(w.player.mode).toBe('hang');
  });

  it('climbs the line and lets it out', () => {
    const w = underBeam();
    run(w, TICK, { web: true, aimAssist: false });
    run(w, 0.5, { aimAssist: false });
    const y = w.player.pos.y;
    run(w, 1, { moveZ: 1, aimAssist: false });
    expect(w.player.pos.y).toBeGreaterThan(y + 3);
    const high = w.player.pos.y;
    run(w, 1, { moveZ: -1, aimAssist: false });
    expect(w.player.pos.y).toBeLessThan(high - 3);
    expect(w.player.mode).toBe('hang');
  });

  it('drops off the line with a jump', () => {
    const w = underBeam();
    run(w, TICK, { web: true, aimAssist: false });
    run(w, 0.3, { aimAssist: false });
    run(w, TICK, { jump: true, aimAssist: false });
    expect(w.player.mode).toBe('air');
  });

  function onRoofEdge(): World {
    const w = testWorld();
    w.player.pos = { x: 0, y: 24.05, z: 53.5 };
    w.player.yaw = 0;
    w.player.pitch = -0.8;
    run(w, 0.1, { aimAssist: false });
    return w;
  }

  it('drops over a roof edge on a line, and climbs back over', () => {
    const w = onRoofEdge();
    run(w, TICK, { web: true, aimAssist: false });
    expect(w.player.mode).toBe('hang');
    run(w, 0.8, { aimAssist: false });
    expect(w.player.pos.y).toBeLessThan(23.5);
    expect(w.player.pos.z).toBeLessThan(52.5);

    run(w, 0.8, { moveZ: -1, aimAssist: false });
    const low = w.player.pos.y;
    expect(low).toBeLessThan(22);

    for (let i = 0; i < 120 && w.player.mode === 'hang'; i += 1) run(w, TICK, { moveZ: 1, aimAssist: false });
    expect(w.player.mode).toBe('ground');
    expect(w.player.pos.y).toBeGreaterThan(23.9);
    expect(w.player.pos.z).toBeGreaterThan(52);
  });
});

describe('jumps and landings', () => {
  function onFloor(): World {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    return w;
  }

  function peak(w: World, input: (tick: number) => Partial<TickInput>, seconds = 1.5): number {
    let top = w.player.pos.y;
    run(w, seconds, (tick) => {
      top = Math.max(top, w.player.pos.y);
      return input(tick);
    });
    return top;
  }

  it('crouching charges a much higher jump', () => {
    const plain = peak(onFloor(), once({ jump: true }));
    const w = onFloor();
    run(w, MOVES.chargeTime, { slide: true });
    expect(w.player.charge).toBeCloseTo(1, 1);
    const charged = peak(w, once({ jump: true, slide: true }));
    expect(charged).toBeGreaterThan(plain * 2.5);
  });

  function dropFrom(height: number): World {
    const w = testWorld();
    w.player.pos = { x: 40, y: height, z: 18 };
    w.player.vel = { x: 10, y: 0, z: 0 };
    w.player.mode = 'air';
    return w;
  }

  it('a hard landing knocks the speed out', () => {
    const w = dropFrom(20);
    run(w, 1.2);
    expect(w.player.landT > 0 || horizontalSpeed(w.player) < 6).toBe(true);
  });

  it('jumping straight out of a hard landing keeps the speed', () => {
    const w = dropFrom(20);
    let events: WorldEvent[] = [];
    for (let i = 0; i < 120 && w.player.mode !== 'ground'; i += 1) events = run(w, TICK);
    events = run(w, TICK, { jump: true });
    expect(events.some((e) => e.type === 'perfect' && e.what === 'recover')).toBe(true);
    expect(w.player.vel.y).toBeGreaterThan(TUNING.jumpSpeed);
  });
});

describe('dodging', () => {
  it('a dash is a dodge that hits pass through', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    run(w, TICK, { dash: true });
    expect(w.player.dodgeT).toBeGreaterThan(0);
    knockPlayer(w.player, w.map, { x: 0, y: 20, z: 0 }, 1, false);
    expect(w.player.stunT).toBe(0);
  });

  it('dodging just as a hit comes is perfect, and earns focus', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    w.danger.left = 1;
    const events = run(w, TICK, { dash: true });
    expect(events.some((e) => e.type === 'perfect' && e.what === 'dodge')).toBe(true);
    expect(w.player.dodgeT).toBeCloseTo(MOVES.perfectDodgeSafe, 1);
    expect(w.player.focus).toBeGreaterThan(0.4);
  });

  it('a jump out of a dodge goes long', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    run(w, TICK, { dash: true });
    run(w, TICK, { jump: true });
    expect(w.player.mode).toBe('air');
    expect(horizontalSpeed(w.player)).toBeGreaterThan(TUNING.dashSpeed);
  });
});

describe('fighting up close', () => {
  it('cannot hit or finish a target through a wall', () => {
    const w = besideDummy();
    const d = w.dummies[0];
    w.map.boxes.push({ min: { x: d.pos.x - 2, y: 0, z: d.pos.z + 0.8 }, max: { x: d.pos.x + 2, y: 3, z: d.pos.z + 1.2 }, kind: 'building' });
    w.player.focus = MOVES.finisherCost;
    const events = run(w, TICK, { shoot: true, focus: true });
    expect(events.some((e) => e.type === 'hitTarget')).toBe(false);
    expect(d.hp).toBe(MAX_HP);
    expect(w.player.focus).toBe(MOVES.finisherCost);
  });

  it('cannot shoot, snare or jump while stunned, or shoot during a committed strike or pound', () => {
    const w = besideDummy(10);
    w.player.stunT = 0.5;
    const stunned = run(w, TICK, { shoot: true, snare: true, jump: true });
    expect(stunned.some((e) => e.type === 'shot' || e.type === 'jump')).toBe(false);
    expect(w.player.jumpBufT).toBe(0);
    for (const mode of ['strike', 'pound'] as const) {
      const active = besideDummy(10);
      active.player.mode = mode;
      active.player.pos.y = 20;
      const events = run(active, TICK, { shoot: true });
      expect(events.some((e) => e.type === 'shot')).toBe(false);
    }
  });

  it('punches someone close instead of shooting', () => {
    const w = besideDummy();
    const events = run(w, TICK, { shoot: true });
    expect(events.some((e) => e.type === 'shot')).toBe(false);
    expect(w.dummies[0].hp).toBe(MAX_HP - HITS.melee.damage);
  });

  it('shoots a web when no one is close', () => {
    const w = besideDummy(10);
    const events = run(w, TICK, { shoot: true, aimAssist: false });
    expect(events.some((e) => e.type === 'shot')).toBe(true);
  });

  it('runs a four-hit combo that sends them flying on the last hit', () => {
    const w = besideDummy();
    const start = { ...w.dummies[0].pos };
    for (let i = 0; i < 4; i += 1) run(w, 0.4, once({ shoot: true }));
    const d = w.dummies[0];
    expect(d.hp).toBe(MAX_HP - HITS.melee.damage * 3 - HITS.heavy.damage);
    run(w, 0.3);
    expect(Math.hypot(d.pos.x - start.x, d.pos.z - start.z)).toBeGreaterThan(2);
  });

  it('holding after a hit launches them, and the player goes up too', () => {
    const w = besideDummy();
    run(w, 0.5, { shoot: true, shootHeld: true });
    run(w, 0.2);
    expect(w.dummies[0].pos.y).toBeGreaterThan(2);
    expect(w.player.pos.y).toBeGreaterThan(2);
  });

  it('keeps them up with hits in the air', () => {
    const w = besideDummy();
    run(w, 0.4, { shoot: true, shootHeld: true });
    let lowest = Infinity;
    for (let i = 0; i < 4; i += 1) {
      run(w, 0.24, (tick) => {
        lowest = Math.min(lowest, w.dummies[0].pos.y);
        return tick === 0 ? { shoot: true } : {};
      });
    }
    expect(lowest).toBeGreaterThan(1);
  });

  it('jumps away from someone just hit, even in the air', () => {
    const w = besideDummy();
    run(w, TICK, { shoot: true });
    run(w, TICK, { jump: true });
    expect(w.player.mode).toBe('air');
    expect(w.player.vel.z).toBeGreaterThan(5);
  });
});

describe('the web on someone', () => {
  it('cancels a pending web attack when the player dodges', () => {
    const w = besideDummy(14);
    w.player.pitch = -Math.atan2(0.62, 14);
    run(w, TICK, { web: true, webHeld: true });
    expect(w.player.webPending).toBe(true);
    const events = run(w, TICK, { dash: true, webHeld: false });
    expect(w.player.webPending).toBe(false);
    expect(w.player.mode).not.toBe('strike');
    expect(events.some((e) => e.type === 'hitTarget')).toBe(false);
  });

  it('cancels a pending web if a target moves behind a wall', () => {
    const w = besideDummy(14);
    w.player.pitch = -Math.atan2(0.62, 14);
    run(w, TICK, { web: true, webHeld: true });
    expect(w.player.webPending).toBe(true);
    const d = w.dummies[0];
    w.map.boxes.push({ min: { x: d.pos.x - 2, y: 0, z: d.pos.z + 5 }, max: { x: d.pos.x + 2, y: 4, z: d.pos.z + 6 }, kind: 'building' });
    run(w, TICK, { webHeld: false });
    expect(w.player.webPending).toBe(false);
    expect(w.player.mode).not.toBe('strike');
  });

  it('a tap zips in and kicks them', () => {
    const w = besideDummy(14);
    w.player.pitch = -Math.atan2(0.62, 14);
    run(w, TICK, { web: true, webHeld: true });
    run(w, 1, { webHeld: false });
    expect(w.dummies[0].hp).toBe(MAX_HP - HITS.strike.damage);
    expect(w.player.mode).not.toBe('strike');
  });

  it('a hold yanks them in', () => {
    const w = besideDummy(14);
    w.player.pitch = -Math.atan2(0.62, 14);
    run(w, TICK, { web: true, webHeld: true });
    run(w, MOVES.webHold + 0.05, { webHeld: true });
    run(w, 0.3);
    const d = w.dummies[0];
    expect(Math.hypot(d.pos.x - w.player.pos.x, d.pos.z - w.player.pos.z)).toBeLessThan(10);
  });

  it('a hold up close throws them where the camera looks', () => {
    const w = besideDummy(2);
    const z = w.dummies[0].pos.z;
    run(w, TICK, { web: true, webHeld: true, aimAssist: false });
    run(w, MOVES.webHold + 0.05, { webHeld: true, aimAssist: false });
    run(w, 0.25, { aimAssist: false });
    expect(w.dummies[0].pos.z).toBeLessThan(z - 3);
  });
});

describe('ground pound', () => {
  it('slams down and hits everyone nearby, harder from higher up', () => {
    const low = besideDummy(2);
    low.player.pos.y = 5;
    low.player.mode = 'air';
    run(low, TICK, { slide: true });
    expect(low.player.mode).toBe('pound');
    const lowEvents = run(low, 1);
    expect(lowEvents.some((e) => e.type === 'pound')).toBe(true);
    const lowDamage = MAX_HP - low.dummies[0].hp;

    const high = besideDummy(2);
    high.player.pos.y = 30;
    high.player.mode = 'air';
    run(high, TICK, { slide: true });
    run(high, 1.5);
    expect(MAX_HP - high.dummies[0].hp).toBeGreaterThan(lowDamage);
  });

  it('needs some height to start', () => {
    const w = besideDummy(6);
    w.player.pos.y = 1;
    w.player.mode = 'air';
    run(w, TICK, { slide: true });
    expect(w.player.mode).not.toBe('pound');
  });
});

describe('focus', () => {
  it('does not spend online focus on a heal still on cooldown', () => {
    const w = testWorld();
    w.setOnline(true);
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    w.player.hp = 40;
    w.player.focus = MOVES.focusMax;
    expect(run(w, TICK, { focus: true }).some((e) => e.type === 'heal')).toBe(true);
    expect(w.player.focus).toBe(2);
    expect(run(w, TICK, { focus: true }).some((e) => e.type === 'heal')).toBe(false);
    expect(w.player.focus).toBe(2);
    run(w, MOVES.healCooldown + 0.05);
    expect(run(w, TICK, { focus: true }).some((e) => e.type === 'heal')).toBe(true);
    expect(w.player.focus).toBe(1);
  });

  it('does not heal during a swing', () => {
    const w = testWorld();
    w.player.pos = { x: 0, y: 20, z: 8 };
    w.player.mode = 'swing';
    w.player.anchor = { x: 0, y: 40, z: 0 };
    w.player.ropeLen = 20;
    w.player.hp = 40;
    w.player.focus = 1;
    const events = run(w, TICK, { focus: true, swing: true });
    expect(events.some((e) => e.type === 'heal')).toBe(false);
    expect(w.player.focus).toBe(1);
  });

  it('is earned by hitting, and a finisher spends it', () => {
    const w = besideDummy();
    run(w, TICK, { shoot: true });
    expect(w.player.focus).toBeGreaterThan(0);
    run(w, 0.5);
    w.player.focus = MOVES.focusMax;
    const before = w.dummies[0].hp;
    const events = run(w, TICK, { focus: true });
    expect(events.some((e) => e.type === 'finisher')).toBe(true);
    expect(w.dummies[0].hp).toBe(before - HITS.finisher.damage);
    expect(w.player.focus).toBeCloseTo(MOVES.focusMax - MOVES.finisherCost);
  });

  it('heals when hurt', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    w.player.hp = 40;
    w.player.focus = 1;
    run(w, TICK, { focus: true });
    expect(w.player.hp).toBe(40 + MOVES.healAmount);
    expect(w.player.focus).toBe(0);
  });

  it('turns tricks in the air for focus, a few per jump', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 60, z: 18 };
    w.player.vel = { x: 0, y: 12, z: 0 };
    w.player.mode = 'air';
    let tricks = 0;
    for (let i = 0; i < 5; i += 1) {
      tricks += run(w, MOVES.trickTime + 0.05, once({ focus: true })).filter((e) => e.type === 'trick').length;
    }
    expect(tricks).toBe(MOVES.tricksPerJump);
    expect(w.player.focus).toBeGreaterThan(0.3);
  });
});

describe('crates', () => {
  it('fetches a crate with the web and throws it', () => {
    const map = createTestArena();
    map.crates = [{ x: 40, y: 0, z: 8 }];
    const w = new World(null, map);
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    w.player.yaw = 0;
    w.player.pitch = -Math.atan2(1.2, 10);
    run(w, 0.1, { aimAssist: false });
    const events = run(w, 0.5, (tick) => ({ snare: tick === 0, aimAssist: false }));
    expect(events.some((e) => e.type === 'crateThrown')).toBe(true);
    expect(events.some((e) => e.type === 'shot' && e.snare)).toBe(false);
    expect(w.crates[0].state).toBe('gone');
  });
});

describe('being hit by another player', () => {
  it('is thrown and dazed', () => {
    const w = testWorld();
    w.player.pos = { x: 40, y: 0.05, z: 18 };
    run(w, 0.2);
    knockPlayer(w.player, w.map, { x: 10, y: 8, z: 0 }, 0.8, false);
    expect(w.player.mode).toBe('air');
    expect(w.player.stunT).toBeCloseTo(0.8);
    run(w, 0.2);
    expect(w.player.pos.x).toBeGreaterThan(41);
  });

  it('a snare next to a wall holds a target twice as long', () => {
    const w = testWorld();
    holdDummies(w);
    const open = w.dummies[0];
    w.player.pos = { x: open.pos.x, y: 0.05, z: open.pos.z + 14 };
    w.player.pitch = -Math.atan2(0.62, 14);
    run(w, 0.3, once({ snare: true, aimAssist: false }));
    expect(open.snareT).toBeGreaterThan(0);
    expect(open.snareT).toBeLessThanOrEqual(TUNING.snareTime);
  });
});
