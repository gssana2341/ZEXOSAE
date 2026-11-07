// The room server, running in the browser of the player who made the room.
// When this player leaves, the room ends.

import { makeAnswer, type Link } from './link';
import { parseClientMessage, SNAPSHOT_HZ, type ClientMessage, type ServerMessage } from './protocol';
import { Room, type Client } from './room';
import type { GameMode } from '../sim/game-modes';
import { beat, closeRoom, closeRoomNow, poll, sendToPeer } from './signal';

const POLL_MS = 2500;
const BEAT_MS = 10000;

export class HostSession {
  private readonly room: Room;
  private readonly links = new Set<Link>();
  private readonly hostId: number;
  private readonly timers: number[];
  private stopped = false;

  private readonly closeOnExit = () => closeRoomNow(this.code, this.hostKey);

  constructor(
    readonly code: string,
    private readonly hostKey: string,
    maxPlayers: number,
    name: string,
    mode: GameMode,
    local: Client,
  ) {
    this.room = new Room(code, Date.now, maxPlayers, Math.random, mode);
    this.hostId = this.room.add(local, name)!;

    this.timers = [
      window.setInterval(() => this.room.tick(), 1000 / SNAPSHOT_HZ),
      window.setInterval(() => void this.pollOffers(), POLL_MS),
      window.setInterval(() => this.beat(), BEAT_MS),
    ];
    window.addEventListener('pagehide', this.closeOnExit);
  }

  /** A message from the host's own game. */
  fromLocal(message: ClientMessage): void {
    this.room.handle(this.hostId, message);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach((t) => window.clearInterval(t));
    window.removeEventListener('pagehide', this.closeOnExit);
    this.links.forEach((link) => link.close());
    closeRoom(this.code, this.hostKey).catch(() => undefined);
  }

  private beat(): void {
    beat(this.code, this.hostKey, this.room.size).catch(() => undefined);
  }

  private async pollOffers(): Promise<void> {
    let signals: string[];
    try {
      signals = await poll(`h:${this.code}`, this.hostKey);
    } catch {
      return;
    }
    for (const raw of signals) {
      try {
        const { from, sdp } = JSON.parse(raw) as { from: string; sdp: string };
        await this.accept(from, sdp);
      } catch {
        // One bad offer shouldn't stop the others from being answered.
      }
    }
  }

  private async accept(box: string, offer: string): Promise<void> {
    const { link, sdp } = await makeAnswer(offer);
    if (this.stopped) {
      link.close();
      return;
    }
    this.links.add(link);

    let playerId: number | null = null;
    const client: Client = {
      send: (m: ServerMessage) => link.send(JSON.stringify(m), m.t === 'snapshot' || m.t === 'pong'),
    };

    link.onMessage = (raw) => {
      const message = parseClientMessage(raw);
      if (!message) return;

      if (message.t !== 'join') {
        if (playerId !== null) this.room.handle(playerId, message);
        return;
      }
      if (playerId !== null) return;
      playerId = message.watch ? this.room.watch(client) : this.room.add(client, message.name);
      if (playerId === null) client.send({ t: 'error', reason: 'full' });
      else this.beat();
    };

    link.onClosed = () => {
      this.links.delete(link);
      if (playerId !== null) this.room.remove(playerId);
      this.beat();
    };

    await sendToPeer(box, JSON.stringify({ sdp }), this.code, this.hostKey);
  }
}
