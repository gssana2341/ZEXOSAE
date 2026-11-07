// How a web looks. The simulation treats a web as a straight line, so everything here
// is for the eye: the tip flies out, the line whips and settles, three twisted strands
// fan out where they grip, and a released web goes slack and falls away.

import * as THREE from 'three';
import type { V3 } from '../sim/map';

export const WEB = {
  /** Seconds for the tip to reach the web point. */
  shootTime: 0.09,
  /** Seconds for the whip along the line to die away. */
  settleTime: 0.4,
  /** Seconds a released web stays in the air. */
  /** A let-go web hangs on this long while it drops and thins away. */
  fadeTime: 1.1,
  fallSpeed: 9,
  segments: 22,
  strands: 3,
  /** Keeps a far web readable: the least width, per metre from the camera. */
  minWidthPerMetre: 0.0016,
  splatSize: 0.8,
} as const;

/** How far along the line the tip has flown, from 0 to 1. */
export function webReach(age: number): number {
  const t = Math.min(1, Math.max(0, age / WEB.shootTime));
  return 1 - (1 - t) * (1 - t);
}

/**
 * Sideways movement at a point on the web, from 0 at the hand to 1 at the web point.
 * Both ends stay pinned, and the whip fades as the line pulls tight.
 */
export function webRipple(t: number, age: number, length: number): number {
  const settle = Math.max(0, 1 - age / WEB.settleTime);
  const pinned = Math.sin(Math.PI * t);
  return pinned * Math.sin(t * 9 - age * 34) * settle * settle * Math.min(0.9, length * 0.04);
}

/** A flat burst of uneven spikes, used where a web lands and where it leaves the hand. */
function starGeometry(): THREE.BufferGeometry {
  const lengths = [1, 0.62, 0.88, 0.55, 0.96, 0.66, 0.82, 0.58];
  const positions: number[] = [];
  lengths.forEach((length, i) => {
    const angle = (i / lengths.length) * Math.PI * 2;
    const side = 0.17;
    positions.push(
      Math.cos(angle - side) * 0.2, Math.sin(angle - side) * 0.2, 0,
      Math.cos(angle) * length, Math.sin(angle) * length, 0,
      Math.cos(angle + side) * 0.2, Math.sin(angle + side) * 0.2, 0,
      0, 0, 0,
      Math.cos(angle - side) * 0.2, Math.sin(angle - side) * 0.2, 0,
      Math.cos(angle + side) * 0.2, Math.sin(angle + side) * 0.2, 0,
    );
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

const star = starGeometry();
const webMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide });

const along = new THREE.Vector3();
const across = new THREE.Vector3();
const lift = new THREE.Vector3();
const point = new THREE.Vector3();
const toCamera = new THREE.Vector3();
const edge = new THREE.Vector3();
const tip = new THREE.Vector3();

export class WebLine {
  readonly group = new THREE.Group();

  private readonly ribbon: THREE.Mesh;
  private readonly splat: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly hand = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private attached = false;
  private age = 0;
  /** Seconds since release, or below zero when there is nothing to fade. */
  private loose = -1;

  constructor() {
    const perStrand = (WEB.segments + 1) * 2;
    this.positions = new Float32Array(WEB.strands * perStrand * 3);

    const index: number[] = [];
    for (let s = 0; s < WEB.strands; s += 1) {
      for (let i = 0; i < WEB.segments; i += 1) {
        const a = s * perStrand + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setIndex(index);

    this.ribbon = new THREE.Mesh(geometry, webMaterial);
    this.ribbon.frustumCulled = false;
    this.splat = new THREE.Mesh(star, webMaterial);
    this.group.add(this.ribbon, this.splat);
    this.group.visible = false;
  }

  /** Hides the web at once, for leaving the game or a respawn. */
  clear(): void {
    this.attached = false;
    this.loose = -1;
    this.group.visible = false;
  }

  /** Call every frame. Without an anchor, the last web falls away on its own. */
  update(hand: THREE.Vector3, anchor: V3 | null, camera: THREE.Camera, dt: number, width: number, follow = false): void {
    if (anchor) {
      const moved =
        !this.attached ||
        Math.abs(anchor.x - this.anchor.x) + Math.abs(anchor.y - this.anchor.y) + Math.abs(anchor.z - this.anchor.z) > 0.01;
      // Following something in flight, the line is already out: no new shot each frame.
      this.age = follow ? WEB.settleTime : moved ? 0 : this.age + dt;
      this.attached = true;
      this.loose = -1;
      this.anchor.set(anchor.x, anchor.y, anchor.z);
      this.hand.copy(hand);
    } else if (this.attached) {
      this.attached = false;
      this.loose = 0;
    } else if (this.loose >= 0) {
      this.loose += dt;
      this.hand.y -= WEB.fallSpeed * dt;
      if (this.loose >= WEB.fadeTime) this.loose = -1;
    }

    this.group.visible = this.attached || this.loose >= 0;
    if (!this.group.visible) return;

    // Holds its width at first, then thins away, so a let-go web lingers instead of vanishing.
    const fade = this.attached ? 1 : 1 - (this.loose / WEB.fadeTime) ** 2;
    this.draw(camera, width * fade);

    const landed = Math.min(1, Math.max(0, (this.age - WEB.shootTime) / 0.12));
    // A flying projectile has not landed anywhere yet; only anchored webs splat.
    this.splat.visible = !follow && landed > 0;
    this.splat.position.copy(this.anchor);
    this.splat.lookAt(this.hand);
    // Hits a little too big, then settles.
    this.splat.scale.setScalar(WEB.splatSize * fade * (landed + Math.sin(landed * Math.PI) * 0.45));
  }

  private draw(camera: THREE.Camera, width: number): void {
    const reach = this.attached ? webReach(this.age) : 1;
    tip.copy(this.hand).lerp(this.anchor, reach);
    along.copy(tip).sub(this.hand);
    const length = along.length() || 1;
    along.divideScalar(length);
    across.set(along.z, 0, -along.x);
    if (across.lengthSq() < 0.001) across.set(1, 0, 0);
    across.normalize();
    lift.crossVectors(along, across);

    // A released web has no tension left, so it whips wider and sags.
    const slack = this.attached ? 0 : this.loose / WEB.fadeTime;
    const age = this.attached ? this.age : this.loose * 0.5;
    const eye = camera.getWorldPosition(edge);
    const eyeX = eye.x;
    const eyeY = eye.y;
    const eyeZ = eye.z;

    let v = 0;
    for (let s = 0; s < WEB.strands; s += 1) {
      const turn = (s / WEB.strands) * Math.PI * 2;
      const strandWidth = s === 0 ? 1 : 0.55;
      for (let i = 0; i <= WEB.segments; i += 1) {
        const t = i / WEB.segments;
        const pin = Math.sin(Math.PI * t);
        const ripple = webRipple(t, age, length) + pin * slack * Math.sin(t * 14 + turn) * 0.5;

        // The side strands wind round the main one, then spread apart at the grip.
        const angle = t * length * 0.9 + turn;
        const fan = s === 0 ? 0 : t ** 7 * 0.34;
        const twist = s === 0 ? 0 : 0.012 + fan;
        point
          .copy(this.hand)
          .addScaledVector(along, t * length)
          .addScaledVector(across, ripple + Math.cos(angle) * twist)
          .addScaledVector(lift, ripple * 0.4 + Math.sin(angle) * twist - pin * slack * 1.2);

        toCamera.set(eyeX - point.x, eyeY - point.y, eyeZ - point.z);
        const far = toCamera.length();
        const half = 0.5 * Math.max(width * strandWidth * (1 - t * 0.5), far * WEB.minWidthPerMetre * strandWidth * fadeOf(width));
        edge.crossVectors(along, toCamera).normalize().multiplyScalar(half);

        this.positions[v++] = point.x + edge.x;
        this.positions[v++] = point.y + edge.y;
        this.positions[v++] = point.z + edge.z;
        this.positions[v++] = point.x - edge.x;
        this.positions[v++] = point.y - edge.y;
        this.positions[v++] = point.z - edge.z;
      }
    }
    this.ribbon.geometry.getAttribute('position').needsUpdate = true;
  }
}

/** The far-away width has to fade with the web too, or it would never thin out. */
function fadeOf(width: number): number {
  return Math.min(1, width / 0.012);
}

/** A quick burst at the hand when a web or a shot leaves it. */
export class WebPuffs {
  readonly group = new THREE.Group();

  private readonly puffs: Array<{ mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; age: number }> = [];
  private next = 0;

  constructor(count = 4) {
    for (let i = 0; i < count; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(star, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.puffs.push({ mesh, material, age: 1 });
    }
  }

  fire(at: THREE.Vector3, color: string): void {
    const puff = this.puffs[this.next];
    this.next = (this.next + 1) % this.puffs.length;
    puff.age = 0;
    puff.material.color.set(color);
    puff.mesh.position.copy(at);
    puff.mesh.rotation.z = this.next * 1.3;
    puff.mesh.visible = true;
  }

  update(camera: THREE.Camera, dt: number): void {
    for (const puff of this.puffs) {
      if (!puff.mesh.visible) continue;
      puff.age += dt / 0.16;
      puff.mesh.visible = puff.age < 1;
      const spin = puff.mesh.rotation.z;
      puff.mesh.quaternion.copy(camera.quaternion);
      puff.mesh.rotateZ(spin);
      puff.mesh.scale.setScalar(0.06 + puff.age * 0.34);
      puff.material.opacity = 1 - puff.age;
    }
  }
}
