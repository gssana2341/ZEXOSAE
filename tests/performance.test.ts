import { describe, expect, it } from 'vitest';
import { FrameLimiter, pixelRatioFor, QUALITY } from '../src/render/performance';

describe('rendering budget', () => {
  it('keeps rendered pixels within the selected quality budget', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const ratio = pixelRatioFor(quality, 2, 3840, 2160);
      expect(3840 * 2160 * ratio * ratio).toBeLessThanOrEqual(QUALITY[quality].maxPixels + 1);
    }
    expect(pixelRatioFor('high', 1, 1280, 720)).toBe(1);
    expect(pixelRatioFor('medium', 2, 1920, 1080)).toBe(1);
  });

  it.each([60, 120, 144, 240])('draws about 60 times per second on a %i Hz display', (refresh) => {
    const limiter = new FrameLimiter();
    const drawn: number[] = [];
    for (let i = 0; i < refresh * 5; i += 1) {
      const dt = limiter.advance(1 / refresh);
      if (dt !== null) drawn.push(dt);
    }
    expect(drawn.length).toBeGreaterThanOrEqual(299);
    expect(drawn.length).toBeLessThanOrEqual(301);
    expect(drawn.reduce((sum, dt) => sum + dt, 0)).toBeCloseTo(5, 1);
  });

  it('draws each available frame when the display or device is slower than the target', () => {
    const limiter = new FrameLimiter();
    for (let i = 0; i < 30; i += 1) expect(limiter.advance(1 / 30)).not.toBeNull();
  });
});
