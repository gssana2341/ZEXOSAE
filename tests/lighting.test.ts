import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { blendLooks, cycleAt, Lighting, LOOKS } from '../src/render/lighting';
import { buildCity, LAMP_HEIGHT } from '../src/sim/city';
import { createArena } from '../src/sim/map';
import { windowMaterial } from '../src/render/window-lights';

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
    expect(LOOKS.night.hemi).toBeLessThan(LOOKS.day.hemi);
    expect(LOOKS.night.sunPower).toBeLessThan(LOOKS.day.sunPower);
  });

  it('lights the original window surfaces at night and turns them off in the morning', () => {
    const renderer = { toneMappingExposure: 1, shadowMap: { needsUpdate: false } } as THREE.WebGLRenderer;
    const lighting = new Lighting(new THREE.Scene(), new THREE.DirectionalLight(), new THREE.HemisphereLight(), renderer);
    lighting.set('night');
    const glass = new THREE.MeshLambertMaterial();
    const farGlass = windowMaterial(null, true);
    lighting.lit.glass.push(glass, farGlass);
    lighting.refresh();
    expect(glass.emissiveIntensity).toBeGreaterThan(0);
    expect(farGlass.emissiveIntensity).toBeLessThan(glass.emissiveIntensity);
    expect(farGlass.color.getHexString()).toBe(new THREE.Color(LOOKS.night.far).getHexString());
    lighting.set('morning');
    expect(glass.emissiveIntensity).toBe(0);
    expect(farGlass.emissiveIntensity).toBe(0);
    expect(farGlass.color.getHexString()).toBe(new THREE.Color(LOOKS.morning.far).getHexString());
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
    const map = createArena();
    const central = map.scenery!.lamps.filter((lamp) => Math.max(Math.abs(lamp.x), Math.abs(lamp.z)) < 50);
    expect(central.length).toBeGreaterThanOrEqual(8);
    for (const lamp of central) {
      expect(map.boxes.some((box) => box.kind === 'prop' && box.max.y === LAMP_HEIGHT &&
        box.min.x < lamp.x && box.max.x > lamp.x && box.min.z < lamp.z && box.max.z > lamp.z)).toBe(true);
    }
  });
});
