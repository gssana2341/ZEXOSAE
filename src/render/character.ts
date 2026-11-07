// The player character, built from coloured blocks: a visored helmet, a suit with a
// chest stripe, bracers, boots and a web pack on the back. Each body part is one
// merged mesh, and parts are shared between characters of the same colour, so a
// full room stays cheap to draw. The front of the body faces -z.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bodyPose, createSwingTrack, type BodyPose, type SwingTrack } from './body-pose';
import type { HeroBody } from './hero';
import { WebLine } from './web-line';

export interface Palette {
  suit: string;
  trim: string;
  dark: string;
  glow: string;
}

/** The first colour is the practice dummy. The rest go to players by their id. */
export const PALETTES: Palette[] = [
  { suit: '#d8434a', trim: '#f2f2f2', dark: '#2a2f3e', glow: '#ffcc66' },
  { suit: '#2a7de1', trim: '#e6eefc', dark: '#1b2436', glow: '#37e6ff' },
  { suit: '#e0456f', trim: '#ffe4ec', dark: '#2c2030', glow: '#ff9ad5' },
  { suit: '#25b36b', trim: '#e4fff0', dark: '#16302a', glow: '#7cff6b' },
  { suit: '#1fb6ff', trim: '#e6f6ff', dark: '#14283a', glow: '#ffd23f' },
  { suit: '#8a55e6', trim: '#efe6ff', dark: '#231c36', glow: '#c9a2ff' },
  { suit: '#12b5b0', trim: '#dcfffd', dark: '#123032', glow: '#5ff0e0' },
  { suit: '#e4c62c', trim: '#2b2b2b', dark: '#2e2a18', glow: '#fff08a' },
  { suit: '#d4d8e2', trim: '#3f7fd9', dark: '#262c3c', glow: '#37e6ff' },
];

interface BodyParts {
  torso: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  lowerArm: THREE.BufferGeometry;
  upperLeg: THREE.BufferGeometry;
  lowerLeg: THREE.BufferGeometry;
}

const ARM_LENGTH = 0.36;
const LEG_LENGTH = 0.38;
const RIG_HEIGHT = 1.2;

function colored(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  hex: string,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  const color = new THREE.Color(hex);
  const colors: number[] = [];
  for (let i = 0; i < geometry.getAttribute('position').count; i += 1) {
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

const merged = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;

function buildParts(p: Palette): BodyParts {
  const chest = 1.12 - RIG_HEIGHT;
  const head = 1.68 - RIG_HEIGHT;

  const torso = merged([
    colored(0.62, 0.72, 0.34, 0, chest, 0, p.suit),
    colored(0.2, 0.74, 0.36, 0, chest, 0, p.trim),
    colored(0.64, 0.1, 0.36, 0, chest - 0.34, 0, p.dark),
    colored(0.1, 0.1, 0.05, 0, chest - 0.34, -0.2, p.glow),
    // Helmet with a wide visor and a crest.
    colored(0.44, 0.42, 0.44, 0, head, 0, p.dark),
    colored(0.38, 0.11, 0.05, 0, head + 0.03, -0.235, p.glow),
    colored(0.08, 0.1, 0.34, 0, head + 0.25, 0.02, p.suit),
    colored(0.2, 0.08, 0.22, 0, head - 0.24, 0, p.dark),
    // Web pack on the back.
    colored(0.36, 0.44, 0.14, 0, chest + 0.08, 0.24, p.dark),
    colored(0.08, 0.3, 0.05, -0.1, chest + 0.08, 0.33, p.glow),
    colored(0.08, 0.3, 0.05, 0.1, chest + 0.08, 0.33, p.glow),
  ]);

  const armW = 0.17;
  const legW = 0.22;
  const upperArm = merged([
    colored(armW, ARM_LENGTH, armW * 1.15, 0, -ARM_LENGTH / 2, 0, p.suit),
    colored(armW + 0.08, 0.14, armW * 1.15 + 0.08, 0, -0.03, 0, p.trim),
  ]);
  const lowerArm = merged([
    colored(armW, ARM_LENGTH, armW * 1.15, 0, -ARM_LENGTH / 2, 0, p.dark),
    colored(armW + 0.05, 0.13, armW * 1.15 + 0.05, 0, -ARM_LENGTH * 0.62, 0, p.trim),
    colored(0.06, 0.05, 0.05, 0, -ARM_LENGTH * 0.62, -0.13, p.glow),
    colored(armW + 0.04, 0.12, armW * 1.15 + 0.04, 0, -ARM_LENGTH - 0.02, 0, p.suit),
  ]);
  const upperLeg = merged([
    colored(legW, LEG_LENGTH, legW * 1.15, 0, -LEG_LENGTH / 2, 0, p.dark),
    colored(legW + 0.02, 0.12, legW * 1.15 + 0.02, 0, -LEG_LENGTH * 0.5, 0, p.suit),
  ]);
  const lowerLeg = merged([
    colored(legW, LEG_LENGTH, legW * 1.15, 0, -LEG_LENGTH / 2, 0, p.dark),
    colored(legW + 0.04, 0.1, legW * 1.15 + 0.04, 0, -0.03, -0.01, p.trim),
    colored(legW + 0.05, 0.16, legW * 1.15 + 0.16, 0, -LEG_LENGTH + 0.03, -0.06, p.suit),
  ]);

  return { torso, upperArm, lowerArm, upperLeg, lowerLeg };
}

const partsByPalette = new Map<number, BodyParts>();

function partsFor(palette: number): BodyParts {
  let parts = partsByPalette.get(palette);
  if (!parts) {
    parts = buildParts(PALETTES[palette]);
    partsByPalette.set(palette, parts);
  }
  return parts;
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  upperMesh: THREE.Mesh;
  lowerMesh: THREE.Mesh;
  /** The end of the limb, where a web leaves the hand. */
  tip: THREE.Object3D;
}

export interface CharacterView {
  group: THREE.Group;
  /** Tips the whole body. Pivots at the chest, so it hangs naturally from a web. */
  rig: THREE.Group;
  torso: THREE.Mesh;
  armLeft: Limb;
  armRight: Limb;
  legLeft: Limb;
  legRight: Limb;
  palette: number;
  /** Replaces the block body once the animated model has loaded. */
  hero: HeroBody | null;
  pose: BodyPose;
  lastPos: THREE.Vector3;
  velocity: THREE.Vector3;
  wrap: THREE.Mesh;
  web: WebLine;
  swing: SwingTrack;
  /** The body's lean, eased so that a flip can run straight into the next web. */
  tilt: THREE.Vector3;
  /** Seconds since this character let go of a wall, to spot a pull-up over its top. */
  offWall: number;
  /** Which way the body faced on the wall it last held. */
  wallYaw: number;
  /** Counts down while the pull-up over a ledge plays. */
  ledge: number;
  /** Counts down while the crouch after a hard landing plays. */
  land: number;
  /** How far through a hand-over-hand climb up a line. */
  ropePhase: number;
  /** How far into a head-first dive the body is, eased, from 0 to 1. */
  dive: number;
  /** Which hand is higher on a line, so the web leaves from it. */
  ropeTop: 1 | -1;
  /** The mode last frame, to spot the moment of landing. */
  lastMode: string | undefined;
}

function buildLimb(parent: THREE.Object3D, x: number, y: number, length: number, upperGeo: THREE.BufferGeometry, lowerGeo: THREE.BufferGeometry): Limb {
  const upper = new THREE.Group();
  upper.position.set(x, y, 0);
  const upperMesh = new THREE.Mesh(upperGeo, material);
  upper.add(upperMesh);

  const lower = new THREE.Group();
  lower.position.y = -length;
  const lowerMesh = new THREE.Mesh(lowerGeo, material);
  lower.add(lowerMesh);
  upper.add(lower);

  const tip = new THREE.Object3D();
  tip.position.y = -length;
  lower.add(tip);

  parent.add(upper);
  return { upper, lower, upperMesh, lowerMesh, tip };
}

export function buildCharacter(): CharacterView {
  const parts = partsFor(0);
  const group = new THREE.Group();
  const rig = new THREE.Group();
  rig.position.y = RIG_HEIGHT;
  group.add(rig);

  const torso = new THREE.Mesh(parts.torso, material);
  rig.add(torso);

  const shoulder = 1.42 - RIG_HEIGHT;
  const hip = 0.76 - RIG_HEIGHT;
  const armLeft = buildLimb(rig, -0.42, shoulder, ARM_LENGTH, parts.upperArm, parts.lowerArm);
  const armRight = buildLimb(rig, 0.42, shoulder, ARM_LENGTH, parts.upperArm, parts.lowerArm);
  const legLeft = buildLimb(rig, -0.17, hip, LEG_LENGTH, parts.upperLeg, parts.lowerLeg);
  const legRight = buildLimb(rig, 0.17, hip, LEG_LENGTH, parts.upperLeg, parts.lowerLeg);

  const wrap = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 2.0, 0.8),
    new THREE.MeshBasicMaterial({ color: '#b8ecff', transparent: true, opacity: 0.6 }),
  );
  wrap.position.y = 1;
  wrap.visible = false;
  group.add(wrap);

  return {
    group,
    rig,
    torso,
    armLeft,
    armRight,
    legLeft,
    legRight,
    palette: 0,
    hero: null,
    pose: bodyPose({ speed: 0, forwardSpeed: 0, verticalSpeed: 0, rope: null, time: 0 }),
    lastPos: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    wrap,
    web: new WebLine(),
    swing: createSwingTrack(),
    tilt: new THREE.Vector3(),
    offWall: Infinity,
    wallYaw: 0,
    ledge: 0,
    land: 0,
    ropePhase: 0,
    dive: 0,
    ropeTop: 1,
    lastMode: undefined,
  };
}

/** Dresses a character in a palette. Only swaps shared geometry, so it costs almost nothing. */
export function paintCharacter(view: CharacterView, palette: number): void {
  if (view.palette === palette) return;
  view.palette = palette;
  view.hero?.setPalette(palette);
  const parts = partsFor(palette);
  view.torso.geometry = parts.torso;
  for (const arm of [view.armLeft, view.armRight]) {
    arm.upperMesh.geometry = parts.upperArm;
    arm.lowerMesh.geometry = parts.lowerArm;
  }
  for (const leg of [view.legLeft, view.legRight]) {
    leg.upperMesh.geometry = parts.upperLeg;
    leg.lowerMesh.geometry = parts.lowerLeg;
  }
}

/** Palette 0 is for practice dummies. Everyone else gets a colour from their player id. */
export function paletteFor(playerId: number | null): number {
  if (playerId === null) return 0;
  return 1 + (playerId % (PALETTES.length - 1));
}
