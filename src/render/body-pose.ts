// Works out how a character's body should bend from how it is moving. Angles are
// radians around the joint's sideways axis. A positive limb angle swings forward,
// and an arm at about PI points straight up.

export interface BodyState {
  /** Ground speed, in metres per second. */
  speed: number;
  /** Speed in the direction the body faces. Negative is moving backward. */
  forwardSpeed: number;
  verticalSpeed: number;
  /** Direction from the hand to the web point, in the body's own frame. Null when not on a web. */
  rope: { x: number; y: number; z: number } | null;
  time: number;
}

export interface BodyPose {
  /** Whole body tipping forward or back, and to the side. */
  pitch: number;
  roll: number;
  armLeft: number;
  armRight: number;
  elbowLeft: number;
  elbowRight: number;
  legLeft: number;
  legRight: number;
  kneeLeft: number;
  kneeRight: number;
}

const MAX_TIP = 1.15;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/** Above this vertical speed, the character counts as jumping or falling. */
const AIRBORNE_SPEED = 2;
const RUN_SPEED = 1;

function swinging(s: BodyState, rope: NonNullable<BodyState['rope']>): BodyPose {
  // The body hangs along the web, with the legs trailing behind the swing.
  const trail = clamp(-s.forwardSpeed * 0.03, -0.9, 0.9);
  const sway = Math.sin(s.time * 3.2) * 0.12;
  return {
    pitch: clamp(Math.atan2(rope.z, rope.y), -MAX_TIP, MAX_TIP),
    roll: clamp(-Math.atan2(rope.x, rope.y), -MAX_TIP, MAX_TIP),
    armRight: 3.0,
    elbowRight: 0.1,
    armLeft: -0.5 + trail * 0.5 + sway,
    elbowLeft: 0.9,
    legLeft: 0.85 + trail + sway,
    kneeLeft: -1.35,
    legRight: 0.15 + trail - sway,
    kneeRight: -0.45,
  };
}

function running(s: BodyState): BodyPose {
  const phase = s.time * (6 + s.speed * 0.7);
  const stride = Math.min(1, s.speed / 11) * 0.95;
  const swing = Math.sin(phase);
  return {
    pitch: -Math.min(0.38, s.speed * 0.022),
    roll: 0,
    armLeft: -swing * stride,
    armRight: swing * stride,
    elbowLeft: 0.9,
    elbowRight: 0.9,
    legLeft: swing * stride,
    legRight: -swing * stride,
    kneeLeft: -Math.max(0, -Math.cos(phase)) * 1.3 * stride - 0.15,
    kneeRight: -Math.max(0, Math.cos(phase)) * 1.3 * stride - 0.15,
  };
}

function airborne(s: BodyState): BodyPose {
  if (s.verticalSpeed > 0) {
    return {
      pitch: -0.12,
      roll: 0,
      armLeft: 0.7,
      armRight: -0.5,
      elbowLeft: 0.7,
      elbowRight: 0.7,
      legLeft: 0.75,
      legRight: -0.25,
      kneeLeft: -1.1,
      kneeRight: -0.5,
    };
  }
  // Falling: arms flail upward, faster as the drop gets harder.
  const flail = Math.sin(s.time * (8 + Math.min(10, -s.verticalSpeed * 0.3))) * 0.3;
  return {
    pitch: 0.1,
    roll: flail * 0.2,
    armLeft: 2.3 + flail,
    armRight: 2.3 - flail,
    elbowLeft: 0.3,
    elbowRight: 0.3,
    legLeft: 0.3 - flail,
    legRight: -0.2 + flail,
    kneeLeft: -0.5,
    kneeRight: -0.7,
  };
}

function standing(s: BodyState): BodyPose {
  const breath = Math.sin(s.time * 1.8) * 0.04;
  return {
    pitch: 0,
    roll: 0,
    armLeft: breath,
    armRight: -breath,
    elbowLeft: 0.2,
    elbowRight: 0.2,
    legLeft: 0,
    legRight: 0,
    kneeLeft: 0,
    kneeRight: 0,
  };
}

export function bodyPose(s: BodyState): BodyPose {
  if (s.rope) return swinging(s, s.rope);
  if (Math.abs(s.verticalSpeed) > AIRBORNE_SPEED) return airborne(s);
  if (s.speed > RUN_SPEED) return running(s);
  return standing(s);
}
