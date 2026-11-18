// Human-like input for the demo recordings: curved pointer paths with a minimum-jerk speed
// profile (slow start, fast middle, gentle landing), Fitts's-law timing, small overshoots on long
// moves, a landing point that is never the exact centre, reading pauses with a little drift,
// uneven typing and trackpad-style scrolling. A headless browser has no system cursor, so every
// position is logged and compose.py draws the pointer at 60 fps over the page frames.
import type { Locator, Page } from "playwright";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seeded PRNG, so a re-recording moves the same way. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum-jerk position profile: the speed curve of a relaxed hand movement. */
const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Event =
  | { t: number; type: "zoom"; box: Box | null; scale?: number }
  | { t: number; type: "caption"; text: string | null }
  | { t: number; type: "mark"; name: string };

export class Human {
  x = 0;
  y = 0;
  readonly events: Event[] = [];
  /** Every pointer position (and press), for the compositor to draw a 60 fps cursor. */
  readonly pointer: [t: number, x: number, y: number, down: 0 | 1][] = [];
  private down: 0 | 1 = 0;
  private rnd: () => number;

  constructor(
    private page: Page,
    seed = 7,
  ) {
    this.rnd = mulberry32(seed);
  }

  private r(a: number, b: number) {
    return a + (b - a) * this.rnd();
  }

  /** Camera and caption cues for the compositor, stamped with the browser's clock. */
  zoom(box: Box | null, scale?: number) {
    this.events.push({ t: Date.now() / 1000, type: "zoom", box, scale });
  }
  caption(text: string | null) {
    this.events.push({ t: Date.now() / 1000, type: "caption", text });
  }
  mark(name: string) {
    this.events.push({ t: Date.now() / 1000, type: "mark", name });
  }

  private async to(x: number, y: number) {
    this.pointer.push([Date.now() / 1000, x, y, this.down]);
    await this.page.mouse.move(x, y);
  }

  async place(x: number, y: number) {
    this.x = x;
    this.y = y;
    await this.to(x, y);
  }

  /** Move along a gently curved path; long moves overshoot a little and correct. */
  async moveTo(tx: number, ty: number, opts: { width?: number; speed?: number } = {}) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const overshoot = d > 280 && this.rnd() < 0.55;
    let ex = tx;
    let ey = ty;
    if (overshoot) {
      const k = this.r(6, 14) / d;
      ex = tx + dx * k + this.r(-3, 3);
      ey = ty + dy * k + this.r(-3, 3);
    }
    await this.segment(ex, ey, d, opts.width ?? 40, opts.speed ?? 1);
    if (overshoot) {
      await sleep(this.r(40, 90));
      await this.segment(tx, ty, Math.hypot(tx - ex, ty - ey), 12, 1.4);
    }
  }

  private async segment(tx: number, ty: number, d: number, width: number, speed: number) {
    const sx = this.x;
    const sy = this.y;
    // Fitts's law: time grows with the log of distance over target size.
    const ms = ((140 + 150 * Math.log2(1 + d / Math.max(width, 8))) * this.r(0.88, 1.15)) / speed;
    // One bend, to one side, like a wrist pivoting.
    const nx = -(ty - sy) / (d || 1);
    const ny = (tx - sx) / (d || 1);
    const bend = d * this.r(0.04, 0.16) * (this.rnd() < 0.5 ? -1 : 1);
    const c1 = { x: sx + (tx - sx) * 0.3 + nx * bend, y: sy + (ty - sy) * 0.3 + ny * bend };
    const c2 = {
      x: sx + (tx - sx) * 0.75 + nx * bend * 0.6,
      y: sy + (ty - sy) * 0.75 + ny * bend * 0.6,
    };
    const start = performance.now();
    for (;;) {
      const el = performance.now() - start;
      const u = Math.min(1, el / ms);
      const s = minJerk(u);
      const a = 1 - s;
      // cubic Bézier
      const x = a * a * a * sx + 3 * a * a * s * c1.x + 3 * a * s * s * c2.x + s * s * s * tx;
      const y = a * a * a * sy + 3 * a * a * s * c1.y + 3 * a * s * s * c2.y + s * s * s * ty;
      // a hand is never perfectly steady
      const tremor = (1 - Math.abs(0.5 - u) * 2) * 0.6;
      this.x = x + this.r(-tremor, tremor);
      this.y = y + this.r(-tremor, tremor);
      await this.to(this.x, this.y);
      if (u >= 1) break;
      await sleep(14);
    }
    this.x = tx;
    this.y = ty;
    await this.to(tx, ty);
  }

  /** A point a person would aim at: inside the middle of the target, not its exact centre. */
  private aim(b: Box) {
    return {
      x: b.x + b.width * this.r(0.35, 0.62),
      y: b.y + b.height * this.r(0.4, 0.6),
    };
  }

  async box(target: Locator | string): Promise<Box> {
    const loc = typeof target === "string" ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: "visible", timeout: 15000 });
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no box for ${String(target)}`);
    return b;
  }

  async hover(target: Locator | string, dwell = [180, 360]) {
    const b = await this.box(target);
    const p = this.aim(b);
    await this.moveTo(p.x, p.y, { width: Math.min(b.width, b.height * 3) });
    await sleep(this.r(dwell[0] as number, dwell[1] as number));
    return b;
  }

  async click(target: Locator | string, opts: { dwell?: [number, number] } = {}) {
    const b = await this.hover(target, opts.dwell ?? [90, 220]);
    this.down = 1;
    this.pointer.push([Date.now() / 1000, this.x, this.y, 1]);
    await this.page.mouse.down();
    await sleep(this.r(60, 110));
    this.down = 0;
    this.pointer.push([Date.now() / 1000, this.x, this.y, 0]);
    await this.page.mouse.up();
    return b;
  }

  /** Type like a person: uneven rhythm, a beat after spaces, now and then a pause to think. */
  async type(text: string) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      let ms = this.r(55, 130);
      if (ch === " ") ms += this.r(30, 90);
      if (this.rnd() < 0.06) ms += this.r(180, 360);
      await sleep(ms);
    }
  }

  async press(key: string) {
    await sleep(this.r(80, 160));
    await this.page.keyboard.press(key);
  }

  /** Read: stay put, with the slow drift of a resting hand. */
  async read(ms: number) {
    const end = performance.now() + ms;
    const ox = this.x;
    const oy = this.y;
    let phase = this.r(0, Math.PI * 2);
    while (performance.now() < end) {
      phase += 0.05;
      this.x = ox + Math.sin(phase) * 2.2 + Math.sin(phase * 0.37) * 3;
      this.y = oy + Math.cos(phase * 0.8) * 1.6;
      await this.to(this.x, this.y);
      await sleep(40);
    }
  }

  /** Trackpad scroll: a flick that eases out, in small wheel steps. */
  async scroll(dy: number, ms = 700) {
    const steps = Math.max(8, Math.round(ms / 16));
    let done = 0;
    for (let i = 1; i <= steps; i++) {
      const target = dy * (1 - (1 - i / steps) ** 3);
      const step = target - done;
      done = target;
      await this.page.mouse.wheel(0, step);
      await sleep(16);
    }
  }

  pause(ms: number) {
    return sleep(ms * this.r(0.9, 1.1));
  }
}
