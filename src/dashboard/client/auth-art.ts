// The living part of the sign-in drawing: the anvil's dot-matrix shadow, drawn on a canvas over
// the line drawing. Each dot breathes a little, a few flicker like a live dither, and every few
// seconds a band of light sweeps across, warming the dots it passes. The sun's slow breathing
// is CSS (app.css, .aa-sun). Respects prefers-reduced-motion, pauses in background tabs and
// stops when the sign-in screen goes away.
import { ANVIL_DOT_PITCH, ANVIL_DOTS } from "./anvil-dots";

type Dot = { x: number; y: number; ph: number; boil: number };

function decode(): Dot[] {
  const out: Dot[] = [];
  for (let i = 0; i < ANVIL_DOTS.length; i += 4) {
    const x = Number.parseInt(ANVIL_DOTS.slice(i, i + 2), 16);
    const y = Number.parseInt(ANVIL_DOTS.slice(i + 2, i + 4), 16);
    // a stable pseudo-random phase per dot, so the pattern is the same on every load
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const r = h - Math.floor(h);
    out.push({ x, y, ph: r * Math.PI * 2, boil: Math.floor(r * 997) });
  }
  return out;
}

export function startAuthArt(root: HTMLElement): void {
  const fig = root.querySelector<HTMLElement>(".aa-fig");
  const cv = fig?.querySelector<HTMLCanvasElement>("canvas.aa-dots");
  const ctx = cv?.getContext("2d");
  if (!fig || !cv || !ctx) return;
  const dots = decode();
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0;
  let h = 0;
  let dpr = 1;
  const size = () => {
    const r = fig.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width;
    h = r.height;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  };
  const draw = (t: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const k = w / 760;
    const s = Math.max(1, 2 * k);
    // the light band: a diagonal that crosses the drawing every 6 s
    const sweep = still ? -1 : (((t / 1000) % 6) / 6) * 1.8 - 0.4;
    const tick = Math.floor(t / 140);
    for (const d of dots) {
      if (!still && (tick + d.boil) % 29 === 0) continue; // the dither "boils"
      const x = (d.x * ANVIL_DOT_PITCH + 1) * k;
      const y = (d.y * ANVIL_DOT_PITCH + 1) * k;
      const u = (x / w) * 0.75 + (y / h) * 0.25;
      const boost = Math.max(0, 1 - Math.abs(u - sweep) / 0.09);
      const breathe = still ? 0.8 : 0.6 + 0.4 * Math.sin(t * 0.0015 + d.ph);
      ctx.globalAlpha = Math.min(1, 0.25 + 0.6 * breathe + 0.5 * boost);
      ctx.fillStyle = boost > 0.35 ? "#ffd2bd" : "#ededeb";
      const z = s * (1 + 0.7 * boost);
      ctx.fillRect(x - (z - s) / 2, y - (z - s) / 2, z, z);
    }
  };
  const ro = new ResizeObserver(() => {
    size();
    draw(performance.now());
  });
  ro.observe(fig);
  size();
  if (still) {
    draw(0);
    return;
  }
  const loop = (t: number) => {
    if (!cv.isConnected) {
      ro.disconnect();
      return;
    }
    if (!document.hidden) draw(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
