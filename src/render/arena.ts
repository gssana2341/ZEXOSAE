// Draws the district. Everything is generated here, with no model or image files,
// so the download stays small. Boxes are merged into a few meshes to keep draw calls
// low on phones. Nothing in this file affects play: collision lives in sim/map.ts.

import { CITY_FROM } from '../sim/city';
import * as THREE from 'three';
import { ARENA_LIMIT, type Box, type BoxKind, type GameMap, type V3 } from '../sim/map';
import { shellFor } from './shells';

const GRID_METRES = 4;
/** One window texture repeat, in metres. */
const FACADE_METRES = 24;

/** These colours are game rules, so they stay bright against the muted city. */
const KIND_COLORS: Partial<Record<BoxKind, string>> = {
  ground: '#5a6072',
  run: '#1fd6c4',
  beam: '#ff8a2b',
  ledge: '#f5c842',
  deck: '#8d93a6',
};

const STYLE_COLORS = {
  glass: ['#7fa6d6', '#6f97cc', '#8ab3dd'],
  brick: ['#b0705c', '#9c6352', '#c08068'],
  concrete: ['#a9acb8', '#9aa0ae'],
  steel: ['#5c6577', '#4f5869'],
};

const ROOF_COLOR = '#a3a7b8';

/** Repeatable noise, so the city looks the same for every player. */
function noise(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  quad(corners: V3[], normal: V3, uvs: Array<[number, number]>, color: THREE.Color, shades = [1, 1, 1, 1]): void {
    const base = this.positions.length / 3;
    corners.forEach((p, i) => {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(normal.x, normal.y, normal.z);
      this.uvs.push(uvs[i][0], uvs[i][1]);
      this.colors.push(color.r * shades[i], color.g * shades[i], color.b * shades[i]);
    });
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A plain box with the same colour on all sides. */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, hex: string): void {
    const color = new THREE.Color(hex);
    for (const face of boxFaces({ x: cx - w / 2, y: cy - h / 2, z: cz - d / 2 }, { x: cx + w / 2, y: cy + h / 2, z: cz + d / 2 })) {
      this.quad(face.corners, face.normal, [[0, 0], [1, 0], [1, 1], [0, 1]], color);
    }
  }

  build(material: THREE.Material): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    return new THREE.Mesh(geometry, material);
  }
}

interface Face {
  corners: V3[];
  normal: V3;
  axis: 'x' | 'y' | 'z';
  u: 'x' | 'y' | 'z';
  v: 'x' | 'y' | 'z';
}

function boxFaces(min: V3, max: V3): Face[] {
  const faces: Face[] = [];
  const axes: Array<['x' | 'y' | 'z', 'x' | 'y' | 'z', 'x' | 'y' | 'z']> = [
    ['x', 'y', 'z'],
    ['y', 'z', 'x'],
    ['z', 'x', 'y'],
  ];
  for (const [n, u, v] of axes) {
    for (const sign of [1, -1]) {
      const plane = sign > 0 ? max[n] : min[n];
      const flat: Array<[number, number]> = [
        [min[u], min[v]],
        [max[u], min[v]],
        [max[u], max[v]],
        [min[u], max[v]],
      ];
      if (sign < 0) flat.reverse();
      const corners = flat.map(([cu, cv]) => {
        const p: V3 = { x: 0, y: 0, z: 0 };
        p[n] = plane;
        p[u] = cu;
        p[v] = cv;
        return p;
      });
      faces.push({
        corners,
        normal: { x: n === 'x' ? sign : 0, y: n === 'y' ? sign : 0, z: n === 'z' ? sign : 0 },
        axis: n,
        u,
        v,
      });
    }
  }
  return faces;
}

// --------------------------------------------------------------- textures

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d')!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function gridTexture(): THREE.Texture {
  return canvasTexture(128, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(16, 24, 40, 0.24)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, 128, 128);
  });
}

/** Eight floors of varied glass repeat without stretching on the tallest towers. */
function windowTexture(lit: boolean): THREE.Texture {
  return canvasTexture(256, (ctx) => {
    ctx.fillStyle = lit ? '#000000' : '#63758b';
    ctx.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const on = noise(row * 8 + col + 3) > 0.64;
        if (lit && !on) continue;
        const shade = noise(row * 8 + col + 71);
        const x = col * 32 + 5;
        const y = row * 32 + 6;
        if (lit) {
          ctx.fillStyle = shade < 0.5 ? '#ffdb91' : shade < 0.8 ? '#fff6db' : '#b8dbff';
          ctx.fillRect(x + 1, y + 1, 20, 18);
        } else {
          ctx.fillStyle = '#34475e';
          ctx.fillRect(x, y, 22, 20);
          const pane = ctx.createLinearGradient(x, y, x + 20, y + 18);
          pane.addColorStop(0, shade < 0.4 ? '#b6cfe0' : '#9ebdd1');
          pane.addColorStop(0.52, shade < 0.4 ? '#779bb8' : '#7394ad');
          pane.addColorStop(1, '#506d89');
          ctx.fillStyle = pane;
          ctx.fillRect(x + 1, y + 1, 20, 18);
          ctx.fillStyle = 'rgba(232, 246, 255, 0.22)';
          ctx.fillRect(x + 3, y + 2, 1, 16);
          ctx.fillStyle = 'rgba(25, 42, 60, 0.38)';
          ctx.fillRect(x + 11, y + 1, 1, 18);
        }
      }
    }
  });
}

// ------------------------------------------------------------- level meshes

/** How far the roof filler sits under a model's roof, and in from its walls, in metres. */
const CAP_DROP = 0.3;
const CAP_INSET = 0.12;
/** How far inside a modelled building its plain backing wall stands. */
const BACKING_INSET = 1.2;

/** Returns the meshes that the Kenney buildings replace once they have loaded. */
function buildBoxes(map: GameMap, group: THREE.Group): { replaced: THREE.Object3D[]; windows: THREE.MeshLambertMaterial } {
  const facade = new MeshBuilder();
  const solid = new MeshBuilder();
  const coveredFacade = new MeshBuilder();
  const coveredSolid = new MeshBuilder();
  const caps = new MeshBuilder();
  const color = new THREE.Color();
  const capColor = new THREE.Color('#34394a');

  map.boxes.forEach((box: Box, i) => {
    if (box.kind === 'bound' || box.kind === 'prop') return;

    const palette = box.style ? STYLE_COLORS[box.style] : [KIND_COLORS[box.kind] ?? '#888888'];
    const wallHex = palette[i % palette.length];
    const windowed = box.kind === 'building' && (box.style === 'glass' || box.style === 'brick');
    const covered = shellFor(box, i) !== null;

    for (const face of boxFaces(box.min, box.max)) {
      const isTop = face.axis === 'y' && face.normal.y > 0;
      color.set(isTop && box.kind === 'building' ? ROOF_COLOR : wallHex);

      const onWall = windowed && face.axis !== 'y';
      const metres = onWall ? FACADE_METRES : GRID_METRES;
      const uvs = face.corners.map((p): [number, number] => [p[face.u] / metres, p[face.v] / metres]);
      // Walls sit in shade at street level, so the city looks grounded without real occlusion.
      const shades = face.corners.map((p) => (box.kind === 'building' && face.axis !== 'y' && p.y === box.min.y ? 0.6 : 1));
      if (covered && isTop) {
        // Fills any gap left by cutting off roof clutter. It sits well under the model's
        // roof and stops short of its walls: a few centimetres apart, the two surfaces
        // fight over every pixel on distant towers and the roofs flicker.
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const inset = (value: number, middle: number) => value + Math.sign(middle - value) * CAP_INSET;
        const lowered = face.corners.map((p) => ({ x: inset(p.x, cx), y: p.y - CAP_DROP, z: inset(p.z, cz) }));
        caps.quad(lowered, face.normal, uvs, capColor);
      }
      const target = onWall ? (covered ? coveredFacade : facade) : covered ? coveredSolid : solid;
      if (covered && face.axis !== 'y') {
        // A modelled building keeps a plain wall of its own just inside the model. Some
        // models don't fill their whole box, and without this the gap showed straight
        // through under a full roof. Deep enough not to cover the model's recesses.
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const inset = (value: number, middle: number) => value + Math.sign(middle - value) * BACKING_INSET;
        const backed = face.corners.map((p) => ({ x: inset(p.x, cx), y: p.y, z: inset(p.z, cz) }));
        target.quad(backed, face.normal, onWall && face.axis === 'x' ? uvs.map(([a, b]) => [b, a]) : uvs, color, shades);
        continue;
      }
      if (covered && face.axis === 'y') continue;
      target.quad(face.corners, face.normal, onWall && face.axis === 'x' ? uvs.map(([a, b]) => [b, a]) : uvs, color, shades);
    }
  });

  const gridMaterial = new THREE.MeshLambertMaterial({ map: gridTexture(), vertexColors: true });
  // The cap fills holes in model roofs; bias it behind the model to avoid depth fighting.
  const capMaterial = gridMaterial.clone();
  capMaterial.polygonOffset = true;
  capMaterial.polygonOffsetFactor = 1;
  capMaterial.polygonOffsetUnits = 2;
  const wallMaterial = new THREE.MeshLambertMaterial({
    map: windowTexture(false),
    emissiveMap: windowTexture(true),
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0.55,
    vertexColors: true,
  });

  const replaced = [coveredSolid.build(gridMaterial), coveredFacade.build(wallMaterial)];
  for (const mesh of [solid.build(gridMaterial), facade.build(wallMaterial), caps.build(capMaterial), ...replaced]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { replaced, windows: wallMaterial };
}

/** Road paint, pavements and the plaza floor. All flat, so none of it can trip a player. */
function buildGround(map: GameMap, group: THREE.Group): void {
  const flat = new MeshBuilder();
  const up: V3 = { x: 0, y: 1, z: 0 };
  const rect = (x0: number, z0: number, x1: number, z1: number, y: number, hex: string) => {
    flat.quad(
      [
        { x: x0, y, z: z1 },
        { x: x1, y, z: z1 },
        { x: x1, y, z: z0 },
        { x: x0, y, z: z0 },
      ],
      up,
      [[x0 / GRID_METRES, z1 / GRID_METRES], [x1 / GRID_METRES, z1 / GRID_METRES], [x1 / GRID_METRES, z0 / GRID_METRES], [x0 / GRID_METRES, z0 / GRID_METRES]],
      new THREE.Color(hex),
    );
  };

  // Pavement around every block that reaches the ground.
  for (const box of map.boxes) {
    if (box.kind !== 'building' || box.min.y !== 0 || box.max.x - box.min.x < 6) continue;
    // Out in the street grid, every block already has its pavement.
    if (Math.max(Math.abs((box.min.x + box.max.x) / 2), Math.abs((box.min.z + box.max.z) / 2)) >= CITY_FROM - 20) continue;
    rect(box.min.x - 2, box.min.z - 2, box.max.x + 2, box.max.z + 2, 0.02, '#8a8e9e');
  }

  rect(-21, -21, 21, 21, 0.03, '#b7b3ad');
  rect(-9, -9, 9, 9, 0.04, '#d6b98c');

  // Dashed lane around the plaza.
  const lane = 28;
  for (let s = -26; s < 26; s += 5) {
    rect(s, -lane - 0.12, s + 2.6, -lane + 0.12, 0.05, '#f2e9c9');
    rect(s, lane - 0.12, s + 2.6, lane + 0.12, 0.05, '#f2e9c9');
    rect(-lane - 0.12, s, -lane + 0.12, s + 2.6, 0.05, '#f2e9c9');
    rect(lane - 0.12, s, lane + 0.12, s + 2.6, 0.05, '#f2e9c9');
  }

  // Crossings from the plaza to the road.
  for (let i = -3; i <= 3; i += 1) {
    const a = i * 2.2 - 0.6;
    rect(a, 22, a + 1.2, 25, 0.05, '#eeeeee');
    rect(a, -25, a + 1.2, -22, 0.05, '#eeeeee');
    rect(22, a, 25, a + 1.2, 0.05, '#eeeeee');
    rect(-25, a, -22, a + 1.2, 0.05, '#eeeeee');
  }

  // The street grid beyond the district draws its own roads and pavements (streets.ts).

  const mesh = flat.build(new THREE.MeshLambertMaterial({ map: gridTexture(), vertexColors: true }));
  mesh.receiveShadow = true;
  group.add(mesh);
}

export interface FarTower {
  x: number;
  z: number;
  w: number;
  h: number;
}

/** Where the distant towers stand, shared with the Kenney skyline. */
export function farTowers(): FarTower[] {
  const towers: FarTower[] = [];
  for (let i = 0; i < 90; i += 1) {
    const angle = (i / 90) * Math.PI * 2 + noise(i) * 0.05;
    // Keep decorative, non-solid towers outside the enlarged playable square.
    const distance = (ARENA_LIMIT + 24) * Math.SQRT2 + 30 + noise(i + 100) * 170;
    towers.push({
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      w: 16 + noise(i + 200) * 22,
      h: 40 + noise(i + 300) * 130,
    });
  }
  return towers;
}

/** Distant towers past the edge of the arena, and clouds. Returns the towers, which Kenney models replace. */
function buildSkyline(group: THREE.Group): { far: THREE.Mesh; clouds: THREE.MeshBasicMaterial; land: THREE.MeshBasicMaterial } {
  const towers = new MeshBuilder();
  const clouds = new MeshBuilder();

  for (const t of farTowers()) towers.box(t.x, t.h / 2, t.z, t.w, t.h, t.w, '#57618a');

  for (let i = 0; i < 16; i += 1) {
    const x = (noise(i + 400) - 0.5) * 1200;
    const z = (noise(i + 500) - 0.5) * 1200;
    const y = 130 + noise(i + 600) * 60;
    // White, so the time of day can tint them.
    clouds.box(x, y, z, 40 + noise(i + 700) * 40, 3, 18 + noise(i + 800) * 16, '#f2f2f2');
    clouds.box(x + 8, y + 3, z, 22, 3, 12, '#ffffff');
  }

  const far = towers.build(new THREE.MeshLambertMaterial({ map: windowTexture(false), vertexColors: true }));
  group.add(far);
  const cloudMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, color: '#ffd7c4' });
  group.add(clouds.build(cloudMaterial));

  const landMaterial = new THREE.MeshBasicMaterial({ color: '#3a3f58' });
  const land = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), landMaterial);
  land.rotation.x = -Math.PI / 2;
  land.position.y = -4.5;
  group.add(land);
  return { far, clouds: cloudMaterial, land: landMaterial };
}

/** Low in the sky, for long shadows across the plaza. */
export const SUN_DIRECTION = new THREE.Vector3(-0.72, 0.34, 0.6).normalize();
export const FOG_COLOR = '#d98f8a';

export interface Arena {
  group: THREE.Group;
  /** Hidden once the Kenney city has loaded. */
  placeholders: THREE.Object3D[];
  /** Materials the time of day changes. */
  windows: THREE.MeshLambertMaterial;
  far: THREE.MeshLambertMaterial;
  clouds: THREE.MeshBasicMaterial;
  land: THREE.MeshBasicMaterial;
}

export function buildArena(map: GameMap): Arena {
  const group = new THREE.Group();
  // The sky itself belongs to the time of day (lighting.ts).
  const skyline = buildSkyline(group);
  const { windows } = buildBoxes(map, group);
  buildGround(map, group);
  return {
    group,
    // The backing walls under the models stay: only the stand-in skyline is swapped out.
    placeholders: [skyline.far],
    windows,
    far: skyline.far.material as THREE.MeshLambertMaterial,
    clouds: skyline.clouds,
    land: skyline.land,
  };
}
