import type { Quality } from '../settings';

/** Keep high-resolution displays from multiplying the rendering cost without limit. */
export const QUALITY: Record<Quality, { pixelRatio: number; maxPixels: number; shadow: number }> = {
  low: { pixelRatio: 1, maxPixels: 1280 * 720, shadow: 0 },
  medium: { pixelRatio: 1.5, maxPixels: 1920 * 1080, shadow: 1024 },
  high: { pixelRatio: 2, maxPixels: 2560 * 1440, shadow: 2048 },
};

export function pixelRatioFor(quality: Quality, deviceRatio: number, width: number, height: number): number {
  const budget = QUALITY[quality];
  const pixels = Math.max(1, width) * Math.max(1, height);
  return Math.min(Math.max(deviceRatio, 0.1), budget.pixelRatio, Math.sqrt(budget.maxPixels / pixels));
}

/** Limit drawing, not simulation or input, and preserve the fractional time between frames. */
export class FrameLimiter {
  private readonly interval: number;
  private carry: number;
  private elapsed = 0;

  constructor(fps = 60) {
    this.interval = 1 / fps;
    this.carry = this.interval; // Draw immediately on startup.
  }

  /** Returns the time since the last draw, or null when this display refresh can be skipped. */
  advance(dt: number): number | null {
    this.carry += dt;
    this.elapsed += dt;
    if (this.carry + 1e-8 < this.interval) return null;
    const intervals = Math.floor((this.carry + 1e-8) / this.interval);
    this.carry = Math.max(0, this.carry - intervals * this.interval);
    const elapsed = this.elapsed;
    this.elapsed = 0;
    return elapsed;
  }
}

/** Give input and rendering a chance to run between batches of asset preparation. */
export const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
