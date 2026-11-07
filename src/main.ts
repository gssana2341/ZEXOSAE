import { InputManager } from './input';
import { blockPageZoom } from './mobile';
import { NetClient } from './net/client';
import { LobbyPoller } from './net/lobby-poller';
import { cleanCode, CODE_LENGTH, STATE_HZ, type ServerMessage, type Vec } from './net/protocol';
import { CROWN_CARRY_HEIGHT } from './sim/game-modes';
import { SignalError, type NetError } from './net/signal';
import { GameView } from './render/view';
import { FrameLimiter } from './render/performance';
import { loadProfile, saveProfile } from './profile';
import { isTouchDevice, loadBestLap, loadSettings, saveBestLap, saveSettings } from './settings';
import { emptyInput, knockPlayer, poseOf, snarePlayer, webLineOf, type Player } from './sim/player';
import type { V3 } from './sim/map';
import { TICK, World } from './sim/world';
import { formatTime, Hud, Menus } from './ui';

type State = 'menu' | 'playing' | 'paused';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const uiRoot = document.querySelector<HTMLElement>('#ui')!;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingMessage = document.querySelector<HTMLElement>('#loading-message')!;
const loadingRetry = document.querySelector<HTMLButtonElement>('#loading-retry')!;
const touchDevice = isTouchDevice();

const LOBBY_REFRESH_MS = 5000;

const settings = loadSettings();
const profile = loadProfile();
const world = new World(loadBestLap());
const view = new GameView(canvas, world.map, settings, !touchDevice, (message) => { loadingMessage.textContent = message; });
const hud = new Hud(uiRoot, view, settings);
const input = new InputManager(settings, hud.stick);
input.bindTouch(
  hud.touch,
  hud.moveButton,
  hud.attackButton,
  hud.dashButton,
  hud.snareButton,
  hud.webButton,
  hud.focusButton,
);

blockPageZoom();

let state: State = 'menu';
let accumulator = 0;
let lastFrame = performance.now();
let prevPos = { ...world.player.pos };
const frameLimiter = new FrameLimiter();

/** Set while waiting to respawn: the name of whoever got the KO. */
let koBy: string | null = null;
let stateTimer = 0;

const toV3 = (v: Vec): V3 => ({ x: v[0], y: v[1], z: v[2] });
const toVec = (v: V3): Vec => [
  Math.round(v.x * 100) / 100,
  Math.round(v.y * 100) / 100,
  Math.round(v.z * 100) / 100,
];

const lockPointer = () => {
  if (touchDevice) return;
  // The browser refuses a re-lock right after Esc. The next click on the game tries again.
  // Raw input skips the system's mouse acceleration, which is also where Chrome's rare
  // huge jumps come from. Browsers without it take a plain lock.
  canvas
    .requestPointerLock({ unadjustedMovement: true })
    ?.catch?.(() => canvas.requestPointerLock()?.catch?.(() => undefined));
};

const syncLook = (p: Player) => {
  input.yaw = p.yaw;
  input.pitch = p.pitch;
};

/** While waiting to respawn, the world turns grey and the player can't act. */
function setKoBy(name: string | null): void {
  koBy = name;
  canvas.classList.toggle('ko', name !== null);
}

function toggleView(): void {
  settings.thirdPerson = !settings.thirdPerson;
  saveSettings(settings);
  view.cameraChanged();
}

function play(): void {
  state = 'playing';
  menus.hide();
  hud.setVisible(true);
  input.enabled = true;
  lastFrame = performance.now();
  accumulator = 0;
  lockPointer();
}

function restart(): void {
  world.reset();
  prevPos = { ...world.player.pos };
  syncLook(world.player);
}

function pause(): void {
  if (state !== 'playing') return;
  state = 'paused';
  input.enabled = false;
  input.clear();
  menus.showPause();
}

/** Only watching a room: no body, no input, the camera follows one player after another. */
let watching = false;
let watchIndex = 0;

function setWatching(on: boolean): void {
  watching = on;
  watchIndex = 0;
  view.watching = on;
  hud.setWatching(on);
}

/** Puts the camera on the followed player. A click or Space moves on to the next one, Shift back. */
function followWatched(): void {
  const alive = world.dummies.filter((d) => d.respawnT === 0);
  const s = input.sample();
  if (s.shoot || s.jump) watchIndex += 1;
  if (s.dash) watchIndex -= 1;
  const p = world.player;
  if (!alive.length) {
    hud.watching = 'ยังไม่มีใครเล่นอยู่ในห้องนี้ · Esc เพื่อออก';
    return;
  }
  const target = alive[((watchIndex % alive.length) + alive.length) % alive.length];
  prevPos = { ...target.pos };
  p.pos = { ...target.pos };
  p.vel = { x: 0, y: 0, z: 0 };
  p.mode = 'air';
  hud.watching = `กำลังดู ${target.name ?? 'ผู้เล่น'} · คลิกหรือ Space เปลี่ยนคน · Esc เพื่อออก`;
}

function backToMenu(): void {
  setWatching(false);
  state = 'menu';
  setKoBy(null);
  input.enabled = false;
  input.clear();
  world.setOnline(false);
  hud.online = null;
  if (document.pointerLockElement) document.exitPointerLock();
  hud.setVisible(false);
}

function spawnAt(pos: Vec, yaw: number): void {
  world.respawnAt(toV3(pos), yaw);
  prevPos = { ...world.player.pos };
  syncLook(world.player);
  view.cameraChanged();
}

const NET_ERRORS: Record<NetError, string> = {
  'not-found': 'ไม่พบห้องนี้ เช็กรหัสอีกครั้ง',
  full: 'ห้องเต็มแล้ว',
  busy: 'ระบบห้องไม่ว่าง ลองอีกครั้งภายหลัง',
  'no-store': 'ระบบห้องยังไม่พร้อม ต้องเชื่อม Redis ใน Vercel ก่อน',
  unavailable: 'ระบบห้องขัดข้องชั่วคราว กรุณาลองอีกครั้ง',
  connect: 'ต่อกับเจ้าของห้องไม่ได้ มักเกิดเมื่อเล่นใน Wi-Fi เดียวกันหรือเน็ตมือถือบางเจ้า ลองใหม่อีกครั้ง หรือให้เจ้าของเกมเปิดเซิร์ฟเวอร์ส่งต่อ (TURN)',
  'no-rooms': 'ตอนนี้ยังไม่มีห้องที่มีคนเล่นอยู่ สร้างห้องเองหรือซ้อมคนเดียวก่อนได้',
  network: 'ติดต่อระบบห้องไม่ได้ เช็กอินเทอร์เน็ตแล้วลองใหม่',
};

const netMessage = (error: unknown) =>
  NET_ERRORS[error instanceof SignalError ? error.reason : 'connect'];

function onNetMessage(m: ServerMessage): void {
  switch (m.t) {
    case 'joined':
      lobby.stop();
      world.setOnline(true);
      spawnAt(m.pos, m.yaw);
      setWatching(m.watching === true);
      play();
      hud.toast(m.watching ? `กำลังดูห้อง ${m.code}` : `ห้อง ${m.code}`);
      break;
    case 'roundStart': {
      const spawn = m.spawns.find((s) => s.id === net.id);
      setKoBy(null);
      if (spawn) spawnAt(spawn.pos, spawn.yaw);
      hud.callout('เริ่มรอบใหม่!', true);
      break;
    }
    case 'error':
      net.close();
      menus.onlineStatus(NET_ERRORS[m.reason]);
      break;
    case 'playerJoin':
      hud.toast(`${m.player.name} เข้าห้อง`);
      break;
    case 'shot':
      world.addGhostShot(toV3(m.origin), toV3(m.dir), m.snare, m.crate === true, net.match?.mode === 'teams' && !!net.players.get(m.id)?.team && net.players.get(m.id)?.team === net.players.get(net.id)?.team);
      break;
    case 'knock':
      if (m.target === net.id) knockPlayer(world.player, world.map, toV3(m.vel), m.stun, m.pin);
      break;
    case 'healed':
      if (m.target === net.id) {
        world.player.hp = m.hp;
        hud.callout('ฟื้นเลือด');
      }
      break;
    case 'damage':
      if (m.target === net.id) {
        world.player.hp = m.hp;
        if (m.ko) {
          setKoBy(net.players.get(m.by)?.name ?? '');
          profile.deaths += 1;
          saveProfile(profile);
        } else {
          hud.hurt();
        }
      } else if (m.by === net.id) {
        // The mark waits for the server, so it never shows on a hit that didn't count.
        hud.hitConfirm(m.ko);
        if (m.ko) {
          hud.toast('KO!', true);
          profile.kills += 1;
          saveProfile(profile);
        }
      }
      break;
    case 'snared':
      if (m.target === net.id) {
        snarePlayer(world.player);
        hud.toast('โดนแช่แข็ง!');
      } else if (m.by === net.id) {
        hud.hitConfirm(false);
        hud.toast('แช่แข็งแล้ว');
      }
      break;
    case 'respawn':
      if (m.id === net.id) {
        setKoBy(null);
        spawnAt(m.pos, m.yaw);
      }
      break;
  }
}

function onNetClosed(): void {
  backToMenu();
  menus.showOnline();
  menus.onlineStatus('ออกจากห้องแล้ว เพราะเจ้าของห้องออกหรือการเชื่อมต่อหลุด');
}

const net = new NetClient(onNetMessage, onNetClosed);
const lobby = new LobbyPoller(
  () => net.listRooms(),
  (rooms) => menus.showRooms(rooms),
  (error) => menus.roomBoardError(netMessage(error), () => {
    menus.roomBoardLoading();
    lobby.start();
  }),
  LOBBY_REFRESH_MS,
);

function rememberName(name: string): void {
  profile.name = name.trim();
  saveProfile(profile);
}

const menus = new Menus(uiRoot, settings, profile, {
  start() {
    restart();
    play();
  },
  resume: play,
  restart() {
    restart();
    play();
  },
  quit() {
    net.close();
    backToMenu();
    restart();
    menus.showMain();
  },
  settingsChanged() {
    view.applySettings();
    hud.applySettings();
  },
  createRoom(name, maxPlayers, mode, privateRoom) {
    rememberName(name);
    menus.onlineStatus('กำลังสร้างห้อง…');
    net.create(name, maxPlayers, mode, privateRoom).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  playNow() {
    menus.onlineStatus('กำลังหาห้องที่มีคนเล่นอยู่…');
    net.joinRandom(profile.name || 'ผู้เล่น').catch((error) => menus.onlineStatus(netMessage(error)));
  },
  watchRoom(code, name) {
    rememberName(name);
    menus.onlineStatus('กำลังเข้าไปดู อาจใช้เวลาสักครู่…');
    net.join(code, name, true).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  quickPlay(name) {
    rememberName(name);
    menus.onlineStatus('กำลังสุ่มหาห้อง หากยังไม่มีจะสร้างห้องใหม่…');
    net.quickPlay(name).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  joinRoom(code, name) {
    rememberName(name);
    menus.onlineStatus('กำลังเข้าห้อง อาจใช้เวลาสักครู่…');
    net.join(code, name).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  openLobby() {
    lobby.start();
  },
  closeLobby() {
    lobby.stop();
    net.close();
  },
  saveName: rememberName,
  roomCode: () => net.code,
  async copyInvite() {
    const link = `${location.origin}/?room=${net.code}`;
    try {
      await navigator.clipboard.writeText(link);
      return 'คัดลอกลิงก์แล้ว';
    } catch {
      // Clipboard needs https, so a plain Wi-Fi address shows the link to read out instead.
      return link;
    }
  },
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) pause();
});
canvas.addEventListener('click', () => {
  if (state === 'playing' && !document.pointerLockElement) lockPointer();
});
hud.pauseButton.addEventListener('click', pause);
hud.viewButton.addEventListener('click', toggleView);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
window.addEventListener('keydown', (e) => {
  // Without pointer lock, Esc arrives as a normal key.
  if (e.code === 'Escape' && !document.pointerLockElement) pause();
});

function handleEvents(): void {
  for (const e of world.events) {
    switch (e.type) {
      case 'shot':
        view.recoil();
        if (world.online) {
          net.send({ t: 'shot', origin: toVec(e.origin), dir: [e.dir.x, e.dir.y, e.dir.z], snare: e.snare });
        }
        break;
      case 'land':
        view.land(e.speed);
        break;
      case 'slam':
        view.slam(e.speed);
        break;
      case 'jumpPad':
        view.flashPad(e.index);
        break;
      case 'outOfBounds':
        view.cameraChanged();
        prevPos = { ...world.player.pos };
        input.yaw = e.yaw;
        input.pitch = 0;
        hud.toast('กลับเข้าแมพแล้ว');
        break;
      case 'netHit':
        net.send({
          t: 'hit',
          target: e.target,
          snare: e.snare,
          kind: e.kind,
          knock: e.knock && toVec(e.knock),
          stun: e.stun,
          pin: e.pin,
          power: e.power,
        });
        break;
      case 'hit':
        hud.hitConfirm(e.ko);
        if (e.ko) hud.toast('KO!', true);
        break;
      case 'hitTarget':
        view.punch(e.kind);
        break;
      case 'crateThrown':
        view.recoil();
        if (world.online) {
          net.send({ t: 'shot', origin: toVec(e.origin), dir: [e.dir.x, e.dir.y, e.dir.z], snare: false, crate: true });
        }
        break;
      case 'heal':
        if (world.online) net.send({ t: 'heal' });
        else hud.callout('ฟื้นเลือด');
        break;
      case 'perfect':
        hud.callout(PERFECT_TEXT[e.what]);
        if (e.what === 'dodge') view.slowFlash();
        break;
      case 'trick':
        hud.callout(TRICK_TEXT[e.kind % TRICK_TEXT.length]);
        break;
      case 'finisher':
        hud.callout('ท่าปิดฉาก!', true);
        view.slam(40);
        break;
      case 'pound':
        view.pound(e.at, e.radius);
        break;
      case 'pointLaunch':
        view.burst();
        break;
      case 'snare':
        hud.hitConfirm(false);
        hud.toast('แช่แข็งแล้ว');
        break;
      case 'lap':
        hud.toast(`จบรอบ ${formatTime(e.time)}${e.best ? ' สถิติใหม่!' : ''}`, e.best);
        if (e.best) saveBestLap(e.time);
        break;
    }
  }
  world.events.length = 0;
}

const PERFECT_TEXT = {
  release: 'ปล่อยใยเป๊ะ!',
  dodge: 'หลบเป๊ะ!',
  hit: 'จังหวะเป๊ะ!',
  recover: 'ฟื้นตัว!',
} as const;
const TRICK_TEXT = ['ตีลังกา', 'หมุนสว่าน', 'กางดาว'];

const lineVec = (line: { x: number; y: number; z: number } | null) => (line ? toVec(line) : null);

function sendState(dt: number): void {
  stateTimer += dt;
  if (stateTimer < 1 / STATE_HZ) return;
  stateTimer = 0;
  if (koBy !== null) return;

  const p = world.player;
  net.send({
    t: 'state',
    pos: toVec(p.pos),
    yaw: Math.round(input.yaw * 1000) / 1000,
    pitch: Math.round(input.pitch * 1000) / 1000,
    anchor: lineVec(webLineOf(p)),
    mode: poseOf(p),
    motion: p.mode,
    safe: p.dodgeT > 0,
  });
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // An online match keeps going behind the pause menu.
  const running = state === 'playing' || (state === 'paused' && world.online);

  if (running) {
    if (input.consumeReset() && !world.online) restart();
    if (input.consumeView()) toggleView();
    input.aimFrom = view.aimFrom();
    if (world.online) {
      world.dummies = net.targets(now);
      world.gameMode = net.match?.mode ?? 'deathmatch';
      world.myTeam = net.players.get(net.id)?.team;
      const holder = world.gameMode === 'crown' ? net.match?.holder : null;
      const otherHolder = world.dummies.find((d) => d.id === holder && d.respawnT === 0);
      world.crownMine = holder !== null && holder !== undefined && holder === net.id;
      world.crown = world.crownMine
        ? { ...world.player.pos, y: world.player.pos.y + CROWN_CARRY_HEIGHT }
        : otherHolder
          ? { ...otherHolder.pos, y: otherHolder.pos.y + CROWN_CARRY_HEIGHT }
          : world.gameMode === 'crown' && net.match?.crown ? toV3(net.match.crown) : null;
    }

    if (watching) {
      followWatched();
      world.stepWatching(dt);
      accumulator = 0;
      world.events.length = 0;
    }

    accumulator += watching ? 0 : dt;
    while (accumulator >= TICK) {
      const p = world.player;
      prevPos = { ...p.pos };
      input.setContext(p.mode !== 'ground', p.mode === 'wall');
      const canAct = state === 'playing' && koBy === null;
      world.step(canAct ? input.sample() : { ...emptyInput(), yaw: input.yaw, pitch: input.pitch }, TICK);
      accumulator -= TICK;
    }
    handleEvents();
    if (world.online && !watching) sendState(dt);
  }

  const renderDt = frameLimiter.advance(dt);
  if (renderDt !== null && state === 'menu') {
    view.renderMenu(world, renderDt);
  } else if (renderDt !== null) {
    view.renderGame(world, prevPos, accumulator / TICK, input.yaw, input.pitch, running ? renderDt : 0);
    if (world.online) {
      hud.scoresKey = input.scoresHeld();
      hud.online = {
        code: net.code,
        myId: net.id,
        players: [...net.players.values()],
        koBy,
        ping: net.ping,
        isHost: net.isHost,
        match: net.match,
      };
    }
    hud.update(world);
  }

  requestAnimationFrame(frame);
}

syncLook(world.player);

// A friend's invite link opens straight on the join screen with the code filled in.
const invited = cleanCode(new URLSearchParams(location.search).get('room') ?? '');
const firstScreen = () => {
  if (invited.length === CODE_LENGTH) menus.showOnline(invited);
  else menus.showMain();
};
if (profile.noticeSeen) firstScreen();
else menus.showWelcome(firstScreen);

loadingRetry.addEventListener('click', () => location.reload());
void view.ready.then(() => {
  // Draw the first complete city behind the loading screen before opening the menu.
  view.renderMenu(world, 0);
  lastFrame = performance.now();
  uiRoot.inert = false;
  loading.remove();
  requestAnimationFrame(frame);
}).catch((error: unknown) => {
  console.error('Could not prepare the game.', error);
  loading.querySelector('.loading-spinner')?.remove();
  loadingMessage.textContent = 'โหลดเกมไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง';
  loadingRetry.hidden = false;
});

if (import.meta.env.DEV) {
  Object.assign(window, { __zx: { world, input, view, net } });
}
