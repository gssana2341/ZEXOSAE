import * as THREE from 'three';
import type { Box } from '../sim/map';
import type { FarTower } from './arena';
import { shellFor } from './shells';

/** Width and height of the repeating eight-window tile, in metres. */
const TILE = 24;
const OFFSET = 0.25;

/** Four orderly window grids per modelled building, with roofs and corners left clear. */
export function windowGeometry(boxes: Box[], skyline: FarTower[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const add = (minX: number, maxX: number, minZ: number, maxZ: number, base: number, top: number, seed: number) => {
    const y0 = base + 3.2;
    const y1 = top - 1.4;
    if (y1 <= y0) return;
    const left = minX + 1;
    const right = maxX - 1;
    const back = minZ + 1;
    const front = maxZ - 1;
    if (right <= left || front <= back) return;
    const quad = (a: number[], b: number[], c: number[], d: number[], width: number, side: number) => {
      const first = positions.length / 3;
      positions.push(...a, ...b, ...c, ...d);
      const u = ((seed * 5 + side * 3) % 8) / 8;
      const v = ((seed * 3) % 8) / 8;
      uvs.push(u, v, u + width / TILE, v, u + width / TILE, v + (y1 - y0) / TILE, u, v + (y1 - y0) / TILE);
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    };
    quad([left, y0, maxZ + OFFSET], [right, y0, maxZ + OFFSET], [right, y1, maxZ + OFFSET], [left, y1, maxZ + OFFSET], right - left, 0);
    quad([right, y0, minZ - OFFSET], [left, y0, minZ - OFFSET], [left, y1, minZ - OFFSET], [right, y1, minZ - OFFSET], right - left, 1);
    quad([maxX + OFFSET, y0, front], [maxX + OFFSET, y0, back], [maxX + OFFSET, y1, back], [maxX + OFFSET, y1, front], front - back, 2);
    quad([minX - OFFSET, y0, back], [minX - OFFSET, y0, front], [minX - OFFSET, y1, front], [minX - OFFSET, y1, back], front - back, 3);
  };

  boxes.forEach((box, i) => {
    if (shellFor(box, i)) add(box.min.x, box.max.x, box.min.z, box.max.z, box.min.y, box.max.y, i);
  });
  skyline.forEach((tower, i) => add(tower.x - tower.w / 2, tower.x + tower.w / 2, tower.z - tower.w / 2, tower.z + tower.w / 2, 0, tower.h, i + boxes.length));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** A single preloaded, mipmapped texture keeps window lights stable at a distance. */
export function cityWindowLights(boxes: Box[], skyline: FarTower[], maxAnisotropy: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the city window lights');
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const hash = ((row * 73 + col * 37 + row * col * 19 + 29) % 101) / 101;
      if (hash < 0.58) continue;
      ctx.fillStyle = hash > 0.89 ? '#c9dcf2' : hash > 0.73 ? '#ffe6b4' : '#e8bd84';
      ctx.fillRect(col * 32 + 6, row * 32 + 8, 20, 16);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.max(1, Math.min(4, maxAnisotropy));
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  return new THREE.Mesh(windowGeometry(boxes, skyline), material);
}
