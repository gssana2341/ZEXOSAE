import { describe, expect, it } from 'vitest';
import { styleControl } from '../src/dom';
import { blockPageZoom } from '../src/mobile';

function fire(target: EventTarget, type: string, extra: object = {}, timeStamp?: number) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  target.dispatchEvent(event);
  return event;
}

function page() {
  const target = new EventTarget();
  blockPageZoom(target as unknown as Document);
  return target;
}

describe('page zoom', () => {
  it.each(['gesturestart', 'gesturechange', 'gestureend'])('blocks the Safari %s event', (type) => {
    expect(fire(page(), type).defaultPrevented).toBe(true);
  });

  it('blocks a two-finger pinch', () => {
    expect(fire(page(), 'touchmove', { touches: [{}, {}] }).defaultPrevented).toBe(true);
  });

  it('leaves one-finger scrolling alone, for long menus', () => {
    expect(fire(page(), 'touchmove', { touches: [{}] }).defaultPrevented).toBe(false);
  });

  it('blocks a double tap but not a single tap', () => {
    const target = page();
    expect(fire(target, 'touchend', {}, 1000).defaultPrevented).toBe(false);
    expect(fire(target, 'touchend', {}, 1100).defaultPrevented).toBe(true);
    expect(fire(target, 'touchend', {}, 3000).defaultPrevented).toBe(false);
  });

  it('allows double taps in a text field, to select a word', () => {
    const target = page();
    const field = { closest: () => ({}) };
    fire(target, 'touchend', { target: field }, 1000);
    const event = new Event('touchend', { cancelable: true });
    Object.defineProperty(event, 'target', { value: field });
    Object.defineProperty(event, 'timeStamp', { value: 1100 });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('moved controls', () => {
  const node = () => ({ style: {} as Record<string, string> }) as unknown as HTMLElement;

  it('keeps the stylesheet position until the player moves a control', () => {
    const n = node();
    styleControl(n, { scale: 1.2, opacity: 0.5 });
    expect(n.style.left).toBe('');
    expect(n.style.transform).toBe('scale(1.2)');
    expect(n.style.opacity).toBe('0.5');
  });

  it('places a moved control by share of the screen, kept inside the edges', () => {
    const n = node();
    styleControl(n, { x: 0.25, y: 0.75, scale: 1, opacity: 1 });
    expect(n.style.left).toContain('25%');
    expect(n.style.left).toContain('clamp');
    expect(n.style.top).toContain('75%');
    expect(n.style.right).toBe('auto');
    expect(n.style.transform).toContain('translate(-50%, -50%)');
  });

  it('falls back to defaults with no saved layout', () => {
    const n = node();
    styleControl(n, undefined);
    expect(n.style.opacity).toBe('1');
    expect(n.style.transform).toBe('scale(1)');
  });
});
