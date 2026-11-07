// Messages shared by the game and the server. No DOM and no Node APIs in here.

import { ACTS, HIT_KINDS, MAX_HP, type HitKind } from '../sim/hits';
import type { Mode } from '../sim/player';
import type { GameMode, Team } from '../sim/game-modes';

export const MAX_ROOM_SIZE = 16;
export const DEFAULT_ROOM_SIZE = 8;
export const ROOM_SIZES = [2, 4, 6, 8, 10, 12, 14, 16];
/** Each hit takes what its kind deals, from sim/hits.ts. */
export const PLAYER_HP = MAX_HP;
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECT_MS = 1500;
export const SNAPSHOT_HZ = 20;
export const STATE_HZ = 20;

const MOTION_MODES: readonly Mode[] = [
  'ground',
  'air',
  'wall',
  'swing',
  'dash',
  'zip',
  'hang',
  'strike',
  'pound',
];
const POSE_MODES = [
  ...MOTION_MODES,
  'slide',
  'stun',
  ...ACTS,
] as const;
export type PoseMode = (typeof POSE_MODES)[number];
const isPoseMode = (v: unknown): v is PoseMode => POSE_MODES.includes(v as PoseMode);
const isMotionMode = (v: unknown): v is Mode => MOTION_MODES.includes(v as Mode);

export const CODE_LENGTH = 4;

export type Vec = [number, number, number];

export interface PlayerInfo {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  hp: number;
  alive: boolean;
  team?: Team;
  score?: number;
}

/** A frozen result from the completed round, including players who later leave. */
export interface FinalStanding {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  score: number;
  team?: Team;
  /** Tied players share a rank; crown mode ranks only the final holder. */
  rank: number | null;
}

export interface MatchState {
  mode: GameMode;
  phase: 'waiting' | 'playing' | 'finished';
  /** Identifies this round so a delayed rematch request cannot affect a later one. */
  round: number;
  remaining: number;
  teamScores: Record<Team, number>;
  holder: number | null;
  /** Crown position in the world, whether loose or above its holder. */
  crown: Vec | null;
  result: string;
  /** Present on the reliable round-end event and for players joining afterward. */
  standings?: FinalStanding[];
  /** Current players who have chosen to play another round. */
  ready: number[];
}

export interface PlayerSnapshot {
  id: number;
  pos: Vec;
  yaw: number;
  pitch: number;
  anchor: Vec | null;
  mode?: PoseMode;
  motion?: Mode;
}

export interface RoomSummary {
  /** Empty for a private room: its code only comes from the host. */
  code: string;
  host: string;
  players: number;
  max: number;
  mode: GameMode;
  private?: boolean;
}

export type ClientMessage =
  | { t: 'join'; code: string; name: string; watch?: boolean }
  | { t: 'state'; pos: Vec; yaw: number; pitch: number; anchor: Vec | null; mode?: PoseMode; motion?: Mode; safe?: boolean }
  | { t: 'shot'; origin: Vec; dir: Vec; snare: boolean; crate?: boolean }
  | { t: 'hit'; target: number; snare: boolean; kind?: HitKind; knock?: Vec; stun?: number; pin?: boolean; power?: number }
  | { t: 'heal' }
  | { t: 'rematch'; round: number; ready: boolean }
  | { t: 'ping'; at: number };


export type ServerMessage =
  | { t: 'joined'; code: string; id: number; players: PlayerInfo[]; pos: Vec; yaw: number; match: MatchState; watching?: boolean }
  | { t: 'error'; reason: 'full' }
  | { t: 'pong'; at: number }
  | { t: 'playerJoin'; player: PlayerInfo }
  | { t: 'playerLeave'; id: number }
  | { t: 'snapshot'; seq: number; players: PlayerSnapshot[]; match: MatchState; scores: Array<{ id: number; score: number }> }
  | { t: 'roundStart'; seq: number; match: MatchState; players: PlayerInfo[]; spawns: Array<{ id: number; pos: Vec; yaw: number }> }
  | { t: 'roundEnd'; seq: number; match: MatchState }
  | { t: 'shot'; id: number; origin: Vec; dir: Vec; snare: boolean; crate?: boolean }
  | { t: 'damage'; target: number; by: number; hp: number; ko: boolean; kills: number; deaths: number }
  | { t: 'snared'; target: number; by: number }
  | { t: 'knock'; target: number; by: number; vel: Vec; stun: number; pin: boolean }
  | { t: 'healed'; target: number; hp: number }
  | { t: 'respawn'; id: number; pos: Vec; yaw: number };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec => Array.isArray(v) && v.length === 3 && v.every(isNumber);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isHitKind = (v: unknown): v is HitKind => HIT_KINDS.includes(v as HitKind);

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
        ? { t: 'join', code: m.code, name: m.name, watch: m.watch === true }
        : null;
    case 'state':
      return isVec(m.pos) && isNumber(m.yaw) && isNumber(m.pitch) && (m.anchor === null || isVec(m.anchor))
        ? {
            t: 'state',
            pos: m.pos,
            yaw: m.yaw,
            pitch: m.pitch,
            anchor: m.anchor,
            mode: isPoseMode(m.mode) ? m.mode : undefined,
            motion: isMotionMode(m.motion) ? m.motion : undefined,
            safe: m.safe === true,
          }
        : null;
    case 'shot':
      return isVec(m.origin) && isVec(m.dir) && typeof m.snare === 'boolean'
        ? { t: 'shot', origin: m.origin, dir: m.dir, snare: m.snare, crate: m.crate === true }
        : null;
    case 'hit':
      return isNumber(m.target) && typeof m.snare === 'boolean'
        ? {
            t: 'hit',
            target: m.target,
            snare: m.snare,
            kind: isHitKind(m.kind) ? m.kind : undefined,
            knock: isVec(m.knock) ? m.knock : undefined,
            stun: isNumber(m.stun) ? m.stun : undefined,
            pin: m.pin === true,
            power: isNumber(m.power) ? m.power : undefined,
          }
        : null;
    case 'heal':
      return { t: 'heal' };
    case 'rematch':
      return Number.isSafeInteger(m.round) && (m.round as number) > 0 && typeof m.ready === 'boolean'
        ? { t: 'rematch', round: m.round as number, ready: m.ready }
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
