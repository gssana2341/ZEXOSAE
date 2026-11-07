// Everything that can land on another player, and what it costs them. Shared by the
// game, which reports a hit, and the host, which checks it and applies the damage.

/** Every way to hurt or move someone. */
export type HitKind =
  | 'shot'
  | 'snare'
  | 'melee'
  | 'heavy'
  | 'launch'
  | 'strike'
  | 'yank'
  | 'tug'
  | 'throw'
  | 'pound'
  | 'crate'
  | 'finisher';

export const HIT_KINDS: readonly HitKind[] = [
  'shot',
  'snare',
  'melee',
  'heavy',
  'launch',
  'strike',
  'yank',
  'tug',
  'throw',
  'pound',
  'crate',
  'finisher',
];

export interface HitSpec {
  damage: number;
  /** The fastest one player can land this kind again, in seconds. */
  cooldown: number;
  /** The farthest apart the two players can be, in metres. */
  range: number;
}

export const MAX_HP = 100;

export const HITS: Record<HitKind, HitSpec> = {
  shot: { damage: 25, cooldown: 0.28, range: 90 },
  snare: { damage: 0, cooldown: 2.5, range: 90 },
  melee: { damage: 9, cooldown: 0.16, range: 6 },
  heavy: { damage: 16, cooldown: 0.3, range: 7 },
  launch: { damage: 8, cooldown: 0.4, range: 6 },
  strike: { damage: 14, cooldown: 0.4, range: 8 },
  yank: { damage: 4, cooldown: 0.25, range: 40 },
  /** Holding someone on the web: many small pulls, none of them painful. */
  tug: { damage: 0, cooldown: 0.08, range: 45 },
  throw: { damage: 12, cooldown: 0.5, range: 7 },
  /** Scaled by how far the player fell: a short drop does a third of this. */
  pound: { damage: 40, cooldown: 0.8, range: 14 },
  crate: { damage: 30, cooldown: 0.8, range: 90 },
  finisher: { damage: 55, cooldown: 2, range: 7 },
};

/** Damage for a hit. `power` only matters for a ground pound, from 0.3 to 1. */
export function hitDamage(kind: HitKind, power = 1): number {
  const spec = HITS[kind];
  if (kind !== 'pound') return spec.damage;
  return Math.round(spec.damage * Math.min(1, Math.max(0.3, power)));
}

/** Short moves the body makes, which pick its animation for everyone who sees it. */
export const ACTS = [
  'jab',
  'cross',
  'kick',
  'launch',
  'strike',
  'cast',
  'pound',
  'finisher',
  'trick',
  'charge',
  'hang',
  'zip',
  'dodgeL',
  'dodgeR',
  'heal',
] as const;
export type Act = (typeof ACTS)[number];

/** Strongest shove one hit may give, and longest daze, so a bad report can't fling anyone. */
export const MAX_KNOCK = 32;
export const MAX_STUN = 1.5;
