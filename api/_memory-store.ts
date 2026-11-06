// Stands in for Redis during local development and tests. The leading underscore
// keeps Vercel from deploying this file as a function.

import { ROOM_TTL_SECONDS, type RoomRecord, type Store } from './rooms';

export function memoryStore(now: () => number = Date.now): Store {
  const rooms = new Map<string, { room: RoomRecord; expires: number }>();
  const boxes = new Map<string, string[]>();

  const live = (code: string) => {
    const entry = rooms.get(code);
    if (entry && entry.expires <= now()) {
      rooms.delete(code);
      return null;
    }
    return entry?.room ?? null;
  };
  const put = (room: RoomRecord) =>
    rooms.set(room.code, { room, expires: now() + ROOM_TTL_SECONDS * 1000 });

  return {
    async claimRoom(room) {
      if (live(room.code)) return false;
      put(room);
      return true;
    },
    async putRoom(room) {
      put(room);
    },
    async getRoom(code) {
      return live(code);
    },
    async removeRoom(code) {
      rooms.delete(code);
    },
    async listRooms() {
      return [...rooms.keys()].flatMap((code) => live(code) ?? []);
    },
    async pushSignal(box, data) {
      boxes.set(box, [...(boxes.get(box) ?? []), data]);
    },
    async takeSignals(box) {
      const signals = boxes.get(box) ?? [];
      boxes.delete(box);
      return signals;
    },
  };
}
