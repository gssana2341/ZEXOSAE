// HUD, menus and the settings screen. Plain DOM keeps the menus cheap on phones.

import { SKY_CHOICES, SKY_LABELS, type SkyChoice } from './render/lighting';
import { MAX_HP } from './sim/hits';
import {
  cleanCode,
  CODE_LENGTH,
  DEFAULT_ROOM_SIZE,
  MAX_ROOM_SIZE,
  ROOM_SIZES,
  type PlayerInfo,
  type MatchState,
  type RoomSummary,
} from './net/protocol';
import { openControlEditor } from './control-editor';
import { el, styleControl } from './dom';
import type { Profile } from './profile';
import { raycast } from './sim/map';
import { CONTROL_POINT, GAME_MODES, MODE_INFO, type GameMode } from './sim/game-modes';
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

export const formatTime = (t: number): string => {
  const minutes = Math.floor(t / 60);
  const seconds = t - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
};

// ---------------------------------------------------------------------- HUD

export function pingQuality(ping: number | null): 'good' | 'fair' | 'bad' {
  if (ping === null || ping >= 150) return 'bad';
  return ping >= 80 ? 'fair' : 'good';
}

export interface OnlineHud {
  code: string;
  myId: number;
  players: PlayerInfo[];
  /** Set while waiting to respawn. */
  koBy: string | null;
  /** Round trip to the host in milliseconds, or null with no fresh reading. */
  ping: number | null;
  isHost: boolean;
  match: MatchState | null;
}

export class Hud {
  online: OnlineHud | null = null;

  readonly root = el('div', 'hud');
  readonly touch = el('div', 'touch');
  readonly stick = el('div', 'stick');
  readonly moveButton = el('button', 'pad pad-move', 'โหน');
  readonly attackButton = el('button', 'pad pad-attack', 'ตี');
  readonly dashButton = el('button', 'pad pad-small pad-dash', 'พุ่ง');
  readonly snareButton = el('button', 'pad pad-small pad-snare', 'ใยรัด');
  readonly webButton = el('button', 'pad pad-small pad-web', 'ใยดึง');
  readonly focusButton = el('button', 'pad pad-small pad-focus', 'โฟกัส');
  readonly pauseButton = el('button', 'pause-button', 'ตั้งค่า');
  readonly scoresButton = el('button', 'scores-button', 'คะแนน');
  readonly viewButton = el('button', 'view-button', 'มุมกล้อง');
  /** Set each frame while the player holds the scoreboard key. */
  scoresKey = false;

  private readonly speedLines = el('div', 'speed-lines');
  private readonly frozen = el('div', 'frozen-screen');
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
  private readonly skills = el('div', 'skills');
  private readonly dash = el('div', 'cooldown');
  private readonly snare = el('div', 'cooldown');
  private readonly anchor = el('div', 'marker anchor');
  private readonly perch = el('div', 'marker perch');
  private readonly hpFill = el('div', 'hp-fill');
  private readonly hpValue = el('div', 'hp-value');
  private readonly focusPips = [el('div', 'focus-pip'), el('div', 'focus-pip'), el('div', 'focus-pip')];
  private readonly targetHp = el('div', 'target-hp');
  private readonly calloutBox = el('div', 'callout');
  private readonly hurtFlash = el('div', 'hurt-flash');
  private calloutTimer = 0;
  private hurtTimer = 0;
  private readonly target = el('div', 'marker target');
  private readonly ring = el('div', 'marker ring-marker');
  private readonly toastBox = el('div', 'toast');
  private readonly hitMark = el('div', 'hit-mark');
  private readonly scoreboard = el('div', 'scoreboard');
  private scoreboardKey = '';
  private scoresTapped = false;
  private readonly koNote = el('div', 'ko-note');
  /** While only watching a room: who is being followed. Null while playing. */
  watching: string | null = null;
  private readonly pingLabel = el('div', 'ping');
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

    const vitals = el('div', 'vitals');
    const hpBar = el('div', 'hp-bar');
    hpBar.append(this.hpFill, this.hpValue);
    const focus = el('div', 'focus-bar');
    focus.append(...this.focusPips);
    vitals.append(hpBar, focus);
    this.target.append(this.targetHp);

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

    this.dash.dataset.label = 'พุ่ง';
    this.snare.dataset.label = 'ใยรัด';
    this.skills.append(this.dash, this.snare);

    this.touch.append(
      this.stick,
      this.moveButton,
      this.attackButton,
      this.dashButton,
      this.snareButton,
      this.webButton,
      this.focusButton,
    );
    this.root.append(
      this.speedLines,
      this.frozen,
      this.hurtFlash,
      vitals,
      this.perch,
      this.calloutBox,
      ...Object.values(this.edges),
      this.touch,
      this.anchor,
      this.target,
      this.ring,
      el('div', 'crosshair'),
      this.hitMark,
      course,
      speed,
      this.skills,
      ...this.nameTags,
      this.koNote,
      this.pingLabel,
      this.toastBox,
      this.scoreboard,
      this.pauseButton,
      this.scoresButton,
      this.viewButton,
    );
    parent.append(this.root);
    this.applySettings();
  }

  applySettings(): void {
    this.touch.classList.toggle('active', isTouchDevice());
    this.touch.classList.toggle('swapped', this.settings.swapButtons);
    this.pauseButton.hidden = !isTouchDevice();
    this.viewButton.hidden = !isTouchDevice();
    this.scoresButton.hidden = true;
    // On touch the buttons themselves show when a skill is ready.
    this.skills.style.display = isTouchDevice() ? 'none' : '';

    const layout = this.settings.touchLayout;
    styleControl(this.moveButton, layout.move);
    styleControl(this.attackButton, layout.attack);
    styleControl(this.dashButton, layout.dash);
    styleControl(this.snareButton, layout.snare);
    styleControl(this.webButton, layout.web);
    styleControl(this.focusButton, layout.focus);
    styleControl(this.pauseButton, layout.pause);
    styleControl(this.scoresButton, layout.scores);
    styleControl(this.viewButton, layout.view);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('visible', visible);
  }

  /** Only watching: hides everything that belongs to a body the viewer doesn't have. */
  setWatching(watching: boolean): void {
    this.root.classList.toggle('watching', watching);
    if (!watching) this.watching = null;
  }

  toast(text: string, strong = false): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.toggle('strong', strong);
    this.toastBox.classList.add('on');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove('on'), 1100);
  }

  /** A short word of praise, for a move done well. */
  callout(text: string, strong = false): void {
    this.calloutBox.textContent = text;
    this.calloutBox.classList.toggle('strong', strong);
    this.calloutBox.classList.remove('on');
    // Restarts the pop when two come quickly.
    void this.calloutBox.offsetWidth;
    this.calloutBox.classList.add('on');
    window.clearTimeout(this.calloutTimer);
    this.calloutTimer = window.setTimeout(() => this.calloutBox.classList.remove('on'), 900);
  }

  /** A red flash at the screen's edge when the player takes a hit. */
  hurt(): void {
    this.hurtFlash.classList.add('on');
    window.clearTimeout(this.hurtTimer);
    this.hurtTimer = window.setTimeout(() => this.hurtFlash.classList.remove('on'), 220);
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

    setText(this.speedValue, `${Math.round(speed * 3.6)} กม./ชม.`);
    setStyle(this.speedFill, 'width', `${Math.round(Math.min(100, (speed / TUNING.maxSpeed) * 100))}%`);
    setStyle(
      this.speedLines,
      'opacity',
      this.settings.reduceMotion ? '0' : String(Math.round(Math.max(0, Math.min(0.9, (speed - 15) / 20)) * 50) / 50),
    );

    this.frozen.classList.toggle('on', p.snareT > 0);

    setStyle(this.hpFill, 'width', `${Math.round((p.hp / MAX_HP) * 100)}%`);
    setText(this.hpValue, String(Math.round(p.hp)));
    this.focusPips.forEach((pip, i) => {
      setStyle(pip, 'opacity', String(Math.round(Math.min(1, Math.max(0, p.focus - i)) * 50) / 50 * 0.85 + 0.15));
      pip.classList.toggle('full', p.focus >= i + 1);
    });
    this.place(this.perch, p.perch && p.targetPreview === null ? p.perch.point : null);
    this.perch.classList.toggle('hang', p.perch?.hang === true);

    const pulse = this.settings.reduceMotion ? 1 : 0.82 + 0.18 * Math.sin(performance.now() / 55);
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      setStyle(this.edges[edge], 'opacity', String(Math.round(world.danger[edge] * pulse * 50) / 50));
    }

    if (world.online && this.online) {
      this.updateOnline(world, this.online);
    } else {
      setText(this.timer, world.lapRunning ? formatTime(world.lapTime) : 'ผ่านห่วงแรกเพื่อจับเวลา');
      setText(this.best, world.bestLap ? `ดีที่สุด ${formatTime(world.bestLap)}` : '');
      setText(this.rings, `ห่วง ${world.ringIndex}/${world.map.rings.length}`);
      setText(this.kos, `KO ${world.kos}`);
      this.scoreboard.classList.remove('on');
      this.scoresButton.hidden = true;
      setText(this.koNote, '');
      setText(this.pingLabel, '');
      for (const tag of this.nameTags) setStyle(tag, 'display', 'none');
    }

    setVar(this.dash, '--ready', String(Math.round((1 - p.dashCdT / TUNING.dashCooldown) * 50) / 50));
    setVar(this.snare, '--ready', String(Math.round((1 - p.snareCdT / TUNING.snareCooldown) * 50) / 50));
    this.dashButton.classList.toggle('cooling', p.dashCdT > 0);
    this.snareButton.classList.toggle('cooling', p.snareCdT > 0);

    this.place(this.anchor, p.mode === 'swing' ? null : p.anchorPreview);

    // The frame is a practice aid. A real match has to be read by eye.
    const target = world.online ? undefined : world.dummies.find((d) => d.id === p.targetPreview);
    this.place(this.target, target ? dummyCenter(target) : null);
    if (target) setStyle(this.targetHp, 'width', `${Math.round(Math.max(0, target.hp / MAX_HP) * 100)}%`);

    this.ring.classList.toggle('crown-marker', world.online && world.gameMode === 'crown');
    if (world.online && world.gameMode === 'control') this.placeClamped(this.ring, { x: CONTROL_POINT.x, y: 1, z: CONTROL_POINT.z });
    else if (world.online && world.gameMode === 'crown' && world.crown && !world.crownMine) this.placeClamped(this.ring, world.crown);
    else if (!world.online) this.placeClamped(this.ring, world.map.rings[world.ringIndex]);
    else this.ring.style.display = 'none';
  }

  private updatePing({ ping, isHost }: OnlineHud): void {
    this.pingLabel.textContent = isHost
      ? 'ปิง 0 ms (โฮสต์)'
      : ping === null
        ? 'ปิง -- ms'
        : `ปิง ${ping} ms`;
    this.pingLabel.dataset.quality = pingQuality(ping);
  }

  private updateScoreboard(online: OnlineHud): void {
    const open = this.scoresKey || this.scoresTapped;
    this.scoreboard.classList.toggle('on', open);
    if (!open) return;

    const crownMode = online.match?.mode === 'crown';
    const holder = online.match?.holder;
    const players = [...online.players].sort((a, b) => Number(b.id === holder && crownMode) - Number(a.id === holder && crownMode) || (b.score ?? 0) - (a.score ?? 0) || b.kills - a.kills || a.deaths - b.deaths);
    const key = JSON.stringify([online.code, online.myId, crownMode, holder, players]);
    if (key === this.scoreboardKey) return;
    this.scoreboardKey = key;

    const table = el('table');
    const head = el('tr');
    for (const title of ['#', 'ผู้เล่น', crownMode ? 'มงกุฎ' : 'คะแนน', 'KO', 'ตาย']) head.append(el('th', '', title));
    table.append(head);

    players.forEach((p, i) => {
      const row = el('tr', p.id === online.myId ? 'me' : '');
      const team = p.team ? (p.team === 'red' ? '🔴 ' : '🔵 ') : '';
      const score = crownMode ? (p.id === holder ? '👑' : '—') : String(p.score ?? 0);
      for (const cell of [String(i + 1), `${team}${p.name}`, score, String(p.kills), String(p.deaths)]) {
        row.append(el('td', '', cell));
      }
      table.append(row);
    });
    this.scoreboard.replaceChildren(el('h2', '', `ห้อง ${online.code}`), table);
  }

  private updateOnline(world: World, online: OnlineHud): void {
    const me = online.players.find((p) => p.id === online.myId);
    const match = online.match;
    const mode = match?.mode ?? 'deathmatch';
    const time = match?.remaining ?? 0;
    this.timer.textContent = `${MODE_INFO[mode].name} · ${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;
    const holder = online.players.find((p) => p.id === match?.holder);
    this.best.textContent = match?.phase === 'waiting'
      ? 'รอผู้เล่นอย่างน้อย 2 คน'
      : match?.phase === 'finished'
        ? match.result
        : mode === 'crown'
          ? match?.holder === online.myId ? '👑 คุณกำลังถือมงกุฎ!' : holder ? `👑 ${holder.name} กำลังถือมงกุฎ` : '👑 มงกุฎอยู่บนพื้น ไปเก็บเลย'
          : `คะแนน ${me?.score ?? 0}/${MODE_INFO[mode].goal}`;
    this.rings.textContent = mode === 'teams' && match ? `🔴 ${match.teamScores.red}  ·  🔵 ${match.teamScores.blue}` : mode === 'control' ? (match?.holder === online.myId ? 'กำลังยึดจุด!' : 'ยืนในวงโดยไม่มีคนอื่นเพื่อเก็บคะแนน') : mode === 'crown' ? 'KO คนถือเพื่อชิงมงกุฎ ถือไว้ตอนหมดเวลาเพื่อชนะ' : '';
    this.kos.textContent = `ห้อง ${online.code}`;

    this.scoresButton.hidden = !isTouchDevice();
    this.updateScoreboard(online);
    this.updatePing(online);

    this.koNote.textContent = this.watching ??
      (online.koBy === null ? '' : `ถูก KO โดย ${online.koBy || 'ผู้เล่น'} กำลังเกิดใหม่…`);

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
      const team = d.team ? (d.team === 'red' ? '🔴 ' : '🔵 ') : '';
      const crown = mode === 'crown' && match?.holder === d.id ? '👑 ' : '';
      setText(tag.firstElementChild as HTMLElement, `${crown}${team}${d.name ?? ''} ${Math.max(0, Math.round(d.hp))}`);
    });
  }

  private place(node: HTMLElement, point: { x: number; y: number; z: number } | null): void {
    const s = point ? this.view.toScreen(point) : null;
    if (!s || s.behind) {
      setStyle(node, 'display', 'none');
      return;
    }
    setStyle(node, 'display', 'block');
    setStyle(node, 'transform', `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`);
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
    setStyle(node, 'display', 'block');
    setStyle(node, 'transform', `translate(${Math.round(x)}px, ${Math.round(y)}px)`);
  }
}

/**
 * The HUD changes every frame, but most of it holds still. Writing a value, even the same
 * one, makes the browser restyle and repaint, so these only write what changed.
 */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function setStyle(node: HTMLElement, property: 'opacity' | 'width' | 'display' | 'transform', value: string): void {
  if (node.style[property] !== value) node.style[property] = value;
}

function setVar(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
}

// -------------------------------------------------------------------- menus

export interface MenuActions {
  start(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(): void;
  createRoom(name: string, maxPlayers: number, mode: GameMode, privateRoom: boolean): void;
  quickPlay(name: string): void;
  /** Joins a random open room that already has players, or says there is none. */
  playNow(): void;
  joinRoom(code: string, name: string): void;
  /** Goes into a room only to watch. */
  watchRoom(code: string, name: string): void;
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
  private watchFromBoard: (code: string) => void = () => undefined;

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
    this.status.textContent = '';
    const playNow = this.button('เล่นทันที', () => {
      this.status.textContent = 'กำลังหาห้องที่มีคนเล่นอยู่…';
      this.actions.playNow();
    }, true);
    playNow.classList.add('hero-button');
    const practice = this.button('ซ้อมคนเดียว', () => this.actions.start());
    practice.classList.add('subtle');
    panel.append(
      el('h1', '', 'ZEXOSAE'),
      el('p', 'tagline', 'โหนใย ไต่ตึก และสู้กับเพื่อน'),
      el('p', 'profile-line', this.profileLine()),
      playNow,
      this.status,
      this.button('ห้องทั้งหมด และสร้างห้อง', () => this.showOnline()),
      this.button('ตั้งค่า', () => this.showSettings(() => this.showMain())),
      practice,
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
    // A code being typed into a private room survives the board refreshing.
    if (this.roomList.querySelector('.room-code-ask input:focus')) return;
    this.roomList.replaceChildren(
      ...rooms.map((room) => {
        const row = el('div', 'room-row');
        const about = el('div', 'room-about');
        const mode = MODE_INFO[room.mode ?? 'deathmatch'].name;
        about.append(
          el('strong', '', `${room.private ? '🔒 ' : ''}ห้องของ ${room.host}`),
          // A private room's code never reaches the board: the host hands it out.
          el('span', '', room.private ? `${mode} · ห้องส่วนตัว ต้องใช้รหัส` : `${mode} · รหัส ${room.code}`),
        );
        const full = room.players >= room.max;
        const join = el('button', 'key', full ? 'เต็ม' : 'เข้า');
        join.disabled = full;
        const watch = el('button', 'key watch', '👁');
        watch.title = 'เข้าไปดูเฉยๆ';
        watch.setAttribute('aria-label', `ดูห้องของ ${room.host}`);

        const go = (enter: (code: string) => void) => {
          if (!room.private) {
            enter(room.code);
            return;
          }
          this.askCode(row, enter);
        };
        join.addEventListener('click', () => go(this.joinFromBoard));
        watch.addEventListener('click', () => go(this.watchFromBoard));
        row.append(about, el('span', 'room-count', `${room.players}/${room.max}`), join, watch);
        return row;
      }),
    );
  }

  /** Asks for a private room's code under its row, then goes in with it. */
  private askCode(row: HTMLElement, enter: (code: string) => void): void {
    row.parentElement?.querySelectorAll('.room-code-ask').forEach((old) => old.remove());
    const ask = el('div', 'room-code-ask');
    const input = el('input', 'code');
    input.maxLength = CODE_LENGTH;
    input.placeholder = 'รหัสห้อง';
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'รหัสห้องส่วนตัว');
    input.addEventListener('input', () => {
      input.value = cleanCode(input.value);
    });
    const submit = () => {
      if (input.value.length < CODE_LENGTH) {
        this.status.textContent = `ห้องนี้เป็นห้องส่วนตัว ใส่รหัส ${CODE_LENGTH} ตัวจากเจ้าของห้อง`;
        input.focus();
        return;
      }
      enter(input.value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const ok = el('button', 'key', 'ตกลง');
    ok.addEventListener('click', submit);
    ask.append(input, ok);
    row.after(ask);
    input.focus();
  }

  roomBoardLoading(): void {
    this.roomList.replaceChildren(el('p', 'empty', 'กำลังโหลดรายการห้อง…'));
  }

  roomBoardError(text: string, retry: () => void): void {
    const button = el('button', 'key', 'ลองอีกครั้ง');
    button.addEventListener('click', retry);
    this.roomList.replaceChildren(el('p', 'empty', text), button);
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

    const mode = el('select');
    mode.setAttribute('aria-label', 'เลือกโหมดการเล่น');
    for (const id of GAME_MODES) {
      const option = el('option', '', MODE_INFO[id].name);
      option.value = id;
      mode.append(option);
    }
    const modeRow = el('label', 'row');
    modeRow.append(el('span', '', 'โหมดการเล่น'), mode);
    const modeHelp = el('p', 'mode-help', MODE_INFO.deathmatch.description);
    mode.addEventListener('change', () => { modeHelp.textContent = MODE_INFO[mode.value as GameMode].description; });

    const visibility = el('select');
    visibility.setAttribute('aria-label', 'การมองเห็นห้อง');
    for (const [value, label] of [['private', 'ส่วนตัว — เข้าด้วยรหัส'], ['public', 'สาธารณะ — ให้คนสุ่มเข้าได้']]) {
      const option = el('option', '', label);
      option.value = value;
      visibility.append(option);
    }
    const visibilityRow = el('label', 'row');
    visibilityRow.append(el('span', '', 'ห้อง'), visibility);

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
    this.watchFromBoard = (roomCode) => this.actions.watchRoom(roomCode, name.value);

    const form = el('div', 'online-form');
    form.append(
      el('h2', '', 'เล่นออนไลน์'),
      name,
      this.button('สุ่มเล่นกับผู้เล่นอื่น', () => this.actions.quickPlay(name.value), !code),
      el('h3', '', 'สร้างห้องกับเพื่อน'),
      modeRow,
      modeHelp,
      sizeRow,
      visibilityRow,
      this.button('สร้างห้องใหม่', () => this.actions.createRoom(name.value, Number(size.value), mode.value as GameMode, visibility.value === 'private')),
      el('h3', '', 'มีรหัสจากเพื่อน'),
      codeInput,
      this.button('เข้าห้อง', join, !!code),
      this.status,
      el('p', 'device-note', 'คนสร้างห้องต้องเปิดเกมค้างไว้ ถ้าออก ห้องจะจบ ชื่อและคะแนนเก็บในเครื่องนี้ ถ้าล้างแคชข้อมูลจะหาย'),
      this.button('กลับ', () => {
        this.actions.saveName(name.value);
        this.actions.closeLobby();
        this.showMain();
      }),
    );

    const board = el('div', 'room-board');
    this.roomBoardLoading();
    board.append(el('h2', '', 'ห้องที่เปิดอยู่'), el('p', 'board-help', 'กด 👁 เพื่อเข้าไปดูเฉยๆ ห้องส่วนตัวต้องใส่รหัสทั้งเข้าเล่นและเข้าดู'), this.roomList);

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
          ['นิ้วซ้าย', 'ลากเพื่อเดิน ปัดลงเร็วๆ เพื่อสไลด์'],
          ['นิ้วขวา', 'ลากเพื่อหันกล้อง'],
          ['ปุ่มโหน', 'แตะเพื่อกระโดด กดค้างเพื่อโหน'],
          ['ปุ่มอื่น', 'ยิง พุ่ง และใยรัด แตะเพื่อใช้'],
        ]
      : [
          ['เดิน', [k.forward, k.left, k.back, k.right].map(keyName).join(' ')],
          ['กระโดด / โหนใย', `${keyName(k.jump)} / ${keyName(k.swing)} ค้าง`],
          ['ยิงใย / ใยรัด', `${keyName(k.shoot)} / ${keyName(k.snare)}`],
          ['พุ่งหลบ / สไลด์', `${keyName(k.dash)} / ${keyName(k.slide)} ค้าง`],
          ['สลับมุมกล้อง', keyName(k.view)],
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

    const sky = () => {
      const row = el('label', 'row');
      const input = el('select');
      input.setAttribute('aria-label', 'ช่วงเวลาของเมือง');
      for (const choice of SKY_CHOICES) {
        const o = el('option', '', SKY_LABELS[choice]);
        o.value = choice;
        input.append(o);
      }
      input.value = s.timeOfDay;
      input.addEventListener('change', () => {
        s.timeOfDay = input.value as SkyChoice;
        changed();
      });
      row.append(el('span', '', 'ช่วงเวลาของเมือง'), input);
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

    const trafficRow = () => {
      const row = el('label', 'row');
      const input = el('select');
      input.setAttribute('aria-label', 'จำนวนรถบนถนน');
      for (const [value, text] of [['busy', 'เยอะ'], ['some', 'น้อย'], ['off', 'ไม่มี']] as const) {
        const o = el('option', '', text);
        o.value = value;
        input.append(o);
      }
      input.value = s.traffic;
      input.addEventListener('change', () => {
        s.traffic = input.value as Settings['traffic'];
        changed();
      });
      row.append(el('span', '', 'รถวิ่งบนถนน'), input);
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
      sky(),
      range('มุมมองกล้อง (FOV)', s.fov, 70, 110, 1, (v) => {
        s.fov = v;
        changed();
      }),
      toggle('เริ่มด้วยมุมบุคคลที่ 3', s.thirdPerson, (v) => {
        s.thirdPerson = v;
        changed();
      }),
      toggle('ลดการเคลื่อนไหวของกล้องทั้งหมด (ช่วยลดอาการเวียนหัว)', s.reduceMotion, (v) => {
        s.reduceMotion = v;
        changed();
      }),
      el('h3', '', 'เอฟเฟกต์ (ปิดได้ถ้าเวียนหัวหรือเครื่องช้า)'),
      toggle('จอสั่นตอนดิ่ง', s.screenShake, (v) => {
        s.screenShake = v;
        changed();
      }),
      toggle('ภาพกว้างและกล้องถอยตามความเร็ว', s.speedZoom, (v) => {
        s.speedZoom = v;
        changed();
      }),
      trafficRow(),
      toggle('แสงไฟส่องพื้นตอนกลางคืน', s.cityGlow, (v) => {
        s.cityGlow = v;
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

    if (isTouchDevice()) {
      panel.append(
        this.button('ปรับปุ่มบนจอ', () => {
          const parent = this.root.parentElement!;
          this.hide();
          openControlEditor(parent, s, () => {
            changed();
            this.showSettings(back);
          });
        }),
      );
    }

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
