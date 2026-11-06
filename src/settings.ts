export type Quality = 'low' | 'medium' | 'high';

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'swing'
  | 'dash'
  | 'slide'
  | 'shoot'
  | 'snare'
  | 'reset'
  | 'scores';

export interface Settings {
  quality: Quality;
  fov: number;
  mouseSens: number;
  touchSens: number;
  aimAssist: boolean;
  reduceMotion: boolean;
  swapButtons: boolean;
  keys: Record<Action, string>;
  /** Only present in saved settings. */
  version?: number;
}

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'เดินหน้า',
  back: 'ถอยหลัง',
  left: 'ไปซ้าย',
  right: 'ไปขวา',
  jump: 'กระโดด',
  swing: 'โหนใย (กดค้าง)',
  dash: 'พุ่งหลบ',
  slide: 'สไลด์ (กดค้าง)',
  shoot: 'ยิงใย',
  snare: 'ใยรัด',
  reset: 'กลับจุดเริ่ม',
  scores: 'ดูคะแนน (กดค้าง)',
};

/** True when a finger, not a mouse, is the main way to aim. */
export const isCoarsePointer = (): boolean => window.matchMedia('(pointer: coarse)').matches;

export const isTouchDevice = (): boolean =>
  window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

function defaults(): Settings {
  return {
    quality: isTouchDevice() ? 'low' : 'medium',
    fov: 90,
    mouseSens: 1,
    touchSens: 1,
    aimAssist: true,
    reduceMotion: false,
    swapButtons: false,
    keys: {
      forward: 'KeyW',
      back: 'KeyS',
      left: 'KeyA',
      right: 'KeyD',
      jump: 'Space',
      swing: 'Mouse2',
      dash: 'ShiftLeft',
      slide: 'KeyC',
      shoot: 'Mouse0',
      snare: 'KeyQ',
      reset: 'KeyR',
      scores: 'Tab',
    },
  };
}

const SETTINGS_VERSION = 2;
const SETTINGS_KEY = 'zexosae.settings';
const BEST_LAP_KEY = 'zexosae.bestLap';

export function loadSettings(): Settings {
  const base = defaults();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // Aim help changed meaning in version 2, so an older saved choice no longer applies.
    if (saved.version !== SETTINGS_VERSION) delete saved.aimAssist;
    const keys = { ...base.keys };
    for (const action of Object.keys(keys) as Action[]) {
      // Ignores actions saved by older versions of the game.
      const code = saved.keys?.[action];
      if (code) keys[action] = code;
    }
    return { ...base, ...saved, keys };
  } catch {
    return base;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch {
    // Storage can be blocked in private windows. Settings still apply for this visit.
  }
}

export function resetSettings(target: Settings): void {
  Object.assign(target, defaults());
  saveSettings(target);
}

export function loadBestLap(): number | null {
  try {
    const value = Number(localStorage.getItem(BEST_LAP_KEY));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveBestLap(time: number): void {
  try {
    localStorage.setItem(BEST_LAP_KEY, String(time));
  } catch {
    // See saveSettings.
  }
}

export function keyName(code: string): string {
  const named: Record<string, string> = {
    Mouse0: 'คลิกซ้าย',
    Mouse1: 'คลิกกลาง',
    Mouse2: 'คลิกขวา',
    Space: 'Spacebar',
    ShiftLeft: 'Shift ซ้าย',
    ShiftRight: 'Shift ขวา',
    ControlLeft: 'Ctrl ซ้าย',
    ControlRight: 'Ctrl ขวา',
    AltLeft: 'Alt ซ้าย',
    AltRight: 'Alt ขวา',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return `เมาส์ ${code.slice(5)}`;
  return code;
}
