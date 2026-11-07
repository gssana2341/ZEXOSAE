// Calls to the room API. Used only to find rooms and start a connection.

import type { RoomSummary } from './protocol';
import type { GameMode } from '../sim/game-modes';

const API = '/api/rooms';

export type NetError = 'not-found' | 'full' | 'busy' | 'no-store' | 'unavailable' | 'connect' | 'network';

export class SignalError extends Error {
  constructor(readonly reason: NetError) {
    super(reason);
  }
}

async function call<T>(init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API, init);
  } catch {
    throw new SignalError('network');
  }

  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (response.ok && body) return body;

  const error = body?.error;
  if (error === 'not-found' || error === 'busy' || error === 'no-store') throw new SignalError(error);
  throw new SignalError(response.status >= 500 ? 'unavailable' : 'network');
}

const post = <T>(body: object) =>
  call<T>({ method: 'POST', body: JSON.stringify(body) });

export async function listRooms(): Promise<RoomSummary[]> {
  return (await call<{ rooms: RoomSummary[] }>()).rooms;
}

export const createRoom = (host: string, max: number, mode: GameMode, privateRoom: boolean) =>
  post<{ code: string; hostKey: string }>({ action: 'create', host, max, mode, private: privateRoom });

export const quickRoom = (host: string, mode: GameMode, avoid: string[]) =>
  post<{ code: string; hosted: true; hostKey: string; mode: GameMode } | { code: string; hosted: false }>({ action: 'quick-create', host, mode, avoid });

export const beat = (code: string, hostKey: string, players: number) =>
  post({ action: 'beat', code, hostKey, players });

/** For when the page is closing: a normal request could be cut off. */
export function closeRoomNow(code: string, hostKey: string): void {
  navigator.sendBeacon(API, JSON.stringify({ action: 'close', code, hostKey }));
}

export const closeRoom = (code: string, hostKey: string) =>
  post({ action: 'close', code, hostKey });

export const sendToHost = (code: string, data: string) =>
  post({ action: 'send', to: `h:${code}`, data });

export const sendToPeer = (box: string, data: string, code: string, hostKey: string) =>
  post({ action: 'send', to: box, data, code, hostKey });

export async function poll(box: string, hostKey?: string): Promise<string[]> {
  return (await post<{ signals: string[] }>({ action: 'poll', box, hostKey })).signals;
}
