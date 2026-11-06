import { InputManager } from './input';
import { blockPageZoom } from './mobile';
import { NetClient } from './net/client';
import { cleanCode, CODE_LENGTH, STATE_HZ, type ServerMessage, type Vec } from './net/protocol';
import { SignalError, type NetError } from './net/signal';
import { GameView } from './render/view';
import { loadProfile, saveProfile } from './profile';
import { isTouchDevice, loadBestLap, loadSettings, saveBestLap } from './settings';
import { createAimState, stepAim } from './sim/aim';
import { emptyInput, eyePosition, snarePlayer, type Player } from './sim/player';
import type { V3 } from './sim/map';
import { TICK, World } from './sim/world';
import { formatTime, Hud, Menus } from './ui';

type State = 'menu' | 'playing' | 'paused';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const uiRoot = document.querySelector<HTMLElement>('#ui')!;
const touchDevice = isTouchDevice();

const LOBBY_REFRESH_MS = 5000;

const settings = loadSettings();
const profile = loadProfile();
const world = new World(loadBestLap());
const view = new GameView(canvas, world.map, settings, !touchDevice);
const hud = new Hud(uiRoot, view, settings);
const input = new InputManager(settings, hud.stick);
input.bindTouch(hud.touch, hud.moveButton, hud.attackButton, hud.dashButton, hud.snareButton);

blockPageZoom();

let state: State = 'menu';
let accumulator = 0;
let lastFrame = performance.now();
let prevPos = { ...world.player.pos };

/** Set while waiting to respawn: the name of whoever got the KO. */
let koBy: string | null = null;
let stateTimer = 0;
let lobbyTimer = 0;
const aim = createAimState();

const toV3 = (v: Vec): V3 => ({ x: v[0], y: v[1], z: v[2] });
const toVec = (v: V3): Vec => [
  Math.round(v.x * 100) / 100,
  Math.round(v.y * 100) / 100,
  Math.round(v.z * 100) / 100,
];

const lockPointer = () => {
  if (touchDevice) return;
  // The browser refuses a re-lock right after Esc. The next click on the game tries again.
  canvas.requestPointerLock()?.catch?.(() => undefined);
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

function backToMenu(): void {
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
}

const NET_ERRORS: Record<NetError, string> = {
  'not-found': 'ไม่พบห้องนี้ เช็กรหัสอีกครั้ง',
  full: 'ห้องเต็มแล้ว',
  busy: 'ระบบห้องไม่ว่าง ลองอีกครั้งภายหลัง',
  'no-store': 'ระบบห้องยังไม่พร้อม ต้องเชื่อม Redis ใน Vercel ก่อน',
  connect: 'เชื่อมต่อกับเจ้าของห้องไม่ได้ เครือข่ายอาจบล็อกการต่อตรง',
  network: 'ติดต่อระบบห้องไม่ได้ เช็กอินเทอร์เน็ตแล้วลองใหม่',
};

const netMessage = (error: unknown) =>
  NET_ERRORS[error instanceof SignalError ? error.reason : 'connect'];

function onNetMessage(m: ServerMessage): void {
  switch (m.t) {
    case 'joined':
      window.clearInterval(lobbyTimer);
      world.setOnline(true);
      spawnAt(m.pos, m.yaw);
      play();
      hud.toast(`ห้อง ${m.code}`);
      break;
    case 'error':
      net.close();
      menus.onlineStatus(NET_ERRORS[m.reason]);
      break;
    case 'playerJoin':
      hud.toast(`${m.player.name} เข้าห้อง`);
      break;
    case 'shot':
      world.addGhostShot(toV3(m.origin), toV3(m.dir), m.snare);
      break;
    case 'damage':
      if (m.target === net.id) {
        view.hitFeedback(m.ko);
        if (m.ko) {
          setKoBy(net.players.get(m.by)?.name ?? '');
          profile.deaths += 1;
          saveProfile(profile);
        } else {
          hud.toast('โดนยิง!');
        }
      } else if (m.by === net.id) {
        // The mark waits for the server, so it never shows on a hit that didn't count.
        hud.hitConfirm(m.ko);
        if (m.ko) {
          hud.toast('KO!', true);
          view.hitFeedback(true);
          profile.kills += 1;
          saveProfile(profile);
        }
      }
      break;
    case 'snared':
      if (m.target === net.id) {
        snarePlayer(world.player);
        hud.toast('โดนใยรัด!');
      } else if (m.by === net.id) {
        hud.hitConfirm(false);
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

async function refreshRooms(): Promise<void> {
  try {
    menus.showRooms(await net.listRooms());
  } catch (error) {
    menus.roomBoardError(netMessage(error));
  }
}

const net = new NetClient(onNetMessage, onNetClosed);

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
  createRoom(name, maxPlayers) {
    rememberName(name);
    menus.onlineStatus('กำลังสร้างห้อง…');
    net.create(name, maxPlayers).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  joinRoom(code, name) {
    rememberName(name);
    menus.onlineStatus('กำลังเข้าห้อง อาจใช้เวลาสักครู่…');
    net.join(code, name).catch((error) => menus.onlineStatus(netMessage(error)));
  },
  openLobby() {
    window.clearInterval(lobbyTimer);
    void refreshRooms();
    lobbyTimer = window.setInterval(() => void refreshRooms(), LOBBY_REFRESH_MS);
  },
  closeLobby() {
    window.clearInterval(lobbyTimer);
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
      case 'outOfBounds':
        prevPos = { ...world.player.pos };
        input.yaw = e.yaw;
        input.pitch = 0;
        hud.toast('กลับเข้าแมพแล้ว');
        break;
      case 'netHit':
        net.send({ t: 'hit', target: e.target, snare: e.snare });
        break;
      case 'hit':
        hud.hitConfirm(e.ko);
        if (e.ko) hud.toast('KO!', true);
        view.hitFeedback(e.ko);
        break;
      case 'snare':
        hud.hitConfirm(false);
        hud.toast('รัดติดแล้ว');
        break;
      case 'lap':
        hud.toast(`จบรอบ ${formatTime(e.time)}${e.best ? ' สถิติใหม่!' : ''}`, e.best);
        if (e.best) saveBestLap(e.time);
        break;
    }
  }
  world.events.length = 0;
}

function updateAim(dt: number): void {
  const motion = input.takeLookMotion();
  if (!settings.aimAssist || state !== 'playing' || koBy !== null) {
    input.lookScale = 1;
    return;
  }
  const result = stepAim(
    aim,
    input.yaw,
    input.pitch,
    eyePosition(world.player),
    world.map,
    world.dummies,
    dt,
    motion,
    input.aimScale,
  );
  input.yaw = result.yaw;
  input.pitch = result.pitch;
  input.lookScale = result.lookScale;
}

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
    anchor: p.mode === 'swing' && p.anchor ? toVec(p.anchor) : null,
  });
}

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // An online match keeps going behind the pause menu.
  const running = state === 'playing' || (state === 'paused' && world.online);

  if (running) {
    if (input.consumeReset() && !world.online) restart();
    if (world.online) world.dummies = net.targets(now);
    updateAim(dt);

    accumulator += dt;
    while (accumulator >= TICK) {
      const p = world.player;
      prevPos = { ...p.pos };
      input.setContext(p.mode !== 'ground', p.mode === 'wall');
      const canAct = state === 'playing' && koBy === null;
      world.step(canAct ? input.sample() : { ...emptyInput(), yaw: input.yaw, pitch: input.pitch }, TICK);
      accumulator -= TICK;
    }
    handleEvents();
    if (world.online) sendState(dt);
  }

  if (state === 'menu') {
    view.renderMenu(world, dt);
  } else {
    view.renderGame(world, prevPos, accumulator / TICK, input.yaw, input.pitch, running ? dt : 0);
    if (world.online) {
      hud.scoresKey = input.scoresHeld();
      hud.online = {
        code: net.code,
        myId: net.id,
        players: [...net.players.values()],
        koBy,
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

requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, { __zx: { world, input, view, net } });
}
