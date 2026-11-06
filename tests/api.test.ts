import { describe, expect, it } from 'vitest';
import { memoryStore } from '../api/_memory-store';
import { handle, ROOM_TTL_SECONDS, type Store } from '../api/rooms';

function api(store: Store | null = memoryStore()) {
  const post = async (body: object) => {
    const response = await handle(
      new Request('http://x/api/rooms', { method: 'POST', body: JSON.stringify(body) }),
      store,
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const list = async () => {
    const response = await handle(new Request('http://x/api/rooms'), store);
    return ((await response.json()) as { rooms: Array<Record<string, unknown>> }).rooms;
  };
  return { post, list };
}

const box = `p:${'a'.repeat(32)}`;

describe('rooms', () => {
  it('creates a room with a 4-letter code', async () => {
    const { post } = api();
    const { body } = await post({ action: 'create', host: 'A', max: 8 });
    expect(body.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(body.hostKey).toBeTruthy();
  });

  it('lists rooms without revealing the host key', async () => {
    const { post, list } = api();
    const { body } = await post({ action: 'create', host: 'Host', max: 6 });
    expect(await list()).toEqual([{ code: body.code, host: 'Host', players: 1, max: 6 }]);
  });

  it('keeps room sizes between 2 and 16', async () => {
    const { post, list } = api();
    await post({ action: 'create', host: 'Big', max: 99 });
    await post({ action: 'create', host: 'Small', max: 0 });
    const rooms = await list();
    expect(rooms.find((r) => r.host === 'Big')?.max).toBe(16);
    expect(rooms.find((r) => r.host === 'Small')?.max).toBe(2);
  });

  it('lists rooms with space first, busiest first', async () => {
    const { post, list } = api();
    const quiet = await post({ action: 'create', host: 'Quiet', max: 8 });
    const busy = await post({ action: 'create', host: 'Busy', max: 8 });
    const full = await post({ action: 'create', host: 'Full', max: 2 });
    await post({ action: 'beat', ...busy.body, players: 3 });
    await post({ action: 'beat', ...full.body, players: 2 });
    await post({ action: 'beat', ...quiet.body, players: 1 });
    expect((await list()).map((r) => r.host)).toEqual(['Busy', 'Quiet', 'Full']);
  });

  it('drops a room when its host stops checking in', async () => {
    let time = 0;
    const { post, list } = api(memoryStore(() => time));
    const { body } = await post({ action: 'create', host: 'A', max: 8 });
    time += (ROOM_TTL_SECONDS - 1) * 1000;
    await post({ action: 'beat', ...body, players: 1 });
    time += (ROOM_TTL_SECONDS - 1) * 1000;
    expect(await list()).toHaveLength(1);
    time += 2000;
    expect(await list()).toHaveLength(0);
  });

  it('only the host can update or close a room', async () => {
    const { post, list } = api();
    const { body } = await post({ action: 'create', host: 'A', max: 8 });
    expect((await post({ action: 'beat', code: body.code, hostKey: 'wrong', players: 8 })).status).toBe(404);
    await post({ action: 'close', code: body.code, hostKey: 'wrong' });
    expect(await list()).toHaveLength(1);
    await post({ action: 'close', ...body });
    expect(await list()).toHaveLength(0);
  });

  it('cleans the host name', async () => {
    const { post, list } = api();
    await post({ action: 'create', host: ' a\u0000b ', max: 8 });
    expect((await list())[0].host).toBe('ab');
  });
});

describe('connecting two browsers', () => {
  it('passes an offer to the host and the answer back', async () => {
    const { post } = api();
    const { body: room } = await post({ action: 'create', host: 'A', max: 8 });

    await post({ action: 'send', to: `h:${room.code}`, data: 'offer' });
    const offers = await post({ action: 'poll', box: `h:${room.code}`, hostKey: room.hostKey });
    expect(offers.body.signals).toEqual(['offer']);

    await post({ action: 'send', to: box, data: 'answer', ...room });
    expect((await post({ action: 'poll', box })).body.signals).toEqual(['answer']);
    expect((await post({ action: 'poll', box })).body.signals).toEqual([]);
  });

  it('reports a wrong room code', async () => {
    const { post } = api();
    const result = await post({ action: 'send', to: 'h:ZZZZ', data: 'offer' });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('not-found');
  });

  it("does not let strangers read a host's offers", async () => {
    const { post } = api();
    const { body: room } = await post({ action: 'create', host: 'A', max: 8 });
    const result = await post({ action: 'poll', box: `h:${room.code}`, hostKey: 'wrong' });
    expect(result.status).toBe(404);
  });

  it("only a host can write to a player's box", async () => {
    const { post } = api();
    expect((await post({ action: 'send', to: box, data: 'x' })).status).toBe(400);
  });

  it.each([
    { action: 'send', to: 'room:1', data: 'x' },
    { action: 'send', to: 'h:ZZZZ' },
    { action: 'poll', box: 'anything' },
    { action: 'nope' },
  ])('rejects %j', async (body) => {
    expect((await api().post(body)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('bad requests', () => {
  it('rejects a body that is not JSON', async () => {
    const response = await handle(
      new Request('http://x/api/rooms', { method: 'POST', body: 'not json' }),
      memoryStore(),
    );
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const { post } = api();
    expect((await post({ action: 'send', to: 'h:AAAA', data: 'x'.repeat(20000) })).status).toBe(413);
  });

  it('says so when no database is connected', async () => {
    const result = await api(null).post({ action: 'create', host: 'A', max: 8 });
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('no-store');
  });
});
