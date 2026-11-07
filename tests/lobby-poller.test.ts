import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LobbyPoller } from '../src/net/lobby-poller';

describe('room list refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops after a failure and starts refreshing again when retried', async () => {
    const load = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(['open']);
    const result = vi.fn();
    const error = vi.fn();
    const poller = new LobbyPoller(load, result, error, 5000);
    poller.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledOnce();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toHaveBeenCalledWith(['open']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('never overlaps refreshes and ignores replies after the board closes', async () => {
    let finish!: (value: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    const result = vi.fn();
    const poller = new LobbyPoller(load, result, vi.fn(), 5000);
    poller.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(load).toHaveBeenCalledTimes(1);
    poller.stop();
    finish(['stale']);
    await vi.advanceTimersByTimeAsync(10000);
    expect(result).not.toHaveBeenCalled();
  });
});
