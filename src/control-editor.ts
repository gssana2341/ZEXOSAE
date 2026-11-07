// A full-screen editor for touch devices: drag a control to move it, then use the
// sliders to change its size and strength. Computers don't need this.

import { el, styleControl } from './dom';
import type { ControlId, ControlLayout, Settings } from './settings';

const CONTROLS: Array<{ id: ControlId; className: string; label: string }> = [
  { id: 'move', className: 'pad pad-move', label: 'โหน' },
  { id: 'attack', className: 'pad pad-attack', label: 'ตี' },
  { id: 'dash', className: 'pad pad-small pad-dash', label: 'พุ่ง' },
  { id: 'snare', className: 'pad pad-small pad-snare', label: 'ใยรัด' },
  { id: 'web', className: 'pad pad-small pad-web', label: 'ใยดึง' },
  { id: 'focus', className: 'pad pad-small pad-focus', label: 'โฟกัส' },
  { id: 'pause', className: 'pause-button', label: 'ตั้งค่า' },
  { id: 'scores', className: 'scores-button', label: 'คะแนน' },
  { id: 'view', className: 'view-button', label: 'มุมกล้อง' },
];

function slider(label: string, min: number, max: number, onInput: (value: number) => void) {
  const row = el('label', 'editor-slider');
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = '0.05';
  input.addEventListener('input', () => onInput(Number(input.value)));
  row.append(el('span', '', label), input);
  return { row, input };
}

export function openControlEditor(parent: HTMLElement, settings: Settings, onDone: () => void): void {
  const root = el('div', 'control-editor');
  const stage = el('div', settings.swapButtons ? 'touch active swapped' : 'touch active');
  const nodes = new Map<ControlId, HTMLElement>();
  let selected: ControlId = 'move';

  const layoutOf = (id: ControlId): ControlLayout => {
    settings.touchLayout[id] ??= { scale: 1, opacity: 1 };
    return settings.touchLayout[id];
  };

  const title = el('strong');
  const size = slider('ขนาด', 0.6, 1.6, (value) => {
    layoutOf(selected).scale = value;
    styleControl(nodes.get(selected)!, layoutOf(selected));
  });
  const strength = slider('ความเข้ม', 0.15, 1, (value) => {
    layoutOf(selected).opacity = value;
    styleControl(nodes.get(selected)!, layoutOf(selected));
  });

  const select = (id: ControlId) => {
    selected = id;
    for (const [other, node] of nodes) node.classList.toggle('selected', other === id);
    title.textContent = `ปุ่ม${CONTROLS.find((c) => c.id === id)!.label}`;
    const layout = settings.touchLayout[id];
    size.input.value = String(layout?.scale ?? 1);
    strength.input.value = String(layout?.opacity ?? 1);
  };

  for (const { id, className, label } of CONTROLS) {
    const node = el('div', `${className} editable`, label);
    styleControl(node, settings.touchLayout[id]);
    nodes.set(id, node);
    stage.append(node);

    let dragging = false;
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      node.setPointerCapture(e.pointerId);
      select(id);
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const layout = layoutOf(id);
      layout.x = Math.max(0, Math.min(1, e.clientX / window.innerWidth));
      layout.y = Math.max(0, Math.min(1, e.clientY / window.innerHeight));
      styleControl(node, layout);
    });
    const stop = () => {
      dragging = false;
    };
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
  }

  const reset = el('button', 'btn', 'คืนค่าเริ่มต้น');
  reset.addEventListener('click', () => {
    settings.touchLayout = {};
    for (const [id, node] of nodes) styleControl(node, settings.touchLayout[id]);
    select(selected);
  });

  const done = el('button', 'btn primary', 'เสร็จ');
  done.addEventListener('click', () => {
    root.remove();
    onDone();
  });

  const panel = el('div', 'editor-panel');
  const actions = el('div', 'editor-actions');
  actions.append(reset, done);
  panel.append(el('p', '', 'ลากปุ่มเพื่อย้าย แตะปุ่มเพื่อปรับ'), title, size.row, strength.row, actions);

  root.append(stage, panel);
  parent.append(root);
  select('move');
}
