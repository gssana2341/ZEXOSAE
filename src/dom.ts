import type { ControlLayout } from './settings';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Keeps a moved control on screen, even after the device rotates. */
const EDGE_MARGIN = 36;

/** Applies a player's layout to an on-screen control. With no position it keeps its place from the stylesheet. */
export function styleControl(node: HTMLElement, layout: ControlLayout | undefined): void {
  const scale = layout?.scale ?? 1;
  node.style.opacity = String(layout?.opacity ?? 1);

  if (layout?.x === undefined || layout.y === undefined) {
    node.style.left = '';
    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.transform = `scale(${scale})`;
    return;
  }

  // Stored as a share of the screen, so a layout survives rotating the device.
  node.style.left = `clamp(${EDGE_MARGIN}px, ${layout.x * 100}%, calc(100% - ${EDGE_MARGIN}px))`;
  node.style.top = `clamp(${EDGE_MARGIN}px, ${layout.y * 100}%, calc(100% - ${EDGE_MARGIN}px))`;
  node.style.right = 'auto';
  node.style.bottom = 'auto';
  node.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
