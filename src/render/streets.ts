// The street grid around the Spire district: asphalt, kerbs and pavements, crossings,
// park lawns and car park bays, then the parked cars, trees and slow traffic. Cars and
// trees are blocky models built here, so they match the rest of the city. Traffic is
// only scenery: it follows the clock, so everyone sees the same cars in the same places.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCK, CAR_COLOURS, CITY_FROM, LAMP_HEIGHT, ROAD_WIDTH, SIDEWALK, SIGNAL_HEIGHT, type Scenery } from '../sim/city';
import { lightFor, Traffic, type Light } from './traffic';
import { ARENA_LIMIT } from '../sim/map';

const CAR_PAINT = ['#d94a3d', '#2f6fd6', '#f2f2f2', '#2b2d33', '#f2b632', '#3aa66b', '#8e5bd6', '#9aa3ad'];

/** Ground layers, each a little above the last, far enough apart to never flicker. */
const LAYER = { road: 0.02, pavement: 0.05, lot: 0.08, paint: 0.1 } as const;

/** Cars per lane at each traffic setting. */
export const TRAFFIC_LEVELS = { off: 0, some: 2, busy: 5 } as const;
export type TrafficLevel = keyof typeof TRAFFIC_LEVELS;

const SIGNAL_COLOURS: Record<Light, THREE.Color> = {
  green: new THREE.Color('#38ff74'),
  yellow: new THREE.Color('#ffcc33'),
  red: new THREE.Color('#ff3b30'),
};
/** How far from a road's centre line each direction drives. */
const LANE_OFFSET = 3.4;
/** Traffic leaves and enters behind the buildings at the edge of the city. */
const TRAFFIC_REACH = ARENA_LIMIT - 10;

class Flat {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly color = new THREE.Color();

  rect(x0: number, z0: number, x1: number, z1: number, y: number, hex: string): void {
    this.color.set(hex);
    const { r, g, b } = this.color;
    this.positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    for (let i = 0; i < 6; i += 1) this.colors.push(r, g, b);
  }

  build(): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** True for a spot in the Spire district, which draws its own streets. */
const inDistrict = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) < CITY_FROM - ROAD_WIDTH / 2;

function buildGround(scenery: Scenery): THREE.Mesh {
  const flat = new Flat();
  const half = ROAD_WIDTH / 2;
  const edge = ARENA_LIMIT;

  // Asphalt along every road, stopping at the district.
  for (const line of scenery.roads) {
    const spans: Array<[number, number]> = Math.abs(line) < CITY_FROM ? [[-edge, -CITY_FROM + half], [CITY_FROM - half, edge]] : [[-edge, edge]];
    for (const [a, b] of spans) {
      flat.rect(line - half, a, line + half, b, LAYER.road, '#3b404c');
      flat.rect(a, line - half, b, line + half, LAYER.road, '#3b404c');
    }
  }

  // Pavements round every block, and its lot or lawn inside them.
  const lot = BLOCK / 2 - half;
  const areas = new Map(scenery.areas.map((a) => [`${a.x0 + (a.x1 - a.x0) / 2},${a.z0 + (a.z1 - a.z0) / 2}`, a]));
  for (let gx = -7; gx <= 7; gx += 1) {
    for (let gz = -7; gz <= 7; gz += 1) {
      if (Math.max(Math.abs(gx), Math.abs(gz)) <= 2) continue;
      const cx = gx * BLOCK;
      const cz = gz * BLOCK;
      flat.rect(cx - lot, cz - lot, cx + lot, cz + lot, LAYER.pavement, '#a3a7b2');
      const inner = lot - SIDEWALK;
      const area = areas.get(`${cx},${cz}`);
      const fill = area?.kind === 'park' ? '#5d9e58' : area?.kind === 'parking' ? '#4a4f5c' : '#8d919c';
      flat.rect(cx - inner, cz - inner, cx + inner, cz + inner, LAYER.lot, fill);
      if (area?.kind === 'park') {
        // A path across the lawn.
        flat.rect(cx - 1.4, cz - inner, cx + 1.4, cz + inner, LAYER.paint, '#cdbb98');
        flat.rect(cx - inner, cz - 1.4, cx + inner, cz + 1.4, LAYER.paint, '#cdbb98');
      } else if (area?.kind === 'parking') {
        for (const row of [-9, 3]) {
          for (let slot = -3; slot <= 3; slot += 1) {
            const x = cx + slot * 3.2 - 3.6;
            flat.rect(x - 0.06, cz + row - 2.6, x + 0.06, cz + row + 2.6, LAYER.paint, '#e8e8e8');
          }
        }
      }
    }
  }

  // Paint: dashed centre lines between junctions, and crossings at every junction.
  for (const line of scenery.roads) {
    for (let at = -edge; at < edge; at += 6) {
      if (scenery.roads.some((other) => Math.abs(at + 1.5 - other) < half + 1)) continue;
      for (const [x0, z0, x1, z1] of [
        [line - 0.12, at, line + 0.12, at + 3],
        [at, line - 0.12, at + 3, line + 0.12],
      ]) {
        if (inDistrict((x0 + x1) / 2, (z0 + z1) / 2)) continue;
        flat.rect(x0, z0, x1, z1, LAYER.paint - 0.04, '#eee4c7');
      }
    }
  }
  for (const lx of scenery.roads) {
    for (const lz of scenery.roads) {
      if (inDistrict(lx, lz)) continue;
      for (let i = -3; i <= 3; i += 1) {
        const s = i * 2 - 0.5;
        // Zebra stripes on all four sides of the junction.
        flat.rect(lx + s, lz - half - 3, lx + s + 1, lz - half - 0.6, LAYER.paint - 0.04, '#eeeeee');
        flat.rect(lx + s, lz + half + 0.6, lx + s + 1, lz + half + 3, LAYER.paint - 0.04, '#eeeeee');
        flat.rect(lx - half - 3, lz + s, lx - half - 0.6, lz + s + 1, LAYER.paint - 0.04, '#eeeeee');
        flat.rect(lx + half + 0.6, lz + s, lx + half + 3, lz + s + 1, LAYER.paint - 0.04, '#eeeeee');
      }
    }
  }
  return flat.build();
}

/** A box with one colour on every face, ready to merge. */
function part(w: number, h: number, d: number, x: number, y: number, z: number, hex: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y + h / 2, z);
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

/** A blocky car pointing along +z. White parts take the paint colour. */
function carGeometry(): THREE.BufferGeometry {
  const parts = [
    part(2, 0.65, 4.4, 0, 0.35, 0, '#ffffff'),
    part(1.84, 0.55, 2.3, 0, 1, -0.25, '#2c3c58'),
    part(1.6, 0.08, 2.1, 0, 1.55, -0.25, '#ffffff'),
  ];
  for (const [x, z] of [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.4], [0.95, -1.4]]) {
    parts.push(part(0.3, 0.62, 0.62, x, 0, z, '#1d1f24'));
  }
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** A car's head and tail lights, drawn unlit so they can shine at night. */
function carLightGeometry(): THREE.BufferGeometry {
  const parts = [
    part(0.34, 0.16, 0.06, -0.68, 0.72, 2.21, '#fff4c2'),
    part(0.34, 0.16, 0.06, 0.68, 0.72, 2.21, '#fff4c2'),
    part(0.34, 0.16, 0.06, -0.68, 0.72, -2.21, '#ff3a2d'),
    part(0.34, 0.16, 0.06, 0.68, 0.72, -2.21, '#ff3a2d'),
  ];
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** A pool of light on the ground, for lamps and headlights. Bright in the middle, gone at the rim. */
function glowGeometry(radius: number): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, 24).rotateX(-Math.PI / 2);
  const position = g.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const r = Math.hypot(position.getX(i), position.getZ(i)) / radius;
    const k = Math.max(0, 1 - r) ** 1.6;
    colors.set([k, k, k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A lamp post with its arm out along +x and +z, lamp head left off: it glows on its own. */
function lampGeometry(): { post: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const reach = 1.6;
  const parts = [
    part(0.26, LAMP_HEIGHT, 0.26, 0, 0, 0, '#5d6270'),
    part(0.14, 0.14, reach * 1.4, reach * 0.5, LAMP_HEIGHT - 0.2, reach * 0.5, '#5d6270'),
  ];
  // The arm runs diagonally, so turn it after building it straight.
  parts[1].translate(-reach * 0.5, 0, -reach * 0.5);
  parts[1].rotateY(Math.PI / 4);
  parts[1].translate(reach * 0.5, 0, reach * 0.5);
  const post = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  const head = part(0.7, 0.22, 0.7, reach, LAMP_HEIGHT - 0.42, reach, '#ffffff');
  return { post, head };
}

/** A traffic light pole, with a dark box at the top for the lenses to sit on. */
function signalGeometry(): THREE.BufferGeometry {
  const parts = [part(0.24, SIGNAL_HEIGHT, 0.24, 0, 0, 0, '#3c414c'), part(0.5, 1.2, 0.5, 0, SIGNAL_HEIGHT - 1.15, 0, '#20232a')];
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** A blocky tree, trunk and two layers of leaves, at full size. */
function treeGeometry(): THREE.BufferGeometry {
  const parts = [
    part(0.8, 2.6, 0.8, 0, 0, 0, '#6e4a2f'),
    part(3.6, 2.2, 3.6, 0, 2.6, 0, '#4f9a4a'),
    part(2.4, 1, 2.4, 0, 4.8, 0, '#62b25b'),
  ];
  const merged = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

export class Streets {
  readonly group = new THREE.Group();
  private readonly traffic: THREE.InstancedMesh;
  private flow: Traffic | null = null;
  private glow = true;
  private lightsOn = 0;
  private roads: number[] = [];
  private drivable: number[] = [];
  private lastUpdate = performance.now();
  private readonly signalLights: THREE.InstancedMesh;
  private shownNs: Light | null = null;
  private shownEw: Light | null = null;
  private readonly parked: THREE.InstancedMesh;
  private readonly parkedLights: THREE.InstancedMesh;
  private readonly parkedCars: Scenery['cars'];
  private readonly trafficLights: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly lampHeads: THREE.MeshBasicMaterial;
  private readonly carLights: THREE.MeshBasicMaterial;
  private readonly pools: THREE.MeshBasicMaterial;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly lampPools: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly turn = new THREE.Quaternion();
  private readonly at = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(scenery: Scenery) {
    this.group.add(buildGround(scenery));

    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const car = carGeometry();
    const paint = new THREE.Color();

    const parked = new THREE.InstancedMesh(car, material, scenery.cars.length);
    this.parked = parked;
    this.parkedCars = scenery.cars;
    // Cars the web moves leave their parking spot, so these bounds change.
    parked.frustumCulled = false;
    scenery.cars.forEach((c, i) => {
      this.turn.setFromAxisAngle(this.up, c.along === 'z' ? 0 : Math.PI / 2);
      this.matrix.compose(this.at.set(c.x, 0, c.z), this.turn, this.scale.set(1, 1, 1));
      parked.setMatrixAt(i, this.matrix);
      parked.setColorAt(i, paint.set(CAR_PAINT[c.color % CAR_COLOURS]));
    });
    parked.castShadow = true;
    parked.receiveShadow = true;
    this.group.add(parked);

    // Lights stay unlit by the scene, so at night they shine, and by day they just look painted.
    this.carLights = new THREE.MeshBasicMaterial({ vertexColors: true, color: '#9a9a9a' });
    const lights = carLightGeometry();
    const parkedLights = new THREE.InstancedMesh(lights, this.carLights, scenery.cars.length);
    this.parkedLights = parkedLights;
    parkedLights.frustumCulled = false;
    for (let i = 0; i < scenery.cars.length; i += 1) {
      parked.getMatrixAt(i, this.matrix);
      parkedLights.setMatrixAt(i, this.matrix);
    }
    this.group.add(parkedLights);

    // Street lamps: posts, heads that light up, and a pool of light under each.
    const lamp = lampGeometry();
    const posts = new THREE.InstancedMesh(lamp.post, material, scenery.lamps.length);
    this.lampHeads = new THREE.MeshBasicMaterial({ color: '#c9ccd4' });
    const heads = new THREE.InstancedMesh(lamp.head, this.lampHeads, scenery.lamps.length);
    this.pools = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: '#ffc46b',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    this.lampPools = new THREE.InstancedMesh(glowGeometry(6), this.pools, scenery.lamps.length);
    scenery.lamps.forEach((l, i) => {
      // The arm is built reaching to +x +z. Turn it to reach over the road.
      const angle = Math.atan2(l.outX, l.outZ) - Math.PI / 4;
      this.turn.setFromAxisAngle(this.up, angle);
      this.matrix.compose(this.at.set(l.x, 0, l.z), this.turn, this.scale.set(1, 1, 1));
      posts.setMatrixAt(i, this.matrix);
      heads.setMatrixAt(i, this.matrix);
      this.matrix.compose(this.at.set(l.x + l.outX * 1.6, LAYER.paint + 0.03, l.z + l.outZ * 1.6), this.turn, this.scale.set(1, 1, 1));
      this.lampPools.setMatrixAt(i, this.matrix);
    });
    posts.castShadow = true;
    this.lampPools.visible = false;
    this.group.add(posts, heads, this.lampPools);

    const trees = new THREE.InstancedMesh(treeGeometry(), material, Math.max(1, scenery.trees.length));
    trees.count = scenery.trees.length;
    scenery.trees.forEach((t, i) => {
      this.turn.setFromAxisAngle(this.up, (i * 0.9) % Math.PI);
      this.matrix.compose(this.at.set(t.x, 0, t.z), this.turn, this.scale.setScalar(t.size));
      trees.setMatrixAt(i, this.matrix);
    });
    trees.castShadow = true;
    trees.receiveShadow = true;
    this.group.add(trees);

    // Traffic drives the roads that skirt the district, and obeys the lights.
    const drivable = scenery.roads.filter((line) => Math.abs(line) >= CITY_FROM && Math.abs(line) <= ARENA_LIMIT - ROAD_WIDTH);
    this.roads = scenery.roads;
    this.drivable = drivable;
    this.setTraffic('busy');

    // Traffic light poles, each with a light facing along each road.
    const signalPost = new THREE.InstancedMesh(signalGeometry(), material, Math.max(1, scenery.signals.length));
    signalPost.count = scenery.signals.length;
    const lens = new THREE.BoxGeometry(0.36, 0.36, 0.36);
    this.signalLights = new THREE.InstancedMesh(lens, new THREE.MeshBasicMaterial({ color: '#ffffff' }), Math.max(1, scenery.signals.length * 2));
    this.signalLights.count = scenery.signals.length * 2;
    scenery.signals.forEach((at, i) => {
      this.matrix.compose(this.at.set(at.x, 0, at.z), this.turn.identity(), this.scale.set(1, 1, 1));
      signalPost.setMatrixAt(i, this.matrix);
      // One lens sticks out along x, for traffic on the east-west road; one along z.
      this.matrix.compose(this.at.set(at.x + 0.3, SIGNAL_HEIGHT - 0.55, at.z), this.turn, this.scale);
      this.signalLights.setMatrixAt(i * 2, this.matrix);
      this.matrix.compose(this.at.set(at.x, SIGNAL_HEIGHT - 0.55, at.z + 0.3), this.turn, this.scale);
      this.signalLights.setMatrixAt(i * 2 + 1, this.matrix);
    });
    signalPost.castShadow = true;
    this.group.add(signalPost, this.signalLights);

    const capacity = drivable.length * 4 * TRAFFIC_LEVELS.busy;
    this.traffic = new THREE.InstancedMesh(car, material, Math.max(1, capacity));
    for (let i = 0; i < capacity; i += 1) this.traffic.setColorAt(i, paint.set(CAR_PAINT[(i * 5) % CAR_PAINT.length]));
    // Moving instances change their bounds every frame, so this mesh is never culled.
    this.traffic.frustumCulled = false;
    this.traffic.castShadow = false;
    this.trafficLights = new THREE.InstancedMesh(lights, this.carLights, Math.max(1, capacity));
    this.trafficLights.frustumCulled = false;
    // Headlight beams on the road ahead of each moving car, only at night.
    this.beamMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      color: '#fff1c8',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    });
    const beam = glowGeometry(3.2).scale(0.8, 1, 1.6).translate(0, LAYER.paint + 0.05, 7);
    this.beams = new THREE.InstancedMesh(beam, this.beamMaterial, Math.max(1, capacity));
    this.beams.frustumCulled = false;
    this.beams.visible = false;
    this.group.add(this.traffic, this.trafficLights, this.beams);
    this.update();
  }

  /** Moves the traffic to where the shared clock says it is. */
  /** How busy the roads are: none, some, or busy. Changing it starts the traffic afresh. */
  setTraffic(level: TrafficLevel): void {
    this.flow = new Traffic(this.roads, this.drivable, TRAFFIC_REACH, ROAD_WIDTH / 2, TRAFFIC_LEVELS[level]);
    // Let it settle into queues and gaps before anyone sees it.
    for (let i = 0; i < 120; i += 1) this.flow.step(0.25, Date.now() / 1000 - 30 + i * 0.25);
  }

  /** Moves the traffic on, and turns the lights. */
  update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastUpdate) / 1000));
    this.lastUpdate = now;
    const seconds = Date.now() / 1000;

    const ns = lightFor(true, seconds);
    const ew = lightFor(false, seconds);
    if (ns !== this.shownNs || ew !== this.shownEw) {
      this.shownNs = ns;
      this.shownEw = ew;
      const count = this.signalLights.count / 2;
      for (let i = 0; i < count; i += 1) {
        this.signalLights.setColorAt(i * 2, SIGNAL_COLOURS[ew]);
        this.signalLights.setColorAt(i * 2 + 1, SIGNAL_COLOURS[ns]);
      }
      if (this.signalLights.instanceColor) this.signalLights.instanceColor.needsUpdate = true;
    }

    const flow = this.flow;
    this.traffic.count = flow ? flow.cars.length : 0;
    this.trafficLights.count = this.traffic.count;
    this.beams.count = this.traffic.count;
    if (!flow || !flow.cars.length) return;
    flow.step(dt, seconds);
    flow.cars.forEach((car, i) => {
      // Drive on the left: each direction keeps to its own side of the centre line.
      const at = flow.place(car, LANE_OFFSET);
      this.turn.setFromAxisAngle(this.up, at.yaw);
      this.matrix.compose(this.at.set(at.x, 0, at.z), this.turn, this.scale.set(1, 1, 1));
      this.traffic.setMatrixAt(i, this.matrix);
      this.trafficLights.setMatrixAt(i, this.matrix);
      if (this.beams.visible) this.beams.setMatrixAt(i, this.matrix);
    });
    this.traffic.instanceMatrix.needsUpdate = true;
    this.trafficLights.instanceMatrix.needsUpdate = true;
    if (this.beams.visible) this.beams.instanceMatrix.needsUpdate = true;
  }

  /**
   * Moves a parked car that the web has picked up, tumbling as it flies, or puts it
   * back where it parks with null. A size under 1 shrinks it away before it goes home.
   */
  placeCar(index: number, at: { x: number; y: number; z: number } | null, spin: number, size = 1): void {
    const car = this.parkedCars[index];
    if (!car) return;
    if (at) {
      this.turn.setFromEuler(new THREE.Euler(spin * 0.6, (car.along === 'z' ? 0 : Math.PI / 2) + spin, spin * 0.3));
      this.matrix.compose(this.at.set(at.x, at.y, at.z), this.turn, this.scale.setScalar(size));
    } else {
      this.turn.setFromAxisAngle(this.up, car.along === 'z' ? 0 : Math.PI / 2);
      this.matrix.compose(this.at.set(car.x, 0, car.z), this.turn, this.scale.set(1, 1, 1));
    }
    this.parked.setMatrixAt(index, this.matrix);
    this.parkedLights.setMatrixAt(index, this.matrix);
    this.parked.instanceMatrix.needsUpdate = true;
    this.parkedLights.instanceMatrix.needsUpdate = true;
  }

  /** Turns the street lamps and car lights from off (0) to fully on (1). */
  setLights(on: number): void {
    this.lightsOn = on;
    this.lampHeads.color.set('#c9ccd4').lerp(new THREE.Color('#fff2c6'), on);
    this.carLights.color.set('#9a9a9a').lerp(new THREE.Color('#ffffff'), on);
    this.pools.opacity = on * 0.42;
    this.beamMaterial.opacity = on * 0.3;
    this.lampPools.visible = this.glow && on > 0.02;
    this.beams.visible = this.glow && on > 0.02;
  }

  /** The pools of light on the ground at night. Off, the lamps and car lights still shine. */
  setGlow(glow: boolean): void {
    this.glow = glow;
    this.setLights(this.lightsOn);
  }
}
