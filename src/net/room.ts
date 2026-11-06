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
  type ServerMessage,
  type Vec,
} from './protocol';
import { createArena } from '../sim/map';
import { TUNING } from '../sim/player';

/** Allows for lag between what the shooter saw and the last position the server has. */
const HIT_RANGE_MARGIN = 25;
/** Cooldowns are checked with some slack, so a late packet isn't treated as cheating. */
const COOLDOWN_SLACK = 0.7;
/** A spawn this far from everyone alive counts as safe. */
const SAFE_SPAWN_DISTANCE = 30;
/** With no safe spawn, the pick comes from this many of the farthest ones. */
const FALLBACK_SPAWNS = 3;

const SPAWNS = createArena().spawns;

export interface Client {
  send(message: ServerMessage): void;
}

interface RoomPlayer extends PlayerInfo {
  client: Client;
  pos: Vec;
  yaw: number;
  pitch: number;
  anchor: Vec | null;
  /** The last spawn used, so a player doesn't appear in the same place twice in a row. */
  spawn: (typeof SPAWNS)[number];
  respawnAt: number;
  protectedUntil: number;
  lastHitAt: number;
  lastSnareAt: number;
}

function info(p: RoomPlayer): PlayerInfo {
  const { id, name, kills, deaths, hp, alive } = p;
  return { id, name, kills, deaths, hp, alive };
}

const distance = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const toVec = (spawn: (typeof SPAWNS)[number]): Vec => [spawn.pos.x, spawn.pos.y, spawn.pos.z];

export class Room {
  private readonly players = new Map<number, RoomPlayer>();
  private nextId = 1;

  constructor(
    readonly code: string,
    private readonly now: () => number,
    readonly maxPlayers: number = DEFAULT_ROOM_SIZE,
    private readonly random: () => number = Math.random,
  ) {}

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
      lastHitAt: 0,
      lastSnareAt: 0,
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
    });
    return player.id;
  }

  remove(id: number): void {
    if (this.players.delete(id)) this.broadcast({ t: 'playerLeave', id });
  }

  handle(id: number, m: ClientMessage): void {
    const player = this.players.get(id);
    if (!player) return;

    switch (m.t) {
      case 'state':
        if (player.alive) {
          player.pos = m.pos;
          player.yaw = m.yaw;
          player.pitch = m.pitch;
          player.anchor = m.anchor;
        }
        break;
      case 'shot':
        if (player.alive) this.broadcast({ ...m, id }, id);
        break;
      case 'hit':
        this.handleHit(player, m.target, m.snare);
        break;
    }
  }

  /** The shooter's game reports the hit, so what they saw is what counts. The server rejects impossible ones. */
  private handleHit(shooter: RoomPlayer, targetId: number, snare: boolean): void {
    const target = this.players.get(targetId);
    const now = this.now();
    if (!target || target === shooter || !shooter.alive || !target.alive) return;
    if (now < target.protectedUntil) return;
    if (distance(shooter.pos, target.pos) > TUNING.shotRange + HIT_RANGE_MARGIN) return;

    if (snare) {
      if (now - shooter.lastSnareAt < TUNING.snareCooldown * 1000 * COOLDOWN_SLACK) return;
      shooter.lastSnareAt = now;
      this.broadcast({ t: 'snared', target: target.id, by: shooter.id });
      return;
    }

    if (now - shooter.lastHitAt < TUNING.shotCooldown * 1000 * COOLDOWN_SLACK) return;
    shooter.lastHitAt = now;

    target.hp = Math.max(0, target.hp - 1);
    const ko = target.hp === 0;
    if (ko) {
      target.alive = false;
      target.anchor = null;
      target.deaths += 1;
      target.respawnAt = now + RESPAWN_MS;
      shooter.kills += 1;
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
  }

  tick(): void {
    const now = this.now();
    for (const p of this.players.values()) {
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
      players: [...this.players.values()]
        .filter((p) => p.alive)
        .map((p) => ({ id: p.id, pos: p.pos, yaw: p.yaw, pitch: p.pitch, anchor: p.anchor })),
    });
  }

  /** A random spawn away from everyone alive, and not the one just used. */
  private pickSpawn(last?: (typeof SPAWNS)[number]) {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const gap = (spawn: (typeof SPAWNS)[number]) =>
      Math.min(Infinity, ...alive.map((p) => distance(toVec(spawn), p.pos)));

    const options = SPAWNS.filter((spawn) => spawn !== last);
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
  }
}
