// One practice session: the player, moving dummies and the timed ring course.

import { createDanger, stepDanger, type DangerState } from './danger';
import { createArena, raycast, RING_RADIUS, type GameMap, type V3 } from './map';
import {
  createPlayer,
  dummyCenter,
  eyePosition,
  stepPlayer,
  TUNING,
  type Dummy,
  type GameEvent,
  type Player,
  type TickInput,
} from './player';

export const TICK_RATE = 60;
export const TICK = 1 / TICK_RATE;

const DUMMY_HP = 1;
const DUMMY_SPEED = 5;
const DUMMY_SNARED_SPEED = 0.8;
const DUMMY_RESPAWN = 4;
/** In practice, each dummy aims at the player this long, this often, so the warning can be felt. */
const DUMMY_AIM_TIME = 1.2;
const DUMMY_AIM_EVERY = 6;

/** A web shot in flight. It goes exactly where it was aimed. */
export interface Shot {
  pos: V3;
  dir: V3;
  snare: boolean;
  travelled: number;
  /** Another player's shot: drawn here, but their game decides if it hits. */
  ghost?: boolean;
}

export type WorldEvent =
  | GameEvent
  | { type: 'hit'; id: number; ko: boolean }
  | { type: 'snare'; id: number }
  | { type: 'netHit'; target: number; snare: boolean }
  | { type: 'ring'; index: number }
  | { type: 'lap'; time: number; best: boolean };

export class World {
  readonly map: GameMap = createArena();
  player: Player;
  dummies: Dummy[];
  shots: Shot[] = [];
  events: WorldEvent[] = [];
  danger: DangerState = createDanger();
  private time = 0;

  ringIndex = 0;
  lapTime = 0;
  lapRunning = false;
  bestLap: number | null;
  kos = 0;
  online = false;

  constructor(bestLap: number | null = null) {
    this.bestLap = bestLap;
    this.player = createPlayer(this.map.spawn, this.map.spawnYaw);
    this.dummies = this.createDummies();
  }

  private createDummies(): Dummy[] {
    return this.map.patrols.map((patrol, id) => ({
      id,
      pos: { ...patrol.a },
      hp: DUMMY_HP,
      snareT: 0,
      respawnT: 0,
      phase: 0,
      dir: 1,
    }));
  }

  /** Online there are no dummies or rings: the targets are other players. */
  setOnline(online: boolean): void {
    this.online = online;
    this.dummies = online ? [] : this.createDummies();
    this.shots.length = 0;
    this.kos = 0;
  }

  respawnAt(pos: V3, yaw: number): void {
    this.player = createPlayer(pos, yaw);
    this.danger = createDanger();
  }

  addGhostShot(origin: V3, dir: V3, snare: boolean): void {
    this.shots.push({ pos: origin, dir, snare, travelled: 0, ghost: true });
  }

  /** Back to spawn and restart the lap. Dummies and the best time are kept. */
  reset(): void {
    this.player = createPlayer(this.map.spawn, this.map.spawnYaw);
    this.danger = createDanger();
    this.shots.length = 0;
    this.ringIndex = 0;
    this.lapTime = 0;
    this.lapRunning = false;
  }

  step(input: TickInput, dt: number): void {
    const gameEvents: GameEvent[] = [];
    stepPlayer(this.player, input, this.map, this.dummies, dt, gameEvents);
    this.events.push(...gameEvents);

    for (const e of gameEvents) {
      if (e.type === 'shot') {
        this.shots.push({ pos: e.origin, dir: e.dir, snare: e.snare, travelled: 0 });
      }
    }

    this.stepShots(dt);
    if (!this.online) {
      this.stepDummies(dt);
      this.aimDummies(dt);
      this.stepCourse(dt);
    }
    stepDanger(this.danger, this.player, this.dummies, this.map, dt);
  }

  private stepShots(dt: number): void {
    const step = TUNING.shotSpeed * dt;

    this.shots = this.shots.filter((shot) => {
      const wall = raycast(this.map, shot.pos, shot.dir, step);
      const reach = wall ? wall.t : step;

      const hit = shot.ghost
        ? undefined
        : this.dummies.find((d) => d.respawnT === 0 && this.shotTouches(shot, d, reach));
      if (hit) {
        this.applyShot(shot, hit);
        return false;
      }
      if (wall) return false;

      shot.pos.x += shot.dir.x * step;
      shot.pos.y += shot.dir.y * step;
      shot.pos.z += shot.dir.z * step;
      shot.travelled += step;
      return shot.travelled < TUNING.shotRange;
    });
  }

  /** True if the dummy's body lies within `reach` along the shot's path this tick. */
  private shotTouches(shot: Shot, d: Dummy, reach: number): boolean {
    const c = dummyCenter(d);
    const ox = c.x - shot.pos.x;
    const oy = c.y - shot.pos.y;
    const oz = c.z - shot.pos.z;
    const t = Math.max(0, Math.min(reach, ox * shot.dir.x + oy * shot.dir.y + oz * shot.dir.z));
    const miss = Math.hypot(ox - shot.dir.x * t, oy - shot.dir.y * t, oz - shot.dir.z * t);
    return miss < TUNING.shotRadius;
  }

  private applyShot(shot: Shot, d: Dummy): void {
    if (this.online) {
      this.events.push({ type: 'netHit', target: d.id, snare: shot.snare });
      return;
    }

    if (shot.snare) {
      d.snareT = TUNING.snareTime;
      this.events.push({ type: 'snare', id: d.id });
      return;
    }

    d.hp -= 1;
    const ko = d.hp <= 0;
    if (ko) {
      d.respawnT = DUMMY_RESPAWN;
      d.snareT = 0;
      this.kos += 1;
    }
    // A landed hit gives the dash back so the player can keep moving.
    this.player.dashCdT = 0;
    this.events.push({ type: 'hit', id: d.id, ko });
  }

  private aimDummies(dt: number): void {
    this.time += dt;
    const target = eyePosition(this.player);

    for (const d of this.dummies) {
      const turn = (this.time + d.id * 1.1) % DUMMY_AIM_EVERY;
      if (turn >= DUMMY_AIM_TIME || d.snareT > 0) {
        d.aim = undefined;
        continue;
      }
      const dx = target.x - d.pos.x;
      const dy = target.y - (d.pos.y + TUNING.standEye);
      const dz = target.z - d.pos.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      d.aim = { x: dx / len, y: dy / len, z: dz / len };
    }
  }

  private stepDummies(dt: number): void {
    this.dummies.forEach((d, i) => {
      if (d.respawnT > 0) {
        d.respawnT = Math.max(0, d.respawnT - dt);
        if (d.respawnT === 0) d.hp = DUMMY_HP;
        return;
      }
      d.snareT = Math.max(0, d.snareT - dt);

      const { a, b } = this.map.patrols[i];
      const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
      const speed = d.snareT > 0 ? DUMMY_SNARED_SPEED : DUMMY_SPEED;
      d.phase += (d.dir * speed * dt) / length;
      if (d.phase >= 1) {
        d.phase = 1;
        d.dir = -1;
      } else if (d.phase <= 0) {
        d.phase = 0;
        d.dir = 1;
      }
      d.pos.x = a.x + (b.x - a.x) * d.phase;
      d.pos.y = a.y + (b.y - a.y) * d.phase;
      d.pos.z = a.z + (b.z - a.z) * d.phase;
    });
  }

  private stepCourse(dt: number): void {
    if (this.lapRunning) this.lapTime += dt;

    const ring = this.map.rings[this.ringIndex];
    const p = this.player.pos;
    const dist = Math.hypot(ring.x - p.x, ring.y - (p.y + 1), ring.z - p.z);
    if (dist > RING_RADIUS) return;

    if (this.ringIndex === 0) {
      this.lapRunning = true;
      this.lapTime = 0;
    }
    this.events.push({ type: 'ring', index: this.ringIndex });
    this.ringIndex += 1;

    if (this.ringIndex === this.map.rings.length) {
      const best = this.bestLap === null || this.lapTime < this.bestLap;
      if (best) this.bestLap = this.lapTime;
      this.events.push({ type: 'lap', time: this.lapTime, best });
      this.ringIndex = 0;
      this.lapRunning = false;
    }
  }
}
