// iPad and iPhone Safari ignore the page's "no zoom" setting, so two-finger pinch
// and double-tap zoom have to be blocked here. Two fingers are normal in this game:
// one moves and one looks.

const DOUBLE_TAP_MS = 320;

export function blockPageZoom(target: Document = document): void {
  const block = (e: Event) => e.preventDefault();
  const active = { passive: false };

  for (const gesture of ['gesturestart', 'gesturechange', 'gestureend']) {
    target.addEventListener(gesture, block, active);
  }

  target.addEventListener(
    'touchmove',
    (e) => {
      if ((e as TouchEvent).touches.length > 1) e.preventDefault();
    },
    active,
  );

  let lastTouchEnd = 0;
  target.addEventListener(
    'touchend',
    (e) => {
      const now = e.timeStamp;
      const typing = (e.target as Element | null)?.closest?.('input, select');
      if (!typing && now - lastTouchEnd < DOUBLE_TAP_MS) e.preventDefault();
      lastTouchEnd = now;
    },
    active,
  );
}
