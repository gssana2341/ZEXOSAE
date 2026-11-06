import { describe, expect, it } from 'vitest';
import { Room, type Client } from '../src/net/room';
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
import { TICK, World } from '../src/sim/world';
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
  return { room, a, b, idA, idB, hit, advance: (ms: number) => (time += ms) };
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
    const { room, b, idA, hit, advance } = roomWithTwo();
    let previous = b.last('joined')!.pos.join();
    for (let i = 0; i < 30; i += 1) {
      advance(SPAWN_PROTECT_MS + 1);
      room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
      hit();
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

  it('one hit is a KO', () => {
    const { a, idA, idB, hit } = roomWithTwo();
    hit();
    expect(a.last('damage')).toMatchObject({ target: idB, by: idA, hp: 0, ko: true, kills: 1, deaths: 1 });
  });

  it('respawns a KO player with full HP after the delay', () => {
    const { room, b, idB, hit, advance } = roomWithTwo();
    hit();
    room.tick();
    expect(b.last('respawn')).toBeUndefined();
    advance(RESPAWN_MS + 1);
    room.tick();
    expect(b.last('respawn')?.id).toBe(idB);
    expect(b.inbox.filter((m) => m.t === 'damage')).toHaveLength(1);
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
    const { room, a, idA, idB, hit } = roomWithTwo();
    hit(false, idA, idA); // self
    hit(false, idA, 999); // nobody
    room.handle(idA, { t: 'state', pos: [0, 0, 500], yaw: 0, pitch: 0, anchor: null }); // out of range
    hit();
    expect(a.last('damage')).toBeUndefined();

    room.handle(idA, { t: 'state', pos: [0, 0, 0], yaw: 0, pitch: 0, anchor: null });
    hit();
    hit(); // already KO
    room.handle(idB, { t: 'hit', target: idA, snare: false }); // KO players can't shoot
    expect(a.inbox.filter((m) => m.t === 'damage')).toHaveLength(1);
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

describe('message checks', () => {
  it('accepts valid messages', () => {
    expect(parseClientMessage('{"t":"state","pos":[1,2,3],"yaw":0,"pitch":0,"anchor":null}')?.t).toBe('state');
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
  ])('rejects %s', (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('cleans names', () => {
    expect(cleanName('  ')).toBe('ผู้เล่น');
    expect(cleanName('a\u0000b\nc')).toBe('abc');
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
  });
});

describe('online world', () => {
  it('reports a hit on another player instead of deciding it', () => {
    const w = new World();
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
    const w = new World();
    w.setOnline(true);
    w.respawnAt({ x: 0, y: 0.05, z: 22 }, 0);
    w.dummies = [{ id: 7, pos: { x: 0, y: 0, z: 8 }, hp: 2, snareT: 0, respawnT: 0, phase: 0, dir: 1 }];
    w.addGhostShot({ x: 0, y: 1, z: 14 }, { x: 0, y: 0, z: -1 }, false);
    for (let i = 0; i < 20; i += 1) w.step(emptyInput(), TICK);
    expect(w.events.some((e) => e.type === 'netHit')).toBe(false);
  });

  it('a snare cuts the web and blocks a new one', () => {
    const w = new World();
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
    const w = new World();
    const count = w.dummies.length;
    w.setOnline(true);
    expect(w.dummies).toHaveLength(0);
    w.setOnline(false);
    expect(w.dummies).toHaveLength(count);
  });
});

