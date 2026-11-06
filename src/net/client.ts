// The game's side of a room, whether this player hosts it or joined it. Other
// players are drawn slightly in the past, so their movement can be blended between
// updates instead of jumping.

import { viewForward } from '../sim/aim';
import type { V3 } from '../sim/map';
import type { Dummy } from '../sim/player';
import { HostSession } from './host';
import { makeOffer, type Link } from './link';
import {
  cleanCode,
  PLAYER_HP,
  type ClientMessage,
  type PlayerInfo,
  type PlayerSnapshot,
  type RoomSummary,
  type ServerMessage,
  type Vec,
} from './protocol';
import { createRoom, listRooms, poll, sendToHost, SignalError } from './signal';

const RENDER_DELAY_MS = 120;
const MAX_SAMPLES = 12;
/** The host checks for new players every few seconds, so answers take a moment. */
const ANSWER_TIMEOUT_MS = 12000;
const ANSWER_POLL_MS = 800;
const CONNECT_TIMEOUT_MS = 12000;

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
  readonly players = new Map<number, PlayerInfo>();

  private host: HostSession | null = null;
  private link: Link | null = null;
  /** Bumped on every new attempt, so a slow old join can tell it was cancelled. */
  private attempt = 0;
  private readonly samples = new Map<number, Sample[]>();
  private readonly dummies = new Map<number, Dummy>();

  constructor(
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  listRooms(): Promise<RoomSummary[]> {
    return listRooms();
  }

  async create(name: string, maxPlayers: number): Promise<void> {
    this.close();
    const attempt = this.attempt;
    const { code, hostKey } = await createRoom(name, maxPlayers);
    if (attempt !== this.attempt) return;

    this.host = new HostSession(code, hostKey, maxPlayers, name, {
      send: (m) => this.receive(m),
    });
  }

  async join(rawCode: string, name: string): Promise<void> {
    this.close();
    const attempt = this.attempt;
    const code = cleanCode(rawCode);
    const box = randomBox();

    const { link, sdp } = await makeOffer();
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
      this.reset();
      this.onClosed();
    };
    this.send({ t: 'join', code, name });
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
    this.host?.stop();
    this.host = null;
    this.link?.close();
    this.link = null;
    this.reset();
  }

  private reset(): void {
    this.players.clear();
    this.samples.clear();
    this.dummies.clear();
    this.code = '';
  }

  send(message: ClientMessage): void {
    if (this.host) this.host.fromLocal(message);
    else this.link?.send(JSON.stringify(message), message.t === 'state');
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
