import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from '../src/input';
import type { Settings } from '../src/settings';

const settings = {
  aimAssist: true,
  mouseSens: 1,
  touchSens: 1,
  keys: { scores: 'Tab', jump: 'Space' },
} as unknown as Settings;

function press(code: string, init: Partial<KeyboardEventInit & { repeat: boolean; altKey: boolean }> = {}) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...init });
  window.dispatchEvent(event);
  return event;
}

describe('touch buttons', () => {
  function setup() {
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { matchMedia: () => ({ matches: true }), setTimeout, clearTimeout }));
    const button = () =>
      Object.assign(new EventTarget(), {
        classList: { add() {}, remove() {} },
        setPointerCapture() {},
      }) as unknown as HTMLElement;
    const [surface, move, attack, dash, snare] = [button(), button(), button(), button(), button()];
    const input = new InputManager(settings, { classList: { remove() {} } } as unknown as HTMLElement);
    input.bindTouch(surface, move, attack, dash, snare);
    input.enabled = true;
    return { input, attack, dash, snare };
  }
  const tap = (el: HTMLElement) => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      el.dispatchEvent(event);
    }
  };
  afterEach(() => vi.unstubAllGlobals());

  it('each skill has its own button', () => {
    const { input, attack, dash, snare } = setup();
    tap(attack);
    let s = input.sample();
    expect([s.shoot, s.dash, s.snare]).toEqual([true, false, false]);
    tap(dash);
    s = input.sample();
    expect([s.shoot, s.dash, s.snare]).toEqual([false, true, false]);
    tap(snare);
    s = input.sample();
    expect([s.shoot, s.dash, s.snare]).toEqual([false, false, true]);
  });

  it('shoots the moment the button goes down', () => {
    const { input, attack } = setup();
    const down = new Event('pointerdown', { cancelable: true });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    attack.dispatchEvent(down);
    expect(input.sample().shoot).toBe(true);
  });

  it('ignores buttons while the game is paused', () => {
    const { input, dash } = setup();
    input.enabled = false;
    tap(dash);
    expect(input.sample().dash).toBe(false);
  });
});

describe('held keys', () => {
  let input: InputManager;

  beforeEach(() => {
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { matchMedia: () => ({ matches: false }) }));
    input = new InputManager(settings, { classList: { remove() {} } } as unknown as HTMLElement);
    input.enabled = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('blocks the browser on the first press and on every repeat', () => {
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(press('Tab', { repeat: true }).defaultPrevented).toBe(true);
    expect(press('Space', { repeat: true }).defaultPrevented).toBe(true);
  });

  it('holding Tab keeps the scoreboard key down', () => {
    press('Tab');
    press('Tab', { repeat: true });
    expect(input.scoresHeld()).toBe(true);
  });

  it('a repeat is not a new press', () => {
    press('Space');
    expect(input.sample().jump).toBe(true);
    press('Space', { repeat: true });
    expect(input.sample().jump).toBe(false);
  });

  it('leaves the browser alone in menus, so Tab can move between buttons', () => {
    input.enabled = false;
    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('leaves system shortcuts alone', () => {
    expect(press('Tab', { altKey: true }).defaultPrevented).toBe(false);
    expect(press('Escape').defaultPrevented).toBe(false);
  });
});
