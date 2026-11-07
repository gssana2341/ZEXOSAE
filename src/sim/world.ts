// One practice session: the player, moving dummies and the timed ring course.

import { createDanger, stepDanger, type DangerState } from './danger';
import {
  ARENA_FLOOR,
  ARENA_LIMIT,
  createArena,
  raycast,
  RING_RADIUS,
  type GameMap,
  type SpawnPoint,
  type V3,
} from './map';
import { viewForward } from './aim';
import { hitDamage, MAX_HP, type HitKind } from './hits';
import type { GameMode, Team } from './game-modes';
import { healPlayer, nearWall } from './moves';
import {
  createPlayer,
  dummyCenter,
  eyePosition,
  handPosition,
  stepPlayer,
  TUNING,
  type Dummy,
  type GameEvent,
  type Player,
  type TickInput,
} from './player';

export const TICK_RATE = 60;
export const TICK = 1 / TICK_RATE;

const DUMMY_HP = MAX_HP;
const DUMMY_GRAVITY = 36;
/** A dummy knocked further than this from its path, or off its floor, blinks back to it. */
const DUMMY_LEASH = 15;
const CRATE_RESPAWN = 10;
/** How long the web takes to fetch a crate to the hand. */
const CRATE_PULL = 0.22;
const CRATE_SPEED = 80;
const CRATE_RADIUS = 1.6;
/** A shot this close and heading at the player is a threat a dodge can beat. */
const THREAT_DISTANCE = 14;
const UP: V3 = { x: 0, y: 1, z: 0 };
const DOWN: V3 = { x: 0, y: -1, z: 0 };
const DUMMY_SPEED = 5;
const DUMMY_RESPAWN = 4;
/** In practice, each dummy aims at the player this long, this often, so the warning can be felt. */
const DUMMY_AIM_TIME = 1.2;
const DUMMY_AIM_EVERY = 6;
/** Coming back into the arena online avoids spawns this close to another player. */
const SAFE_RETURN_DISTANCE = 30;

/** A web shot in flight. It goes exactly where it was aimed. */
export interface Shot {
  pos: V3;
  dir: V3;
  snare: boolean;
  travelled: number;
  /** Another player's shot: drawn here, but their game decides if it hits. */
  ghost?: boolean;
  friendly?: boolean;
  /** A thrown crate: slower, bigger and harder hitting than a web shot. */
  crate?: boolean;
}

/** A loose crate: sitting at home, flying to a hand, or gone until it comes back. */
export interface Crate {
  id: number;
  home: V3;
  pos: V3;
  state: 'idle' | 'pulled' | 'gone';
  t: number;
}

interface Hit {
  kind: HitKind;
  knock?: V3;
  stun?: number;
  pin?: boolean;
  power?: number;
}

export type WorldEvent =
  | GameEvent
  | { type: 'hit'; id: number; ko: boolean; kind: HitKind }
  | { type: 'snare'; id: number }
  | { type: 'netHit'; target: number; snare: boolean; kind: HitKind; knock?: V3; stun?: number; pin?: boolean; power?: number }
  | { type: 'crateThrown'; origin: V3; dir: V3 }
  | { type: 'outOfBounds'; yaw: number }
  | { type: 'ring'; index: number }
  | { type: 'lap'; time: number; best: boolean };

export class World {
  player: Player;
  dummies: Dummy[];
  shots: Shot[] = [];
  crates: Crate[];
  events: WorldEvent[] = [];
  danger: DangerState = createDanger();
  private time = 0;

  ringIndex = 0;
  lapTime = 0;
  lapRunning = false;
  bestLap: number | null;
  kos = 0;
  online = false;
  gameMode: GameMode = 'deathmatch';
  myTeam: Team | undefined;
  /** Crown position for the renderer, and whether it is on this player. */
  crown: V3 | null = null;
  crownMine = false;

  constructor(
    bestLap: number | null = null,
    readonly map: GameMap = createArena(),
  ) {
    this.bestLap = bestLap;
    this.player = createPlayer(this.map.spawn, this.map.spawnYaw);
    this.dummies = this.createDummies();
    this.crates = this.map.crates.map((home, id) => ({ id, home, pos: { ...home }, state: 'idle', t: 0 }));
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
    if (!online) {
      this.gameMode = 'deathmatch';
      this.myTeam = undefined;
      this.crown = null;
      this.crownMine = false;
    }
    this.dummies = online ? [] : this.createDummies();
    this.shots.length = 0;
    this.kos = 0;
  }

  respawnAt(pos: V3, yaw: number): void {
    this.player = createPlayer(pos, yaw);
    this.danger = createDanger();
  }

  addGhostShot(origin: V3, dir: V3, snare: boolean, crate = false, friendly = false): void {
    this.shots.push({ pos: origin, dir, snare, travelled: 0, ghost: true, crate, friendly });
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
    const crates = this.crates.filter((c) => c.state === 'idle').map(({ id, pos }) => ({ id, pos }));
    const enemies = this.dummies.filter((d) => !d.ally);
    stepPlayer(this.player, input, this.map, enemies, dt, gameEvents, { threatened: this.threatened(), crates, online: this.online });
    this.events.push(...gameEvents);

    for (const e of gameEvents) {
      switch (e.type) {
        case 'shot':
          this.shots.push({ pos: e.origin, dir: e.dir, snare: e.snare, travelled: 0 });
          break;
        case 'hitTarget': {
          const d = this.dummies.find((x) => x.id === e.target);
          if (d) this.applyHit(d, e);
          break;
        }
        case 'heal':
          if (!this.online) healPlayer(this.player, e.amount);
          break;
        case 'pullCrate': {
          const crate = this.crates.find((c) => c.id === e.crate);
          if (crate?.state === 'idle') {
            crate.state = 'pulled';
            crate.t = CRATE_PULL;
          }
          break;
        }
      }
    }

    this.stepCrates(dt);
    this.stepShots(dt);
    if (!this.online) {
      this.stepDummies(dt);
      this.aimDummies(dt);
      this.stepCourse(dt);
    }
    stepDanger(this.danger, this.player, enemies, this.map, dt);
    this.keepInBounds();
  }

  /**
   * The web can carry a player over the boundary walls. Coming back is not a
   * death, so it costs nothing online. In practice it restarts the lap, or leaving
   * the arena would be a shortcut.
   */
  private keepInBounds(): void {
    const { x, y, z } = this.player.pos;
    if (Math.abs(x) <= ARENA_LIMIT && Math.abs(z) <= ARENA_LIMIT && y >= ARENA_FLOOR) return;

    if (this.online) {
      const spawn = this.pickReturnSpawn();
      this.respawnAt(spawn.pos, spawn.yaw);
    } else {
      this.reset();
    }
    this.events.push({ type: 'outOfBounds', yaw: this.player.yaw });
  }

  /**
   * Someone is about to land a hit: a shot closing in, or an enemy holding their aim.
   * A dodge now is a perfect one.
   */
  private threatened(): boolean {
    const p = this.player;
    const body = { x: p.pos.x, y: p.pos.y + 1, z: p.pos.z };
    for (const s of this.shots) {
      if (!s.ghost || s.friendly) continue;
      const ox = body.x - s.pos.x;
      const oy = body.y - s.pos.y;
      const oz = body.z - s.pos.z;
      const dist = Math.hypot(ox, oy, oz);
      if (dist > THREAT_DISTANCE) continue;
      if ((ox * s.dir.x + oy * s.dir.y + oz * s.dir.z) / (dist || 1) > 0.9) return true;
    }
    const d = this.danger;
    return Math.max(d.top, d.right, d.bottom, d.left) >= 0.6;
  }

  /** Crates fly to the hand that fetched them, then on along the crosshair. */
  private stepCrates(dt: number): void {
    const p = this.player;
    for (const c of this.crates) {
      if (c.state === 'gone') {
        c.t -= dt;
        if (c.t <= 0) {
          c.state = 'idle';
          c.pos = { ...c.home };
        }
        continue;
      }
      if (c.state !== 'pulled') continue;

      const hand = handPosition(p);
      const k = Math.min(1, dt / Math.max(dt, c.t));
      c.pos = {
        x: c.pos.x + (hand.x - c.pos.x) * k,
        y: c.pos.y + (hand.y - c.pos.y) * k,
        z: c.pos.z + (hand.z - c.pos.z) * k,
      };
      c.t -= dt;
      if (c.t > 0) continue;

      const target = this.dummies.find((x) => x.id === p.targetPreview && x.respawnT === 0);
      const eye = eyePosition(p);
      const aim = target ? dummyCenter(target) : null;
      const look = viewForward(p.yaw, p.pitch);
      let dir = look;
      if (aim) {
        const len = Math.hypot(aim.x - hand.x, aim.y - hand.y, aim.z - hand.z) || 1;
        dir = { x: (aim.x - hand.x) / len, y: (aim.y - hand.y) / len, z: (aim.z - hand.z) / len };
      } else {
        // Straight at whatever the crosshair is on, from the hand.
        const hit = raycast(this.map, eye, look, TUNING.shotRange);
        const end = hit ? hit.point : { x: eye.x + look.x * 60, y: eye.y + look.y * 60, z: eye.z + look.z * 60 };
        const len = Math.hypot(end.x - hand.x, end.y - hand.y, end.z - hand.z) || 1;
        dir = { x: (end.x - hand.x) / len, y: (end.y - hand.y) / len, z: (end.z - hand.z) / len };
      }
      const origin = { ...hand };
      this.shots.push({ pos: origin, dir, snare: false, travelled: 0, crate: true });
      this.events.push({ type: 'crateThrown', origin: { ...origin }, dir: { ...dir } });
      c.state = 'gone';
      c.t = CRATE_RESPAWN;
    }
  }

  private pickReturnSpawn(): SpawnPoint {
    const isClear = ({ pos }: SpawnPoint) =>
      this.dummies.every(
        (d) =>
          d.respawnT > 0 ||
          Math.hypot(d.pos.x - pos.x, d.pos.y - pos.y, d.pos.z - pos.z) >= SAFE_RETURN_DISTANCE,
      );
    const clear = this.map.spawns.filter(isClear);
    const pool = clear.length ? clear : this.map.spawns;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private stepShots(dt: number): void {
    this.shots = this.shots.filter((shot) => {
      const step = (shot.crate ? CRATE_SPEED : TUNING.shotSpeed) * dt;
      const wall = raycast(this.map, shot.pos, shot.dir, step);
      const reach = wall ? wall.t : step;

      const hit = shot.ghost
        ? undefined
        : this.dummies.find((d) => !d.ally && d.respawnT === 0 && this.shotTouches(shot, d, reach));
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
    return miss < (shot.crate ? CRATE_RADIUS : TUNING.shotRadius);
  }

  private applyShot(shot: Shot, d: Dummy): void {
    if (shot.crate) {
      const k = 14;
      this.applyHit(d, { kind: 'crate', knock: { x: shot.dir.x * k, y: 5, z: shot.dir.z * k }, stun: 0.8 });
      return;
    }
    this.applyHit(d, { kind: shot.snare ? 'snare' : 'shot' });
  }

  /**
   * One hit on a target. Online, the host decides, so it's only reported. In practice
   * it lands here: damage, then the shove and the daze.
   */
  private applyHit(d: Dummy, hit: Hit): void {
    if (this.online) {
      this.events.push({
        type: 'netHit',
        target: d.id,
        snare: hit.kind === 'snare',
        kind: hit.kind,
        knock: hit.knock,
        stun: hit.stun,
        pin: hit.pin,
        power: hit.power,
      });
      return;
    }

    if (hit.kind === 'snare') {
      // Caught next to a wall, the web sticks them to it for longer.
      d.snareT = TUNING.snareTime * (this.dummyNearWall(d) ? 2 : 1);
      this.events.push({ type: 'snare', id: d.id });
      return;
    }

    d.hp -= hitDamage(hit.kind, hit.power);
    const ko = d.hp <= 0;
    if (ko) {
      d.respawnT = DUMMY_RESPAWN;
      d.snareT = 0;
      d.vel = undefined;
      d.knockT = 0;
      d.mode = undefined;
      this.kos += 1;
    } else if (hit.knock) {
      d.vel = { ...hit.knock };
      d.knockT = hit.stun ?? 0.5;
      d.pinned = hit.pin === true;
      d.snareT = 0;
      d.mode = 'stun';
    }
    // A landed shot gives the dash back so the player can keep moving.
    if (hit.kind === 'shot') this.player.dashCdT = 0;
    this.events.push({ type: 'hit', id: d.id, ko, kind: hit.kind });
  }

  private dummyNearWall(d: Dummy): boolean {
    const probe = createPlayer(d.pos, 0);
    return nearWall(probe, this.map);
  }

  /** A dummy thrown by a hit: it flies, falls, sticks to a wall if thrown into one, then gets up. */
  private stepKnocked(d: Dummy, dt: number): void {
    const vel = d.vel!;
    vel.y -= DUMMY_GRAVITY * dt;
    const flat = Math.hypot(vel.x, vel.z) * dt;
    if (flat > 0) {
      const dir = { x: (vel.x * dt) / flat, y: 0, z: (vel.z * dt) / flat };
      const wall = raycast(this.map, { x: d.pos.x, y: d.pos.y + 1, z: d.pos.z }, dir, flat + 0.4);
      if (wall) {
        if (d.pinned && Math.hypot(vel.x, vel.z) > 6) {
          d.snareT = TUNING.snareTime * 1.5;
          d.vel = { x: 0, y: 0, z: 0 };
          d.knockT = Math.max(d.knockT ?? 0, d.snareT);
          return;
        }
        vel.x = 0;
        vel.z = 0;
      } else {
        d.pos.x += vel.x * dt;
        d.pos.z += vel.z * dt;
      }
    }

    let grounded = false;
    const rise = vel.y * dt;
    if (rise > 0) {
      if (raycast(this.map, { x: d.pos.x, y: d.pos.y + 1.8, z: d.pos.z }, UP, rise)) vel.y = 0;
      else d.pos.y += rise;
    } else {
      const floor = raycast(this.map, { x: d.pos.x, y: d.pos.y + 0.5, z: d.pos.z }, DOWN, 0.5 - rise);
      if (floor) {
        d.pos.y = floor.point.y;
        vel.y = 0;
        grounded = true;
        const keep = Math.exp(-8 * dt);
        vel.x *= keep;
        vel.z *= keep;
      } else {
        d.pos.y += rise;
      }
    }

    d.knockT = Math.max(0, (d.knockT ?? 0) - dt);
    const lost = d.pos.y < ARENA_FLOOR || Math.abs(d.pos.x) > ARENA_LIMIT || Math.abs(d.pos.z) > ARENA_LIMIT;
    if (lost || (grounded && d.knockT === 0 && Math.hypot(vel.x, vel.z) < 1)) {
      d.vel = undefined;
      d.pinned = false;
      d.mode = undefined;
      const { a, b } = this.map.patrols[d.id];
      const home = { x: a.x + (b.x - a.x) * d.phase, y: a.y + (b.y - a.y) * d.phase, z: a.z + (b.z - a.z) * d.phase };
      const far = Math.hypot(home.x - d.pos.x, home.z - d.pos.z) > DUMMY_LEASH;
      if (lost || far || Math.abs(home.y - d.pos.y) > 2) {
        // Too far to walk back: it blinks home, keeping its damage.
        d.pos = home;
        d.respawnT = 0.6;
      } else {
        d.homing = true;
      }
    }
  }

  private aimDummies(dt: number): void {
    this.time += dt;
    const target = eyePosition(this.player);

    for (const d of this.dummies) {
      const turn = (this.time + d.id * 1.1) % DUMMY_AIM_EVERY;
      if (turn >= DUMMY_AIM_TIME || d.snareT > 0 || d.vel) {
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
        if (d.respawnT === 0 && d.hp <= 0) d.hp = DUMMY_HP;
        return;
      }
      d.snareT = Math.max(0, d.snareT - dt);
      if (d.vel) {
        if (d.snareT === 0) this.stepKnocked(d, dt);
        else d.knockT = Math.max(0, (d.knockT ?? 0) - dt);
        if (d.vel && d.snareT === 0 && d.knockT === 0 && d.vel.x === 0 && d.vel.y === 0 && d.vel.z === 0) {
          // Unstuck from a wall: drop to the ground first.
          d.vel = { x: 0, y: -1, z: 0 };
          d.pinned = false;
        }
        return;
      }
      d.mode = d.snareT > 0 ? 'stun' : undefined;
      if (d.homing) {
        // Back to its path on foot after being knocked off it.
        const { a, b } = this.map.patrols[i];
        const home = { x: a.x + (b.x - a.x) * d.phase, y: a.y + (b.y - a.y) * d.phase, z: a.z + (b.z - a.z) * d.phase };
        const dx = home.x - d.pos.x;
        const dz = home.z - d.pos.z;
        const dist = Math.hypot(dx, dz);
        const stride = DUMMY_SPEED * dt;
        if (dist <= stride) {
          d.homing = false;
          d.pos = home;
        } else {
          d.pos.x += (dx / dist) * stride;
          d.pos.z += (dz / dist) * stride;
        }
        return;
      }

      const { a, b } = this.map.patrols[i];
      const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
      if (d.snareT > 0) return;
      d.phase += (d.dir * DUMMY_SPEED * dt) / length;
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
