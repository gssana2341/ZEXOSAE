// Chooses which Kenney model dresses each building. The models are only skins: the
// collision box stays exactly as it is, so swapping art can never change how the
// arena plays. No three.js in here, so the choices can be tested directly.

import type { Box } from '../sim/map';

// The models look for Textures/colormap.png next to them.
const commercial = (name: string) => `commercial/${name}`;

const TOWERS = ['a', 'b', 'c', 'd', 'e'].map((k) => commercial(`building-skyscraper-${k}`));
const MID_RISE = ['a', 'g', 'l'].map((k) => commercial(`building-${k}`));
const LOW_RISE = ['e', 'k', 'c'].map((k) => commercial(`building-${k}`));

export const FAR_MODELS = ['a', 'b', 'c', 'e', 'f', 'g', 'h', 'j', 'wide-a'].map((k) =>
  commercial(`low-detail-building-${k}`),
);

/** Models scale to fit, but past these limits windows stretch too far to look right. */
const MAX_FOOTPRINT_RATIO = 2.3;
const MIN_WIDTH = 12;

/** The model for a building, or null if it keeps its generated look. */
export function shellFor(box: Box, index: number): string | null {
  if (box.landmark) return null;
  if (box.kind !== 'building' || (box.style !== 'glass' && box.style !== 'brick')) return null;

  const w = box.max.x - box.min.x;
  const d = box.max.z - box.min.z;
  const h = box.max.y - box.min.y;
  if (Math.min(w, d) < MIN_WIDTH) return null;
  if (Math.max(w, d) / Math.min(w, d) > MAX_FOOTPRINT_RATIO) return null;

  const tallness = h / Math.max(w, d);
  const list = tallness >= 1.5 ? TOWERS : tallness >= 0.85 ? MID_RISE : LOW_RISE;
  return list[index % list.length];
}

export function usedModels(boxes: Box[]): string[] {
  const shells = boxes.map(shellFor).filter((m): m is string => m !== null);
  return [...new Set([...shells, ...FAR_MODELS])];
}
