// The game's side of a room, whether this player hosts it or joined it. Other
// players are drawn slightly in the past, so their movement can be blended between
// updates instead of jumping.

import { viewForward } from '../sim/aim';
import type { V3 } from '../sim/map';
import { TUNING, type Dummy } from '../sim/player';
import { GAME_MODES, isGameMode, type GameMode } from '../sim/game-modes';
import { HostSession } from './host';
import { makeOffer, type Link } from './link';
import {
  cleanCode,
  PLAYER_HP,
  type ClientMessage,
  type MatchState,
  type PlayerInfo,
  type PlayerSnapshot,
  type RoomSummary,
  type ServerMessage,
  type Vec,
} from './protocol';
import { closeRoom, createRoom, listRooms, poll, quickRoom, sendToHost, SignalError } from './signal';

const RENDER_DELAY_MS = 120;
const MAX_SAMPLES = 12;
/** The host checks for new players every few seconds, so answers take a moment. */
const ANSWER_TIMEOUT_MS = 12000;
const ANSWER_POLL_MS = 800;
const CONNECT_TIMEOUT_MS = 12000;
const PING_EVERY_MS = 1000;
/** With no reply for this long, the last reading no longer means anything. */
const PING_STALE_MS = 3000;
/** How much each new reading moves the shown ping, so the number doesn't flicker. */
const PING_SMOOTHING = 0.3;

interface Sample extends PlayerSnapshot {
  at: number;
}

const toV3 = (v: Vec): V3 => ({ x: v[0], y: v[1], z: v[2] });

function angleLerp(a: number, b: number, k: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
}

function randomBox(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `p:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export class NetClient {
  id = 0;
  code = '';
  match: MatchState | null = null;
  readonly players = new Map<number, PlayerInfo>();

  private host: HostSession | null = null;
  private link: Link | null = null;
  /** Bumped on every new attempt, so a slow old join can tell it was cancelled. */
  private attempt = 0;
  private readonly samples = new Map<number, Sample[]>();
  private readonly dummies = new Map<number, Dummy>();
  /** When each frozen player thaws, on the performance.now() clock. */
  private readonly frozenUntil = new Map<number, number>();
  private pingTimer = 0;
  private pingMs: number | null = null;
  private lastPongAt = 0;
  private lastSnapshotSeq = -1;
  private joining: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  get isHost(): boolean {
    return this.host !== null;
  }

  /** Round trip to the host in milliseconds, or null when there is no fresh reading. */
  get ping(): number | null {
    if (this.host) return 0;
    if (this.pingMs === null || performance.now() - this.lastPongAt > PING_STALE_MS) return null;
    return Math.round(this.pingMs);
  }

  listRooms(): Promise<RoomSummary[]> {
    return listRooms();
  }

  async create(name: string, maxPlayers: number, mode: GameMode = 'deathmatch', privateRoom = false): Promise<void> {
    this.close();
    const attempt = this.attempt;
    const { code, hostKey } = await createRoom(name, maxPlayers, mode, privateRoom);
    if (attempt !== this.attempt) {
      void closeRoom(code, hostKey).catch(() => undefined);
      return;
    }

    this.host = new HostSession(code, hostKey, maxPlayers, name, mode, {
      send: (m) => this.receive(m),
    });
  }

  /**
   * Joins a random open public room that already has people in it. Throws a
   * 'no-rooms' error when there is none, rather than making one.
   */
  async joinRandom(name: string): Promise<void> {
    this.close();
    const attempt = this.attempt;
    const rooms = (await listRooms()).filter((room) => !room.private && room.code && room.players < room.max);
    if (attempt !== this.attempt) return;
    if (!rooms.length) throw new SignalError('no-rooms');
    for (let i = rooms.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    }
    let last: unknown = new SignalError('no-rooms');
    for (const room of rooms.slice(0, 3)) {
      try {
        await this.join(room.code, name);
        return;
      } catch (error) {
        if (!(error instanceof SignalError) || !['full', 'not-found', 'connect'].includes(error.reason)) throw error;
        last = error;
      }
    }
    throw last;
  }

  /** Join a random open public room, or host a random mode if none is available. */
  async quickPlay(name: string): Promise<void> {
    this.close();
    let attempt = this.attempt;
    const rooms = (await listRooms()).filter((room) => !room.private && room.code && room.players < room.max);
    if (attempt !== this.attempt) return;
    // Shuffle without trusting the room board's ordering to be random.
    for (let i = rooms.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    }
    const tried: string[] = [];
    for (const room of rooms.slice(0, 3)) {
      const joining = this.join(room.code, name);
      attempt = this.attempt;
      try {
        await joining;
        return;
      } catch (error) {
        if (attempt !== this.attempt) return;
        if (!(error instanceof SignalError) || !['full', 'not-found', 'connect'].includes(error.reason)) throw error;
        tried.push(room.code);
      }
    }
    for (let i = 0; i < 3 && attempt === this.attempt; i += 1) {
      const mode = GAME_MODES[Math.floor(Math.random() * GAME_MODES.length)];
      const room = await quickRoom(name, mode, tried);
      if (attempt !== this.attempt) {
        if (room.hosted) void closeRoom(room.code, room.hostKey).catch(() => undefined);
        return;
      }
      if (room.hosted) {
        try {
          this.host = new HostSession(room.code, room.hostKey, 8, name, room.mode, { send: (m) => this.receive(m) });
        } catch (error) {
          void closeRoom(room.code, room.hostKey).catch(() => undefined);
          throw error;
        }
        return;
      }
      const joining = this.join(room.code, name);
      attempt = this.attempt;
      try {
        await joining;
        return;
      } catch (error) {
        if (attempt !== this.attempt) return;
        if (!(error instanceof SignalError) || !['full', 'not-found', 'connect'].includes(error.reason)) throw error;
        tried.push(room.code);
      }
    }
    if (attempt === this.attempt) throw new SignalError('connect');
  }

  /** True while this player only watches the room. */
  watching = false;

  async join(rawCode: string, name: string, watch = false): Promise<void> {
    this.close();
    const attempt = this.attempt;
    const code = cleanCode(rawCode);
    const box = randomBox();

    const { link, sdp } = await makeOffer();
    if (attempt !== this.attempt) {
      link.close();
      return;
    }
    try {
      await sendToHost(code, JSON.stringify({ from: box, sdp }));
      const answer = await this.waitForAnswer(box, attempt);
      await link.accept(answer);
      if (!(await link.opened(CONNECT_TIMEOUT_MS))) throw new SignalError('connect');
    } catch (error) {
      link.close();
      throw error;
    }
    if (attempt !== this.attempt) {
      link.close();
      return;
    }

    this.link = link;
    link.onMessage = (raw) => this.receive(JSON.parse(raw) as ServerMessage);
    link.onClosed = () => {
      this.link = null;
      if (this.joining) {
        const joining = this.joining;
        this.joining = null;
        joining.reject(new SignalError('connect'));
        return;
      }
      this.reset();
      this.onClosed();
    };
    const joined = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.joining = null;
        reject(new SignalError('connect'));
      }, CONNECT_TIMEOUT_MS);
      this.joining = {
        resolve: () => { window.clearTimeout(timer); resolve(); },
        reject: (error) => { window.clearTimeout(timer); reject(error); },
      };
    });
    this.send({ t: 'join', code, name, watch });
    try {
      await joined;
    } catch (error) {
      link.close();
      if (this.link === link) this.link = null;
      throw error;
    }
    if (attempt !== this.attempt) return;
    this.pingTimer = window.setInterval(
      () => this.send({ t: 'ping', at: performance.now() }),
      PING_EVERY_MS,
    );
  }

  private async waitForAnswer(box: string, attempt: number): Promise<string> {
    const started = performance.now();
    while (attempt === this.attempt && performance.now() - started < ANSWER_TIMEOUT_MS) {
      const [signal] = await poll(box);
      if (signal) return (JSON.parse(signal) as { sdp: string }).sdp;
      await wait(ANSWER_POLL_MS);
    }
    throw new SignalError('connect');
  }

  /** Leaves on purpose, so this doesn't call onClosed. */
  close(): void {
    this.attempt += 1;
    if (this.joining) {
      const joining = this.joining;
      this.joining = null;
      joining.reject(new SignalError('connect'));
    }
    this.host?.stop();
    this.host = null;
    this.link?.close();
    this.link = null;
    this.reset();
  }

  private reset(): void {
    window.clearInterval(this.pingTimer);
    this.pingMs = null;
    this.players.clear();
    this.samples.clear();
    this.dummies.clear();
    this.frozenUntil.clear();
    this.code = '';
    this.match = null;
    this.lastSnapshotSeq = -1;
  }

  send(message: ClientMessage): void {
    if (this.host) this.host.fromLocal(message);
    else this.link?.send(JSON.stringify(message), message.t === 'state' || message.t === 'ping');
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'pong': {
        const reading = performance.now() - m.at;
        this.pingMs = this.pingMs === null ? reading : this.pingMs + (reading - this.pingMs) * PING_SMOOTHING;
        this.lastPongAt = performance.now();
        return;
      }
      case 'joined':
        this.id = m.id;
        this.code = m.code;
        this.watching = m.watching === true;
        for (const p of m.players) this.players.set(p.id, p);
        this.match = m.match && isGameMode(m.match.mode) ? m.match : null;
        break;
      case 'error':
        if (this.joining) {
          const joining = this.joining;
          this.joining = null;
          joining.reject(new SignalError(m.reason));
          return;
        }
        break;
      case 'playerJoin':
        this.players.set(m.player.id, m.player);
        break;
      case 'playerLeave':
        this.players.delete(m.id);
        this.samples.delete(m.id);
        this.dummies.delete(m.id);
        break;
      case 'snapshot': {
        if (typeof m.seq === 'number') {
          if (m.seq <= this.lastSnapshotSeq) return;
          this.lastSnapshotSeq = m.seq;
        }
        const at = performance.now();
        if (m.match && isGameMode(m.match.mode)) {
          const previous = this.match;
          this.match = m.match.phase === 'finished' && previous?.phase === 'finished' && previous.round === m.match.round
            ? { ...m.match, standings: m.match.standings ?? previous.standings }
            : m.match;
        }
        for (const s of m.scores ?? []) {
          const player = this.players.get(s.id);
          if (player) player.score = s.score;
        }
        for (const s of m.players) {
          const list = this.samples.get(s.id) ?? [];
          list.push({ ...s, at });
          if (list.length > MAX_SAMPLES) list.shift();
          this.samples.set(s.id, list);
        }
        return;
      }
      case 'roundStart':
        if (this.match && (m.match.round < this.match.round ||
          (m.match.round === this.match.round && this.match.phase === 'finished'))) return;
        if (typeof m.seq === 'number') this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, m.seq);
        if (m.match && isGameMode(m.match.mode)) this.match = m.match;
        this.players.clear();
        for (const player of m.players) this.players.set(player.id, player);
        this.samples.clear();
        this.frozenUntil.clear();
        break;
      case 'roundEnd': {
        if (!m.match || !isGameMode(m.match.mode) || (this.match && m.match.round < this.match.round)) return;
        if (m.seq <= this.lastSnapshotSeq) {
          // An unreliable snapshot can arrive before the reliable final board.
          // Keep the newer readiness state while attaching the frozen standings.
          if (this.match?.phase === 'finished' && this.match.round === m.match.round) {
            this.match = { ...this.match, standings: m.match.standings };
          }
          return;
        }
        this.lastSnapshotSeq = m.seq;
        this.match = m.match;
        break;
      }
      case 'damage': {
        const target = this.players.get(m.target);
        const shooter = this.players.get(m.by);
        if (target) {
          target.hp = m.hp;
          target.deaths = m.deaths;
          if (m.ko) target.alive = false;
        }
        if (shooter) shooter.kills = m.kills;
        if (m.ko) this.samples.delete(m.target);
        break;
      }
      case 'snared':
        this.frozenUntil.set(m.target, performance.now() + TUNING.snareTime * 1000);
        break;
      case 'healed': {
        const p = this.players.get(m.target);
        if (p) p.hp = m.hp;
        break;
      }
      case 'respawn': {
        this.frozenUntil.delete(m.id);
        const p = this.players.get(m.id);
        if (p) {
          p.alive = true;
          p.hp = PLAYER_HP;
        }
        this.samples.delete(m.id);
        break;
      }
    }
    this.onMessage(m);
    if (m.t === 'joined' && this.joining) {
      const joining = this.joining;
      this.joining = null;
      joining.resolve();
    }
  }

  /** Other players, positioned for this frame, in the shape the simulation shoots at. */
  targets(now: number): Dummy[] {
    const list: Dummy[] = [];
    for (const info of this.players.values()) {
      if (info.id === this.id) continue;

      let d = this.dummies.get(info.id);
      if (!d) {
        d = { id: info.id, pos: { x: 0, y: -50, z: 0 }, hp: PLAYER_HP, snareT: 0, respawnT: 1, phase: 0, dir: 1 };
        this.dummies.set(info.id, d);
      }
      d.name = info.name;
      d.team = info.team;
      const ownTeam = this.players.get(this.id)?.team;
      d.ally = ownTeam !== undefined && ownTeam === info.team;
      d.hp = info.hp;
      d.snareT = Math.max(0, ((this.frozenUntil.get(info.id) ?? 0) - now) / 1000);

      const sample = this.interpolate(info.id, now - RENDER_DELAY_MS);
      // Dead or not yet seen: hidden, and shots pass through.
      d.respawnT = info.alive && sample ? 0 : 1;
      if (sample) {
        d.pos = toV3(sample.pos);
        d.yaw = sample.yaw;
        d.aim = viewForward(sample.yaw, sample.pitch);
        d.mode = sample.mode;
        d.motion = sample.motion;
        d.anchor = sample.anchor ? toV3(sample.anchor) : null;
      }
      list.push(d);
    }
    return list;
  }

  private interpolate(id: number, at: number): PlayerSnapshot | null {
    const list = this.samples.get(id);
    if (!list?.length) return null;

    for (let i = list.length - 1; i > 0; i -= 1) {
      const a = list[i - 1];
      const b = list[i];
      if (a.at <= at && at <= b.at) {
        const k = (at - a.at) / (b.at - a.at || 1);
        return {
          id,
          pos: [
            a.pos[0] + (b.pos[0] - a.pos[0]) * k,
            a.pos[1] + (b.pos[1] - a.pos[1]) * k,
            a.pos[2] + (b.pos[2] - a.pos[2]) * k,
          ],
          yaw: angleLerp(a.yaw, b.yaw, k),
          pitch: a.pitch + (b.pitch - a.pitch) * k,
          anchor: b.anchor,
          mode: b.mode,
          motion: b.motion,
        };
      }
    }
    return list[at < list[0].at ? 0 : list.length - 1];
  }
}
