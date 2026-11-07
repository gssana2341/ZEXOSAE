import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WEB, WebLine, webReach, webRipple } from '../src/render/web-line';

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 0, 5);
camera.updateMatrixWorld();
const hand = new THREE.Vector3(0, 0, 0);
const anchor = { x: 0, y: 20, z: 0 };
const dt = 1 / 60;

function lineEnd(web: WebLine): number {
  const ribbon = web.group.children[0] as THREE.Mesh;
  return ribbon.geometry.getAttribute('position').getY((WEB.segments + 1) * 2 - 1);
}

function settle(web: WebLine): void {
  for (let t = 0; t < 0.6; t += dt) web.update(hand, anchor, camera, dt, 0.03);
}

describe('web shape', () => {
  it('flies out to the web point and stops there', () => {
    expect(webReach(0)).toBe(0);
    expect(webReach(WEB.shootTime / 2)).toBeGreaterThan(0.5);
    expect(webReach(WEB.shootTime)).toBe(1);
    expect(webReach(5)).toBe(1);
  });

  it('stays pinned at both ends while it whips', () => {
    expect(webRipple(0, 0.05, 20)).toBeCloseTo(0);
    expect(webRipple(1, 0.05, 20)).toBeCloseTo(0);
    const middle = [0.2, 0.3, 0.4, 0.5, 0.6].map((t) => Math.abs(webRipple(t, 0.05, 20)));
    expect(Math.max(...middle)).toBeGreaterThan(0.1);
  });

  it('pulls straight once it has settled', () => {
    expect(webRipple(0.5, WEB.settleTime, 20)).toBeCloseTo(0);
    expect(webRipple(0.5, 3, 20)).toBeCloseTo(0);
  });
});

describe('web line', () => {
  it('starts short, then reaches the web point', () => {
    const web = new WebLine();
    web.update(hand, anchor, camera, dt, 0.03);
    expect(web.group.visible).toBe(true);
    expect(lineEnd(web)).toBeLessThan(1);
    settle(web);
    expect(lineEnd(web)).toBeCloseTo(20, 0);
  });

  it('shoots again for a new web point', () => {
    const web = new WebLine();
    settle(web);
    web.update(hand, { x: 0, y: 40, z: 0 }, camera, dt, 0.03);
    expect(lineEnd(web)).toBeLessThan(1);
  });

  it('does not show an impact burst on a projectile still flying', () => {
    const web = new WebLine();
    web.update(hand, anchor, camera, dt, 0.03, true);
    expect(web.group.children[1].visible).toBe(false);
    settle(web);
    expect(web.group.children[1].visible).toBe(true);
  });

  it('falls away after release, then hides', () => {
    const web = new WebLine();
    settle(web);
    web.update(hand, null, camera, dt, 0.03);
    expect(web.group.visible).toBe(true);
    for (let t = 0; t < WEB.fadeTime + 0.1; t += dt) web.update(hand, null, camera, dt, 0.03);
    expect(web.group.visible).toBe(false);
  });

  it('can be hidden at once', () => {
    const web = new WebLine();
    web.update(hand, anchor, camera, dt, 0.03);
    web.clear();
    web.update(hand, null, camera, dt, 0.03);
    expect(web.group.visible).toBe(false);
  });
});
