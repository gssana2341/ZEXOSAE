// Messages shared by the game and the server. No DOM and no Node APIs in here.

export const MAX_ROOM_SIZE = 16;
export const DEFAULT_ROOM_SIZE = 8;
export const ROOM_SIZES = [2, 4, 6, 8, 10, 12, 14, 16];
/** Each hit takes 1. Raise this if players should survive a hit. */
export const PLAYER_HP = 1;
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECT_MS = 1500;
export const SNAPSHOT_HZ = 20;
export const STATE_HZ = 20;

export const CODE_LENGTH = 4;

export type Vec = [number, number, number];

export interface PlayerInfo {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  hp: number;
  alive: boolean;
}

export interface PlayerSnapshot {
  id: number;
  pos: Vec;
  yaw: number;
  pitch: number;
  anchor: Vec | null;
}

export interface RoomSummary {
  code: string;
  host: string;
  players: number;
  max: number;
}

export type ClientMessage =
  | { t: 'join'; code: string; name: string }
  | { t: 'state'; pos: Vec; yaw: number; pitch: number; anchor: Vec | null }
  | { t: 'shot'; origin: Vec; dir: Vec; snare: boolean }
  | { t: 'hit'; target: number; snare: boolean }
  | { t: 'ping'; at: number };


export type ServerMessage =
  | { t: 'joined'; code: string; id: number; players: PlayerInfo[]; pos: Vec; yaw: number }
  | { t: 'error'; reason: 'full' }
  | { t: 'pong'; at: number }
  | { t: 'playerJoin'; player: PlayerInfo }
  | { t: 'playerLeave'; id: number }
  | { t: 'snapshot'; players: PlayerSnapshot[] }
  | { t: 'shot'; id: number; origin: Vec; dir: Vec; snare: boolean }
  | { t: 'damage'; target: number; by: number; hp: number; ko: boolean; kills: number; deaths: number }
  | { t: 'snared'; target: number; by: number }
  | { t: 'respawn'; id: number; pos: Vec; yaw: number };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Anything from the network is untrusted, so each message is checked field by field. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;

  switch (m.t) {
    case 'join':
      return isText(m.code, 16) && isText(m.name, 64)
        ? { t: 'join', code: m.code, name: m.name }
        : null;
    case 'state':
      return isVec(m.pos) && isNumber(m.yaw) && isNumber(m.pitch) && (m.anchor === null || isVec(m.anchor))
        ? { t: 'state', pos: m.pos, yaw: m.yaw, pitch: m.pitch, anchor: m.anchor }
        : null;
    case 'shot':
      return isVec(m.origin) && isVec(m.dir) && typeof m.snare === 'boolean'
        ? { t: 'shot', origin: m.origin, dir: m.dir, snare: m.snare }
        : null;
    case 'hit':
      return isNumber(m.target) && typeof m.snare === 'boolean'
        ? { t: 'hit', target: m.target, snare: m.snare }
        : null;
    case 'ping':
      return isNumber(m.at) ? { t: 'ping', at: m.at } : null;
    default:
      return null;
  }
}

export function cleanName(raw: string): string {
  // Strips control characters so a name can't break the scoreboard.
  const name = raw.replace(/[\p{C}]/gu, '').trim().slice(0, 16);
  return name || 'ผู้เล่น';
}

export const cleanCode = (raw: string): string => raw.trim().toUpperCase();
