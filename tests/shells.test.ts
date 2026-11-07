import { existsSync, readFileSync, statSync } from 'node:fs';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { cutAbove, flushShell, withoutSlivers } from '../src/render/kenney';
import { shellFor, usedModels } from '../src/render/shells';
import { createArena, type Box } from '../src/sim/map';

const map = createArena();
const file = (name: string) => `public/models/kenney/${name}.glb`;

const building = (w: number, d: number, h: number, style: Box['style'] = 'glass'): Box => ({
  min: { x: 0, y: 0, z: 0 },
  max: { x: w, y: h, z: d },
  kind: 'building',
  style,
});

describe('Kenney models', () => {
  it('every model the map uses is in the project', () => {
    for (const name of usedModels(map.boxes)) expect(existsSync(file(name)), name).toBe(true);
  });

  it('ships the license with the models', () => {
    expect(readFileSync('public/models/kenney/commercial/License.txt', 'utf8')).toContain('CC0');
    expect(existsSync('public/models/kenney/commercial/Textures/colormap.png')).toBe(true);
  });

  it('keeps the download small', () => {
    const bytes = usedModels(map.boxes).reduce((sum, name) => sum + statSync(file(name)).size, 0);
    expect(bytes).toBeLessThan(3 * 1024 * 1024);
  });

  it('dresses most of the city', () => {
    const shells = map.boxes.filter((b, i) => shellFor(b, i));
    expect(shells.length).toBeGreaterThan(15);
  });

  it('picks towers for tall buildings and low blocks for wide ones', () => {
    expect(shellFor(building(26, 26, 62), 0)).toContain('skyscraper');
    expect(shellFor(building(30, 22, 12), 0)).toMatch(/building-[eck]$/);
  });

  it('leaves alone what a model would stretch badly, or that needs its own shape', () => {
    expect(shellFor(building(8, 26, 46), 0)).toBeNull();
    expect(shellFor(building(26, 26, 14, 'concrete'), 0)).toBeNull();
    expect(shellFor({ ...building(26, 26, 14), kind: 'ledge' }, 0)).toBeNull();
  });

  it('cuts roof clutter off, since it has no collision', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 10, 0, 0, 10, 1, 1, 10, 0, 1, 12, 0], 3),
    );
    g.setIndex([0, 1, 2, 3, 4, 5]);
    expect(cutAbove(g, 10).getIndex()!.count).toBe(3);
  });

  it('aligns an overhanging roof with the facade and collision footprint', () => {
    const walls = new THREE.BoxGeometry(2, 4, 2);
    walls.translate(0, 2, 0);
    const roof = new THREE.BoxGeometry(2.8, 0.25, 2.8);
    roof.translate(0, 4.125, 0);
    const source = mergeGeometries([walls, roof])!;
    const shell = flushShell(source);
    const position = shell.getAttribute('position');
    const index = shell.getIndex()!;
    const top: THREE.Vector3[] = [];
    const facade: THREE.Vector3[] = [];
    for (let i = 0; i < index.count; i += 1) {
      const p = new THREE.Vector3().fromBufferAttribute(position, index.getX(i));
      if (p.y > 0.99) top.push(p);
      if (p.y < 0.95) facade.push(p);
    }
    expect(top.length).toBeGreaterThan(0);
    expect(facade.length).toBeGreaterThan(0);
    for (const axis of ['x', 'z'] as const) {
      const roofEdge = Math.max(...top.map((p) => Math.abs(p[axis])));
      const wallEdge = Math.max(...facade.map((p) => Math.abs(p[axis])));
      expect(roofEdge).toBeCloseTo(wallEdge, 4);
      expect(roofEdge).toBeCloseTo(0.5, 4);
    }
  });

  it('keeps layered window geometry in front of the facade instead of flattening it onto the wall', () => {
    const walls = new THREE.BoxGeometry(2, 4, 2);
    walls.translate(0, 2, 0);
    const window = new THREE.BoxGeometry(0.04, 0.6, 0.6);
    window.translate(1.12, 2, 0);
    const roof = new THREE.BoxGeometry(2.8, 0.25, 2.8);
    roof.translate(0, 4.125, 0);
    const source = mergeGeometries([walls, window, roof])!;
    const shell = flushShell(source);
    const positions = shell.getAttribute('position');
    const facadeX = positions.getX(0);
    const windowX = Array.from({ length: window.getAttribute('position').count }, (_, i) => positions.getX(walls.getAttribute('position').count + i));
    expect(facadeX).toBeCloseTo(0.5, 4);
    expect(Math.min(...windowX)).toBeGreaterThan(facadeX + 0.0001);
    expect(Math.max(...windowX)).toBeLessThan(0.51);
  });

  it('preserves separate facade details in the actual city models', async () => {
    const io = new NodeIO().registerExtensions([KHRTextureTransform]);
    for (const name of ['building-c', 'building-skyscraper-a']) {
      const document = await io.read(file(`commercial/${name}`));
      const node = document.getRoot().listNodes().find((n) => n.getMesh())!;
      const primitive = node.getMesh()!.listPrimitives()[0];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(primitive.getAttribute('POSITION')!.getArray() as Float32Array, 3));
      geometry.setIndex(new THREE.BufferAttribute(primitive.getIndices()!.getArray() as Uint16Array, 1));
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
      const shell = flushShell(geometry);
      const positions = shell.getAttribute('position');
      const index = shell.getIndex()!;
      let separated = 0;
      for (let i = 0; i < index.count; i += 1) {
        const n = index.getX(i);
        if (positions.getY(n) < 0.9 && (Math.abs(positions.getX(n)) > 0.5001 || Math.abs(positions.getZ(n)) > 0.5001)) separated += 1;
      }
      expect(separated, name).toBeGreaterThan(0);
    }
  });
});

describe('sliver triangles', () => {
  it('drops long hair-thin triangles and keeps real faces', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          // A proper wall face.
          0, 0, 0, 10, 0, 0, 10, 10, 0,
          // A 20 m long, 2 cm wide sliver.
          0, 5, 0, 20, 5, 0, 10, 5.02, 0,
          // A small triangle, thin but short: real trim, kept.
          0, 0, 1, 1, 0, 1, 0.5, 0.01, 1,
        ],
        3,
      ),
    );
    g.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const out = withoutSlivers(g);
    expect(Array.from(out.getIndex()!.array)).toEqual([0, 1, 2, 6, 7, 8]);
  });
});
