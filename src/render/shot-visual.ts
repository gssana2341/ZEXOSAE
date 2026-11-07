import * as THREE from 'three';
import type { Shot } from '../sim/world';

/** Draw the first metres from the moving hand, then meet the unchanged aim path. */
export function shotVisualTip(shot: Shot, hand: THREE.Vector3, out: THREE.Vector3, fromHand = !shot.ghost): THREE.Vector3 {
  out.set(shot.pos.x, shot.pos.y, shot.pos.z);
  if (!fromHand || shot.snare || shot.crate) return out;
  const blend = Math.min(1, Math.max(0, shot.travelled / 7));
  return out.lerpVectors(hand, out, blend);
}
