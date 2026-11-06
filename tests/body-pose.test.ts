import { describe, expect, it } from 'vitest';
import { bodyPose, type BodyState } from '../src/render/body-pose';

const state = (extra: Partial<BodyState>): BodyState => ({
  speed: 0,
  forwardSpeed: 0,
  verticalSpeed: 0,
  rope: null,
  time: 1,
  ...extra,
});

describe('on the web', () => {
  const rope = { x: 0, y: 1, z: 0 };

  it('reaches up with one arm and bends the legs, instead of standing straight', () => {
    const pose = bodyPose(state({ rope }));
    expect(pose.armRight).toBeGreaterThan(2.5);
    expect(pose.kneeLeft).toBeLessThan(-1);
    expect(pose.legLeft).not.toBeCloseTo(pose.legRight, 1);
  });

  it('tips the body toward the web point', () => {
    const ahead = bodyPose(state({ rope: { x: 0, y: 0.7, z: -0.7 } }));
    const behind = bodyPose(state({ rope: { x: 0, y: 0.7, z: 0.7 } }));
    expect(ahead.pitch).toBeLessThan(-0.5);
    expect(behind.pitch).toBeGreaterThan(0.5);

    const right = bodyPose(state({ rope: { x: 0.7, y: 0.7, z: 0 } }));
    expect(right.roll).toBeLessThan(-0.5);
  });

  it('never tips over completely', () => {
    const pose = bodyPose(state({ rope: { x: 0, y: -1, z: 0.01 } }));
    expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(1.15);
  });

  it('trails the legs behind a fast swing', () => {
    const still = bodyPose(state({ rope, time: 0 }));
    const fast = bodyPose(state({ rope, forwardSpeed: 25, time: 0 }));
    expect(fast.legLeft).toBeLessThan(still.legLeft);
  });

  it('keeps moving over time', () => {
    const a = bodyPose(state({ rope, time: 0 }));
    const b = bodyPose(state({ rope, time: 0.5 }));
    expect(a.legLeft).not.toBeCloseTo(b.legLeft, 2);
  });
});

describe('on foot and in the air', () => {
  it('stands relaxed when still', () => {
    const pose = bodyPose(state({}));
    expect(pose.legLeft).toBe(0);
    expect(pose.pitch).toBe(0);
  });

  it('swings opposite arms and legs when running', () => {
    const pose = bodyPose(state({ speed: 11, time: 0.3 }));
    expect(pose.legLeft).toBeCloseTo(-pose.legRight, 5);
    expect(pose.armLeft).toBeCloseTo(-pose.legLeft, 5);
    expect(Math.abs(pose.legLeft)).toBeGreaterThan(0.1);
  });

  it('leans into a run, more when faster', () => {
    expect(bodyPose(state({ speed: 14 })).pitch).toBeLessThan(bodyPose(state({ speed: 4 })).pitch);
  });

  it('tucks a leg when jumping and raises the arms when falling', () => {
    expect(bodyPose(state({ verticalSpeed: 8 })).kneeLeft).toBeLessThan(-0.8);
    expect(bodyPose(state({ verticalSpeed: -20 })).armLeft).toBeGreaterThan(1.5);
  });
});
