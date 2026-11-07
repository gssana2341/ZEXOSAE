// The only server code in the game. It lists open rooms and passes connection
// offers between browsers. Game traffic never comes here: players connect to the
// host's browser directly. Vercel doesn't keep memory between requests, so this
// state lives in Redis.

import type { GameMode } from '../src/sim/game-modes';

// Keep the function self-contained at runtime. Vercel executes the emitted Node
// module directly, so an extensionless import of a TypeScript source can fail.
// The type check still requires this list to match the game's modes.
const ROOM_MODES = { deathmatch: true, teams: true, control: true, crown: true } satisfies Record<GameMode, true>;
function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && Object.hasOwn(ROOM_MODES, value);
}

export interface RoomRecord {
  code: string;
  host: string;
  players: number;
  max: number;
  hostKey: string;
  mode: GameMode;
  private: boolean;
}

export interface Store {
  /** Saves a new room. Returns false if the code is taken. */
  claimRoom(room: RoomRecord): Promise<boolean>;
  putRoom(room: RoomRecord): Promise<void>;
  getRoom(code: string): Promise<RoomRecord | null>;
  removeRoom(code: string): Promise<void>;
  listRooms(): Promise<RoomRecord[]>;
  pushSignal(box: string, data: string): Promise<void>;
  takeSignals(box: string): Promise<string[]>;
}

/** A room disappears this long after its host stops checking in. */
export const ROOM_TTL_SECONDS = 25;
const SIGNAL_TTL_SECONDS = 60;
const MAX_SIGNALS_PER_POLL = 20;
const MAX_LISTED_ROOMS = 40;
const MAX_BODY_CHARS = 16000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Shared, atomically claimed slots prevent simultaneous quick-play requests from
// each creating an empty room. They remain ordinary rooms after creation.
const QUICK_CODES = Array.from({ length: 64 }, (_, i) => `QA${CODE_ALPHABET[Math.floor(i / CODE_ALPHABET.length)]}${CODE_ALPHABET[i % CODE_ALPHABET.length]}`);
const CODE_PATTERN = /^[A-Z2-9]{4}$/;
const HOST_BOX = /^h:[A-Z2-9]{4}$/;
const PEER_BOX = /^p:[a-f0-9]{32}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const fail = (error: string, status: number) => json({ error }, status);

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\p{C}]/gu, '').trim().slice(0, 16) : '';
  return name || 'ผู้เล่น';
}

const clampSize = (raw: unknown, low: number, high: number, fallback: number) => {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(low, Math.min(high, n));
};

async function ownedRoom(store: Store, code: unknown, hostKey: unknown): Promise<RoomRecord | null> {
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
  const room = await store.getRoom(code);
  return room && room.hostKey === hostKey ? room : null;
}

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * Relay (TURN) servers, for players whose network won't let two browsers connect
 * directly: the same Wi-Fi, some mobile networks, offices. Cloudflare's are made
 * fresh here, so the key never reaches a browser. Without either setting, the game
 * still connects directly where it can.
 */
async function relayServers(): Promise<IceServer[]> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (keyId && token) {
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (response.ok) {
        const body = (await response.json()) as { iceServers?: IceServer[] | IceServer };
        const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
        return list.map(withoutPort53).filter((s) => [s.urls].flat().length > 0);
      }
    } catch {
      // Fall through to the fixed servers, if any.
    }
  }
  const urls = process.env.TURN_URLS?.split(',').map((u) => u.trim()).filter(Boolean);
  if (urls?.length) {
    return [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
  }
  return [];
}

/** Browsers block port 53, and waiting on it only slows the connection down. */
function withoutPort53(server: IceServer): IceServer {
  return { ...server, urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)) };
}

export async function handle(request: Request, store: Store | null): Promise<Response> {
  if (!store) return fail('no-store', 503);

  if (request.method === 'GET') {
    const rooms = await store.listRooms();
    const open = (r: RoomRecord) => (r.players < r.max ? 1 : 0);
    return json({
      rooms: rooms
        .filter((r) => !r.mode || isGameMode(r.mode))
        .sort((a, b) => open(b) - open(a) || b.players - a.players)
        .slice(0, MAX_LISTED_ROOMS)
        // A private room shows on the board, but never its code: that comes from the host.
        .map(({ code, host, players, max, mode, private: hidden }) => ({
          code: hidden ? '' : code,
          host,
          players,
          max,
          mode: isGameMode(mode) ? mode : 'deathmatch',
          private: hidden === true,
        })),
    });
  }
  if (request.method !== 'POST') return fail('method', 405);

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return fail('too-large', 413);

  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail('bad-request', 400);
  }

  switch (m.action) {
    case 'ice':
      return json({ iceServers: await relayServers() });

    case 'create': {
      const hostKey = crypto.randomUUID();
      const max = clampSize(m.max, 2, 16, 8);
      if (m.mode !== undefined && !isGameMode(m.mode)) return fail('bad-request', 400);
      const mode = isGameMode(m.mode) ? m.mode : 'deathmatch';
      for (let tries = 0; tries < 8; tries += 1) {
        const room = { code: newCode(), host: cleanName(m.host), players: 1, max, hostKey, mode, private: m.private === true };
        if (await store.claimRoom(room)) return json({ code: room.code, hostKey });
      }
      return fail('busy', 503);
    }

    case 'quick-create': {
      if (!isGameMode(m.mode)) return fail('bad-request', 400);
      const avoid = Array.isArray(m.avoid) ? m.avoid.filter((code): code is string => typeof code === 'string' && CODE_PATTERN.test(code)).slice(0, 10) : [];
      for (const code of QUICK_CODES) {
        if (avoid.includes(code)) continue;
        const existing = await store.getRoom(code);
        if (existing) {
          if (!existing.private && (!existing.mode || isGameMode(existing.mode)) && existing.players < existing.max) return json({ code, hosted: false });
          continue;
        }
        const hostKey = crypto.randomUUID();
        const room: RoomRecord = { code, host: cleanName(m.host), players: 1, max: 8, hostKey, mode: m.mode, private: false };
        if (await store.claimRoom(room)) return json({ code, hostKey, mode: room.mode, hosted: true });
        // Another request won the same slot between our read and claim.
        const winner = await store.getRoom(code);
        if (winner && !winner.private && (!winner.mode || isGameMode(winner.mode)) && winner.players < winner.max) return json({ code, hosted: false });
      }
      return fail('busy', 503);
    }

    case 'beat': {
      const room = await ownedRoom(store, m.code, m.hostKey);
      if (!room) return fail('not-found', 404);
      await store.putRoom({ ...room, players: clampSize(m.players, 0, room.max, room.players) });
      return json({ ok: true });
    }

    case 'close': {
      if (await ownedRoom(store, m.code, m.hostKey)) await store.removeRoom(m.code as string);
      return json({ ok: true });
    }

    case 'send': {
      const { to, data } = m;
      if (typeof to !== 'string' || typeof data !== 'string') return fail('bad-request', 400);

      if (HOST_BOX.test(to)) {
        if (!(await store.getRoom(to.slice(2)))) return fail('not-found', 404);
      } else if (!PEER_BOX.test(to) || !(await ownedRoom(store, m.code, m.hostKey))) {
        // Only a room's host may write to a player's box.
        return fail('bad-request', 400);
      }
      await store.pushSignal(to, data);
      return json({ ok: true });
    }

    case 'poll': {
      const { box } = m;
      if (typeof box !== 'string') return fail('bad-request', 400);
      if (HOST_BOX.test(box)) {
        if (!(await ownedRoom(store, box.slice(2), m.hostKey))) return fail('not-found', 404);
      } else if (!PEER_BOX.test(box)) {
        return fail('bad-request', 400);
      }
      return json({ signals: await store.takeSignals(box) });
    }

    default:
      return fail('bad-request', 400);
  }
}

// ------------------------------------------------------------------ Redis

const ROOM_INDEX = 'zx:rooms';
const roomKey = (code: string) => `zx:room:${code}`;
const signalKey = (box: string) => `zx:signal:${box}`;

/** Talks to Upstash Redis over its REST API, which suits short-lived functions. */
export function redisStore(url: string, token: string): Store {
  async function run<T>(...commands: Array<Array<string | number>>): Promise<T[]> {
    const response = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!response.ok) throw new Error(`Redis responded ${response.status}`);
    const results = (await response.json()) as Array<{ result: T; error?: string }>;
    return results.map((r) => {
      if (r.error) throw new Error(r.error);
      return r.result;
    });
  }

  const expiry = () => Date.now() + ROOM_TTL_SECONDS * 1000;

  return {
    async claimRoom(room) {
      const [claimed] = await run<string | null>([
        'SET', roomKey(room.code), JSON.stringify(room), 'NX', 'EX', ROOM_TTL_SECONDS,
      ]);
      if (claimed !== 'OK') return false;
      await run(['ZADD', ROOM_INDEX, expiry(), room.code]);
      return true;
    },
    async putRoom(room) {
      await run(
        ['SET', roomKey(room.code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS],
        ['ZADD', ROOM_INDEX, expiry(), room.code],
      );
    },
    async getRoom(code) {
      const [value] = await run<string | null>(['GET', roomKey(code)]);
      return value ? (JSON.parse(value) as RoomRecord) : null;
    },
    async removeRoom(code) {
      await run(['DEL', roomKey(code)], ['ZREM', ROOM_INDEX, code]);
    },
    async listRooms() {
      const [, codes] = await run<unknown>(
        ['ZREMRANGEBYSCORE', ROOM_INDEX, '-inf', Date.now()],
        ['ZRANGE', ROOM_INDEX, 0, MAX_LISTED_ROOMS - 1],
      );
      const list = codes as string[];
      if (!list.length) return [];
      const [values] = await run<Array<string | null>>(['MGET', ...list.map(roomKey)]);
      return values.flatMap((v) => (v ? [JSON.parse(v) as RoomRecord] : []));
    },
    async pushSignal(box, data) {
      await run(['RPUSH', signalKey(box), data], ['EXPIRE', signalKey(box), SIGNAL_TTL_SECONDS]);
    },
    async takeSignals(box) {
      const [values] = await run<string[] | null>(['LPOP', signalKey(box), MAX_SIGNALS_PER_POLL]);
      return values ?? [];
    },
  };
}

function storeFromEnv(): Store | null {
  // Vercel's Redis integrations use one of these two sets of names.
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? redisStore(url, token) : null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request, storeFromEnv());
    } catch (error) {
      console.error(error);
      return fail('store-failed', 503);
    }
  },
};
