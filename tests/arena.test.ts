import { describe, expect, it } from 'vitest';
import { ARENA_LIMIT, createArena, JUMP_PAD_RADIUS, nearbyBoxes, raycast, type Box, type V3 } from '../src/sim/map';
import { createPlayer, emptyInput, findAnchor, TUNING } from '../src/sim/player';
import { TICK, World } from '../src/sim/world';
import { farTowers } from '../src/render/arena';

const map = createArena();
const r = TUNING.radius;

const touching = (x: number, y0: number, y1: number, z: number): Box | undefined =>
  map.boxes.find(
    (b) =>
      x + r > b.min.x && x - r < b.max.x && y1 > b.min.y && y0 < b.max.y && z + r > b.min.z && z - r < b.max.z,
  );

const insideSolid = (p: V3) =>
  map.boxes.some(
    (b) =>
      p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z,
  );

describe('the Spire district', () => {
  it('opens the old perimeter into a larger outer district', () => {
    expect(ARENA_LIMIT * 2).toBe(900);
    expect(map.spawns.some(({ pos }) => Math.abs(pos.x) > 200 || Math.abs(pos.z) > 200)).toBe(true);
    const w = new World();
    w.player.pos = { x: 0, y: 0.05, z: -65 };
    for (let i = 0; i < 220; i += 1) w.step({ ...emptyInput(), moveZ: 1 }, TICK);
    expect(w.player.pos.z).toBeLessThan(-90);
  });

  it('surrounds all four sides with a continuous edge of buildings', () => {
    const edge = map.boxes.filter((b) => b.kind === 'building');
    for (let along = -449; along <= 449; along += 3) {
      expect(edge.some((b) => b.min.x <= along && b.max.x >= along && b.min.z === -ARENA_LIMIT)).toBe(true);
      expect(edge.some((b) => b.min.x <= along && b.max.x >= along && b.max.z === ARENA_LIMIT)).toBe(true);
      expect(edge.some((b) => b.min.z <= along && b.max.z >= along && b.min.x === -ARENA_LIMIT)).toBe(true);
      expect(edge.some((b) => b.min.z <= along && b.max.z >= along && b.max.x === ARENA_LIMIT)).toBe(true);
    }
  });

  it('keeps collision queries local and rebuilds the index after boxes change', () => {
    const small = nearbyBoxes(map, 197, 197, 203, 203);
    expect(small.length).toBeLessThan(map.boxes.length / 5);
    const added: Box = { min: { x: 198, y: 5, z: 198 }, max: { x: 202, y: 10, z: 202 }, kind: 'building' };
    map.boxes.push(added);
    expect(nearbyBoxes(map, 200, 200, 200, 200)).toContain(added);
    map.boxes.pop();
    expect(nearbyBoxes(map, 200, 200, 200, 200)).not.toContain(added);
  });

  it('keeps decorative skyline towers outside the playable area', () => {
    for (const tower of farTowers()) {
      expect(Math.abs(tower.x) - tower.w / 2 > ARENA_LIMIT || Math.abs(tower.z) - tower.w / 2 > ARENA_LIMIT).toBe(true);
    }
  });
  it('has a spawn for every player in a full room', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(16);
  });

  it('every spawn is on a surface with room to stand', () => {
    for (const { pos } of map.spawns) {
      expect(touching(pos.x, pos.y, pos.y + TUNING.standHeight, pos.z), JSON.stringify(pos)).toBeUndefined();
      expect(touching(pos.x, pos.y - 0.2, pos.y, pos.z), JSON.stringify(pos)).toBeDefined();
    }
  });

  it('every spawn stays where it was put', () => {
    for (const { pos, yaw } of map.spawns) {
      const w = new World();
      w.setOnline(true);
      w.respawnAt(pos, yaw);
      for (let i = 0; i < 30; i += 1) w.step(emptyInput(), TICK);
      expect(Math.abs(w.player.pos.y - pos.y), JSON.stringify(pos)).toBeLessThan(0.2);
    }
  });

  it('spawns face into the arena', () => {
    for (const { pos, yaw } of map.spawns) {
      const toward = -Math.sin(yaw) * -pos.x + -Math.cos(yaw) * -pos.z;
      expect(toward).toBeGreaterThan(0);
    }
  });

  it('patrols run along a surface', () => {
    for (const { a, b } of map.patrols) {
      for (const k of [0, 0.5, 1]) {
        const x = a.x + (b.x - a.x) * k;
        const y = a.y + (b.y - a.y) * k;
        const z = a.z + (b.z - a.z) * k;
        expect(touching(x, y + 0.1, y + 1.8, z), JSON.stringify({ x, y, z })).toBeUndefined();
        expect(touching(x, y - 0.2, y, z), JSON.stringify({ x, y, z })).toBeDefined();
      }
    }
  });

  it('rings are in open air', () => {
    for (const ring of map.rings) expect(insideSolid(ring), JSON.stringify(ring)).toBe(false);
  });

  it('every ring has a web point within reach', () => {
    for (const ring of map.rings) {
      expect(insideSolid(ring), JSON.stringify(ring)).toBe(false);
      const reachable = [0.5, 0.8, 1.1, 1.4].some((elevation) =>
        [...Array(16).keys()].some((i) => {
          const a = (i / 16) * Math.PI * 2;
          const c = Math.cos(elevation);
          const d = { x: Math.cos(a) * c, y: Math.sin(elevation), z: Math.sin(a) * c };
          const hit = raycast(map, ring, d, TUNING.ropeRange);
          return hit && hit.box.kind !== 'bound';
        }),
      );
      expect(reachable, JSON.stringify(ring)).toBe(true);
    }
  });

  it('jump pads have a clear flight and stay off spawn points', () => {
    expect(map.jumpPads.length).toBeGreaterThan(25);
    const roofs = map.jumpPads.filter((pad) => pad.y > 0);
    for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      expect(roofs.some((pad) => sx * pad.x > 250 && sz * pad.z > 250)).toBe(true);
    }
    for (const pad of map.jumpPads) {
      for (const { pos } of map.spawns) {
        expect(Math.hypot(pos.x - pad.x, pos.y - pad.y, pos.z - pad.z)).toBeGreaterThan(4);
      }
      expect(raycast(map, { ...pad, y: pad.y + 0.1 }, { x: 0, y: 1, z: 0 }, 32)).toBeNull();
      if (pad.y > 0) {
        expect(map.boxes.some((box) => box.kind === 'building' && box.max.y === pad.y &&
          pad.x - JUMP_PAD_RADIUS > box.min.x && pad.x + JUMP_PAD_RADIUS < box.max.x &&
          pad.z - JUMP_PAD_RADIUS > box.min.z && pad.z + JUMP_PAD_RADIUS < box.max.z)).toBe(true);
      } else {
        // The original ground pads are inside the plaza, away from its ring road.
        expect(Math.max(Math.abs(pad.x), Math.abs(pad.z))).toBeLessThan(21 - JUMP_PAD_RADIUS);
      }
    }
  });

  it('launches a player from a rooftop pad', () => {
    const pad = map.jumpPads.find((p) => p.y > 0)!;
    const world = new World(null, map);
    world.respawnAt({ ...pad, y: pad.y + 0.05 }, 0);
    world.step(emptyInput(), TICK);
    expect(world.player.vel.y).toBeGreaterThan(30);
    expect(world.events.some((event) => event.type === 'jumpPad')).toBe(true);
  });

  it('keeps everything inside the arena limit', () => {
    for (const { pos } of map.spawns) {
      expect(Math.max(Math.abs(pos.x), Math.abs(pos.z))).toBeLessThan(ARENA_LIMIT);
    }
    for (const box of map.boxes) {
      if (box.kind === 'ground' || box.kind === 'bound') continue;
      expect(Math.max(Math.abs(box.min.x), Math.abs(box.max.x))).toBeLessThanOrEqual(ARENA_LIMIT);
      expect(Math.max(Math.abs(box.min.z), Math.abs(box.max.z))).toBeLessThanOrEqual(ARENA_LIMIT);
    }
  });

  it('holds only buildings, the web frame, and low street things you can vault', () => {
    const kinds = new Set(map.boxes.map((b) => b.kind));
    for (const clutter of ['run', 'ledge'] as const) expect(kinds.has(clutter)).toBe(false);
    for (const box of map.boxes.filter((b) => b.kind === 'prop')) {
      // Cars are low enough to vault. Trees stand on the ground, in parks.
      expect(box.min.y).toBeLessThan(7);
      expect(box.max.y).toBeLessThan(8);
    }
  });

  it('the web frame over the plaza stays tidy: every beam runs along an axis through it', () => {
    const frame = map.boxes.filter((b) => b.kind === 'beam' && b.min.y === 34);
    expect(frame).toHaveLength(6);
    for (const beam of frame) {
      const long = Math.max(beam.max.x - beam.min.x, beam.max.z - beam.min.z);
      expect(long).toBeGreaterThanOrEqual(60);
    }
  });

  it('webs do not stick to the invisible edge', () => {
    const p = createPlayer({ x: ARENA_LIMIT - 0.5, y: 155, z: 0 }, -Math.PI / 2);
    p.pitch = 0.4;
    expect(findAnchor(p, map, 'off')).toBeNull();
  });

  it('you can run through the mall tunnel', () => {
    const w = new World();
    w.player.pos = { x: 0, y: 0.05, z: -33 };
    for (let i = 0; i < 230; i += 1) w.step({ ...emptyInput(), moveZ: 1 }, TICK);
    expect(w.player.pos.z).toBeLessThan(-59);
  });

  it('you can run under the garage floors', () => {
    const w = new World();
    w.player.pos = { x: 34, y: 0.05, z: 7 };
    for (let i = 0; i < 200; i += 1) w.step({ ...emptyInput(), yaw: -Math.PI / 2, moveZ: 1 }, TICK);
    expect(w.player.pos.x).toBeGreaterThan(55);
  });

  it('survives wild play without leaving the arena', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      let state = seed;
      const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const w = new World();
      w.setOnline(true);
      const spawn = map.spawns[seed % map.spawns.length];
      w.respawnAt(spawn.pos, spawn.yaw);

      let yaw = spawn.yaw;
      let pitch = 0.5;
      let swing = false;
      let swap = 0;
      for (let i = 0; i < 60 * 25; i += 1) {
        if (random() < 0.03) {
          yaw += (random() - 0.5) * 3;
          pitch = random() * 1.5 - 0.2;
        }
        swap -= 1;
        if (swap <= 0) {
          swing = !swing;
          swap = swing ? 30 + random() * 150 : 10 + random() * 60;
        }
        w.step({ ...emptyInput(), yaw, pitch, moveZ: 1, swing, jump: random() < 0.03, dash: random() < 0.01, webAssist: 'near' }, TICK);
        const p = w.player.pos;
        expect(Math.abs(p.x) <= ARENA_LIMIT && Math.abs(p.z) <= ARENA_LIMIT && p.y > -8).toBe(true);
        expect(touching(p.x, p.y, p.y + w.player.height, p.z)).toBeUndefined();
      }
    }
  }, 30000);
});
