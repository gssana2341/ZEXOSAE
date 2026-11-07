/** Rules shared by the room directory, host, and game UI. */
export const GAME_MODES = ['deathmatch', 'teams', 'control', 'crown'] as const;
export type GameMode = (typeof GAME_MODES)[number];
export type Team = 'red' | 'blue';

export const MODE_INFO: Record<GameMode, { name: string; description: string; goal: number; seconds: number }> = {
  deathmatch: { name: 'เดธแมตช์เดี่ยว', description: 'ต่อสู้ทุกคน ใคร KO ครบ 15 ก่อนชนะ', goal: 15, seconds: 300 },
  teams: { name: 'เดธแมตช์ทีม', description: 'แบ่งทีมแดงและน้ำเงิน ทีมที่ KO ครบ 25 ก่อนชนะ', goal: 25, seconds: 300 },
  control: { name: 'ยึดจุด', description: 'ยืนในวงเพียงคนเดียว เก็บเวลาให้ครบ 45 วินาที', goal: 45, seconds: 300 },
  crown: { name: 'ชิงมงกุฎ', description: 'เก็บมงกุฎและถือไว้จนหมดเวลา คนที่ถืออยู่เป็นผู้ชนะ', goal: 0, seconds: 300 },
};

export const CONTROL_POINT = { x: 0, y: 0, z: 16, radius: 8, height: 10 } as const;
/** The loose crown floats at chest height until someone comes close enough to collect it. */
export const CROWN_SPAWN = { x: 0, y: 1, z: 16 } as const;
export const CROWN_PICKUP_RADIUS = 2.5;
export const CROWN_CARRY_HEIGHT = 2.25;
export const MIN_MATCH_PLAYERS = 2;

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode);
}
