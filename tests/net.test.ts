import { describe, expect, it } from 'vitest';
import { MAX_WATCHERS, Room, type Client } from '../src/net/room';
import {
  cleanName,
  MAX_ROOM_SIZE,
  parseClientMessage,
  RESPAWN_MS,
  SPAWN_PROTECT_MS,
  type ClientMessage,
  type ServerMessage,
} from '../src/net/protocol';
import { createArena } from '../src/sim/map';
import { TUNING } from '../src/sim/player';
import { HITS, MAX_KNOCK, MAX_STUN } from '../src/sim/hits';
import { TICK, World } from '../src/sim/world';
import { createTestArena } from './test-map';
import { emptyInput, snarePlayer } from '../src/sim/player';

class FakeClient implements Client {
  inbox: ServerMessage[] = [];
  send(m: ServerMessage) {
    this.inbox.push(m);
  }
  last<T extends ServerMessage['t']>(t: T) {
    return this.inbox.filter((m) => m.t === t).pop() as Extract<ServerMessage, { t: T }> | undefined;
  }
}

function roomWithTwo() {
  let time = 100000;
  const room = new Room('TEST', () => time);
  const a = new FakeClient();
  const b = new FakeClient();
  const idA = room.add(a, 'A')!;
  const idB = room.add(b, 'B')!;
  time += SPAWN_PROTECT_MS + 1;
  room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
  room.handle(idB, { t: 'state', pos: [0, 0, 10], yaw: 0, pitch: 0, anchor: null });
  const hit = (snare = false, by = idA, target = idB): ClientMessage & { t: 'hit' } => {
    const m = { t: 'hit' as const, target, snare };
    room.handle(by, m);
    return m;
  };
  /** Four web shots take a full 100 HP. */
  const ko = (by = idA, target = idB) => {
    for (let i = 0; i < 4; i += 1) {
      hit(false, by, target);
      time += 400;
    }
  };
  return { room, a, b, idA, idB, hit, ko, advance: (ms: number) => (time += ms) };
}

describe('room size', () => {
  it('stops at the size chosen when the room was made', () => {
    const room = new Room('TEST', () => 0, 4);
    for (let i = 0; i < 4; i += 1) expect(room.add(new FakeClient(), 'X')).not.toBeNull();
    expect(room.add(new FakeClient(), 'Late')).toBeNull();
  });

  it('holds a full room of 16', () => {
    const room = new Room('TEST', () => 0, MAX_ROOM_SIZE);
    for (let i = 0; i < MAX_ROOM_SIZE; i += 1) room.add(new FakeClient(), 'X');
    expect(room.size).toBe(MAX_ROOM_SIZE);
  });
});

describe('room rules', () => {
  it('tells everyone when a player joins and leaves', () => {
    const { room, a, idB } = roomWithTwo();
    expect(a.last('playerJoin')?.player.name).toBe('B');
    room.remove(idB);
    expect(a.last('playerLeave')?.id).toBe(idB);
  });

  it('spawns players apart from each other', () => {
    for (let i = 0; i < 40; i += 1) {
      const { a, b } = roomWithTwo();
      const pa = a.last('joined')!.pos;
      const pb = b.last('joined')!.pos;
      expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeGreaterThanOrEqual(30);
    }
  });

  it('spawns in random places, not the same one every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 80; i += 1) {
      const a = new FakeClient();
      new Room('TEST', () => 0).add(a, 'A');
      seen.add(a.last('joined')!.pos.join());
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('never respawns a player in the same place twice in a row', () => {
    const { room, b, idA, ko, advance } = roomWithTwo();
    let previous = b.last('roundStart')!.spawns.find((s) => s.id === b.last('joined')!.id)!.pos.join();
    // Stay within one round, whose kill limit is 15.
    for (let i = 0; i < 12; i += 1) {
      advance(SPAWN_PROTECT_MS + 1);
      room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
      ko();
      advance(RESPAWN_MS + 1);
      room.tick();
      const now = b.last('respawn')!.pos.join();
      expect(now).not.toBe(previous);
      previous = now;
      room.handle(b.last('joined')!.id, { t: 'state', pos: [0, 0, 10], yaw: 0, pitch: 0, anchor: null });
    }
  });

  it('still finds a spawn when the map is crowded', () => {
    const room = new Room('TEST', () => 0, MAX_ROOM_SIZE);
    for (let i = 0; i < MAX_ROOM_SIZE; i += 1) {
      const c = new FakeClient();
      room.add(c, 'X');
      expect(c.last('joined')!.pos).toHaveLength(3);
    }
  });

  it('every spawn is on a surface, with room to stand', () => {
    const { boxes, spawns } = createArena();
    const r = TUNING.radius;
    const touches = (x: number, y0: number, y1: number, z: number) =>
      boxes.some(
        (b) =>
          x + r > b.min.x && x - r < b.max.x && y1 > b.min.y && y0 < b.max.y && z + r > b.min.z && z - r < b.max.z,
      );
    expect(spawns.length).toBeGreaterThanOrEqual(MAX_ROOM_SIZE);
    for (const { pos } of spawns) {
      expect(touches(pos.x, pos.y, pos.y + TUNING.standHeight, pos.z)).toBe(false);
      expect(touches(pos.x, pos.y - 0.2, pos.y, pos.z)).toBe(true);
    }
  });

  it('a web shot takes a quarter of the HP, and four are a KO', () => {
    const { a, idA, idB, hit, ko, advance } = roomWithTwo();
    hit();
    expect(a.last('damage')).toMatchObject({ target: idB, by: idA, hp: 75, ko: false });
    advance(400);
    ko();
    expect(a.last('damage')).toMatchObject({ target: idB, by: idA, hp: 0, ko: true, kills: 1, deaths: 1 });
  });

  it('respawns a KO player with full HP after the delay', () => {
    const { room, b, idB, ko, advance } = roomWithTwo();
    ko();
    room.tick();
    expect(b.last('respawn')).toBeUndefined();
    advance(RESPAWN_MS + 1);
    room.tick();
    expect(b.last('respawn')?.id).toBe(idB);
    expect(b.inbox.filter((m) => m.t === 'damage')).toHaveLength(4);
    expect(b.last('damage')?.ko).toBe(true);
  });

  it('protects a player right after spawning', () => {
    let time = 1000;
    const room = new Room('TEST', () => time);
    const a = new FakeClient();
    const idA = room.add(a, 'A')!;
    const idB = room.add(new FakeClient(), 'B')!;
    room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
    room.handle(idB, { t: 'state', pos: [0, 0, 10], yaw: 0, pitch: 0, anchor: null });
    room.handle(idA, { t: 'hit', target: idB, snare: false });
    expect(a.last('damage')).toBeUndefined();
    time += SPAWN_PROTECT_MS + 1;
    room.handle(idA, { t: 'hit', target: idB, snare: false });
    expect(a.last('damage')).toBeDefined();
  });

  it('ignores impossible hits', () => {
    const { room, a, idA, idB, hit, ko } = roomWithTwo();
    hit(false, idA, idA); // self
    hit(false, idA, 999); // nobody
    room.handle(idA, { t: 'state', pos: [0, 0, 500], yaw: 0, pitch: 0, anchor: null }); // out of range
    hit();
    expect(a.last('damage')).toBeUndefined();

    room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
    ko();
    hit(); // already KO
    room.handle(idB, { t: 'hit', target: idA, snare: false }); // KO players can't shoot
    expect(a.inbox.filter((m) => m.t === 'damage')).toHaveLength(4);
  });

  it('ignores shots faster than the fire rate', () => {
    let time = 100000;
    const room = new Room('TEST', () => time);
    const a = new FakeClient();
    const ids = ['A', 'B', 'C'].map((n, i) => room.add(i ? new FakeClient() : a, n)!);
    time += SPAWN_PROTECT_MS + 1;
    ids.forEach((id, i) => room.handle(id, { t: 'state', pos: [i * 5, 0, 0], yaw: 0, pitch: 0, anchor: null }));
    room.handle(ids[0], { t: 'hit', target: ids[1], snare: false });
    room.handle(ids[0], { t: 'hit', target: ids[2], snare: false });
    expect(a.inbox.filter((m) => m.t === 'damage')).toHaveLength(1);
  });

  it('snare limits itself to its own cooldown', () => {
    const { a, hit, advance } = roomWithTwo();
    hit(true);
    hit(true);
    expect(a.inbox.filter((m) => m.t === 'snared')).toHaveLength(1);
    advance(TUNING.snareCooldown * 1000);
    hit(true);
    expect(a.inbox.filter((m) => m.t === 'snared')).toHaveLength(2);
  });
});

describe('pose over the network', () => {
  it('passes each player\'s move on, so others see the right animation', () => {
    const { room, b, idA } = roomWithTwo();
    room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null, mode: 'slide' });
    room.tick();
    expect(b.last('snapshot')?.players.find((p) => p.id === idA)?.mode).toBe('slide');
  });

  it('sends physical motion separately from the action being animated', () => {
    const m = parseClientMessage('{"t":"state","pos":[1,2,3],"yaw":0,"pitch":0,"anchor":[0,20,0],"mode":"cast","motion":"swing"}');
    expect(m).toMatchObject({ t: 'state', mode: 'cast', motion: 'swing' });
    const { room, b, idA } = roomWithTwo();
    room.handle(idA, m as Extract<ClientMessage, { t: 'state' }>);
    room.tick();
    expect(b.last('snapshot')?.players.find((p) => p.id === idA)).toMatchObject({ mode: 'cast', motion: 'swing' });
    const bad = parseClientMessage('{"t":"state","pos":[1,2,3],"yaw":0,"pitch":0,"anchor":null,"motion":"cast"}');
    expect(bad).toMatchObject({ t: 'state', motion: undefined });
  });

  it('ignores a pose it does not know', () => {
    const m = parseClientMessage('{"t":"state","pos":[1,2,3],"yaw":0,"pitch":0,"anchor":null,"mode":"fly"}');
    expect(m).toMatchObject({ t: 'state', mode: undefined });
  });
});

describe('ping', () => {
  it('sends a ping straight back to the player who asked', () => {
    const { room, a, b, idA } = roomWithTwo();
    room.handle(idA, { t: 'ping', at: 123.5 });
    expect(a.last('pong')).toEqual({ t: 'pong', at: 123.5 });
    expect(b.last('pong')).toBeUndefined();
  });

  it('rejects a ping with no time', () => {
    expect(parseClientMessage('{"t":"ping"}')).toBeNull();
    expect(parseClientMessage('{"t":"ping","at":"soon"}')).toBeNull();
    expect(parseClientMessage('{"t":"ping","at":5}')).toEqual({ t: 'ping', at: 5 });
  });
});

describe('message checks', () => {
  it('accepts valid messages', () => {
    expect(parseClientMessage('{"t":"state","pos":[1,2,3],"yaw":0,"pitch":0,"anchor":null}')?.t).toBe('state');
    expect(parseClientMessage('{"t":"rematch","round":3,"ready":true}')).toEqual({ t: 'rematch', round: 3, ready: true });
  });

  it.each([
    'not json',
    'null',
    '{"t":"nope"}',
    '{"t":"state","pos":[1,2],"yaw":0,"pitch":0,"anchor":null}',
    '{"t":"state","pos":[1,2,"3"],"yaw":0,"pitch":0,"anchor":null}',
    '{"t":"hit","target":"1","snare":false}',
    `{"t":"join","code":"ABCD","name":"${'x'.repeat(100)}"}`,
    '{"t":"join","name":"x"}',
    '{"t":"list"}',
    '{"t":"rematch","round":1.5,"ready":true}',
    '{"t":"rematch","round":1,"ready":"yes"}',
  ])('rejects %s', (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('cleans names', () => {
    expect(cleanName('  ')).toBe('ผู้เล่น');
    expect(cleanName('a\u0000b\nc')).toBe('abc');
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
  });
});

describe('fight rules', () => {
  const melee = (room: Room, by: number, target: number, extra: Partial<ClientMessage & { t: 'hit' }> = {}) =>
    room.handle(by, { t: 'hit', target, snare: false, kind: 'melee', knock: [0, 5, 3], stun: 0.4, ...extra });

  it('takes damage from the kind of hit, never from the report', () => {
    const { room, a, idA, idB } = roomWithTwo();
    room.handle(idB, { t: 'state', pos: [0, 0, 2], yaw: 0, pitch: 0, anchor: null });
    melee(room, idA, idB);
    expect(a.last('damage')?.hp).toBe(100 - HITS.melee.damage);
  });

  it('moves only the player who was hit, with a capped shove', () => {
    const { room, a, b, idA, idB } = roomWithTwo();
    room.handle(idB, { t: 'state', pos: [0, 0, 2], yaw: 0, pitch: 0, anchor: null });
    melee(room, idA, idB, { knock: [0, 500, 0], stun: 9 });
    const knock = b.last('knock')!;
    expect(knock.target).toBe(idB);
    expect(Math.hypot(...knock.vel)).toBeCloseTo(MAX_KNOCK);
    expect(knock.stun).toBe(MAX_STUN);
    expect(a.last('knock')).toBeUndefined();
  });

  it('rejects a punch from across the map', () => {
    const { room, a, idA, idB } = roomWithTwo();
    room.handle(idB, { t: 'state', pos: [0, 0, 60], yaw: 0, pitch: 0, anchor: null });
    melee(room, idA, idB);
    expect(a.last('damage')).toBeUndefined();
  });

  it('lets a dodging player through untouched', () => {
    const { room, a, idA, idB } = roomWithTwo();
    room.handle(idB, { t: 'state', pos: [0, 0, 2], yaw: 0, pitch: 0, anchor: null, safe: true });
    melee(room, idA, idB);
    expect(a.last('damage')).toBeUndefined();
  });

  it('scales a ground pound by how far it fell', () => {
    const { room, a, idA, idB, advance } = roomWithTwo();
    room.handle(idB, { t: 'state', pos: [0, 0, 2], yaw: 0, pitch: 0, anchor: null });
    melee(room, idA, idB, { kind: 'pound', power: 0.1 });
    const small = 100 - a.last('damage')!.hp;
    advance(1000);
    melee(room, idA, idB, { kind: 'pound', power: 1 });
    expect(100 - small - a.last('damage')!.hp).toBeGreaterThan(small * 2);
  });

  it('heals, but not over and over', () => {
    const { room, a, b, idA, idB, hit, advance } = roomWithTwo();
    hit();
    advance(400);
    hit();
    room.handle(idB, { t: 'heal' });
    room.handle(idB, { t: 'heal' });
    expect(a.inbox.filter((m) => m.t === 'healed')).toHaveLength(1);
    expect(b.last('healed')?.hp).toBe(Math.min(100, 50 + 35));
    void idA;
  });
});

describe('online world', () => {
  it('reports a hit on another player instead of deciding it', () => {
    const w = new World(null, createTestArena());
    w.setOnline(true);
    w.respawnAt({ x: 0, y: 0.05, z: 22 }, 0);
    w.dummies = [{ id: 7, pos: { x: 0, y: 0, z: 8 }, hp: 2, snareT: 0, respawnT: 0, phase: 0, dir: 1 }];
    const pitch = -Math.atan2(0.62, 14);
    for (let i = 0; i < 20; i += 1) {
      w.step({ ...emptyInput(), aimAssist: false, pitch, shoot: i === 0 }, TICK);
    }
    const hit = w.events.find((e) => e.type === 'netHit');
    expect(hit).toMatchObject({ target: 7, snare: false });
    expect(w.dummies[0].hp).toBe(2);
  });

  it('a ghost shot never hits anything locally', () => {
    const w = new World(null, createTestArena());
    w.setOnline(true);
    w.respawnAt({ x: 0, y: 0.05, z: 22 }, 0);
    w.dummies = [{ id: 7, pos: { x: 0, y: 0, z: 8 }, hp: 2, snareT: 0, respawnT: 0, phase: 0, dir: 1 }];
    w.addGhostShot({ x: 0, y: 1, z: 14 }, { x: 0, y: 0, z: -1 }, false);
    for (let i = 0; i < 20; i += 1) w.step(emptyInput(), TICK);
    expect(w.events.some((e) => e.type === 'netHit')).toBe(false);
  });

  it('a snare cuts the web and blocks a new one', () => {
    const w = new World(null, createTestArena());
    w.player.pos = { x: 0, y: 14, z: 22 };
    w.player.mode = 'air';
    const step = () => w.step({ ...emptyInput(), pitch: 0.9, swing: true, aimAssist: false }, TICK);
    step();
    expect(w.player.mode).toBe('swing');
    snarePlayer(w.player);
    step();
    expect(w.player.mode).toBe('air');
  });

  it('turning online off brings the dummies back', () => {
    const w = new World(null, createTestArena());
    const count = w.dummies.length;
    w.setOnline(true);
    expect(w.dummies).toHaveLength(0);
    w.setOnline(false);
    expect(w.dummies).toHaveLength(count);
  });
});


describe('watching a room', () => {
  it('sees every update, without joining the game', () => {
    const { room, a, idA, idB, hit } = roomWithTwo();
    const watcher = new FakeClient();
    const id = room.watch(watcher)!;
    expect(watcher.last('joined')).toMatchObject({ watching: true });
    expect(watcher.last('joined')!.players.map((p) => p.id)).not.toContain(id);
    expect(room.size).toBe(2);
    room.tick();
    expect(watcher.last('snapshot')!.players.map((p) => p.id)).toEqual(expect.arrayContaining([idA, idB]));
    hit();
    expect(watcher.last('damage')).toBeDefined();
    expect(a.last('playerJoin')?.player.id).not.toBe(id);
  });

  it('can never hit anyone or be hit', () => {
    const { room, a, idA } = roomWithTwo();
    const watcher = new FakeClient();
    const id = room.watch(watcher)!;
    room.handle(id, { t: 'hit', target: idA, snare: false });
    room.handle(idA, { t: 'hit', target: id, snare: false });
    expect(a.inbox.filter((m) => m.t === 'damage')).toHaveLength(0);
    room.handle(id, { t: 'ping', at: 5 });
    expect(watcher.last('pong')?.at).toBe(5);
  });

  it('takes a limited number of watchers, who leave quietly', () => {
    const { room, a } = roomWithTwo();
    const ids = Array.from({ length: MAX_WATCHERS }, () => room.watch(new FakeClient()));
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(room.watch(new FakeClient())).toBeNull();
    room.remove(ids[0]!);
    expect(a.last('playerLeave')).toBeUndefined();
    expect(room.watch(new FakeClient())).not.toBeNull();
  });
});
