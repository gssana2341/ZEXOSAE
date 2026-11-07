// The time of day: sky, sun or moon, fog, and how much the city lights itself up.
// Day is bright and clear, sunset is the warm evening the city was built in, night
// turns on the windows, street lamps and car lights. 'cycle' drifts through them all,
// for watching the city go by.

import * as THREE from 'three';

export type TimeOfDay = 'morning' | 'day' | 'sunset' | 'night';
export type SkyChoice = TimeOfDay | 'cycle';

export const SKY_CHOICES: SkyChoice[] = ['morning', 'day', 'sunset', 'night', 'cycle'];
export const SKY_LABELS: Record<SkyChoice, string> = {
  morning: 'เช้า',
  sunset: 'เย็น',
  day: 'กลางวัน',
  night: 'กลางคืน',
  cycle: 'หมุนเวียนอัตโนมัติ',
};

/** Everything a time of day sets. Colours are hex strings so they read like a palette. */
export interface Look {
  skyLow: string;
  skyMid: string;
  skyHigh: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sun: string;
  sunPower: number;
  /** Where the light comes from. Normalised when used. */
  sunDir: [number, number, number];
  disc: string;
  discSize: number;
  exposure: number;
  clouds: string;
  land: string;
  /** Tint over the distant towers. */
  far: string;
  /** How brightly the windows of the generated buildings glow. */
  windows: number;
  /** How brightly the glass of the modelled buildings glows. */
  glass: number;
  /** Street lamps and car lights, from off to fully on. */
  lamps: number;
  stars: number;
}

export const LOOKS: Record<TimeOfDay, Look> = {
  morning: {
    skyLow: '#ffe1ae',
    skyMid: '#cddff0',
    skyHigh: '#79a8d4',
    fog: '#e7d2b7',
    fogNear: 300,
    fogFar: 1400,
    hemiSky: '#e4edff',
    hemiGround: '#978c7d',
    hemi: 2.0,
    sun: '#ffd39b',
    sunPower: 3.4,
    sunDir: [-0.72, 0.36, 0.6],
    disc: '#fff2d4',
    discSize: 30,
    exposure: 1.12,
    clouds: '#fff2e1',
    land: '#777887',
    far: '#c5b8ae',
    windows: 0.08,
    glass: 0,
    lamps: 0,
    stars: 0,
  },
  day: {
    skyLow: '#d6ebff',
    skyMid: '#93c4f2',
    skyHigh: '#3a78d0',
    fog: '#bfd8f0',
    fogNear: 280,
    fogFar: 1400,
    hemiSky: '#eef4ff',
    hemiGround: '#8c8f86',
    hemi: 2.1,
    sun: '#fff3df',
    sunPower: 3.3,
    sunDir: [-0.38, 0.84, 0.38],
    disc: '#fffbe8',
    discSize: 24,
    exposure: 1.05,
    clouds: '#ffffff',
    land: '#4c5570',
    far: '#a6b6dc',
    windows: 0.12,
    glass: 0,
    lamps: 0,
    stars: 0,
  },
  sunset: {
    skyLow: '#ffb27a',
    skyMid: '#d9799a',
    skyHigh: '#40509a',
    fog: '#d98f8a',
    fogNear: 220,
    fogFar: 1100,
    hemiSky: '#dbe2ff',
    hemiGround: '#a08088',
    hemi: 2.4,
    sun: '#ffd2a0',
    sunPower: 3,
    sunDir: [-0.72, 0.34, 0.6],
    disc: '#fff0c8',
    discSize: 26,
    exposure: 1.2,
    clouds: '#ffd7c4',
    land: '#3a3f58',
    far: '#8a93c4',
    windows: 0.55,
    // The glass only lights after dark: a faint scatter by day looks like broken texture.
    glass: 0,
    lamps: 0.35,
    stars: 0,
  },
  night: {
    skyLow: '#514938',
    skyMid: '#20222c',
    skyHigh: '#070b15',
    fog: '#3b3835',
    fogNear: 240,
    fogFar: 1150,
    hemiSky: '#8796b6',
    hemiGround: '#39332e',
    hemi: 0.95,
    sun: '#b9c9e3',
    sunPower: 0.8,
    sunDir: [0.45, 0.62, -0.5],
    disc: '#eef2ff',
    discSize: 17,
    exposure: 1.08,
    clouds: '#45413e',
    land: '#1d2028',
    far: '#66615a',
    windows: 0.9,
    glass: 1.35,
    lamps: 1,
    stars: 0.4,
  },
};

/** How long each stop of the cycle holds, and how long the change between stops takes, in seconds. */
const CYCLE: Array<[TimeOfDay, number]> = [
  ['morning', 45],
  ['day', 70],
  ['sunset', 50],
  ['night', 90],
  ['sunset', 35],
];
const CHANGE = 10;
/** While the light moves, shadows are redrawn this often rather than every frame. */
const SHADOW_EVERY = 1.2;

const color = (hex: string) => new THREE.Color(hex);

/** Somewhere between two looks. Numbers and colours both blend. */
export function blendLooks(a: Look, b: Look, k: number): Look {
  const out = { ...a } as Record<string, unknown>;
  for (const key of Object.keys(a) as Array<keyof Look>) {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number') out[key] = x + (y - x) * k;
    else if (typeof x === 'string' && typeof y === 'string') out[key] = `#${color(x).lerp(color(y), k).getHexString()}`;
    else if (Array.isArray(x) && Array.isArray(y)) out[key] = x.map((v, i) => v + ((y as number[])[i] - v) * k);
  }
  return out as unknown as Look;
}

/** Where in the cycle a moment falls: the look it comes from, the one it heads to, and how far between. */
export function cycleAt(seconds: number): { from: TimeOfDay; to: TimeOfDay; k: number } {
  const total = CYCLE.reduce((sum, [, hold]) => sum + hold + CHANGE, 0);
  let t = ((seconds % total) + total) % total;
  for (let i = 0; i < CYCLE.length; i += 1) {
    const [look, hold] = CYCLE[i];
    const next = CYCLE[(i + 1) % CYCLE.length][0];
    if (t < hold) return { from: look, to: look, k: 0 };
    t -= hold;
    if (t < CHANGE) {
      const s = t / CHANGE;
      return { from: look, to: next, k: s * s * (3 - 2 * s) };
    }
    t -= CHANGE;
  }
  return { from: 'day', to: 'day', k: 0 };
}

/** Things outside this file that change with the light. */
export interface Lit {
  /** Window materials: their emissive intensity is set from the look. */
  windows: THREE.MeshLambertMaterial[];
  /** Neat rows of light on modelled buildings, drawn only after dark. */
  panes: Array<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>;
  far: THREE.MeshLambertMaterial[];
  clouds: THREE.MeshBasicMaterial[];
  land: THREE.MeshBasicMaterial[];
  /** Street lamps and car lights, from 0 off to 1 on. */
  lamps: Array<(on: number) => void>;
}

export class Lighting {
  readonly group = new THREE.Group();
  readonly lit: Lit = { windows: [], panes: [], far: [], clouds: [], land: [], lamps: [] };
  private readonly dome: THREE.Mesh;
  private readonly disc: THREE.Mesh;
  private readonly stars: THREE.Points;
  private choice: SkyChoice = 'sunset';
  private current: Look = LOOKS.sunset;
  private sinceShadow = 0;
  private lastSun = new THREE.Vector3();
  private readonly radius = 1800;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly hemi: THREE.HemisphereLight,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.SphereGeometry(this.radius, 32, 16);
    dome.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(dome.getAttribute('position').count * 3), 3));
    this.dome = new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));

    this.disc = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ fog: false }));

    // Stars across the upper sky, a little brighter toward the top.
    const points: number[] = [];
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 900; i += 1) {
      const y = 0.08 + random() * 0.92;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      points.push(Math.cos(a) * r * 1700, y * 1700, Math.sin(a) * r * 1700);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: '#ffffff', size: 2.2, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }),
    );
    this.group.add(this.dome, this.disc, this.stars);
  }

  set(choice: SkyChoice): void {
    this.choice = choice;
    this.apply(choice === 'cycle' ? this.cycleLook() : LOOKS[choice], true);
  }

  /** Keeps a cycling sky moving. Fixed times of day cost nothing here. */
  update(dt: number): void {
    if (this.choice !== 'cycle') return;
    this.sinceShadow += dt;
    this.apply(this.cycleLook(), false);
  }

  private cycleLook(): Look {
    // Everyone's cycle follows the clock, so friends see the same sky.
    const { from, to, k } = cycleAt(Date.now() / 1000);
    return k === 0 ? LOOKS[from] : blendLooks(LOOKS[from], LOOKS[to], k);
  }

  private apply(look: Look, force: boolean): void {
    this.current = look;
    const position = this.dome.geometry.getAttribute('position');
    const colors = this.dome.geometry.getAttribute('color') as THREE.BufferAttribute;
    const low = color(look.skyLow);
    const mid = color(look.skyMid);
    const high = color(look.skyHigh);
    const c = new THREE.Color();
    for (let i = 0; i < position.count; i += 1) {
      const t = Math.max(0, position.getY(i) / this.radius);
      if (t < 0.22) c.copy(low).lerp(mid, t / 0.22);
      else c.copy(mid).lerp(high, Math.min(1, (t - 0.22) / 0.5));
      colors.setXYZ(i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;

    const dir = new THREE.Vector3(...look.sunDir).normalize();
    this.disc.position.copy(dir).multiplyScalar(1700);
    this.disc.scale.setScalar(look.discSize);
    (this.disc.material as THREE.MeshBasicMaterial).color.set(look.disc);
    (this.stars.material as THREE.PointsMaterial).opacity = look.stars;
    this.stars.visible = look.stars > 0.02;

    this.scene.background = color(look.fog);
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.color.set(look.fog);
      fog.near = look.fogNear;
      fog.far = look.fogFar;
    }
    this.hemi.color.set(look.hemiSky);
    this.hemi.groundColor.set(look.hemiGround);
    this.hemi.intensity = look.hemi;
    this.sun.color.set(look.sun);
    this.sun.intensity = look.sunPower;
    this.sun.position.copy(dir).multiplyScalar(850);
    this.renderer.toneMappingExposure = look.exposure;

    for (const m of this.lit.windows) m.emissiveIntensity = look.windows;
    for (const pane of this.lit.panes) {
      pane.visible = look.glass > 0.01;
      pane.material.opacity = Math.min(0.68, look.glass * 0.43);
    }
    for (const m of this.lit.far) {
      m.color.set(look.far);
      m.emissiveIntensity = look.glass;
    }
    for (const m of this.lit.clouds) m.color.set(look.clouds);
    for (const m of this.lit.land) m.color.set(look.land);
    for (const on of this.lit.lamps) on(look.lamps);

    // Redraw the shadows when the sun has moved, but not every frame of a slow change.
    const moved = this.lastSun.distanceTo(dir) > 0.01;
    if (moved && (force || this.sinceShadow >= SHADOW_EVERY)) {
      this.lastSun.copy(dir);
      this.sinceShadow = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  /** Applies the current look again, after something new joined the lit set. */
  refresh(): void {
    this.apply(this.current, true);
  }
}
