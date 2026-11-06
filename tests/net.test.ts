import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type GameServer } from '../server/app';
import { Lobby, Room, type Client } from '../server/rooms';
import {
  cleanName,
  CODE_ALPHABET,
  DEFAULT_ROOM_SIZE,
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

describe('lobby', () => {
  it('creates a room with a 4-letter code from the safe alphabet', () => {
    const lobby = new Lobby();
    const client = new FakeClient();
    const result = lobby.create(client, 'A', DEFAULT_ROOM_SIZE);
    if (typeof result === 'string') throw new Error(result);
    expect(result.room.code).toHaveLength(4);
    for (const c of result.room.code) expect(CODE_ALPHABET).toContain(c);
    expect(client.last('joined')?.code).toBe(result.room.code);
  });

  it('joins with a lowercase code and spaces around it', () => {
    const lobby = new Lobby();
    const created = lobby.create(new FakeClient(), 'A', DEFAULT_ROOM_SIZE);
    if (typeof created === 'string') throw new Error(created);
    const friend = new FakeClient();
    const joined = lobby.join(friend, `  ${created.room.code.toLowerCase()} `, 'B');
    expect(typeof joined).not.toBe('string');
    expect(friend.last('joined')?.players).toHaveLength(2);
  });

  it('rejects an unknown code', () => {
    expect(new Lobby().join(new FakeClient(), 'ZZZZ', 'A')).toBe('not-found');
  });

  it('stops at the size chosen when the room was made', () => {
    const lobby = new Lobby();
    const created = lobby.create(new FakeClient(), 'A', 4);
    if (typeof created === 'string') throw new Error(created);
    for (let i = 1; i < 4; i += 1) lobby.join(new FakeClient(), created.room.code, 'X');
    expect(lobby.join(new FakeClient(), created.room.code, 'Late')).toBe('full');
  });

  it('keeps room sizes between 2 and 16', () => {
    const lobby = new Lobby();
    const big = lobby.create(new FakeClient(), 'A', 99);
    const small = lobby.create(new FakeClient(), 'B', 0);
    if (typeof big === 'string' || typeof small === 'string') throw new Error('create failed');
    expect(big.room.maxPlayers).toBe(MAX_ROOM_SIZE);
    expect(small.room.maxPlayers).toBe(2);
  });

  it('holds a full room of 16', () => {
    const lobby = new Lobby();
    const created = lobby.create(new FakeClient(), 'A', 16);
    if (typeof created === 'string') throw new Error(created);
    for (let i = 1; i < 16; i += 1) {
      expect(typeof lobby.join(new FakeClient(), created.room.code, 'X')).not.toBe('string');
    }
    expect(created.room.size).toBe(16);
  });

  it('lists rooms with space first, busiest first', () => {
    const lobby = new Lobby();
    const quiet = lobby.create(new FakeClient(), 'Quiet', 8);
    const busy = lobby.create(new FakeClient(), 'Busy', 8);
    const full = lobby.create(new FakeClient(), 'Full', 2);
    if (typeof quiet === 'string' || typeof busy === 'string' || typeof full === 'string') throw new Error('create failed');
    lobby.join(new FakeClient(), busy.room.code, 'X');
    lobby.join(new FakeClient(), full.room.code, 'X');
    expect(lobby.list().map((r) => r.host)).toEqual(['Busy', 'Quiet', 'Full']);
    expect(lobby.list()[0]).toMatchObject({ players: 2, max: 8, code: busy.room.code });
  });

  it('passes the room name to the next player when the host leaves', () => {
    const lobby = new Lobby();
    const created = lobby.create(new FakeClient(), 'Host', 8);
    if (typeof created === 'string') throw new Error(created);
    lobby.join(new FakeClient(), created.room.code, 'Next');
    lobby.leave(created.room, created.id);
    expect(lobby.list()[0].host).toBe('Next');
  });

  it('removes the room when the last player leaves', () => {
    const lobby = new Lobby();
    const created = lobby.create(new FakeClient(), 'A', DEFAULT_ROOM_SIZE);
    if (typeof created === 'string') throw new Error(created);
    lobby.leave(created.room, created.id);
    expect(lobby.rooms.size).toBe(0);
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
    `{"t":"create","name":"${'x'.repeat(100)}","maxPlayers":8}`,
    '{"t":"create","name":"x"}',
    '{"t":"create","name":"x","maxPlayers":"8"}',
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

describe('real sockets', () => {
  let server: GameServer;

  beforeEach(async () => {
    server = await startServer(0);
  });
  afterEach(async () => {
    await server.close();
  });

  function connect() {
    const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
    const inbox: ServerMessage[] = [];
    const waiters: Array<() => void> = [];
    socket.on('message', (data) => {
      inbox.push(JSON.parse(data.toString()) as ServerMessage);
      waiters.splice(0).forEach((w) => w());
    });
    const until = async <T extends ServerMessage['t']>(t: T) => {
      for (;;) {
        const found = inbox.find((m) => m.t === t);
        if (found) return found as Extract<ServerMessage, { t: T }>;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    const opened = new Promise<void>((r) => socket.on('open', () => r()));
    return { socket, until, opened, send: (m: ClientMessage) => socket.send(JSON.stringify(m)) };
  }

  it('two players meet in a room, see each other move, and the room closes after', async () => {
    const host = connect();
    await host.opened;
    host.send({ t: 'create', name: 'Host', maxPlayers: 8 });
    const { code, id: hostId } = await host.until('joined');

    const friend = connect();
    await friend.opened;
    friend.send({ t: 'join', code, name: 'Friend' });
    const joined = await friend.until('joined');
    expect(joined.players.map((p) => p.name).sort()).toEqual(['Friend', 'Host']);
    expect((await host.until('playerJoin')).player.name).toBe('Friend');

    host.send({ t: 'state', pos: [5, 6, 7], yaw: 1, pitch: 0.5, anchor: null });
    for (;;) {
      await new Promise((r) => setTimeout(r, 30));
      const snap = await friend.until('snapshot');
      const seen = snap.players.find((p) => p.id === hostId);
      if (seen?.pitch === 0.5) break;
    }

    host.socket.close();
    await friend.until('playerLeave');
    friend.socket.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(server.lobby.rooms.size).toBe(0);
  });

  it('shows open rooms to someone who has not joined, without putting them in a room', async () => {
    const host = connect();
    await host.opened;
    host.send({ t: 'create', name: 'Host', maxPlayers: 6 });
    const { code } = await host.until('joined');

    const visitor = connect();
    await visitor.opened;
    visitor.send({ t: 'list' });
    const { rooms } = await visitor.until('rooms');
    expect(rooms).toEqual([{ code, host: 'Host', players: 1, max: 6 }]);

    visitor.send({ t: 'join', code, name: 'Visitor' });
    expect((await visitor.until('joined')).players).toHaveLength(2);
    host.socket.close();
    visitor.socket.close();
  });

  it('answers a wrong code with an error and ignores garbage', async () => {
    const c = connect();
    await c.opened;
    c.socket.send('garbage');
    c.send({ t: 'join', code: 'ZZZZ', name: 'A' });
    expect((await c.until('error')).reason).toBe('not-found');
    c.socket.close();
  });

  it('will not serve files outside the build folder', async () => {
    const res = await fetch(`http://localhost:${server.port}/..%2fpackage.json`);
    expect(res.status).not.toBe(200);
  });
});
