import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRooms } from '../src/net/signal';

describe('room service errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a crashed server separately from a missing Redis configuration', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('server error', { status: 500 })));
    await expect(listRooms()).rejects.toMatchObject({ reason: 'unavailable' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: 'no-store' }, { status: 503 })));
    await expect(listRooms()).rejects.toMatchObject({ reason: 'no-store' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: 'store-failed' }, { status: 503 })));
    await expect(listRooms()).rejects.toMatchObject({ reason: 'unavailable' });
  });
});
