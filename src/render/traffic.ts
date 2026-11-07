// Traffic that keeps to the rules: cars drive their lane, keep their distance from the
// car in front, and stop at the line when the light at the next junction isn't green.
// The lights run off the clock, so every player sees the same lights. No three.js in
// here, so the rules can be tested on their own.

export type Light = 'green' | 'yellow' | 'red';

/** One full turn of the lights, in seconds: north-south goes, then east-west. */
export const LIGHT_CYCLE = 18;
const NS_GREEN = 7;
const NS_YELLOW = 8.5;
const EW_START = 9;
const EW_GREEN = 16;
const EW_YELLOW = 17.5;

/** The light facing traffic on one axis, at a moment. Vertical roads run along z. */
export function lightFor(vertical: boolean, seconds: number): Light {
  const t = ((seconds % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
  if (vertical) {
    if (t < NS_GREEN) return 'green';
    if (t < NS_YELLOW) return 'yellow';
    return 'red';
  }
  if (t < EW_START) return 'red';
  if (t < EW_GREEN) return 'green';
  if (t < EW_YELLOW) return 'yellow';
  return 'red';
}

export const CAR_LENGTH = 4.4;
/** Cars leave this much room to the car in front when stopped. */
const STOP_GAP = 2;
const ACCEL = 3.5;
const BRAKE = 9;
/** The braking a driver plans with, gentler than the hardest they can brake. */
const PLAN_BRAKE = 5;

export interface Lane {
  /** The road's centre line, and the axis the road runs along. */
  line: number;
  vertical: boolean;
  /** +1 or -1 along the road. */
  dir: 1 | -1;
  /** Stop lines, as distances along the lane in the direction of travel, ascending. */
  stops: number[];
}

export interface TrafficCar {
  lane: number;
  /** Distance along the lane in the direction of travel. */
  s: number;
  speed: number;
  top: number;
}

export class Traffic {
  readonly lanes: Lane[] = [];
  readonly cars: TrafficCar[] = [];

  /**
   * @param roads centre lines of every road
   * @param drivable the lines cars may drive along
   * @param reach how far out the lanes run before cars loop back, hidden behind the edge
   * @param junctionHalf half a road's width: the stop line sits just short of it
   */
  constructor(
    roads: number[],
    drivable: number[],
    private readonly reach: number,
    junctionHalf: number,
    perLane: number,
  ) {
    for (const line of drivable) {
      for (const vertical of [true, false]) {
        for (const dir of [1, -1] as const) {
          const stops = roads.map((c) => dir * c - junctionHalf - 1).sort((a, b) => a - b);
          this.lanes.push({ line, vertical, dir, stops });
        }
      }
    }
    let seed = 3;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    this.lanes.forEach((_, lane) => {
      for (let n = 0; n < perLane; n += 1) {
        this.cars.push({
          lane,
          s: -reach + ((n + random() * 0.6) / perLane) * reach * 2,
          speed: 0,
          top: 9 + random() * 4,
        });
      }
    });
  }

  /** Moves every car on by dt, obeying the lights at this moment. */
  step(dt: number, seconds: number): void {
    const byLane = new Map<number, TrafficCar[]>();
    for (const car of this.cars) {
      const list = byLane.get(car.lane) ?? [];
      list.push(car);
      byLane.set(car.lane, list);
    }
    for (const [index, cars] of byLane) {
      const lane = this.lanes[index];
      const light = lightFor(lane.vertical, seconds);
      cars.sort((a, b) => b.s - a.s);
      cars.forEach((car, i) => {
        const ahead = i > 0 ? cars[i - 1] : null;
        let gap = ahead ? ahead.s - car.s - CAR_LENGTH - STOP_GAP : Infinity;
        if (light !== 'green') {
          const front = car.s + CAR_LENGTH / 2;
          const stop = lane.stops.find((s) => s > front - 0.5);
          if (stop !== undefined) {
            const toStop = stop - front;
            // On yellow, only stop if there's room to do it smoothly. Red always stops.
            const canStop = toStop > (car.speed * car.speed) / (2 * BRAKE);
            if (light === 'red' ? toStop > -0.5 : canStop) gap = Math.min(gap, toStop);
          }
        }
        const want = gap <= 0.3 ? 0 : Math.min(car.top, Math.sqrt(2 * PLAN_BRAKE * Math.max(0, gap - 0.3)));
        car.speed = car.speed < want ? Math.min(want, car.speed + ACCEL * dt) : Math.max(want, car.speed - BRAKE * dt);
        car.s += car.speed * dt;
      });
      // Past the far end, a car comes round again from behind the edge buildings,
      // unless that would land it on the last car in line.
      const last = cars[cars.length - 1];
      for (const car of cars) {
        if (car.s <= this.reach) continue;
        const start = -this.reach;
        const blocked = last && last !== car && last.s < start + CAR_LENGTH + STOP_GAP;
        // Waiting out of sight is fine, but never long enough to drive out of the city.
        if (blocked && car.s < this.reach + 25) continue;
        car.s = start;
      }
    }
  }

  /** Where a car is in the world, and which way it faces as a yaw. */
  place(car: TrafficCar, laneOffset: number): { x: number; z: number; yaw: number } {
    const lane = this.lanes[car.lane];
    const along = lane.dir * car.s;
    const across = lane.line - lane.dir * laneOffset;
    const yaw = lane.vertical ? (lane.dir > 0 ? 0 : Math.PI) : lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    return lane.vertical ? { x: across, z: along, yaw } : { x: along, z: across, yaw };
  }
}
