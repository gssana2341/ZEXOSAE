import { describe, expect, it } from 'vitest';
import { Room, type Client } from '../src/net/room';
import { NetClient } from '../src/net/client';
import { RESPAWN_MS, SPAWN_PROTECT_MS, type ServerMessage, type Vec } from '../src/net/protocol';
import { CONTROL_POINT, CROWN_CARRY_HEIGHT, CROWN_SPAWN, MODE_INFO, type GameMode } from '../src/sim/game-modes';
import { emptyInput } from '../src/sim/player';
import { TICK, World } from '../src/sim/world';
import { createTestArena } from './test-map';

class Recorder implements Client {
  messages: ServerMessage[] = [];
  send(message: ServerMessage) { this.messages.push(message); }
  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.messages.filter((m) => m.t === type).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

function setup(mode: GameMode, count = 2) {
  let time = 100000;
  const room = new Room('TEST', () => time, 16, () => 0.37, mode);
  const clients = Array.from({ length: count }, () => new Recorder());
  const ids = clients.map((client, i) => room.add(client, `P${i + 1}`)!);
  const advance = (ms: number) => { time += ms; };
  const tick = (ms = 50) => { advance(ms); room.tick(); };
  const state = (id: number, pos: Vec) => room.handle(id, { t: 'state', pos, yaw: 0, pitch: 0, anchor: null });
  const hit = (by: number, target: number, kind: 'shot' | 'snare' = 'shot') => room.handle(by, { t: 'hit', target, snare: kind === 'snare', kind });
  return { room, clients, ids, advance, tick, state, hit };
}

describe('online match lifecycle', () => {
  it.each(['control', 'crown'] as const)('spawns %s players close enough to contest the objective', (mode) => {
    const g = setup(mode, 8);
    const spawns = g.clients[0].last('roundStart')!.spawns;
    expect(spawns.every(({ pos }) => Math.hypot(pos[0], pos[2]) <= 170)).toBe(true);
    for (const client of g.clients) {
      const pos = client.last('joined')!.pos;
      expect(Math.hypot(pos[0], pos[2])).toBeLessThanOrEqual(170);
    }
  });

  it('ignores reordered snapshots so an old crown holder cannot reappear', () => {
    const g = setup('crown');
    const joined = g.clients[0].last('joined')!;
    g.tick();
    const snapshot = g.clients[0].last('snapshot')!;
    const client = new NetClient(() => undefined, () => undefined);
    const receive = (m: ServerMessage) => (client as unknown as { receive: (value: ServerMessage) => void }).receive(m);
    receive(joined);
    receive({ ...snapshot, seq: 10, match: { ...snapshot.match, holder: joined.id }, scores: [{ id: joined.id, score: 3 }] });
    receive({ ...snapshot, seq: 9, match: { ...snapshot.match, holder: g.ids[1] }, scores: [{ id: joined.id, score: 1 }] });
    expect(client.match?.holder).toBe(joined.id);
    receive({ ...g.clients[0].last('roundStart')!, seq: 10 });
    receive({ ...snapshot, seq: 10, scores: [{ id: joined.id, score: 3 }] });
    expect(client.match?.holder).toBeNull();
    expect(client.players.get(joined.id)?.score).toBe(0);
    receive({ ...snapshot, seq: 11, scores: [{ id: joined.id, score: 1 }] });
    expect(client.players.get(joined.id)?.score).toBe(1);
  });

  it('keeps the final results until every remaining player chooses a rematch', () => {
    const g = setup('deathmatch', 1);
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.phase).toBe('waiting');
    const other = new Recorder();
    const id = g.room.add(other, 'P2')!;
    expect(other.last('roundStart')?.players).toHaveLength(2);
    g.tick();
    expect(other.last('snapshot')?.match.phase).toBe('playing');
    const firstSeq = other.last('snapshot')!.seq;
    g.tick(MODE_INFO.deathmatch.seconds * 1000);
    expect(other.last('snapshot')!.seq).toBeGreaterThan(firstSeq);
    expect(other.last('snapshot')?.match).toMatchObject({ phase: 'finished', result: 'เสมอกัน!' });
    const end = other.last('roundEnd')!;
    expect(end.match.standings?.map((p) => p.rank)).toEqual([1, 1]);
    g.tick(60000);
    expect(other.last('snapshot')?.match.phase).toBe('finished');
    const round = end.match.round;
    g.room.handle(g.ids[0], { t: 'rematch', round, ready: true });
    g.tick();
    expect(other.last('snapshot')?.match.ready).toEqual([g.ids[0]]);
    g.room.handle(g.ids[0], { t: 'rematch', round, ready: false });
    g.room.handle(id, { t: 'rematch', round: round - 1, ready: true });
    g.tick();
    expect(other.last('snapshot')?.match.ready).toEqual([]);
    g.room.handle(g.ids[0], { t: 'rematch', round, ready: true });
    g.room.handle(id, { t: 'rematch', round, ready: true });
    g.tick();
    expect(other.last('snapshot')?.match.phase).toBe('playing');
    expect(other.last('snapshot')!.seq).toBeGreaterThan(other.last('roundStart')!.seq);
    expect(other.last('roundStart')?.players.every((p) => p.score === 0 && p.hp === 100)).toBe(true);
    expect(other.last('roundStart')?.match.round).toBe(round + 1);
    g.room.remove(id);
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.phase).toBe('waiting');
  });

  it('preserves the finished board when players leave, and waits for at least two', () => {
    const g = setup('deathmatch');
    g.tick(MODE_INFO.deathmatch.seconds * 1000);
    const end = g.clients[0].last('roundEnd')!;
    g.room.remove(g.ids[1]);
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.phase).toBe('finished');
    const late = new Recorder();
    const lateId = g.room.add(late, 'P3')!;
    expect(late.last('joined')?.match.standings).toEqual(end.match.standings);
    expect(late.last('joined')?.match.standings?.map((p) => p.name)).toEqual(['P1', 'P2']);
    g.room.handle(g.ids[0], { t: 'rematch', round: end.match.round, ready: true });
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.phase).toBe('finished');
    g.room.handle(lateId, { t: 'rematch', round: end.match.round, ready: true });
    expect(g.clients[0].last('roundStart')?.match.round).toBe(end.match.round + 1);
  });

  it('does not let spectators vote, but starts if only ready players remain', () => {
    const g = setup('deathmatch', 3);
    const spectator = new Recorder();
    const watchId = g.room.watch(spectator)!;
    g.tick(MODE_INFO.deathmatch.seconds * 1000);
    const round = g.clients[0].last('roundEnd')!.match.round;
    g.room.handle(watchId, { t: 'rematch', round, ready: true });
    g.room.handle(g.ids[0], { t: 'rematch', round, ready: true });
    g.room.handle(g.ids[1], { t: 'rematch', round, ready: true });
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.ready).toEqual([g.ids[0], g.ids[1]]);
    g.room.remove(g.ids[2]);
    expect(g.clients[0].last('roundStart')?.match.round).toBe(round + 1);
  });

  it('keeps the reliable results when a newer snapshot arrives first', () => {
    const g = setup('deathmatch');
    const joined = g.clients[0].last('joined')!;
    g.tick(MODE_INFO.deathmatch.seconds * 1000);
    const end = g.clients[0].last('roundEnd')!;
    const snapshot = g.clients[0].last('snapshot')!;
    const client = new NetClient(() => undefined, () => undefined);
    const receive = (m: ServerMessage) => (client as unknown as { receive: (value: ServerMessage) => void }).receive(m);
    receive(joined);
    receive({ ...snapshot, seq: 10, match: { ...snapshot.match, ready: [g.ids[0]] } });
    expect(client.match?.standings).toBeUndefined();
    receive({ ...end, seq: 9 });
    expect(client.match?.standings).toEqual(end.match.standings);
    expect(client.match?.ready).toEqual([g.ids[0]]);
    receive({ ...snapshot, seq: 11, match: { ...snapshot.match, ready: [g.ids[0], g.ids[1]] } });
    expect(client.match?.standings).toEqual(end.match.standings);
    g.room.handle(g.ids[0], { t: 'rematch', round: end.match.round, ready: true });
    g.room.handle(g.ids[1], { t: 'rematch', round: end.match.round, ready: true });
    receive({ ...g.clients[0].last('roundStart')!, seq: 12 });
    receive({ ...end, seq: 13 });
    expect(client.match).toMatchObject({ phase: 'playing', round: end.match.round + 1 });
  });

  it('locks deathmatch results before processing a hit after the deadline', () => {
    const g = setup('deathmatch');
    g.state(g.ids[0], [0, 0, 0]);
    g.state(g.ids[1], [0, 0, 8]);
    g.advance(MODE_INFO.deathmatch.seconds * 1000);
    g.hit(g.ids[0], g.ids[1]);
    expect(g.clients[0].last('damage')).toBeUndefined();
    expect(g.clients[0].last('roundEnd')?.match).toMatchObject({ phase: 'finished', result: 'เสมอกัน!' });
  });

  it('ends a free-for-all when someone reaches the KO goal', () => {
    const g = setup('deathmatch');
    const [a, b] = g.ids;
    g.advance(SPAWN_PROTECT_MS + 1);
    for (let n = 0; n < MODE_INFO.deathmatch.goal; n += 1) {
      g.state(a, [0, 0, 0]);
      g.state(b, [0, 0, 8]);
      for (let i = 0; i < 4; i += 1) {
        g.hit(a, b);
        g.advance(300);
      }
      if (n < MODE_INFO.deathmatch.goal - 1) {
        g.tick(RESPAWN_MS + 1);
        g.advance(SPAWN_PROTECT_MS + 1);
      }
    }
    g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', result: 'P1 ชนะ!' });
    expect(g.clients[0].last('roundEnd')?.match.standings?.[0]).toMatchObject({ name: 'P1', rank: 1, score: MODE_INFO.deathmatch.goal });
    expect(g.clients[0].last('snapshot')?.scores.find((s) => s.id === a)?.score).toBe(MODE_INFO.deathmatch.goal);
  });
});

describe('team deathmatch', () => {
  it('ends when a team reaches its shared KO goal', () => {
    const g = setup('teams');
    const [a, b] = g.ids;
    g.advance(SPAWN_PROTECT_MS + 1);
    for (let n = 0; n < MODE_INFO.teams.goal; n += 1) {
      g.state(a, [0, 0, 0]);
      g.state(b, [0, 0, 8]);
      for (let i = 0; i < 4; i += 1) { g.hit(a, b); g.advance(300); }
      if (n < MODE_INFO.teams.goal - 1) {
        g.tick(RESPAWN_MS + 1);
        g.advance(SPAWN_PROTECT_MS + 1);
      }
    }
    g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', result: 'ทีมแดง ชนะ!', teamScores: { red: 25, blue: 0 } });
  });

  it('balances teams, blocks friendly hits and awards enemy KOs to the team', () => {
    const g = setup('teams', 3);
    const [red, blue, ally] = g.ids;
    expect(g.clients[2].last('joined')?.players.map((p) => p.team)).toEqual(['red', 'blue', 'red']);
    g.advance(SPAWN_PROTECT_MS + 1);
    g.state(red, [0, 0, 0]);
    g.state(blue, [0, 0, 8]);
    g.state(ally, [0, 0, 4]);
    g.hit(red, ally);
    g.hit(red, ally, 'snare');
    expect(g.clients[0].last('damage')).toBeUndefined();
    expect(g.clients[0].last('snared')).toBeUndefined();
    for (let i = 0; i < 4; i += 1) { g.hit(red, blue); g.advance(300); }
    g.tick();
    expect(g.clients[0].last('damage')).toMatchObject({ target: blue, ko: true });
    expect(g.clients[0].last('snapshot')?.match.teamScores).toEqual({ red: 1, blue: 0 });
  });

  it('keeps teammates visible but lets shots pass through them', () => {
    const world = new World(null, createTestArena());
    world.setOnline(true);
    world.respawnAt({ x: 0, y: 0.05, z: 22 }, 0);
    world.dummies = [
      { id: 1, pos: { x: 0, y: 0, z: 16 }, hp: 100, snareT: 0, respawnT: 0, phase: 0, dir: 1, ally: true },
      { id: 2, pos: { x: 0, y: 0, z: 10 }, hp: 100, snareT: 0, respawnT: 0, phase: 0, dir: 1 },
    ];
    for (let i = 0; i < 20; i += 1) world.step({ ...emptyInput(), shoot: i === 0, aimAssist: false }, TICK);
    expect(world.events.some((e) => e.type === 'netHit' && e.target === 2)).toBe(true);
    expect(world.events.some((e) => e.type === 'netHit' && e.target === 1)).toBe(false);
    expect(world.dummies).toHaveLength(2);
  });
});

describe('control point', () => {
  it('counts control time up to the deadline before a late state changes the point', () => {
    const g = setup('control');
    const [a, b] = g.ids;
    g.state(a, [CONTROL_POINT.x, 0, CONTROL_POINT.z]);
    g.state(b, [40, 0, 0]);
    g.tick(MODE_INFO.control.seconds * 1000 - 500);
    g.advance(500);
    g.state(a, [40, 0, 0]);
    const end = g.clients[0].last('roundEnd')!;
    expect(end.match.result).toBe('P1 ชนะ!');
    expect(end.match.standings?.find((p) => p.id === a)?.score).toBeCloseTo(1.5);
  });

  it('awards time only to a sole player inside, pauses when contested, and ends at the goal', () => {
    const g = setup('control');
    const [a, b] = g.ids;
    const inside: Vec = [CONTROL_POINT.x, 0, CONTROL_POINT.z];
    g.state(a, inside);
    g.state(b, [40, 0, 0]);
    for (let i = 0; i < 40; i += 1) g.tick();
    const before = g.clients[0].last('snapshot')!;
    expect(before.match.holder).toBe(a);
    expect(before.scores.find((s) => s.id === a)!.score).toBeGreaterThanOrEqual(1);
    g.state(b, inside);
    for (let i = 0; i < 40; i += 1) g.tick();
    const contested = g.clients[0].last('snapshot')!;
    expect(contested.match.holder).toBeNull();
    expect(contested.scores).toEqual(before.scores);
    g.state(b, [40, 0, 0]);
    for (let i = 0; i < (MODE_INFO.control.goal + 1) * 20; i += 1) g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', result: 'P1 ชนะ!' });
  });
});

describe('crown mode', () => {
  it('lets players collect the crown, drop it on KO, and makes the final holder win', () => {
    const g = setup('crown');
    const [a, b] = g.ids;
    g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ holder: null, crown: [CROWN_SPAWN.x, CROWN_SPAWN.y, CROWN_SPAWN.z] });

    g.state(a, [CROWN_SPAWN.x, 0, CROWN_SPAWN.z]);
    g.state(b, [0, 0, 24]);
    g.state(a, [0, 20, 16]);
    g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ holder: a, crown: [0, 20 + CROWN_CARRY_HEIGHT, 16] });

    g.advance(SPAWN_PROTECT_MS + 1);
    for (let i = 0; i < 4; i += 1) { g.hit(b, a); g.advance(300); }
    g.tick();
    expect(g.clients[0].last('damage')).toMatchObject({ target: a, ko: true });
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ holder: null, crown: [0, 1, 16] });
    g.state(b, [0, 0, 16]);
    g.tick();
    expect(g.clients[0].last('snapshot')?.match.holder).toBe(b);
    g.tick(MODE_INFO.crown.seconds * 1000);
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', holder: b, result: 'P2 ชนะ!' });
    const end = g.clients[0].last('roundEnd')!;
    expect(end.match.standings?.[0]).toMatchObject({ id: b, rank: 1 });
    expect(end.match.standings?.find((p) => p.id === a)?.rank).toBeNull();
    g.room.handle(a, { t: 'rematch', round: end.match.round, ready: true });
    g.room.handle(b, { t: 'rematch', round: end.match.round, ready: true });
    g.tick();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'playing', holder: null, crown: [CROWN_SPAWN.x, CROWN_SPAWN.y, CROWN_SPAWN.z] });
  });

  it('does not award a win if nobody holds the crown at the deadline', () => {
    const g = setup('crown');
    g.state(g.ids[0], [40, 0, 0]);
    g.state(g.ids[1], [-40, 0, 0]);
    g.tick(MODE_INFO.crown.seconds * 1000);
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', holder: null, result: 'ไม่มีผู้ชนะ เพราะไม่มีคนถือมงกุฎ' });
    expect(g.clients[0].last('roundEnd')?.match.standings?.every((p) => p.rank === null)).toBe(true);
  });

  it('locks the winner at the deadline before processing a late hit', () => {
    const g = setup('crown');
    const [a, b] = g.ids;
    g.state(a, [CROWN_SPAWN.x, 0, CROWN_SPAWN.z]);
    g.state(b, [0, 0, 24]);
    g.advance(MODE_INFO.crown.seconds * 1000);
    g.hit(b, a);
    g.tick();
    expect(g.clients[0].last('damage')).toBeUndefined();
    expect(g.clients[0].last('snapshot')?.match).toMatchObject({ phase: 'finished', holder: a, result: 'P1 ชนะ!' });
  });

  it('drops the crown where its holder leaves when other players remain', () => {
    const g = setup('crown', 3);
    const [a, b, c] = g.ids;
    g.state(b, [40, 0, 0]);
    g.state(c, [-40, 0, 0]);
    g.state(a, [CROWN_SPAWN.x, 0, CROWN_SPAWN.z]);
    g.state(a, [0, 20, 16]);
    g.room.remove(a);
    g.tick();
    expect(g.clients[1].last('snapshot')?.match).toMatchObject({ phase: 'playing', holder: null, crown: [0, 1, 16] });
  });

  it('does not let someone collect a dropped crown through a solid roof', () => {
    const g = setup('crown', 3);
    const [a, b, c] = g.ids;
    g.state(a, [CROWN_SPAWN.x, 0, CROWN_SPAWN.z]);
    g.state(a, [14, 24.05, 48]);
    g.state(b, [15.5, 22.1, 48]);
    g.state(c, [40, 0, 40]);
    g.room.remove(a);
    g.tick();
    expect(g.clients[1].last('snapshot')?.match).toMatchObject({ holder: null, crown: [14, 25, 48] });
    g.state(b, [14, 24.05, 48]);
    g.tick();
    expect(g.clients[1].last('snapshot')?.match.holder).toBe(b);
  });
});
