// Loads the Kenney city models and bakes them into independently culled city chunks
// before the game starts, so running through the map never swaps building models.

import { scatterWindows } from './lighting';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameMap } from '../sim/map';
import { farTowers } from './arena';
import { yieldToBrowser } from './performance';
import { FAR_MODELS, shellFor, usedModels } from './shells';

const BASE = '/models/kenney/';
const QUARTER_TURN = Math.PI / 2;

interface Model {
  geometry: THREE.BufferGeometry;
  texture: THREE.Texture | null;
  roof?: number;
  /** Reused by every building dressed with this model. */
  shell?: THREE.BufferGeometry;
}

async function loadModel(loader: GLTFLoader, name: string): Promise<Model> {
  const gltf = await loader.loadAsync(`${BASE}${name}.glb`);
  let found: THREE.Mesh | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!found && o instanceof THREE.Mesh) found = o;
  });
  if (!found) throw new Error(`No mesh in ${name}`);

  const mesh: THREE.Mesh = found;
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
  }
  return { geometry, texture: (mesh.material as THREE.MeshStandardMaterial).map };
}

/**
 * The height of the main roof: the level with the most upward-facing area.
 * Roof clutter stands above it, so fitting by the very top would leave players
 * floating over the visible roof.
 */
function roofHeight(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const areaByLevel = new Map<number, number>();

  const triangles = (index ? index.count : position.count) / 3;
  for (let t = 0; t < triangles; t += 1) {
    const at = (n: number) => (index ? index.getX(t * 3 + n) : t * 3 + n);
    a.fromBufferAttribute(position, at(0));
    b.fromBufferAttribute(position, at(1));
    c.fromBufferAttribute(position, at(2));
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    const area = normal.length() / 2;
    if (area === 0 || normal.y / (area * 2) < 0.9) continue;
    const level = Math.round(((a.y + b.y + c.y) / 3) * 1000) / 1000;
    areaByLevel.set(level, (areaByLevel.get(level) ?? 0) + area);
  }

  geometry.computeBoundingBox();
  const top = geometry.boundingBox!.max.y;
  let best = top;
  let bestArea = 0;
  for (const [level, area] of areaByLevel) {
    if (level > top * 0.5 && area > bestArea) {
      best = level;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Drops every triangle above the roof. Roof clutter has no collision, so a player
 * would walk straight through it. A flat cap in arena.ts fills any gap this leaves.
 */
export function cutAbove(geometry: THREE.BufferGeometry, height: number, tolerance = 0.02): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!index) return geometry;

  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const top = Math.max(position.getY(a), position.getY(b), position.getY(c));
    if (top <= height + tolerance) kept.push(a, b, c);
  }
  geometry.setIndex(kept);
  return geometry;
}

/** Finds the broad outside wall planes, rather than the roof's projecting trim. */
function facadeBounds(geometry: THREE.BufferGeometry, roof: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const bins = { left: new Map<number, number>(), right: new Map<number, number>(), front: new Map<number, number>(), back: new Map<number, number>() };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const middleX = (box.min.x + box.max.x) / 2;
  const middleZ = (box.min.z + box.max.z) / 2;
  const height = roof - box.min.y;
  const triangles = Math.floor((index ? index.count : position.count) / 3);
  for (let t = 0; t < triangles; t += 1) {
    const at = (n: number) => index ? index.getX(t * 3 + n) : t * 3 + n;
    a.fromBufferAttribute(position, at(0));
    b.fromBufferAttribute(position, at(1));
    c.fromBufferAttribute(position, at(2));
    const y = (a.y + b.y + c.y) / 3;
    if (y < box.min.y + height * 0.1 || y > box.min.y + height * 0.85) continue;
    normal.subVectors(b, a).cross(edge.subVectors(c, a));
    const area = normal.length();
    if (area < 1e-8 || Math.abs(normal.y) > area * 0.15) continue;
    const add = (bin: Map<number, number>, value: number) => {
      const plane = Math.round(value * 200) / 200;
      bin.set(plane, (bin.get(plane) ?? 0) + area);
    };
    if (Math.abs(normal.x) > area * 0.95) {
      const x = (a.x + b.x + c.x) / 3;
      add(x < middleX ? bins.left : bins.right, x);
    } else if (Math.abs(normal.z) > area * 0.95) {
      const z = (a.z + b.z + c.z) / 3;
      add(z < middleZ ? bins.back : bins.front, z);
    }
  }
  const strongest = (bin: Map<number, number>, fallback: number) => {
    let selected = fallback;
    let area = 0;
    for (const [plane, size] of bin) if (size > area) { selected = plane; area = size; }
    return selected;
  };
  let minX = strongest(bins.left, box.min.x);
  let maxX = strongest(bins.right, box.max.x);
  let minZ = strongest(bins.back, box.min.z);
  let maxZ = strongest(bins.front, box.max.z);
  if (maxX - minX < (box.max.x - box.min.x) * 0.5) { minX = box.min.x; maxX = box.max.x; }
  if (maxZ - minZ < (box.max.z - box.min.z) * 0.5) { minZ = box.min.z; maxZ = box.max.z; }
  return { minX, maxX, minZ, maxZ };
}

/** Normalizes a playable building around its walls and removes projecting roof trim. */
export function flushShell(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = source.clone();
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const roof = roofHeight(g);
  const height = roof - box.min.y;
  const wall = facadeBounds(g, roof);
  cutAbove(g, roof, Math.max(0.001, height * 0.001));

  const position = g.getAttribute('position');
  const index = g.getIndex();
  const roofVertices = new Set<number>();
  const count = index ? index.count : position.count;
  // Only flatten the narrow roof strip. Clamping the entire facade would put
  // windows and trim directly on top of the wall, making both surfaces flicker.
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map((n) => index ? index.getX(i + n) : i + n);
    if (triangle.every((n) => position.getY(n) >= roof - height * 0.08)) {
      for (const n of triangle) roofVertices.add(n);
    }
  }
  const compress = (value: number, min: number, max: number, outerMin: number, outerMax: number) => {
    const allowance = (max - min) * 0.006;
    if (value < min) return min + (value - min) * Math.min(1, allowance / Math.max(min - outerMin, 1e-8));
    if (value > max) return max + (value - max) * Math.min(1, allowance / Math.max(outerMax - max, 1e-8));
    return value;
  };
  for (let i = 0; i < position.count; i += 1) {
    const roofPart = roofVertices.has(i);
    position.setXYZ(i,
      roofPart ? THREE.MathUtils.clamp(position.getX(i), wall.minX, wall.maxX)
        : compress(position.getX(i), wall.minX, wall.maxX, box.min.x, box.max.x),
      Math.min(position.getY(i), roof),
      roofPart ? THREE.MathUtils.clamp(position.getZ(i), wall.minZ, wall.maxZ)
        : compress(position.getZ(i), wall.minZ, wall.maxZ, box.min.z, box.max.z),
    );
  }
  position.needsUpdate = true;
  g.translate(-(wall.minX + wall.maxX) / 2, -box.min.y, -(wall.minZ + wall.maxZ) / 2);
  g.scale(1 / (wall.maxX - wall.minX), 1 / height, 1 / (wall.maxZ - wall.minZ));
  g.computeBoundingBox();
  return g;
}

/** Longer than this, in metres, and thinner than SLIVER_WIDTH, a triangle is a sliver. */
const SLIVER_LENGTH = 6;
const SLIVER_WIDTH = 0.06;

/**
 * Drops the long, hair-thin triangles left where trim was pressed flat against a wall.
 * They are too thin to show as a surface, so they shimmer as bright lines across the city.
 */
export function withoutSlivers(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.getIndex();
  if (!index) return g;
  const position = g.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const twiceArea = b.clone().sub(a).cross(c.clone().sub(a)).length();
    // The triangle's height across its longest edge.
    if (longest > SLIVER_LENGTH && twiceArea / longest < SLIVER_WIDTH) continue;
    kept.push(ia, ib, ic);
  }
  if (kept.length === index.count) return g;
  g.setIndex(kept);
  return g;
}

/** Stretches a model to exactly cover a footprint, with its roof at the given height. */
function fitted(
  model: Model,
  turn: number,
  min: THREE.Vector3,
  max: THREE.Vector3,
  flatRoof = false,
): THREE.BufferGeometry {
  if (flatRoof) {
    model.shell ??= flushShell(model.geometry);
    const shell = model.shell.clone();
    shell.rotateY(turn * QUARTER_TURN);
    shell.scale(max.x - min.x, max.y - min.y, max.z - min.z);
    shell.translate((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
    return withoutSlivers(shell);
  }
  const g = model.geometry.clone();
  g.rotateY(turn * QUARTER_TURN);
  g.computeBoundingBox();
  const box = g.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const roof = model.roof ??= roofHeight(model.geometry);

  const sx = (max.x - min.x) / size.x;
  const sy = (max.y - min.y) / (roof - box.min.y);
  const sz = (max.z - min.z) / size.z;
  g.translate(-center.x, -box.min.y, -center.z);
  g.scale(sx, sy, sz);
  g.translate((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
  return withoutSlivers(g);
}

/**
 * Paint washes for the buildings. Only a handful of models dress the whole city, so a
 * tint per building keeps neighbours from looking like copies.
 */
const TINTS = ['#ffffff', '#f6e7d6', '#e1ebf7', '#f1e3ee', '#e3f0e1', '#f8efd5', '#dfe2ea', '#f4dcd2'].map(
  (hex) => new THREE.Color(hex),
);

function tinted(geometry: THREE.BufferGeometry, tint: THREE.Color): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) colors.set([tint.r, tint.g, tint.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function mergedMesh(parts: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh {
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('Could not merge models');
  return new THREE.Mesh(geometry, material);
}

export interface KenneyCity {
  /** Buildings, with shadows. */
  city: THREE.Group;
  /** Distant towers. */
  far: THREE.Mesh;
  /** The buildings' material and the distant towers', for the time of day to light. */
  walls: THREE.MeshLambertMaterial;
  farMaterial: THREE.MeshLambertMaterial;
}

/**
 * A mask of the atlas with only its window glass kept, in a warm lamp colour. As
 * the emissive map it lights the windows at night and nothing else.
 */
function glassGlow(atlas: THREE.Texture | null): THREE.Texture | null {
  const image = atlas?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image?.width) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    // Glass in the kit is a clear light blue: bluer than it is red, and bright.
    const glass = b > 140 && b > r + 25 && g > r;
    d[i] = glass ? 255 : 0;
    d[i + 1] = glass ? 206 : 0;
    d[i + 2] = glass ? 130 : 0;
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = atlas!.flipY;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

export async function loadKenneyCity(map: GameMap, maxAnisotropy = 1): Promise<KenneyCity> {
  const loader = new GLTFLoader();
  const names = usedModels(map.boxes);
  const loaded = await Promise.all(names.map((name) => loadModel(loader, name)));
  const models = new Map(names.map((name, i) => [name, loaded[i]]));
  const get = (name: string) => models.get(name)!;

  // Each district keeps one consistent model and is culled independently.
  const chunks = new Map<string, { x: number; z: number; parts: THREE.BufferGeometry[] }>();
  const chunkSize = 112;
  let sliceStarted = performance.now();
  for (const [i, box] of map.boxes.entries()) {
    const name = shellFor(box, i);
    if (!name) continue;
    const min = new THREE.Vector3(box.min.x, box.min.y, box.min.z);
    const max = new THREE.Vector3(box.max.x, box.max.y, box.max.z);
    const x = Math.floor((box.min.x + box.max.x) / 2 / chunkSize);
    const z = Math.floor((box.min.z + box.max.z) / 2 / chunkSize);
    const key = `${x},${z}`;
    const chunk = chunks.get(key) ?? { x: (x + 0.5) * chunkSize, z: (z + 0.5) * chunkSize, parts: [] };
    chunk.parts.push(tinted(fitted(get(name), i % 4, min, max, true), TINTS[(i * 7) % TINTS.length]).translate(-chunk.x, 0, -chunk.z));
    chunks.set(key, chunk);
    if (performance.now() - sliceStarted > 6) {
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }

  const kitOf = (name: string) => get(name).texture;

  const city = new THREE.Group();
  const atlas = kitOf(FAR_MODELS[0]);
  if (atlas) {
    atlas.anisotropy = Math.max(1, Math.min(4, maxAnisotropy));
    atlas.needsUpdate = true;
  }
  const glow = glassGlow(atlas);
  const wallMaterial = new THREE.MeshLambertMaterial({
    map: atlas,
    vertexColors: true,
    emissiveMap: glow,
    emissive: new THREE.Color(glow ? '#ffffff' : '#000000'),
    emissiveIntensity: 0,
  });
  scatterWindows(wallMaterial);
  for (const chunk of chunks.values()) {
    const walls = mergedMesh(chunk.parts, wallMaterial);
    for (const part of chunk.parts) part.dispose();
    chunk.parts.length = 0;
    walls.geometry.computeBoundingSphere();
    walls.castShadow = true;
    walls.receiveShadow = true;
    walls.position.set(chunk.x, 0, chunk.z);
    city.add(walls);
    if (performance.now() - sliceStarted > 6) {
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }

  const farParts: THREE.BufferGeometry[] = [];
  for (const [i, tower] of farTowers().entries()) {
    farParts.push(fitted(
      get(FAR_MODELS[i % FAR_MODELS.length]),
      i % 4,
      new THREE.Vector3(tower.x - tower.w / 2, 0, tower.z - tower.w / 2),
      new THREE.Vector3(tower.x + tower.w / 2, tower.h, tower.z + tower.w / 2),
    ));
    if (performance.now() - sliceStarted > 6) {
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }
  const farMaterial = new THREE.MeshLambertMaterial({
    map: kitOf(FAR_MODELS[0]),
    color: '#8a93c4',
    emissiveMap: glassGlow(kitOf(FAR_MODELS[0])),
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0,
  });
  scatterWindows(farMaterial);
  const far = mergedMesh(farParts, farMaterial);
  for (const part of farParts) part.dispose();
  far.geometry.computeBoundingSphere();

  return { city, far, walls: wallMaterial, farMaterial };
}
