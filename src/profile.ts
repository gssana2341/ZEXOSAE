// There are no accounts yet, so a player's name and lifetime stats live in this
// browser only. Players are told this on their first visit.

export interface Profile {
  name: string;
  kills: number;
  deaths: number;
  /** True once the player has seen the notice about where their data lives. */
  noticeSeen: boolean;
}

const PROFILE_KEY = 'zexosae.profile';
const OLD_SETTINGS_KEY = 'zexosae.settings';

function oldName(): string {
  try {
    const old = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY) ?? '{}') as { playerName?: unknown };
    return typeof old.playerName === 'string' ? old.playerName : '';
  } catch {
    return '';
  }
}

export function loadProfile(): Profile {
  const base: Profile = { name: oldName(), kills: 0, deaths: 0, noticeSeen: false };
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Profile>) } : base;
  } catch {
    return base;
  }
}

/** Returns false when the browser refuses to store it, such as in a private window. */
export function saveProfile(profile: Profile): boolean {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}
