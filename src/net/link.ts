// A direct browser-to-browser connection. Each link has two channels: a reliable
// one for events that must arrive, and a fast one for position updates, where a
// lost packet doesn't matter because the next update replaces it.

import { relayServers } from './signal';

const GATHER_TIMEOUT_MS = 2500;
/** Position updates are dropped past this backlog rather than queued up late. */
const MAX_FAST_BACKLOG = 64 * 1024;

const STUN: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
/** Relay logins last a day. Asking again every half hour keeps them well inside that. */
const RELAY_REFRESH_MS = 30 * 60 * 1000;
let relays: { at: number; servers: RTCIceServer[] } | null = null;

/**
 * Direct connections first, then relays from the room API. On the same Wi-Fi, most
 * routers won't pass a connection back in to a device behind them, and some networks
 * keep devices apart entirely, so only a relay gets two players there talking.
 */
async function iceServers(): Promise<RTCIceServer[]> {
  const custom: string | undefined = import.meta.env.VITE_ICE_SERVERS;
  if (custom) {
    try {
      return JSON.parse(custom) as RTCIceServer[];
    } catch {
      console.error('VITE_ICE_SERVERS is not valid JSON');
    }
  }
  if (!relays || performance.now() - relays.at > RELAY_REFRESH_MS) {
    try {
      relays = { at: performance.now(), servers: await relayServers() };
    } catch {
      relays = { at: performance.now(), servers: [] };
    }
  }
  return [...STUN, ...relays.servers];
}

/** Waits for connection candidates, so the offer can be sent once rather than trickled. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(timer);
        resolve();
      }
    });
  });
}

export class Link {
  onMessage: (raw: string) => void = () => undefined;
  onClosed: () => void = () => undefined;

  private reliable: RTCDataChannel | null = null;
  private fast: RTCDataChannel | null = null;
  private closed = false;

  constructor(private readonly pc: RTCPeerConnection) {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.finish();
    });
    pc.addEventListener('datachannel', (e) => this.attach(e.channel));
  }

  attach(channel: RTCDataChannel): void {
    if (channel.label === 'fast') this.fast = channel;
    else this.reliable = channel;

    channel.addEventListener('message', (e) => this.onMessage(e.data as string));
    channel.addEventListener('close', () => this.finish());
  }

  async accept(answer: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answer });
  }

  /** Resolves once the reliable channel can carry messages. */
  opened(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        if (this.reliable?.readyState === 'open') resolve(true);
        else if (this.closed || performance.now() - started > timeoutMs) resolve(false);
        else window.setTimeout(check, 100);
      };
      check();
    });
  }

  send(raw: string, fast: boolean): void {
    const useFast = fast && this.fast?.readyState === 'open';
    const channel = useFast ? this.fast : this.reliable;
    if (channel?.readyState !== 'open') return;
    if (useFast && channel.bufferedAmount > MAX_FAST_BACKLOG) return;
    channel.send(raw);
  }

  close(): void {
    this.onClosed = () => undefined;
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.close();
    this.onClosed();
  }
}

/** The joining player's side. */
export async function makeOffer(): Promise<{ link: Link; sdp: string }> {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const link = new Link(pc);
  link.attach(pc.createDataChannel('game'));
  link.attach(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));

  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { link, sdp: pc.localDescription!.sdp };
}

/** The host's side. */
export async function makeAnswer(offer: string): Promise<{ link: Link; sdp: string }> {
  const pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const link = new Link(pc);

  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { link, sdp: pc.localDescription!.sdp };
}
