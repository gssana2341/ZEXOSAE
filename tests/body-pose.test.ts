import { describe, expect, it } from 'vitest';
import {
  bodyPose,
  clipFor,
  DIVE_FROM,
  DIVE_RANGE,
  diveAmount,
  diveLimbs,
  diveTilt,
  hangLimbs,
  createSwingTrack,
  RELEASE_MOVES,
  RELEASE_TIME,
  releaseLimbs,
  releaseTurn,
  SWING_STYLES,
  swingLimbs,
  swingAnchor,
  trackSwing,
  usesBothHands,
  type BodyState,
} from '../src/render/body-pose';
import { ACT_TIME } from '../src/sim/moves';

const state = (extra: Partial<BodyState>): BodyState => ({
  speed: 0,
  forwardSpeed: 0,
  verticalSpeed: 0,
  rope: null,
  time: 1,
  ...extra,
});

describe('choosing a motion clip', () => {
  const clip = (s: Partial<Parameters<typeof clipFor>[0]>) => clipFor({ speed: 0, verticalSpeed: 0, ...s }).clip;

  it('stands, jogs and sprints by speed', () => {
    expect(clip({ mode: 'ground' })).toBe('Idle_Loop');
    expect(clip({ mode: 'ground', speed: 4 })).toBe('Jog_Fwd_Loop');
    expect(clip({ mode: 'ground', speed: 11 })).toBe('Sprint_Loop');
  });

  it('plays the matching clip for each move', () => {
    expect(clip({ mode: 'slide', speed: 12 })).toBe('Slide_Loop');
    expect(clip({ mode: 'dash', speed: 20 })).toBe('Roll');
    expect(clip({ mode: 'wall', speed: 15 })).toBe('Sprint_Loop');
    expect(clip({ mode: 'swing', speed: 25 })).toBe('NinjaJump_Idle_Loop');
  });

  it('uses different clips rising and falling', () => {
    expect(clip({ mode: 'air', verticalSpeed: 10 })).toBe('Jump_Loop');
    expect(clip({ mode: 'air', verticalSpeed: -10 })).toBe('NinjaJump_Idle_Loop');
  });

  it('reads the movement when no mode is known, as for practice dummies', () => {
    expect(clip({ speed: 5 })).toBe('Jog_Fwd_Loop');
    expect(clip({ verticalSpeed: -8 })).toBe('NinjaJump_Idle_Loop');
  });

  it('runs the legs faster at higher speed', () => {
    const slow = clipFor({ mode: 'ground', speed: 8, verticalSpeed: 0 }).timeScale;
    const fast = clipFor({ mode: 'ground', speed: 16, verticalSpeed: 0 }).timeScale;
    expect(fast).toBeGreaterThan(slow);
  });
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

describe('swing variety', () => {
  const step = 1 / 60;
  const at = { x: 0, y: 30, z: 0 };
  const next = { x: 5, y: 30, z: 0 };

  it('tracks only a swing rope even while an action animation is playing', () => {
    expect(swingAnchor(at, 'swing', 'cast')).toEqual(at);
    expect(swingAnchor(at, 'ground', 'cast')).toBeNull();
    expect(swingAnchor(at, 'zip', 'zip')).toBeNull();
    expect(swingAnchor(at, undefined, 'swing')).toEqual(at);
  });

  it('changes hands with every new web', () => {
    const t = createSwingTrack();
    expect(trackSwing(t, at, false, step)).toBe(true);
    const first = t.side;
    expect(trackSwing(t, at, false, step)).toBe(false);
    expect(t.side).toBe(first);
    trackSwing(t, next, false, step);
    expect(t.side).toBe(-first);
  });

  it('gets to every shape on both hands', () => {
    const t = createSwingTrack();
    const seen = new Set<string>();
    for (let i = 0; i < SWING_STYLES * 4; i += 1) {
      trackSwing(t, { x: i, y: 30, z: 0 }, false, step);
      seen.add(`${t.style}/${t.side}`);
    }
    expect(seen.size).toBe(SWING_STYLES * 2);
  });

  it('lets go into a move only at speed', () => {
    const fast = createSwingTrack();
    trackSwing(fast, at, false, step);
    trackSwing(fast, null, true, step);
    expect(fast.release).toBe(0);

    const slow = createSwingTrack();
    trackSwing(slow, at, false, step);
    trackSwing(slow, null, false, step);
    expect(slow.release).toBeLessThan(0);
  });

  it('ends a move, and a new web cuts it short', () => {
    const t = createSwingTrack();
    trackSwing(t, at, false, step);
    trackSwing(t, null, true, step);
    trackSwing(t, null, true, RELEASE_TIME + 0.1);
    expect(t.release).toBeLessThan(0);

    trackSwing(t, at, false, step);
    trackSwing(t, null, true, step);
    trackSwing(t, next, false, step);
    expect(t.release).toBeLessThan(0);
  });

  it('mirrors a shape for the other hand', () => {
    const moment = { style: 1, rise: 0, age: 1, time: 0 };
    const right = swingLimbs({ ...moment, side: 1 });
    const left = swingLimbs({ ...moment, side: -1 });
    expect(left.legLeft.upper.x).toBeCloseTo(-right.legRight.upper.x);
    expect(left.legLeft.upper.z).toBeCloseTo(right.legRight.upper.z);
    expect(right.armRight).toBeNull();
    expect(left.armLeft).toBeNull();
    expect(left.armRight).not.toBeNull();
  });

  it('leads with the legs going up and trails them coming down', () => {
    const legs = (rise: number) => swingLimbs({ style: 0, side: 1, rise, age: 1, time: 0 }).legRight.upper.z;
    expect(legs(1)).toBeLessThan(legs(0));
    expect(legs(-1)).toBeGreaterThan(legs(0));
  });

  it('holds the web with both hands only in the haul', () => {
    const both = Array.from({ length: SWING_STYLES }, (_, style) => usesBothHands(style));
    expect(both.filter(Boolean)).toHaveLength(1);
    const style = both.indexOf(true);
    expect(swingLimbs({ style, side: 1, rise: 0, age: 1, time: 0 }).twoHands).toBe(true);
  });

  it('turns a flip and a spin all the way round', () => {
    expect(releaseTurn(0, 1).pitch).toBeCloseTo(-Math.PI * 2);
    expect(releaseTurn(1, 1).spin).toBeCloseTo(Math.PI * 2);
    expect(releaseTurn(2, 1).pitch).toBeCloseTo(0);
    for (let kind = 0; kind < RELEASE_MOVES; kind += 1) {
      expect(releaseLimbs(kind).twoHands).toBe(false);
    }
  });
});

describe('action timing', () => {
  it('fits short attack and skill clips to the actual simulation action', () => {
    for (const mode of ['jab', 'cross', 'kick', 'launch', 'finisher', 'cast', 'heal', 'trick', 'dodgeL', 'dodgeR'] as const) {
      expect(clipFor({ mode, speed: 0, verticalSpeed: 0 }).duration).toBe(ACT_TIME[mode]);
    }
  });
});

describe('climbing clips', () => {
  const climb = (verticalSpeed: number, sideSpeed: number) =>
    clipFor({ mode: 'climb', speed: Math.abs(sideSpeed), verticalSpeed, sideSpeed });

  it('climbs the way the body moves across the wall', () => {
    expect(climb(4, 0).clip).toBe('Climb_Up_Loop');
    expect(climb(-4, 0).clip).toBe('Climb_Down_Loop');
    expect(climb(1, 4).clip).toBe('Climb_Right_Loop');
    expect(climb(1, -4).clip).toBe('Climb_Left_Loop');
    expect(climb(0.1, 0.1).clip).toBe('Climb_Idle_Loop');
  });

  it('climbs faster when moving faster, up to a limit', () => {
    expect(climb(4, 0).timeScale).toBeGreaterThan(climb(2, 0).timeScale);
    expect(climb(30, 0).timeScale).toBe(climb(40, 0).timeScale);
  });

  it('runs when fast along a wall and climbs when slow', () => {
    expect(clipFor({ mode: 'wall', speed: 15, verticalSpeed: 0 }).clip).toBe('Sprint_Loop');
    expect(clipFor({ mode: 'wall', speed: 2, verticalSpeed: 8 }).clip).toBe('Climb_Up_Loop');
  });

  it('pulls up over a ledge in its own time', () => {
    expect(clipFor({ mode: 'ledge', speed: 0, verticalSpeed: 5 }).clip).toBe('ClimbLedge');
  });
});

describe('stepping clips', () => {
  const ground = (forwardSpeed: number, sideSpeed: number) =>
    clipFor({ mode: 'ground', speed: Math.hypot(forwardSpeed, sideSpeed), verticalSpeed: 0, forwardSpeed, sideSpeed });

  it('walks slowly, jogs, then sprints straight ahead', () => {
    expect(ground(0.1, 0).clip).toBe('Idle_Loop');
    expect(ground(1.2, 0).clip).toBe('Walk_Loop');
    expect(ground(4, 0).clip).toBe('Jog_Fwd_Loop');
    expect(ground(8, 0).clip).toBe('Sprint_Loop');
  });

  it('steps the way the body moves, not the way it faces', () => {
    expect(ground(0, 3).clip).toBe('Jog_Right_Loop');
    expect(ground(0, -3).clip).toBe('Jog_Left_Loop');
    expect(ground(-3, 0).clip).toBe('Jog_Bwd_Loop');
    expect(ground(3, 3).clip).toBe('Jog_Fwd_R_Loop');
    expect(ground(-3, -3).clip).toBe('Jog_Bwd_L_Loop');
  });

  it('plays the feet at the speed the ground goes by', () => {
    expect(ground(4, 0).timeScale * 5.45).toBeCloseTo(4, 1);
    expect(ground(8, 0).timeScale * 8.39).toBeCloseTo(8, 1);
  });

  it('crouches into a hard landing and doubles over after a slam', () => {
    expect(clipFor({ mode: 'land', speed: 0, verticalSpeed: 0 }).clip).toBe('Jump_Land');
    expect(clipFor({ mode: 'stun', speed: 0, verticalSpeed: 0 }).clip).toBe('Hit_Stomach');
  });
});

describe('hanging on a line', () => {
  it('hangs with the legs down and the hands left to the line', () => {
    const pose = hangLimbs(0, 0);
    expect(pose.legRight.upper.y).toBeLessThan(-0.9);
    expect(pose.legLeft.upper.y).toBeLessThan(-0.9);
    expect(pose.armRight).toBeNull();
    expect(pose.armLeft).toBeNull();
  });

  it('draws the knees up in turn while climbing', () => {
    const a = hangLimbs(Math.PI / 2, 1);
    const b = hangLimbs(-Math.PI / 2, 1);
    expect(a.legRight.upper.z).toBeLessThan(a.legLeft.upper.z);
    expect(b.legLeft.upper.z).toBeLessThan(b.legRight.upper.z);
  });
});

describe('diving', () => {
  it('starts only in a fast fall, and grows to a full dive', () => {
    expect(diveAmount(5)).toBe(0);
    expect(diveAmount(DIVE_FROM)).toBe(0);
    expect(diveAmount(DIVE_FROM + DIVE_RANGE / 2)).toBeCloseTo(0.5);
    expect(diveAmount(60)).toBe(1);
  });

  it('tips the head straight down in a drop, and along the slant when moving forward too', () => {
    expect(Math.abs(diveTilt(30, 0))).toBeCloseTo(Math.PI, 1);
    const slant = diveTilt(30, 30);
    expect(Math.abs(slant)).toBeGreaterThan(Math.PI / 2);
    expect(Math.abs(slant)).toBeLessThan(Math.abs(diveTilt(30, 0)));
  });

  it('streamlines the body: arms and legs trail behind the head', () => {
    const pose = diveLimbs(0);
    for (const limb of [pose.armRight!, pose.armLeft!, pose.legRight, pose.legLeft]) {
      expect(limb.upper.y).toBeLessThan(-0.85);
    }
    expect(pose.armRight!.upper.x).toBeCloseTo(-pose.armLeft!.upper.x);
  });
});
