import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { shotVisualTip } from '../src/render/shot-visual';
import type { Shot } from '../src/sim/world';

describe('the visible web shot', () => {
  it('starts at the moving hand and joins the unchanged aiming path', () => {
    const hand = new THREE.Vector3(2, 1, 3);
    const shot: Shot = { pos: { x: 0, y: 1.6, z: -4 }, dir: { x: 0, y: 0, z: -1 }, snare: false, travelled: 0 };
    const out = new THREE.Vector3();
    expect(shotVisualTip(shot, hand, out).toArray()).toEqual(hand.toArray());
    shot.travelled = 3.5;
    expect(shotVisualTip(shot, hand, out).x).toBeCloseTo(1);
    shot.travelled = 7;
    expect(shotVisualTip(shot, hand, out).toArray()).toEqual([0, 1.6, -4]);
    expect(shot.pos).toEqual({ x: 0, y: 1.6, z: -4 });
  });

  it('can use a remote hand, while falling back to the received path if it is unavailable', () => {
    const shot: Shot = { pos: { x: 4, y: 5, z: 6 }, dir: { x: 0, y: 0, z: -1 }, snare: false, travelled: 0, ghost: true };
    expect(shotVisualTip(shot, new THREE.Vector3(), new THREE.Vector3()).toArray()).toEqual([4, 5, 6]);
    expect(shotVisualTip(shot, new THREE.Vector3(1, 2, 3), new THREE.Vector3(), true).toArray()).toEqual([1, 2, 3]);
  });
});
