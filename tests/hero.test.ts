import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clipFor, type ClipMode } from '../src/render/body-pose';
import { ACTS } from '../src/sim/hits';
import * as THREE from 'three';
import { armPoseFor, armTriangles, HeroBody, type HeroAsset } from '../src/render/hero';

const file = 'public/models/hero/hero.glb';

function readGlb() {
  const bytes = readFileSync(file);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}

describe('hero model', () => {
  it('is small enough for the web', () => {
    expect(statSync(file).size).toBeLessThan(1024 * 1024);
  });

  it('ships with its license', () => {
    expect(existsSync('public/models/hero/License.txt')).toBe(true);
  });

  it('has a clip for every move the game asks for', () => {
    const clips = readGlb().animations.map((a: { name: string }) => a.name);
    const moves: ClipMode[] = [
      ...(['ground', 'air', 'wall', 'swing', 'dash', 'zip', 'hang', 'strike', 'pound', 'slide', 'stun'] as const),
      ...ACTS,
      'climb',
      'ledge',
      'land',
    ];
    for (const mode of moves) {
      for (const speed of [0, 4, 12]) {
        for (const verticalSpeed of [-10, 0, 10]) {
          for (const sideSpeed of [-6, 0, 6]) {
            for (const forwardSpeed of [-6, 0, 6]) expect(clips).toContain(clipFor({ mode, speed, verticalSpeed, forwardSpeed, sideSpeed }).clip);
          }
        }
      }
    }
  });

  it('has the bones the web arm needs', () => {
    const names = readGlb().nodes.map((n: { name: string }) => n.name);
    for (const bone of ['upperarm_r', 'lowerarm_r', 'hand_r']) expect(names).toContain(bone);
  });
});

describe('first-person arm cut', () => {
  it('keeps only triangles that follow an arm bone', () => {
    const geometry = new THREE.BufferGeometry();
    // Vertices 0-2 follow the forearm, 3-5 the spine, and 6 mostly the spine.
    const bones = [0, 0, 0, 1, 1, 1, 1];
    const skin = bones.flatMap((bone) => [bone, 0, 0, 0]);
    const weight = bones.flatMap(() => [1, 0, 0, 0]);
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    geometry.setIndex([0, 1, 2, 3, 4, 5, 0, 1, 6]);

    expect(armTriangles(geometry, ['lowerarm_r', 'spine_03'])).toEqual([0, 1, 2]);
  });
});

describe('first-person arm poses', () => {
  const web = new THREE.Vector3(0, 0.6, -0.8).normalize();
  const moment = { mode: 'swing', web, webSide: 1 as const, twoHands: false, stride: 0, kick: 0, kickSide: 1 as const };

  it('closes the hand on the web and leaves the other relaxed', () => {
    const pose = armPoseFor(moment);
    expect(pose.gripRight).toBe(1);
    expect(pose.gripLeft).toBeLessThan(0.5);
    expect(pose.rightLower.dot(web)).toBeCloseTo(1);
  });

  it('uses whichever hand has the web', () => {
    const pose = armPoseFor({ ...moment, webSide: -1 });
    expect(pose.gripLeft).toBe(1);
    expect(pose.leftLower.dot(web)).toBeCloseTo(1);
    expect(pose.gripRight).toBeLessThan(0.5);
  });

  it('puts both hands on the web when asked', () => {
    const pose = armPoseFor({ ...moment, twoHands: true });
    expect(pose.gripRight).toBe(1);
    expect(pose.gripLeft).toBe(1);
  });

  it('climbs hand over hand', () => {
    const climb = { ...moment, mode: 'wall', web: null };
    const a = armPoseFor({ ...climb, stride: Math.PI / 2 });
    const b = armPoseFor({ ...climb, stride: -Math.PI / 2 });
    expect(a.rightLower.y).toBeGreaterThan(a.leftLower.y);
    expect(b.leftLower.y).toBeGreaterThan(b.rightLower.y);
  });

  it('opens the hand that fires, and mirrors the two arms at rest', () => {
    const rest = armPoseFor({ ...moment, mode: 'ground', web: null });
    expect(rest.leftUpper.x).toBeCloseTo(-rest.rightUpper.x);
    const firing = armPoseFor({ ...moment, mode: 'ground', web: null, kick: 1, kickSide: -1 });
    expect(firing.gripLeft).toBeLessThan(rest.gripLeft);
  });

  it('makes a fist with the hand that punches', () => {
    const jab = armPoseFor({ ...moment, mode: 'ground', web: null, action: 'jab', actionProgress: 0.5 });
    const cross = armPoseFor({ ...moment, mode: 'ground', web: null, action: 'cross', actionProgress: 0.5 });
    expect(jab.gripLeft).toBe(1);
    expect(jab.gripRight).toBeLessThan(1);
    expect(cross.gripRight).toBe(1);
    expect(cross.gripLeft).toBeLessThan(1);
  });
});

describe('action playback', () => {
  it('fits an animation to its action and restarts a shared clip for a new action', () => {
    const scene = new THREE.Group();
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    scene.add(mesh);
    const names = ['upperarm_r', 'lowerarm_r', 'middle_01_r', 'hand_r', 'upperarm_l', 'lowerarm_l', 'middle_01_l', 'hand_l', 'thigh_r', 'calf_r', 'foot_r', 'thigh_l', 'calf_l', 'foot_l'];
    const bones = names.map((name) => {
      const bone = new THREE.Bone();
      bone.name = name;
      mesh.add(bone);
      return bone;
    });
    mesh.bind(new THREE.Skeleton(bones));
    const clip = new THREE.AnimationClip('Punch_Cross', 1, [
      new THREE.VectorKeyframeTrack('upperarm_r.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
    const asset: HeroAsset = { scene, clips: new Map([[clip.name, clip]]), map: null, scale: 1 };
    const hero = new HeroBody(asset);
    const arm = hero.root.getObjectByName('upperarm_r')!;

    hero.play('Punch_Cross', 1, 0.25, 'cross');
    hero.update(0.125, false);
    expect(arm.position.x).toBeCloseTo(0.5);
    hero.play('Punch_Cross', 1, 0.25, 'cross');
    hero.update(0.0625, false);
    expect(arm.position.x).toBeCloseTo(0.75);
    hero.play('Punch_Cross', 1, 0.5, 'finisher');
    hero.update(0.125, false);
    expect(arm.position.x).toBeCloseTo(0.25);
  });
});
