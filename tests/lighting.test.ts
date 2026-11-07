import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendLooks, cycleAt, Lighting, LOOKS } from '../src/render/lighting';
import { buildCity } from '../src/sim/city';

describe('time of day', () => {
  it('blends smoothly from one look to the next', () => {
    const half = blendLooks(LOOKS.day, LOOKS.night, 0.5);
    expect(half.hemi).toBeCloseTo((LOOKS.day.hemi + LOOKS.night.hemi) / 2);
    expect(half.lamps).toBeCloseTo(0.5);
    expect(blendLooks(LOOKS.day, LOOKS.night, 0).skyHigh).toBe(LOOKS.day.skyHigh);
    expect(blendLooks(LOOKS.day, LOOKS.night, 1).skyHigh).toBe(LOOKS.night.skyHigh);
  });

  it('lights the city only after dark', () => {
    expect(LOOKS.day.lamps).toBe(0);
    expect(LOOKS.night.lamps).toBe(1);
    expect(LOOKS.night.glass).toBeGreaterThan(LOOKS.sunset.glass);
    expect(LOOKS.night.stars).toBeGreaterThan(0);
    expect(LOOKS.morning.lamps).toBe(0);
  });

  it('shows the prepared window lights at night and hides them in the morning', () => {
    const renderer = { toneMappingExposure: 1, shadowMap: { needsUpdate: false } } as THREE.WebGLRenderer;
    const lighting = new Lighting(new THREE.Scene(), new THREE.DirectionalLight(), new THREE.HemisphereLight(), renderer);
    lighting.set('night');
    const panes = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    lighting.lit.panes.push(panes);
    lighting.refresh();
    expect(panes.visible).toBe(true);
    expect(panes.material.opacity).toBeGreaterThan(0);
    lighting.set('morning');
    expect(panes.visible).toBe(false);
    expect(panes.material.opacity).toBe(0);
  });

  it('cycles through day, evening and night, holding each for a while', () => {
    const seen = new Set<string>();
    let changes = 0;
    for (let t = 0; t < 400; t += 1) {
      const at = cycleAt(t);
      seen.add(at.from);
      if (at.from !== at.to) changes += 1;
      expect(at.k).toBeGreaterThanOrEqual(0);
      expect(at.k).toBeLessThanOrEqual(1);
    }
    expect([...seen].sort()).toEqual(['day', 'morning', 'night', 'sunset']);
    // Mostly holding, with short changes between.
    expect(changes).toBeLessThan(80);
  });

  it('every street block has its lamps', () => {
    const city = buildCity();
    expect(city.scenery.lamps.length).toBeGreaterThan(300);
  });
});
