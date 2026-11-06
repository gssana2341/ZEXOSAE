// HUD, menus and the settings screen. Plain DOM keeps the menus cheap on phones.

import {
  cleanCode,
  CODE_LENGTH,
  DEFAULT_ROOM_SIZE,
  MAX_ROOM_SIZE,
  ROOM_SIZES,
  type PlayerInfo,
  type RoomSummary,
} from './net/protocol';
import type { Profile } from './profile';
import { raycast } from './sim/map';
import { dummyCenter, eyePosition, totalSpeed, TUNING } from './sim/player';
import type { World } from './sim/world';
import type { GameView } from './render/view';
import {
  ACTION_LABELS,
  isTouchDevice,
  keyName,
  resetSettings,
  saveSettings,
  type Action,
  type Quality,
  type Settings,
} from './settings';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export const formatTime = (t: number): string => {
  const minutes = Math.floor(t / 60);
  const seconds = t - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
};

// ---------------------------------------------------------------------- HUD

export interface OnlineHud {
  code: string;
  myId: number;
  players: PlayerInfo[];
  /** Set while waiting to respawn. */
  koBy: string | null;
}

export class Hud {
  online: OnlineHud | null = null;

  readonly root = el('div', 'hud');
  readonly touch = el('div', 'touch');
  readonly stick = el('div', 'stick');
  readonly moveButton = el('button', 'pad pad-move', 'โหน');
  readonly attackButton = el('button', 'pad pad-attack', 'ยิง');
  readonly pauseButton = el('button', 'pause-button', 'พัก');
  readonly scoresButton = el('button', 'scores-button', 'คะแนน');
  /** Set each frame while the player holds the scoreboard key. */
  scoresKey = false;

  private readonly speedLines = el('div', 'speed-lines');
  private readonly edges = {
    top: el('div', 'danger danger-top'),
    right: el('div', 'danger danger-right'),
    bottom: el('div', 'danger danger-bottom'),
    left: el('div', 'danger danger-left'),
  };
  private readonly speedValue = el('div', 'speed-value');
  private readonly speedFill = el('div', 'speed-fill');
  private readonly timer = el('div', 'timer');
  private readonly best = el('div', 'best');
  private readonly rings = el('div', 'rings');
  private readonly kos = el('div', 'kos');
  private readonly dash = el('div', 'cooldown');
  private readonly snare = el('div', 'cooldown');
  private readonly anchor = el('div', 'marker anchor');
  private readonly target = el('div', 'marker target');
  private readonly ring = el('div', 'marker ring-marker');
  private readonly toastBox = el('div', 'toast');
  private readonly hitMark = el('div', 'hit-mark');
  private readonly scoreboard = el('div', 'scoreboard');
  private scoreboardKey = '';
  private scoresTapped = false;
  private readonly koNote = el('div', 'ko-note');
  private readonly nameTags: HTMLElement[] = [];
  private hitTimer = 0;
  private toastTimer = 0;

  constructor(
    parent: HTMLElement,
    private readonly view: GameView,
    private readonly settings: Settings,
  ) {
    const speed = el('div', 'speed');
    const bar = el('div', 'speed-bar');
    bar.append(this.speedFill);
    speed.append(this.speedValue, bar);

    const course = el('div', 'course');
    course.append(this.timer, this.best, this.rings, this.kos);

    this.scoresButton.addEventListener('click', () => {
      this.scoresTapped = !this.scoresTapped;
    });

    for (let i = 0; i < MAX_ROOM_SIZE - 1; i += 1) {
      const tag = el('div', 'marker name-tag');
      tag.append(el('span'));
      this.nameTags.push(tag);
    }

    const skills = el('div', 'skills');
    this.dash.dataset.label = 'พุ่ง';
    this.snare.dataset.label = 'ใยรัด';
    skills.append(this.dash, this.snare);

    this.touch.append(this.stick, this.moveButton, this.attackButton);
    this.root.append(
      this.speedLines,
      ...Object.values(this.edges),
      this.touch,
      this.anchor,
      this.target,
      this.ring,
      el('div', 'crosshair'),
      this.hitMark,
      course,
      speed,
      skills,
      ...this.nameTags,
      this.koNote,
      this.toastBox,
      this.scoreboard,
      this.pauseButton,
      this.scoresButton,
    );
    parent.append(this.root);
    this.applySettings();
  }

  applySettings(): void {
    this.touch.classList.toggle('active', isTouchDevice());
    this.touch.classList.toggle('swapped', this.settings.swapButtons);
    this.pauseButton.hidden = !isTouchDevice();
    this.scoresButton.hidden = true;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  toast(text: string, strong = false): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.toggle('strong', strong);
    this.toastBox.classList.add('on');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove('on'), 1100);
  }

  /** The X at the crosshair that confirms a shot landed. */
  hitConfirm(ko: boolean): void {
    this.hitMark.classList.add('on');
    this.hitMark.classList.toggle('ko', ko);
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hitMark.classList.remove('on'), 160);
  }

  update(world: World): void {
    const p = world.player;
    const speed = totalSpeed(p);

    this.speedValue.textContent = `${Math.round(speed * 3.6)} กม./ชม.`;
    this.speedFill.style.width = `${Math.min(100, (speed / TUNING.maxSpeed) * 100)}%`;
    this.speedLines.style.opacity = this.settings.reduceMotion
      ? '0'
      : String(Math.max(0, Math.min(0.9, (speed - 15) / 20)));

    const pulse = this.settings.reduceMotion ? 1 : 0.82 + 0.18 * Math.sin(performance.now() / 55);
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      this.edges[edge].style.opacity = (world.danger[edge] * pulse).toFixed(3);
    }

    if (world.online && this.online) {
      this.updateOnline(world, this.online);
    } else {
      this.timer.textContent = world.lapRunning ? formatTime(world.lapTime) : 'ผ่านห่วงแรกเพื่อจับเวลา';
      this.best.textContent = world.bestLap ? `ดีที่สุด ${formatTime(world.bestLap)}` : '';
      this.rings.textContent = `ห่วง ${world.ringIndex}/${world.map.rings.length}`;
      this.kos.textContent = `KO ${world.kos}`;
      this.scoreboard.classList.remove('on');
      this.scoresButton.hidden = true;
      this.koNote.textContent = '';
      for (const tag of this.nameTags) tag.style.display = 'none';
    }

    this.dash.style.setProperty('--ready', String(1 - p.dashCdT / TUNING.dashCooldown));
    this.snare.style.setProperty('--ready', String(1 - p.snareCdT / TUNING.snareCooldown));

    this.place(this.anchor, p.mode === 'swing' ? null : p.anchorPreview);

    // The frame is a practice aid. A real match has to be read by eye.
    const target = world.online ? undefined : world.dummies.find((d) => d.id === p.targetPreview);
    this.place(this.target, target ? dummyCenter(target) : null);

    if (world.online) this.ring.style.display = 'none';
    else this.placeClamped(this.ring, world.map.rings[world.ringIndex]);
  }

  private updateScoreboard(online: OnlineHud): void {
    const open = this.scoresKey || this.scoresTapped;
    this.scoreboard.classList.toggle('on', open);
    if (!open) return;

    const players = [...online.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const key = JSON.stringify([online.code, online.myId, players]);
    if (key === this.scoreboardKey) return;
    this.scoreboardKey = key;

    const table = el('table');
    const head = el('tr');
    for (const title of ['#', 'ผู้เล่น', 'KO', 'ตาย']) head.append(el('th', '', title));
    table.append(head);

    players.forEach((p, i) => {
      const row = el('tr', p.id === online.myId ? 'me' : '');
      for (const cell of [String(i + 1), p.name, String(p.kills), String(p.deaths)]) {
        row.append(el('td', '', cell));
      }
      table.append(row);
    });
    this.scoreboard.replaceChildren(el('h2', '', `ห้อง ${online.code}`), table);
  }

  private updateOnline(world: World, online: OnlineHud): void {
    const me = online.players.find((p) => p.id === online.myId);
    this.timer.textContent = `ห้อง ${online.code}`;
    this.best.textContent = `KO ${me?.kills ?? 0}`;
    this.rings.textContent = '';
    this.kos.textContent = '';

    this.scoresButton.hidden = !isTouchDevice();
    this.updateScoreboard(online);

    this.koNote.textContent =
      online.koBy === null ? '' : `ถูก KO โดย ${online.koBy || 'ผู้เล่น'} กำลังเกิดใหม่…`;

    // Names only show with a clear line of sight, so they can't reveal players behind walls.
    const eye = eyePosition(world.player);
    this.nameTags.forEach((tag, i) => {
      const d = world.dummies[i];
      if (!d || d.respawnT > 0) {
        tag.style.display = 'none';
        return;
      }
      const head = { x: d.pos.x, y: d.pos.y + 2.2, z: d.pos.z };
      const dx = head.x - eye.x;
      const dy = head.y - eye.y;
      const dz = head.z - eye.z;
      const dist = Math.hypot(dx, dy, dz) || 1;
      const blocked = raycast(world.map, eye, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
      this.place(tag, blocked ? null : head);
      tag.firstElementChild!.textContent = d.name ?? '';
    });
  }

  private place(node: HTMLElement, point: { x: number; y: number; z: number } | null): void {
    const s = point ? this.view.toScreen(point) : null;
    if (!s || s.behind) {
      node.style.display = 'none';
      return;
    }
    node.style.display = 'block';
    node.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }

  /** Keeps the next-ring marker on screen, pinned to the edge when the ring is out of view. */
  private placeClamped(node: HTMLElement, point: { x: number; y: number; z: number }): void {
    const s = this.view.toScreen(point);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const margin = 44;
    let { x, y } = s;
    if (s.behind) {
      x = w - x;
      y = h - margin;
    }
    x = Math.max(margin, Math.min(w - margin, x));
    y = Math.max(margin, Math.min(h - margin, y));
    node.style.display = 'block';
    node.style.transform = `translate(${x}px, ${y}px)`;
  }
}

// -------------------------------------------------------------------- menus

export interface MenuActions {
  start(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(): void;
  createRoom(name: string, maxPlayers: number): void;
  joinRoom(code: string, name: string): void;
  /** The online screen opened: start refreshing the room board. */
  openLobby(): void;
  /** The player left the online screen without joining a room. */
  closeLobby(): void;
  saveName(name: string): void;
  /** The code of the room being played, or an empty string. */
  roomCode(): string;
  /** Returns the message to show after trying to copy. */
  copyInvite(): Promise<string>;
}

export class Menus {
  private readonly root = el('div', 'menu');
  private readonly status = el('p', 'status');
  private readonly roomList = el('div', 'room-list');
  private joinFromBoard: (code: string) => void = () => undefined;

  constructor(
    parent: HTMLElement,
    private readonly settings: Settings,
    private readonly profile: Profile,
    private readonly actions: MenuActions,
  ) {
    parent.append(this.root);
  }

  hide(): void {
    this.root.classList.remove('visible');
    this.root.replaceChildren();
  }

  private open(panel: HTMLElement): void {
    this.root.replaceChildren(panel);
    this.root.classList.add('visible');
  }

  private profileLine(): string {
    const { name, kills, deaths } = this.profile;
    return `${name || 'ผู้เล่น'} · KO รวม ${kills} · ตาย ${deaths} · เก็บในเครื่องนี้`;
  }

  /** Shown once, because a player who clears their browser would otherwise lose everything by surprise. */
  showWelcome(next: () => void): void {
    const panel = el('div', 'panel');
    const name = this.nameInput();
    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'ข้อมูลของคุณเก็บอยู่ในเครื่องนี้เท่านั้น'),
      el('p', '', 'ตอนนี้ยังไม่มีระบบล็อกอิน ชื่อ คะแนนรวม และการตั้งค่าจะเก็บไว้ในเบราว์เซอร์นี้'),
      el('p', '', 'ข้อมูลจะหายถ้าล้างแคชหรือข้อมูลเว็บ ใช้โหมดไม่ระบุตัวตน หรือเปลี่ยนเครื่องหรือเบราว์เซอร์'),
    );
    panel.append(
      el('h2', '', 'ยินดีต้อนรับสู่ ZEXOSAE'),
      name,
      notice,
      this.button(
        'เข้าใจแล้ว เริ่มเลย',
        () => {
          this.profile.noticeSeen = true;
          this.actions.saveName(name.value);
          next();
        },
        true,
      ),
    );
    this.open(panel);
  }

  private nameInput(): HTMLInputElement {
    const name = el('input');
    name.maxLength = 16;
    name.placeholder = 'ชื่อของคุณ';
    name.value = this.profile.name;
    name.setAttribute('aria-label', 'ชื่อของคุณ');
    return name;
  }

  private button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', primary ? 'btn primary' : 'btn', text);
    b.addEventListener('click', onClick);
    return b;
  }

  showMain(): void {
    const panel = el('div', 'panel main');
    panel.append(
      el('h1', '', 'ZEXOSAE'),
      el('p', 'tagline', 'ต้นแบบ: ซ้อมวิ่ง โหนใย และยิงใย'),
      el('p', 'profile-line', this.profileLine()),
      this.button('เริ่มซ้อม', () => this.actions.start(), true),
      this.button('เล่นออนไลน์', () => this.showOnline()),
      this.button('ตั้งค่า', () => this.showSettings(() => this.showMain())),
      this.controlsGuide(),
    );
    this.open(panel);
  }

  onlineStatus(text: string): void {
    this.status.textContent = text;
  }

  showRooms(rooms: RoomSummary[]): void {
    if (!rooms.length) {
      this.roomList.replaceChildren(el('p', 'empty', 'ยังไม่มีห้องเปิดอยู่ สร้างห้องแรกได้เลย'));
      return;
    }
    this.roomList.replaceChildren(
      ...rooms.map((room) => {
        const row = el('div', 'room-row');
        const about = el('div', 'room-about');
        about.append(el('strong', '', `ห้องของ ${room.host}`), el('span', '', `รหัส ${room.code}`));
        const full = room.players >= room.max;
        const join = el('button', 'key', full ? 'เต็ม' : 'เข้า');
        join.disabled = full;
        join.addEventListener('click', () => this.joinFromBoard(room.code));
        row.append(about, el('span', 'room-count', `${room.players}/${room.max}`), join);
        return row;
      }),
    );
  }

  roomBoardError(): void {
    this.roomList.replaceChildren(el('p', 'empty', 'ดูรายการห้องไม่ได้ เพราะเชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
  }

  showOnline(code = ''): void {
    const panel = el('div', 'panel online');
    this.status.textContent = '';

    const name = this.nameInput();

    const size = el('select');
    size.setAttribute('aria-label', 'จำกัดจำนวนผู้เล่น');
    for (const n of ROOM_SIZES) {
      const option = el('option', '', `${n} คน`);
      option.value = String(n);
      size.append(option);
    }
    size.value = String(DEFAULT_ROOM_SIZE);
    const sizeRow = el('label', 'row');
    sizeRow.append(el('span', '', 'จำกัดจำนวนผู้เล่น'), size);

    const codeInput = el('input', 'code');
    codeInput.maxLength = CODE_LENGTH;
    codeInput.placeholder = 'รหัสห้อง';
    codeInput.value = code;
    codeInput.autocapitalize = 'characters';
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    codeInput.setAttribute('aria-label', 'รหัสห้อง');
    codeInput.addEventListener('input', () => {
      codeInput.value = cleanCode(codeInput.value);
    });

    const join = () => {
      if (codeInput.value.length < CODE_LENGTH) {
        this.status.textContent = `ใส่รหัสห้อง ${CODE_LENGTH} ตัว`;
        codeInput.focus();
        return;
      }
      this.actions.joinRoom(codeInput.value, name.value);
    };
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.joinFromBoard = (roomCode) => this.actions.joinRoom(roomCode, name.value);

    const form = el('div', 'online-form');
    form.append(
      el('h2', '', 'เล่นออนไลน์'),
      name,
      sizeRow,
      this.button('สร้างห้องใหม่', () => this.actions.createRoom(name.value, Number(size.value)), !code),
      el('h3', '', 'มีรหัสจากเพื่อน'),
      codeInput,
      this.button('เข้าห้อง', join, !!code),
      this.status,
      el('p', 'device-note', 'ชื่อและคะแนนเก็บในเครื่องนี้ ถ้าล้างแคชข้อมูลจะหาย'),
      this.button('กลับ', () => {
        this.actions.saveName(name.value);
        this.actions.closeLobby();
        this.showMain();
      }),
    );

    const board = el('div', 'room-board');
    this.roomList.replaceChildren(el('p', 'empty', 'กำลังโหลดรายการห้อง…'));
    board.append(el('h2', '', 'ห้องที่เปิดอยู่'), this.roomList);

    panel.append(form, board);
    this.open(panel);
    this.actions.openLobby();
  }

  showPause(): void {
    const panel = el('div', 'panel');
    const code = this.actions.roomCode();

    if (code) {
      const note = el('p', 'status');
      panel.append(
        el('h2', '', `ห้อง ${code}`),
        this.button('เล่นต่อ', () => this.actions.resume(), true),
        this.button('คัดลอกลิงก์ชวนเพื่อน', async () => {
          note.textContent = await this.actions.copyInvite();
        }),
        note,
        this.button('ตั้งค่า', () => this.showSettings(() => this.showPause())),
        this.button('ออกจากห้อง', () => this.actions.quit()),
      );
    } else {
      panel.append(
        el('h2', '', 'พักเกม'),
        this.button('เล่นต่อ', () => this.actions.resume(), true),
        this.button('กลับจุดเริ่ม', () => this.actions.restart()),
        this.button('ตั้งค่า', () => this.showSettings(() => this.showPause())),
        this.button('ออกเมนูหลัก', () => this.actions.quit()),
      );
    }
    this.open(panel);
  }

  private controlsGuide(): HTMLElement {
    const k = this.settings.keys;
    const rows: Array<[string, string]> = isTouchDevice()
      ? [
          ['นิ้วซ้าย', 'ลากเพื่อเดิน ปัดเร็วๆ เพื่อพุ่งหลบ ปัดลงเพื่อสไลด์'],
          ['นิ้วขวา', 'ลากเพื่อหันกล้อง'],
          ['ปุ่มโหน', 'แตะเพื่อกระโดด กดค้างเพื่อโหน'],
          ['ปุ่มยิง', 'แตะเพื่อยิงใย กดค้างเพื่อยิงใยรัด'],
        ]
      : [
          ['เดิน', [k.forward, k.left, k.back, k.right].map(keyName).join(' ')],
          ['กระโดด / โหนใย', `${keyName(k.jump)} / ${keyName(k.swing)} ค้าง`],
          ['ยิงใย / ใยรัด', `${keyName(k.shoot)} / ${keyName(k.snare)}`],
          ['พุ่งหลบ / สไลด์', `${keyName(k.dash)} / ${keyName(k.slide)} ค้าง`],
        ];

    const list = el('dl', 'guide');
    for (const [name, value] of rows) list.append(el('dt', '', name), el('dd', '', value));
    return list;
  }

  private showSettings(back: () => void): void {
    const s = this.settings;
    const panel = el('div', 'panel settings');
    const changed = () => {
      saveSettings(s);
      this.actions.settingsChanged();
    };

    const select = (label: string, value: Quality, onChange: (v: Quality) => void) => {
      const row = el('label', 'row');
      const input = el('select');
      const options: Array<[Quality, string]> = [
        ['low', 'ต่ำ (ไม่มีเงา เหมาะกับมือถือ)'],
        ['medium', 'กลาง'],
        ['high', 'สูง'],
      ];
      for (const [v, text] of options) {
        const o = el('option', '', text);
        o.value = v;
        input.append(o);
      }
      input.value = value;
      input.addEventListener('change', () => onChange(input.value as Quality));
      row.append(el('span', '', label), input);
      return row;
    };

    const range = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      onChange: (v: number) => void,
    ) => {
      const row = el('label', 'row');
      const input = el('input');
      const out = el('output', '', String(value));
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('input', () => {
        out.textContent = input.value;
        onChange(Number(input.value));
      });
      const control = el('span', 'range');
      control.append(input, out);
      row.append(el('span', '', label), control);
      return row;
    };

    const toggle = (label: string, value: boolean, onChange: (v: boolean) => void) => {
      const row = el('label', 'row');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = value;
      input.addEventListener('change', () => onChange(input.checked));
      row.append(el('span', '', label), input);
      return row;
    };

    panel.append(
      el('h2', '', 'ตั้งค่า'),
      el('h3', '', 'ภาพ'),
      select('คุณภาพภาพและแสงเงา', s.quality, (v) => {
        s.quality = v;
        changed();
      }),
      range('มุมมองกล้อง (FOV)', s.fov, 70, 110, 1, (v) => {
        s.fov = v;
        changed();
      }),
      toggle('ลดการเคลื่อนไหวของกล้อง (ช่วยลดอาการเวียนหัว)', s.reduceMotion, (v) => {
        s.reduceMotion = v;
        changed();
      }),
      el('h3', '', 'การควบคุม'),
      range('ความไวเมาส์', s.mouseSens, 0.2, 3, 0.1, (v) => {
        s.mouseSens = v;
        changed();
      }),
      range('ความไวการลากจอ', s.touchSens, 0.2, 3, 0.1, (v) => {
        s.touchSens = v;
        changed();
      }),
      toggle('ช่วยเล็ง', s.aimAssist, (v) => {
        s.aimAssist = v;
        changed();
      }),
      toggle('สลับปุ่มมือถือไปด้านซ้าย', s.swapButtons, (v) => {
        s.swapButtons = v;
        changed();
      }),
    );

    if (!isTouchDevice()) {
      panel.append(el('h3', '', 'ปุ่มคีย์บอร์ดและเมาส์'), this.keyBindings(changed));
    }

    panel.append(
      this.button('คืนค่าเริ่มต้น', () => {
        resetSettings(s);
        this.actions.settingsChanged();
        this.showSettings(back);
      }),
      this.button('กลับ', back, true),
    );
    this.open(panel);
  }

  private keyBindings(changed: () => void): HTMLElement {
    const list = el('div', 'keys');
    const keys = this.settings.keys;

    for (const action of Object.keys(keys) as Action[]) {
      const row = el('div', 'row');
      const b = el('button', 'key', keyName(keys[action]));

      b.addEventListener('click', (click) => {
        click.stopPropagation();
        b.textContent = 'กดปุ่มใหม่…';

        const finish = (code: string | null) => {
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('mousedown', onMouse, true);
          if (code) {
            // A code can only do one job: the action that held it takes the old one.
            for (const other of Object.keys(keys) as Action[]) {
              if (other !== action && keys[other] === code) keys[other] = keys[action];
            }
            keys[action] = code;
            changed();
          }
          list.replaceWith(this.keyBindings(changed));
        };
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          finish(e.code === 'Escape' ? null : e.code);
        };
        const onMouse = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          finish(`Mouse${e.button}`);
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onMouse, true);
      });

      row.append(el('span', '', ACTION_LABELS[action]), b);
      list.append(row);
    }
    return list;
  }
}
