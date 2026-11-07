import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { preloadScenes } from '../src/render/preload';

describe('preparing the city before play', () => {
  it('uploads off-screen and hidden objects, then restores their visibility before baking shadows', async () => {
    const scene = new THREE.Scene();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const farBuilding = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    hidden.add(farBuilding);
    scene.add(hidden);
    const camera = new THREE.PerspectiveCamera();
    const finish = vi.fn();
    const setRenderTarget = vi.fn();
    let draws = 0;
    const renderer = {
      getRenderTarget: () => null,
      shadowMap: { needsUpdate: true },
      compileAsync: vi.fn(async () => {
        expect(hidden.visible).toBe(true);
        expect(farBuilding.frustumCulled).toBe(false);
      }),
      setRenderTarget,
      render: vi.fn(() => {
        draws += 1;
        expect(hidden.visible).toBe(draws === 1);
        expect(farBuilding.frustumCulled).toBe(draws !== 1);
      }),
      getContext: () => ({ finish }),
    } as unknown as THREE.WebGLRenderer;

    await preloadScenes(renderer, [{ scene, camera }]);
    expect(draws).toBe(2);
    expect(hidden.visible).toBe(false);
    expect(farBuilding.frustumCulled).toBe(true);
    expect(setRenderTarget).toHaveBeenLastCalledWith(null);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('restores the scene and renderer if shader preparation fails', async () => {
    const scene = new THREE.Scene();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    hidden.visible = false;
    scene.add(hidden);
    const previous = new THREE.WebGLRenderTarget(2, 2);
    const setRenderTarget = vi.fn();
    const renderer = {
      getRenderTarget: () => previous,
      shadowMap: { needsUpdate: true },
      compileAsync: vi.fn(async () => { throw new Error('shader failed'); }),
      setRenderTarget,
    } as unknown as THREE.WebGLRenderer;

    await expect(preloadScenes(renderer, [{ scene, camera: new THREE.PerspectiveCamera() }])).rejects.toThrow('shader failed');
    expect(hidden.visible).toBe(false);
    expect(hidden.frustumCulled).toBe(true);
    expect(renderer.shadowMap.needsUpdate).toBe(true);
    expect(setRenderTarget).toHaveBeenLastCalledWith(previous);
    previous.dispose();
  });
});
