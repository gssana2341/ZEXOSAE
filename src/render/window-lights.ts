import * as THREE from 'three';

/** The Kenney colour atlas uses this swatch for actual window glass. */
function glassUv(uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): boolean {
  const u = uv.getX(index);
  const v = uv.getY(index);
  return u > 0.68 && u < 0.76 && v > 0.25 && v < 0.5;
}

/**
 * Moves real glass faces into a separate mesh, leaving the building frame in the
 * original mesh. The new faces reuse the exact model positions, so no pane can
 * float in front of a column or compete with the frame for the same pixels.
 * Distant low-detail buildings have plain facades instead of glass; only their
 * large vertical wall faces are selected.
 */
export function splitWindowFaces(source: THREE.BufferGeometry, distant = false): THREE.BufferGeometry | null {
  const index = source.getIndex();
  const uv = source.getAttribute('uv');
  const position = source.getAttribute('position');
  if (!index || !uv || !position) return null;

  const kept: number[] = [];
  const selected: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const edge = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    a.fromBufferAttribute(position, tri[0]);
    b.fromBufferAttribute(position, tri[1]);
    c.fromBufferAttribute(position, tri[2]);
    normal.subVectors(b, a).cross(edge.subVectors(c, a));
    const area2 = normal.length();
    const vertical = area2 > 1e-8 && Math.abs(normal.y) < area2 * 0.15;
    const pane = distant
      ? vertical && area2 > 4 && tri.every((n) => uv.getX(n) > 0.42 && uv.getX(n) < 0.51 && uv.getY(n) > 0.45 && uv.getY(n) < 0.8)
      : vertical && tri.every((n) => glassUv(uv, n));
    (pane ? selected : kept).push(...tri);
  }
  if (!selected.length) return null;

  const out = new THREE.BufferGeometry();
  const remap = new Map<number, number>();
  const vertices: number[] = [];
  const faces = selected.map((old) => {
    let next = remap.get(old);
    if (next === undefined) {
      next = vertices.length;
      vertices.push(old);
      remap.set(old, next);
    }
    return next;
  });
  for (const name of Object.keys(source.attributes)) {
    const attr = source.getAttribute(name);
    const values = new Float32Array(vertices.length * attr.itemSize);
    vertices.forEach((old, i) => {
      for (let component = 0; component < attr.itemSize; component += 1) {
        values[i * attr.itemSize + component] = attr.getComponent(old, component);
      }
    });
    out.setAttribute(name, new THREE.BufferAttribute(values, attr.itemSize));
  }
  out.setIndex(faces);
  source.setIndex(kept);
  return out;
}

/** A single glass material lights only real window faces in warm, white and cool tones. */
export function windowMaterial(atlas: THREE.Texture | null, distant = false): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map: atlas,
    vertexColors: true,
    emissive: '#ffffff',
    emissiveIntensity: 0,
  });
  // The backdrop should sit behind the playable city, not shine like a foreground wall.
  material.userData.emissiveScale = distant ? 0.3 : 1;
  material.userData.distant = distant;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWindowWorld;\nvarying vec3 vWindowNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWindowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWindowNormal = normalize(mat3(modelMatrix) * normal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWindowWorld;
varying vec3 vWindowNormal;
float windowHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float side = step(abs(vWindowNormal.z), abs(vWindowNormal.x));
  float across = mix(vWindowWorld.x, vWindowWorld.z, side);
  float depth = mix(vWindowWorld.z, vWindowWorld.x, side);
  vec2 grid = vec2(across / ${distant ? '5.5' : '3.0'}, vWindowWorld.y / ${distant ? '5.6' : '3.2'});
  vec2 cell = floor(grid);
  vec2 edge = min(fract(grid), 1.0 - fract(grid));
  vec2 aa = clamp(fwidth(grid), vec2(0.004), vec2(0.2));
  float shape = smoothstep(0.13 - aa.x, 0.13 + aa.x, edge.x) * smoothstep(0.17 - aa.y, 0.17 + aa.y, edge.y);
  vec3 id = vec3(cell, floor(depth / 8.0));
  float lit = step(0.60, windowHash(id));
  float shade = windowHash(id + vec3(31.0, 17.0, 7.0));
  vec3 warm = vec3(1.0, 0.50, 0.14);
  vec3 white = vec3(1.0, 0.93, 0.82);
  vec3 blue = vec3(0.16, 0.48, 1.0);
  vec3 tint = shade < 0.53 ? warm : (shade < 0.8 ? white : blue);
  float distanceFade = smoothstep(${distant ? '0.16, 0.4' : '0.35, 0.85'}, max(fwidth(grid.x), fwidth(grid.y)));
  float strength = mix(lit * shape, ${distant ? '0.06' : '0.13'}, distanceFade);
  totalEmissiveRadiance *= strength * mix(tint, vec3(0.85, 0.78, 0.67), distanceFade);
}`);
  };
  material.customProgramCacheKey = () => `city-glass-v3-${distant ? 'far' : 'near'}`;
  return material;
}
