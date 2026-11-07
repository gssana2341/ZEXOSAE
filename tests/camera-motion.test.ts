import { describe, expect, it } from 'vitest';
import {
  createCameraMotion,
  landCamera,
  stepCameraMotion,
  speedFovBoost,
  stepFovBoost,
  type CameraMotionInput,
  type CameraOffset,
} from '../src/render/camera-motion';

const dt = 1 / 60;
const input = (extra: Partial<CameraMotionInput>): CameraMotionInput => ({
  speed: 0,
  sideSpeed: 0,
  totalSpeed: 0,
  onGround: true,
  swinging: false,
  dt,
  ...extra,
});

function run(seconds: number, extra: Partial<CameraMotionInput>, m = createCameraMotion()) {
  const frames: CameraOffset[] = [];
  for (let t = 0; t < seconds; t += dt) frames.push(stepCameraMotion(m, input(extra)));
  return { m, frames };
}

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

describe('camera motion', () => {
  it('widens rapidly and substantially for a fast dive while respecting motion settings', () => {
    const still = speedFovBoost(0, 0, true, false, true);
    const fast = speedFovBoost(40, 0, true, false, true);
    const dive = speedFovBoost(40, 40, true, false, true);
    expect(still).toBe(0);
    expect(fast).toBeGreaterThan(still);
    expect(dive - fast).toBeGreaterThan(12);
    expect(speedFovBoost(60, 60, true, true, true)).toBeLessThanOrEqual(4);
    expect(speedFovBoost(60, 60, true, false, false)).toBe(0);
    expect(stepFovBoost(0, dive, 40, 0.1, false)).toBeGreaterThan(dive * 0.75);
    expect(stepFovBoost(0, dive, 0, 0.1, false)).toBeLessThan(dive * 0.5);
    expect(stepFovBoost(dive, 0, 40, 0.1, false)).toBeGreaterThan(dive * 0.5);
  });

  it('stays still when standing', () => {
    const { frames } = run(1, {});
    expect(spread(frames.map((f) => f.y))).toBeLessThan(0.001);
    expect(spread(frames.map((f) => f.x))).toBeLessThan(0.001);
  });

  it('bobs up and down and sways side to side when running', () => {
    const { frames } = run(2, { speed: 11, totalSpeed: 11 });
    expect(spread(frames.slice(30).map((f) => f.y))).toBeGreaterThan(0.08);
    expect(spread(frames.slice(30).map((f) => f.x))).toBeGreaterThan(0.05);
  });

  it('bobs twice per sideways sway, like two footsteps', () => {
    const { frames } = run(3, { speed: 11, totalSpeed: 11 });
    const crossings = (v: number[]) => v.slice(1).filter((n, i) => Math.sign(n) !== Math.sign(v[i])).length;
    const late = frames.slice(60);
    expect(crossings(late.map((f) => f.y))).toBeGreaterThan(crossings(late.map((f) => f.x)) * 1.7);
  });

  it('does not bob in the air', () => {
    const { frames } = run(1, { speed: 20, totalSpeed: 20, onGround: false });
    expect(spread(frames.map((f) => f.y))).toBeLessThan(0.001);
  });

  it('fades the footsteps out after stopping', () => {
    const { m } = run(1, { speed: 11, totalSpeed: 11 });
    run(1, {}, m);
    expect(m.strideAmount).toBeLessThan(0.01);
  });

  it('leans away from sideways speed, and more on a web', () => {
    const ground = run(1, { sideSpeed: 10 }).frames.at(-1)!;
    const swing = run(1, { sideSpeed: 10, onGround: false, swinging: true }).frames.at(-1)!;
    expect(ground.roll).toBeLessThan(0);
    expect(Math.abs(swing.roll)).toBeGreaterThan(Math.abs(ground.roll) * 2);
  });

  it('never leans too far', () => {
    const { frames } = run(2, { sideSpeed: 80, onGround: false, swinging: true });
    expect(Math.abs(frames.at(-1)!.roll)).toBeLessThanOrEqual(0.15001);
  });

  it('dips on a hard landing and settles back', () => {
    const m = createCameraMotion();
    landCamera(m, 30);
    const { frames } = run(1, {}, m);
    expect(Math.min(...frames.map((f) => f.y))).toBeLessThan(-0.1);
    expect(Math.abs(frames.at(-1)!.y)).toBeLessThan(0.01);
  });

  it('a bigger fall dips further, within a limit', () => {
    const lowest = (fall: number) => {
      const m = createCameraMotion();
      landCamera(m, fall);
      return Math.min(...run(1, {}, m).frames.map((f) => f.y));
    };
    expect(lowest(40)).toBeLessThan(lowest(15));
    expect(lowest(500)).toBeGreaterThanOrEqual(-0.5);
  });

  it('trembles only at high speed', () => {
    const slow = run(1, { totalSpeed: 15, onGround: false }).frames;
    const fast = run(1, { totalSpeed: 40, onGround: false }).frames;
    expect(spread(slow.map((f) => f.y))).toBeLessThan(0.001);
    expect(spread(fast.map((f) => f.y))).toBeGreaterThan(0.02);
  });

  it('moves smoothly from frame to frame, so it cannot look like stutter', () => {
    const { frames } = run(2, { speed: 14, totalSpeed: 40 });
    for (let i = 1; i < frames.length; i += 1) {
      expect(Math.abs(frames[i].y - frames[i - 1].y)).toBeLessThan(0.03);
    }
  });
});
