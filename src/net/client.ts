// The game's side of the connection. Other players are drawn slightly in the past
// so their movement can be blended between server updates instead of jumping.

import { viewForward } from '../sim/aim';
import type { Dummy } from '../sim/player';
import type { V3 } from '../sim/map';
import {
  PLAYER_HP,
  type ClientMessage,
  type PlayerInfo,
  type PlayerSnapshot,
  type ServerMessage,
  type Vec,
} from './protocol';

const RENDER_DELAY_MS = 120;
const MAX_SAMPLES = 12;

interface Sample extends PlayerSnapshot {
  at: number;
}

const toV3 = (v: Vec): V3 => ({ x: v[0], y: v[1], z: v[2] });

/** The room server's address. Empty means the server that delivered this page. */
const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? '';

function serverUrl(): string {
  if (SERVER_URL) return SERVER_URL;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

function angleLerp(a: number, b: number, k: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
}

export class NetClient {
  id = 0;
  code = '';
  readonly players = new Map<number, PlayerInfo>();

  private socket: WebSocket | null = null;
  private readonly pending: ClientMessage[] = [];
  private readonly samples = new Map<number, Sample[]>();
  private readonly dummies = new Map<number, Dummy>();

  constructor(
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  /** Sends a message, opening the connection first if needed. */
  request(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send(message);
      return;
    }
    this.pending.push(message);
    if (this.socket?.readyState === WebSocket.CONNECTING) return;

    const socket = new WebSocket(serverUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      for (const m of this.pending.splice(0)) this.send(m);
    });
    socket.addEventListener('message', (e) => this.receive(JSON.parse(e.data as string) as ServerMessage));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.pending.length = 0;
      this.onClosed();
    });
  }

  /** Leaves on purpose. Unlike a dropped connection, this doesn't call onClosed. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.pending.length = 0;
    socket?.close();
    this.players.clear();
    this.samples.clear();
    this.dummies.clear();
    this.code = '';
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'joined':
        this.id = m.id;
        this.code = m.code;
        for (const p of m.players) this.players.set(p.id, p);
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
        const at = performance.now();
        for (const s of m.players) {
          const list = this.samples.get(s.id) ?? [];
          list.push({ ...s, at });
          if (list.length > MAX_SAMPLES) list.shift();
          this.samples.set(s.id, list);
        }
        return;
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
      case 'respawn': {
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
      d.hp = info.hp;

      const sample = this.interpolate(info.id, now - RENDER_DELAY_MS);
      // Dead or not yet seen: hidden, and shots pass through.
      d.respawnT = info.alive && sample ? 0 : 1;
      if (sample) {
        d.pos = toV3(sample.pos);
        d.yaw = sample.yaw;
        d.aim = viewForward(sample.yaw, sample.pitch);
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
        };
      }
    }
    return list[at < list[0].at ? 0 : list.length - 1];
  }
}
