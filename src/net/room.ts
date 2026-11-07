// Room rules: who is in a room, who is alive, and the score. This runs in the host's
// browser. Connections live in host.ts, so this file can be tested without a network.

import {
  cleanName,
  DEFAULT_ROOM_SIZE,
  PLAYER_HP,
  RESPAWN_MS,
  SPAWN_PROTECT_MS,
  type ClientMessage,
  type PlayerInfo,
  type MatchState,
  type FinalStanding,
  type PoseMode,
  type ServerMessage,
  type Vec,
} from './protocol';
import { HITS, hitDamage, MAX_KNOCK, MAX_STUN, type HitKind } from '../sim/hits';
import { ARENA_FLOOR, ARENA_LIMIT, createArena, raycast } from '../sim/map';
import { MOVES } from '../sim/moves';
import type { Mode } from '../sim/player';
import { CONTROL_POINT, CROWN_CARRY_HEIGHT, CROWN_PICKUP_RADIUS, CROWN_SPAWN, MIN_MATCH_PLAYERS, MODE_INFO, type GameMode, type Team } from '../sim/game-modes';

/** Allows for lag between what the shooter saw and the last position the server has. */
const HIT_RANGE_MARGIN = 25;
/** Cooldowns are checked with some slack, so a late packet isn't treated as cheating. */
const COOLDOWN_SLACK = 0.7;
/** A dodge reported in the last state covers the player for this long, to bridge updates. */
const SAFE_MS = 200;
/** The fastest a player can heal again. */
const HEAL_EVERY_MS = MOVES.healCooldown * 1000;
/** A spawn this far from everyone alive counts as safe. */
const SAFE_SPAWN_DISTANCE = 30;
/** With no safe spawn, the pick comes from this many of the farthest ones. */
const FALLBACK_SPAWNS = 3;
/** Objective modes keep players close enough to contest the central point. */
const OBJECTIVE_SPAWN_RADIUS = 170;

const MAP = createArena();
const SPAWNS = MAP.spawns;

export interface Client {
  send(message: ServerMessage): void;
}

interface RoomPlayer extends PlayerInfo {
  score: number;
  client: Client;
  pos: Vec;
  yaw: number;
  pitch: number;
  anchor: Vec | null;
  mode?: PoseMode;
  motion?: Mode;
  /** The last spawn used, so a player doesn't appear in the same place twice in a row. */
  spawn: (typeof SPAWNS)[number];
  respawnAt: number;
  protectedUntil: number;
  /** Mid-dodge, hits pass through. */
  safeUntil: number;
  /** When this player last landed each kind of hit. */
  lastAt: Partial<Record<HitKind, number>>;
  lastHealAt: number;
}

function info(p: RoomPlayer): PlayerInfo {
  const { id, name, kills, deaths, hp, alive, team, score } = p;
  return { id, name, kills, deaths, hp, alive, team, score: Math.floor(score) };
}

const distance = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const toVec = (spawn: (typeof SPAWNS)[number]): Vec => [spawn.pos.x, spawn.pos.y, spawn.pos.z];

/** Rooms take this many watchers on top of their players. */
export const MAX_WATCHERS = 8;

export class Room {
  private readonly players = new Map<number, RoomPlayer>();
  /** People who only watch: every update reaches them, but they never spawn, score or get hit. */
  private readonly watchers = new Map<number, Client>();
  private nextId = 1;
  private snapshotSeq = 0;
  private phase: MatchState['phase'] = 'waiting';
  private round = 0;
  private roundEnd = 0;
  private lastTick = 0;
  private holder: number | null = null;
  private looseCrown: Vec | null = null;
  private result = '';
  private standings: FinalStanding[] = [];
  private readonly ready = new Set<number>();
  private teamScores: Record<Team, number> = { red: 0, blue: 0 };

  constructor(
    readonly code: string,
    private readonly now: () => number,
    readonly maxPlayers: number = DEFAULT_ROOM_SIZE,
    private readonly random: () => number = Math.random,
    readonly gameMode: GameMode = 'deathmatch',
  ) {}

  private match(now = this.now(), includeStandings = false): MatchState {
    const remaining = this.phase === 'playing' ? Math.max(0, Math.ceil((this.roundEnd - now) / 1000)) : 0;
    const carrier = this.holder === null ? null : this.players.get(this.holder);
    const crown: Vec | null = this.gameMode !== 'crown' || this.phase === 'waiting'
      ? null
      : carrier ? [carrier.pos[0], carrier.pos[1] + CROWN_CARRY_HEIGHT, carrier.pos[2]] : this.looseCrown;
    return {
      mode: this.gameMode, phase: this.phase, round: this.round, remaining,
      teamScores: { ...this.teamScores }, holder: this.holder, crown, result: this.result,
      ready: [...this.ready],
      ...(includeStandings && this.phase === 'finished' ? { standings: this.standings.map((p) => ({ ...p })) } : {}),
    };
  }

  private nextTeam(): Team | undefined {
    if (this.gameMode !== 'teams') return undefined;
    const red = [...this.players.values()].filter((p) => p.team === 'red').length;
    const blue = this.players.size - red;
    return red <= blue ? 'red' : 'blue';
  }

  get size(): number {
    return this.players.size;
  }

  add(client: Client, rawName: string): number | null {
    if (this.players.size >= this.maxPlayers) return null;

    const spawn = this.pickSpawn();
    const player: RoomPlayer = {
      id: this.nextId,
      name: cleanName(rawName),
      kills: 0,
      deaths: 0,
      score: 0,
      team: this.nextTeam(),
      hp: PLAYER_HP,
      alive: true,
      client,
      pos: toVec(spawn),
      yaw: spawn.yaw,
      pitch: 0,
      anchor: null,
      spawn,
      respawnAt: 0,
      protectedUntil: this.now() + SPAWN_PROTECT_MS,
      safeUntil: 0,
      lastAt: {},
      lastHealAt: 0,
    };
    this.nextId += 1;

    this.broadcast({ t: 'playerJoin', player: info(player) });
    this.players.set(player.id, player);
    client.send({
      t: 'joined',
      code: this.code,
      id: player.id,
      players: [...this.players.values()].map(info),
      pos: player.pos,
      yaw: spawn.yaw,
      match: this.match(this.now(), true),
    });
    if (this.phase === 'waiting' && this.players.size >= MIN_MATCH_PLAYERS) this.startRound();
    return player.id;
  }

  /** Lets someone in to watch. Null when the room has all the watchers it takes. */
  watch(client: Client): number | null {
    if (this.watchers.size >= MAX_WATCHERS) return null;
    const id = this.nextId;
    this.nextId += 1;
    this.watchers.set(id, client);
    const first = [...this.players.values()].find((p) => p.alive);
    client.send({
      t: 'joined',
      code: this.code,
      id,
      players: [...this.players.values()].map(info),
      pos: first ? first.pos : [0, 40, 0],
      yaw: first?.yaw ?? 0,
      match: this.match(this.now(), true),
      watching: true,
    });
    return id;
  }

  get watcherCount(): number {
    return this.watchers.size;
  }

  remove(id: number): void {
    if (this.watchers.delete(id)) return;
    this.finishIfExpired();
    const leaving = this.players.get(id);
    if (leaving && this.gameMode === 'crown' && this.holder === id && this.phase === 'playing') this.dropCrown(leaving);
    if (!this.players.delete(id)) return;
    this.ready.delete(id);
    this.broadcast({ t: 'playerLeave', id });
    if (this.phase === 'finished') {
      this.startIfReady();
    } else if (this.players.size < MIN_MATCH_PLAYERS) {
      this.phase = 'waiting';
      this.holder = null;
      this.looseCrown = null;
      this.result = '';
    }
  }

  handle(id: number, m: ClientMessage): void {
    const watcher = this.watchers.get(id);
    if (watcher) {
      // A watcher can only ask for its ping.
      if (m.t === 'ping') watcher.send({ t: 'pong', at: m.at });
      return;
    }
    const player = this.players.get(id);
    if (!player) return;
    // The result is fixed at the deadline, even if the next tick has not run yet.
    this.finishIfExpired();

    switch (m.t) {
      case 'ping':
        player.client.send({ t: 'pong', at: m.at });
        break;
      case 'state':
        if (player.alive) {
          player.pos = m.pos;
          player.yaw = m.yaw;
          player.pitch = m.pitch;
          player.anchor = m.anchor;
          player.mode = m.mode;
          player.motion = m.motion;
          if (m.safe) player.safeUntil = this.now() + SAFE_MS;
          if (this.gameMode === 'crown') this.collectCrown(player);
        }
        break;
      case 'heal':
        if (this.phase !== 'finished') this.handleHeal(player);
        break;
      case 'rematch':
        if (this.phase !== 'finished' || m.round !== this.round) break;
        if (m.ready) this.ready.add(id);
        else this.ready.delete(id);
        this.startIfReady();
        break;
      case 'shot':
        if (player.alive && this.phase !== 'finished') this.broadcast({ ...m, id }, id);
        break;
      case 'hit':
        this.handleHit(player, m);
        break;
    }
  }

  /**
   * The attacker's game reports the hit, so what they saw is what counts. The server
   * rejects impossible ones: too far, too soon after the last of its kind, or on
   * someone mid-dodge. Damage comes from the kind, never from the report.
   */
  private handleHit(shooter: RoomPlayer, m: Extract<ClientMessage, { t: 'hit' }>): void {
    const target = this.players.get(m.target);
    const now = this.now();
    if (!target || target === shooter || !shooter.alive || !target.alive) return;
    if (this.phase === 'finished') return;
    if (this.gameMode === 'teams' && shooter.team === target.team) return;
    if (now < target.protectedUntil || now < target.safeUntil) return;

    const kind: HitKind = m.kind ?? (m.snare ? 'snare' : 'shot');
    const spec = HITS[kind];
    if (distance(shooter.pos, target.pos) > spec.range + HIT_RANGE_MARGIN) return;
    if (now - (shooter.lastAt[kind] ?? -Infinity) < spec.cooldown * 1000 * COOLDOWN_SLACK) return;
    shooter.lastAt[kind] = now;

    if (kind === 'snare') {
      this.broadcast({ t: 'snared', target: target.id, by: shooter.id });
      return;
    }

    const damage = hitDamage(kind, m.power);
    if (damage === 0) {
      // A tug on a held web: only the shove reaches them. A damage message ten times a
      // second would flash their screen red for nothing.
      if (m.knock) this.sendKnock(shooter, target, m);
      return;
    }
    target.hp = Math.max(0, target.hp - damage);
    const ko = target.hp === 0;
    if (ko) {
      target.alive = false;
      if (this.gameMode === 'crown' && this.holder === target.id) this.dropCrown(target);
      target.anchor = null;
      target.deaths += 1;
      target.respawnAt = now + RESPAWN_MS;
      shooter.kills += 1;
      if (this.gameMode === 'deathmatch' || this.gameMode === 'teams') shooter.score += 1;
      if (this.gameMode === 'teams' && shooter.team) this.teamScores[shooter.team] += 1;
    }
    this.broadcast({
      t: 'damage',
      target: target.id,
      by: shooter.id,
      hp: target.hp,
      ko,
      kills: shooter.kills,
      deaths: target.deaths,
    });

    if (ko && this.phase === 'playing') {
      const score = this.gameMode === 'teams' && shooter.team ? this.teamScores[shooter.team] : shooter.score;
      if ((this.gameMode === 'teams' || this.gameMode === 'deathmatch') && score >= MODE_INFO[this.gameMode].goal) this.finishRound();
    }

    if (!ko && m.knock) this.sendKnock(shooter, target, m);
  }

  /** Only the one hit is moved, by their own game, and never harder than the limit. */
  private sendKnock(shooter: RoomPlayer, target: RoomPlayer, m: Extract<ClientMessage, { t: 'hit' }>): void {
    if (m.knock) {
      const size = Math.hypot(...m.knock);
      const k = size > MAX_KNOCK ? MAX_KNOCK / size : 1;
      target.client.send({
        t: 'knock',
        target: target.id,
        by: shooter.id,
        vel: [m.knock[0] * k, m.knock[1] * k, m.knock[2] * k],
        stun: Math.min(MAX_STUN, Math.max(0, m.stun ?? 0)),
        pin: m.pin === true,
      });
    }
  }

  /** Focus is spent on the player's side. The host only limits how often it can heal. */
  private handleHeal(player: RoomPlayer): void {
    const now = this.now();
    if (!player.alive || now - player.lastHealAt < HEAL_EVERY_MS) return;
    player.lastHealAt = now;
    player.hp = Math.min(PLAYER_HP, player.hp + MOVES.healAmount);
    this.broadcast({ t: 'healed', target: player.id, hp: player.hp });
  }

  tick(): void {
    const now = this.now();
    if (this.phase === 'playing') {
      const elapsed = Math.max(0, Math.min(1000, Math.min(now, this.roundEnd) - this.lastTick)) / 1000;
      if (this.gameMode === 'crown' && now >= this.roundEnd) this.finishRound();
      if (this.gameMode === 'control') this.stepControl(elapsed);
      if (this.phase === 'playing' && this.gameMode === 'crown' && this.holder === null) {
        for (const player of this.players.values()) this.collectCrown(player);
      }
      if (this.phase === 'playing' && now >= this.roundEnd) this.finishRound();
    }
    this.lastTick = now;
    for (const p of this.players.values()) {
      if (this.phase === 'finished') break;
      if (p.alive || now < p.respawnAt) continue;
      const spawn = this.pickSpawn(p.spawn);
      p.alive = true;
      p.hp = PLAYER_HP;
      p.pos = toVec(spawn);
      p.yaw = spawn.yaw;
      p.pitch = 0;
      p.spawn = spawn;
      p.protectedUntil = now + SPAWN_PROTECT_MS;
      this.broadcast({ t: 'respawn', id: p.id, pos: p.pos, yaw: spawn.yaw });
    }

    this.broadcast({
      t: 'snapshot',
      seq: ++this.snapshotSeq,
      players: [...this.players.values()]
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, pos: p.pos, yaw: p.yaw, pitch: p.pitch, anchor: p.anchor, mode: p.mode, motion: p.motion })),
      match: this.match(now),
      scores: [...this.players.values()].map((p) => ({ id: p.id, score: Math.floor(p.score) })),
    });
  }

  private startRound(): void {
    const now = this.now();
    this.phase = 'playing';
    this.round += 1;
    this.roundEnd = now + MODE_INFO[this.gameMode].seconds * 1000;
    this.lastTick = now;
    this.teamScores = { red: 0, blue: 0 };
    this.holder = null;
    this.looseCrown = this.gameMode === 'crown' ? [CROWN_SPAWN.x, CROWN_SPAWN.y, CROWN_SPAWN.z] : null;
    this.result = '';
    this.standings = [];
    this.ready.clear();
    const spawns: Array<{ id: number; pos: Vec; yaw: number }> = [];
    for (const p of this.players.values()) {
      const spawn = this.pickSpawn(p.spawn);
      p.pos = toVec(spawn);
      p.yaw = spawn.yaw;
      p.pitch = 0;
      p.spawn = spawn;
      p.hp = PLAYER_HP;
      p.alive = true;
      p.kills = 0;
      p.deaths = 0;
      p.score = 0;
      p.anchor = null;
      p.protectedUntil = now + SPAWN_PROTECT_MS;
      p.safeUntil = 0;
      p.respawnAt = 0;
      p.lastAt = {};
      p.lastHealAt = 0;
      spawns.push({ id: p.id, pos: p.pos, yaw: p.yaw });
    }
    this.broadcast({ t: 'roundStart', seq: ++this.snapshotSeq, match: this.match(now), players: [...this.players.values()].map(info), spawns });
  }

  private startIfReady(): void {
    if (this.phase !== 'finished' || this.players.size < MIN_MATCH_PLAYERS) return;
    if ([...this.players.keys()].every((id) => this.ready.has(id))) this.startRound();
  }

  private collectCrown(player: RoomPlayer): void {
    const crown = this.looseCrown;
    if (this.phase !== 'playing' || !player.alive || this.holder !== null || !crown) return;
    const chest: Vec = [player.pos[0], player.pos[1] + 1, player.pos[2]];
    const dist = distance(chest, crown);
    if (dist > CROWN_PICKUP_RADIUS) return;
    if (dist > 0.01 && raycast(MAP, { x: chest[0], y: chest[1], z: chest[2] }, { x: (crown[0] - chest[0]) / dist, y: (crown[1] - chest[1]) / dist, z: (crown[2] - chest[2]) / dist }, dist)) return;
    this.holder = player.id;
    this.looseCrown = null;
  }

  private dropCrown(player: RoomPlayer): void {
    this.holder = null;
    const [x, y, z] = player.pos;
    if (Math.abs(x) >= ARENA_LIMIT || Math.abs(z) >= ARENA_LIMIT || y < ARENA_FLOOR) {
      this.looseCrown = [CROWN_SPAWN.x, CROWN_SPAWN.y, CROWN_SPAWN.z];
      return;
    }
    const from = { x, y: Math.max(0.1, y + 1), z };
    const ground = raycast(MAP, from, { x: 0, y: -1, z: 0 }, from.y + 10);
    this.looseCrown = ground ? [x, ground.point.y + 1, z] : [CROWN_SPAWN.x, CROWN_SPAWN.y, CROWN_SPAWN.z];
  }

  private stepControl(dt: number): void {
    const zone = CONTROL_POINT;
    const inside = [...this.players.values()].filter((p) => p.alive && p.pos[1] >= zone.y - 0.5 && p.pos[1] <= zone.y + zone.height && Math.hypot(p.pos[0] - zone.x, p.pos[2] - zone.z) <= zone.radius);
    const owner = inside.length === 1 ? inside[0] : null;
    this.holder = owner?.id ?? null;
    if (!owner) return;
    owner.score += dt;
    if (owner.score >= MODE_INFO.control.goal) this.finishRound();
  }

  /** An event arriving just after the deadline must not change the final result. */
  private finishIfExpired(): void {
    if (this.phase !== 'playing' || this.now() < this.roundEnd) return;
    if (this.gameMode === 'control') {
      const elapsed = Math.max(0, Math.min(1000, this.roundEnd - this.lastTick)) / 1000;
      this.lastTick = this.roundEnd;
      this.stepControl(elapsed);
    }
    if (this.phase === 'playing') this.finishRound();
  }

  private finishRound(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'finished';
    this.ready.clear();
    let crownWinner: number | null = null;
    if (this.gameMode === 'crown') {
      const winner = this.holder === null ? null : this.players.get(this.holder);
      crownWinner = winner?.alive ? winner.id : null;
      this.result = winner?.alive ? `${winner.name} ชนะ!` : 'ไม่มีผู้ชนะ เพราะไม่มีคนถือมงกุฎ';
    } else if (this.gameMode === 'teams') {
      this.holder = null;
      const { red, blue } = this.teamScores;
      this.result = red === blue ? 'เสมอกัน!' : `${red > blue ? 'ทีมแดง' : 'ทีมน้ำเงิน'} ชนะ!`;
    } else {
      this.holder = null;
      const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
      this.result = !ranked.length || (ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 0.001)
        ? 'เสมอกัน!'
        : `${ranked[0].name} ชนะ!`;
    }
    const ranked = [...this.players.values()].sort((a, b) =>
      (this.gameMode === 'crown' ? Number(b.id === crownWinner) - Number(a.id === crownWinner) : b.score - a.score) ||
      b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    this.standings = ranked.map((player, i) => ({
      id: player.id, name: player.name, kills: player.kills, deaths: player.deaths,
      score: Math.round(player.score * 100) / 100, team: player.team,
      rank: this.gameMode === 'crown'
        ? player.id === crownWinner ? 1 : null
        : i > 0 && Math.abs(player.score - ranked[i - 1].score) < 0.001 ? this.standingsRank(ranked, i) : i + 1,
    }));
    this.broadcast({ t: 'roundEnd', seq: ++this.snapshotSeq, match: this.match(this.now(), true) });
  }

  private standingsRank(ranked: RoomPlayer[], index: number): number {
    while (index > 0 && Math.abs(ranked[index].score - ranked[index - 1].score) < 0.001) index -= 1;
    return index + 1;
  }

  /** A random spawn away from everyone alive, and not the one just used. */
  private pickSpawn(last?: (typeof SPAWNS)[number]) {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const gap = (spawn: (typeof SPAWNS)[number]) =>
      Math.min(Infinity, ...alive.map((p) => distance(toVec(spawn), p.pos)));

    const poolForMode = this.gameMode === 'crown' || this.gameMode === 'control'
      ? SPAWNS.filter(({ pos }) => Math.hypot(pos.x, pos.z) <= OBJECTIVE_SPAWN_RADIUS)
      : SPAWNS;
    const options = poolForMode.filter((spawn) => spawn !== last);
    const safe = options.filter((spawn) => gap(spawn) >= SAFE_SPAWN_DISTANCE);
    const pool = safe.length
      ? safe
      : [...options].sort((a, b) => gap(b) - gap(a)).slice(0, FALLBACK_SPAWNS);
    return pool[Math.floor(this.random() * pool.length)];
  }

  private broadcast(message: ServerMessage, except?: number): void {
    for (const p of this.players.values()) {
      if (p.id !== except) p.client.send(message);
    }
    for (const watcher of this.watchers.values()) watcher.send(message);
  }
}
