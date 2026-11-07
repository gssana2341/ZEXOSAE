import { describe, expect, it } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import * as THREE from 'three';
import { flushShell } from '../src/render/kenney';
import { splitWindowFaces } from '../src/render/window-lights';

describe('city window lights', () => {
  it('separates the original glass faces without putting new planes over the frame', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
      0, 0, 0.2, 2, 0, 0.2, 2, 0.2, 0.2, 0, 0.2, 0.2,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      0.72, 0.4, 0.72, 0.4, 0.72, 0.4, 0.72, 0.4,
      0.2, 0.4, 0.2, 0.4, 0.2, 0.4, 0.2, 0.4,
    ], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

    const glass = splitWindowFaces(geometry)!;
    expect(glass.getIndex()!.count).toBe(6);
    expect(Array.from(geometry.getIndex()!.array)).toEqual([4, 5, 6, 4, 6, 7]);
    for (let i = 0; i < glass.getAttribute('position').count; i += 1) {
      expect(glass.getAttribute('position').getZ(i)).toBe(0);
    }
    for (const index of geometry.getIndex()!.array) expect(geometry.getAttribute('position').getZ(index)).toBeCloseTo(0.2);
  });

  it('only selects broad vertical facades on distant low-detail buildings', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 10, 0, 0, 10, 10, 0,
      0, 0, 1, 0.5, 0, 1, 0.5, 0.5, 1,
      0, 10, 0, 10, 10, 0, 10, 10, 10,
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(Array(9).fill([0.47, 0.6]).flat(), 2));
    geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const glass = splitWindowFaces(geometry, true)!;
    expect(glass.getIndex()!.count).toBe(3);
    expect(Array.from(geometry.getIndex()!.array)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('finds glass in real city models while preserving every frame face', async () => {
    const io = new NodeIO().registerExtensions([KHRTextureTransform]);
    for (const name of ['building-c', 'building-skyscraper-a']) {
      const document = await io.read(`public/models/kenney/commercial/${name}.glb`);
      const node = document.getRoot().listNodes().find((n) => n.getMesh())!;
      const primitive = node.getMesh()!.listPrimitives()[0];
      const geometry = new THREE.BufferGeometry();
      for (const [source, target, size] of [['POSITION', 'position', 3], ['NORMAL', 'normal', 3], ['TEXCOORD_0', 'uv', 2]] as const) {
        geometry.setAttribute(target, new THREE.BufferAttribute(primitive.getAttribute(source)!.getArray() as Float32Array, size));
      }
      geometry.setIndex(new THREE.BufferAttribute(primitive.getIndices()!.getArray() as Uint16Array, 1));
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));
      const shell = flushShell(geometry).scale(34, 60, 34);
      const before = shell.getIndex()!.count;
      const glass = splitWindowFaces(shell);
      expect(glass, name).not.toBeNull();
      expect(glass!.getIndex()!.count, name).toBeGreaterThan(0);
      expect(shell.getIndex()!.count + glass!.getIndex()!.count, name).toBe(before);
      const uv = glass!.getAttribute('uv');
      for (let i = 0; i < uv.count; i += 1) {
        expect(uv.getX(i)).toBeGreaterThan(0.68);
        expect(uv.getX(i)).toBeLessThan(0.76);
      }
    }
  });
});
