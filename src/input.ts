// Turns keyboard, mouse and touch into the same TickInput the simulation reads.

import { emptyInput, type TickInput } from './sim/player';
import { isCoarsePointer, type Action, type Settings } from './settings';

const MOUSE_LOOK = 0.0022;
const TOUCH_LOOK = 0.0048;
const PITCH_LIMIT = 1.5;
/** Thumbs can't aim as finely as a mouse, so touch gets wider aim help. */
const TOUCH_AIM_SCALE = 1.5;

const STICK_RADIUS = 60;
const FLICK_TIME = 180;
const FLICK_DISTANCE = 45;
const SLIDE_FROM_FLICK = 650;

/** Holding the move button on the ground this long starts a swing. */
const SWING_HOLD = 150;

interface StickTouch {
  id: number;
  startX: number;
  startY: number;
  startT: number;
  x: number;
  y: number;
}

export class InputManager {
  yaw = 0;
  pitch = 0;
  enabled = false;
  readonly aimScale = isCoarsePointer() ? TOUCH_AIM_SCALE : 1;

  private held = new Set<string>();
  private pressed = new Set<Action>();

  private stick: StickTouch | null = null;
  private lookId: number | null = null;
  private lookX = 0;
  private lookY = 0;
  private flick: { x: number; z: number } | null = null;
  private slideUntil = 0;

  private touchSwing = false;
  private swingTimer = 0;

  private airborne = false;
  private onWall = false;

  constructor(
    private readonly settings: Settings,
    private readonly stickView: HTMLElement,
  ) {
    window.addEventListener('keydown', (e) => {
      // Held keys repeat, and each repeat must be blocked too, or holding Tab moves
      // the browser's focus around the page.
      if (this.enabled && e.code !== 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
      if (!e.repeat) this.press(e.code);
    });
    window.addEventListener('keyup', (e) => this.release(e.code));
    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement) this.press(`Mouse${e.button}`);
    });
    window.addEventListener('mouseup', (e) => this.release(`Mouse${e.button}`));
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || !document.pointerLockElement) return;
      this.look(e.movementX * MOUSE_LOOK * settings.mouseSens, e.movementY * MOUSE_LOOK * settings.mouseSens);
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.clear());
  }

  /** Tells touch buttons what the player is doing, so one button can mean jump or swing. */
  setContext(airborne: boolean, onWall: boolean): void {
    this.airborne = airborne;
    this.onWall = onWall;
  }

  clear(): void {
    this.held.clear();
    this.pressed.clear();
    this.stick = null;
    this.lookId = null;
    this.touchSwing = false;
    window.clearTimeout(this.swingTimer);
    this.stickView.classList.remove('on');
  }

  scoresHeld(): boolean {
    return this.held.has(this.settings.keys.scores);
  }

  consumeReset(): boolean {
    return this.pressed.delete('reset');
  }

  sample(): TickInput {
    const keys = this.settings.keys;
    const down = (a: Action) => this.held.has(keys[a]);
    const input = emptyInput();

    input.moveX = (down('right') ? 1 : 0) - (down('left') ? 1 : 0);
    input.moveZ = (down('forward') ? 1 : 0) - (down('back') ? 1 : 0);

    if (this.stick) {
      const dx = this.stick.x - this.stick.startX;
      const dy = this.stick.y - this.stick.startY;
      const len = Math.hypot(dx, dy);
      const k = len > 8 ? Math.min(1, len / STICK_RADIUS) / len : 0;
      input.moveX = dx * k;
      input.moveZ = -dy * k;
    }

    if (this.flick) {
      input.moveX = this.flick.x;
      input.moveZ = this.flick.z;
      this.flick = null;
    }

    input.yaw = this.yaw;
    input.pitch = this.pitch;
    input.jump = this.pressed.delete('jump');
    input.dash = this.pressed.delete('dash');
    input.shoot = this.pressed.delete('shoot');
    input.snare = this.pressed.delete('snare');
    input.swing = down('swing') || this.touchSwing;
    input.slide = down('slide') || performance.now() < this.slideUntil;
    input.aimAssist = this.settings.aimAssist;
    input.aimScale = this.aimScale;
    input.webAssist = !this.settings.aimAssist ? 'off' : isCoarsePointer() ? 'wide' : 'near';
    return input;
  }

  private look(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy));
  }

  private press(code: string): void {
    if (!this.enabled) return;
    this.held.add(code);
    const keys = this.settings.keys;
    for (const action of Object.keys(keys) as Action[]) {
      if (keys[action] === code) this.pressed.add(action);
    }
  }

  private release(code: string): void {
    this.held.delete(code);
  }

  // ------------------------------------------------------------------ touch

  bindTouch(
    surface: HTMLElement,
    moveButton: HTMLElement,
    attackButton: HTMLElement,
    dashButton: HTMLElement,
    snareButton: HTMLElement,
  ): void {
    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      surface.setPointerCapture(e.pointerId);
      const onLeft = e.clientX < window.innerWidth * 0.45;
      if (onLeft && !this.stick) {
        this.stick = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startT: performance.now(),
          x: e.clientX,
          y: e.clientY,
        };
        this.stickView.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        this.stickView.classList.add('on');
      } else if (!onLeft && this.lookId === null) {
        this.lookId = e.pointerId;
        this.lookX = e.clientX;
        this.lookY = e.clientY;
      }
    });

    surface.addEventListener('pointermove', (e) => {
      if (this.stick?.id === e.pointerId) {
        this.stick.x = e.clientX;
        this.stick.y = e.clientY;
      } else if (this.lookId === e.pointerId) {
        const k = TOUCH_LOOK * this.settings.touchSens;
        this.look((e.clientX - this.lookX) * k, (e.clientY - this.lookY) * k);
        this.lookX = e.clientX;
        this.lookY = e.clientY;
      }
    });

    const end = (e: PointerEvent) => {
      if (this.stick?.id === e.pointerId) {
        this.endStick(this.stick);
        this.stick = null;
        this.stickView.classList.remove('on');
      } else if (this.lookId === e.pointerId) {
        this.lookId = null;
      }
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);

    this.bindButton(
      moveButton,
      () => {
        if (!this.enabled) return;
        if (this.airborne && !this.onWall) {
          this.touchSwing = true;
        } else {
          this.pressed.add('jump');
          this.swingTimer = window.setTimeout(() => {
            this.touchSwing = true;
          }, SWING_HOLD);
        }
      },
      () => {
        window.clearTimeout(this.swingTimer);
        this.touchSwing = false;
      },
    );

    const tap = (el: HTMLElement, action: Action) =>
      this.bindButton(
        el,
        () => {
          if (this.enabled) this.pressed.add(action);
        },
        () => undefined,
      );
    tap(attackButton, 'shoot');
    tap(dashButton, 'dash');
    tap(snareButton, 'snare');
  }

  private bindButton(el: HTMLElement, onDown: () => void, onUp: () => void): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      onDown();
    });
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      el.classList.remove('down');
      onUp();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** A quick flick of the move thumb: sideways or up dashes, down slides. */
  private endStick(s: StickTouch): void {
    const elapsed = performance.now() - s.startT;
    const dx = s.x - s.startX;
    const dy = s.y - s.startY;
    const len = Math.hypot(dx, dy);
    if (elapsed > FLICK_TIME || len < FLICK_DISTANCE) return;

    if (dy > Math.abs(dx)) {
      this.slideUntil = performance.now() + SLIDE_FROM_FLICK;
    } else {
      this.flick = { x: dx / len, z: -dy / len };
      this.pressed.add('dash');
    }
  }
}
