#!/usr/bin/env python3
"""Turn a recording from record.ts into the finished walkthrough video.

    python3 scripts/demo/compose.py /tmp/demo/hero docs/media/hero.mp4 [--gif docs/media/hero.gif]

What it does, per 60 fps output frame:
  * puts the latest page frame (Chromium screencast, 2x) into the browser window on the stage;
  * moves a camera that eases into the zoom cues with a critically damped spring and leans a
    little towards the pointer, the way a person's attention follows the hand;
  * draws the pointer from the 60 Hz pointer log (smoother than the page frames), with a press
    squeeze and a soft ring on every click;
  * fades captions in and out, and wraps it all in a title card and an end card.
Frames are rendered in parallel chunks and joined without re-encoding.
"""

import argparse
import bisect
import json
import math
import os
import subprocess
import tempfile
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

W, H = 1920, 1080
FPS = 60
K = 2  # stage pixels per logical pixel (all assets are 2x)
TITLE, TITLE_FADE = 2.4, 0.5
END_FADE, END_HOLD = 0.6, 3.2
CAP_IN, CAP_OUT = 0.28, 0.22


def ease(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def load(src: Path):
    t = json.loads((src / "timeline.json").read_text())
    a = json.loads((src / "assets.json").read_text())
    return t, a


def plan(src: Path):
    """Everything that depends on the past (camera springs) is computed here, once, in order."""
    t, a = load(src)
    S = a["stage"]
    marks = {e["name"]: e["t"] for e in t["events"] if e["type"] == "mark"}
    t0, t1 = marks["start"], marks["end"]
    rec = t1 - t0
    total = TITLE + rec + END_HOLD
    n = int(total * FPS)
    ptr = t["pointer"]
    pts = [p[0] for p in ptr]

    def pointer_at(ts: float):
        i = bisect.bisect_right(pts, ts) - 1
        if i < 0:
            return ptr[0][1], ptr[0][2], 0
        if i >= len(ptr) - 1:
            return ptr[-1][1], ptr[-1][2], ptr[-1][3]
        a0, b0 = ptr[i], ptr[i + 1]
        span = b0[0] - a0[0]
        u = 0 if span <= 0 or span > 0.25 else (ts - a0[0]) / span
        return a0[1] + (b0[1] - a0[1]) * u, a0[2] + (b0[2] - a0[2]) * u, a0[3]

    zooms = [e for e in t["events"] if e["type"] == "zoom"]
    zt = [e["t"] for e in zooms]

    def target(ts: float, px: float, py: float):
        i = bisect.bisect_right(zt, ts) - 1
        e = zooms[i] if i >= 0 else None
        if not e or not e.get("box"):
            return 1.0, W / 2, H / 2
        b = e["box"]
        bw, bh = max(b["width"], 40), max(b["height"], 40)
        fit = min(W * 0.86 / bw, H * 0.78 / bh)
        s = max(1.0, min(e.get("scale") or 1.5, fit, 2.2))
        cx = S["x"] + b["x"] + bw / 2
        cy = S["y"] + b["y"] + bh / 2
        # lean towards the hand
        cx += (S["x"] + px - cx) * 0.14
        cy += (S["y"] + py - cy) * 0.10
        return s, cx, cy

    # critically damped springs for scale and centre
    w_s, w_c = 6.0, 6.5
    s, cx, cy = 1.0, W / 2, H / 2
    vs = vx = vy = 0.0
    dt = 1 / FPS
    frames = []
    for k in range(n):
        tt = k / FPS
        ts = t0 + min(max(tt - TITLE, 0), rec)
        px, py, down = pointer_at(ts)
        ts_, tx, ty = target(ts, px, py)
        vs += (w_s * w_s * (ts_ - s) - 2 * w_s * vs) * dt
        s += vs * dt
        vx += (w_c * w_c * (tx - cx) - 2 * w_c * vx) * dt
        vy += (w_c * w_c * (ty - cy) - 2 * w_c * vy) * dt
        cx += vx * dt
        cy += vy * dt
        hw, hh = W / 2 / s, H / 2 / s
        ccx = min(max(cx, hw), W - hw)
        ccy = min(max(cy, hh), H - hh)
        frames.append((tt, ts, s, ccx, ccy, px, py, down))
    clicks = [p[0] for i, p in enumerate(ptr) if p[3] == 1 and (i == 0 or ptr[i - 1][3] == 0)]
    click_pos = {c: pointer_at(c)[:2] for c in clicks}
    caps = [(e["t"], e["text"]) for e in t["events"] if e["type"] == "caption"]
    return dict(frames=frames, clicks=click_pos, caps=caps, t0=t0, t1=t1, rec=rec, total=total)


class Renderer:
    def __init__(self, src: Path):
        t, a = load(src)
        self.src = src
        self.S = a["stage"]
        self.cap_files = a["captions"]
        self.ft = [f["ts"] for f in t["frames"]]
        self.ff = [f["file"] for f in t["frames"]]
        self.stage = Image.open(src / "stage.png").convert("RGB")
        S = self.S
        self.cw, self.ch = S["cw"] * K, S["ch"] * K
        m = Image.new("L", (self.cw, self.ch), 0)
        d = ImageDraw.Draw(m)
        r = S["radius"] * K
        d.rounded_rectangle((0, 0, self.cw - 1, self.ch - 1), radius=r, fill=255)
        d.rectangle((0, 0, self.cw, r), fill=255)  # the bar covers the top corners
        self.mask = m
        self.cursor = Image.open(src / "cursor.png").convert("RGBA")
        self.title = Image.open(src / "title.png").convert("RGB").resize((W, H), Image.LANCZOS)
        self.end = Image.open(src / "end.png").convert("RGB").resize((W, H), Image.LANCZOS)
        self.caps = {}
        self._idx = -1
        self._comp = None

    def comp_at(self, ts: float):
        i = max(0, bisect.bisect_right(self.ft, ts) - 1)
        if i != self._idx:
            frame = Image.open(self.src / "frames" / self.ff[i]).convert("RGB")
            if frame.size != (self.cw, self.ch):
                frame = frame.resize((self.cw, self.ch), Image.LANCZOS)
            comp = self.stage.copy()
            comp.paste(frame, (self.S["x"] * K, self.S["y"] * K), self.mask)
            self._comp, self._idx = comp, i
        return self._comp

    def caption(self, text: str):
        if text not in self.caps:
            im = Image.open(self.src / self.cap_files[text]).convert("RGBA")
            self.caps[text] = im.resize((im.width // K, im.height // K), Image.LANCZOS)
        return self.caps[text]

    def render(self, f, P) -> Image.Image:
        tt, ts, s, cx, cy, px, py, down = f
        S = self.S
        comp = self.comp_at(ts)
        vw, vh = W / s, H / s
        x0, y0 = cx - vw / 2, cy - vh / 2
        box = (x0 * K, y0 * K, (x0 + vw) * K, (y0 + vh) * K)
        img = comp.resize((W, H), Image.BICUBIC, box=box, reducing_gap=1.5)

        def to_out(lx, ly):
            return (lx - x0) * s, (ly - y0) * s

        # click rings
        over = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(over)
        for c, (qx, qy) in P["clicks"].items():
            u = (ts - c) / 0.5
            if 0 <= u <= 1:
                ox, oy = to_out(S["x"] + qx, S["y"] + qy)
                r = (7 + 20 * ease(u)) * s
                al = int(255 * (1 - u))
                od.ellipse((ox - r, oy - r, ox + r, oy + r), fill=(242, 90, 29, int(al * 0.22)),
                           outline=(242, 90, 29, int(al * 0.5)), width=max(1, int(1.6 * s)))
        # pointer
        sc = (s ** 0.65) * (0.86 if down else 1.0) / K
        cur = self.cursor.resize((max(1, int(self.cursor.width * sc)), max(1, int(self.cursor.height * sc))), Image.LANCZOS)
        ox, oy = to_out(S["x"] + px, S["y"] + py)
        hot = (4.2 / 26 * 30 * K * sc, 2.6 / 26 * 30 * K * sc)
        over.alpha_composite(cur, (int(ox - hot[0]), int(oy - hot[1])))
        # caption
        cur_cap = None
        for i, (ct, text) in enumerate(P["caps"]):
            nxt = P["caps"][i + 1][0] if i + 1 < len(P["caps"]) else P["t1"] + 99
            if ct <= ts < nxt + CAP_OUT and text:
                fin = ease((ts - ct) / CAP_IN)
                fout = 1 - ease((ts - nxt) / CAP_OUT) if ts >= nxt else 1
                cur_cap = (text, fin * fout)
        # captions also fade with the recording at the end
        if cur_cap and cur_cap[1] > 0.01:
            text, al = cur_cap
            ci = self.caption(text)
            a = ci.getchannel("A").point(lambda v: int(v * al))
            ci2 = ci.copy()
            ci2.putalpha(a)
            yoff = int((1 - al) * 10)
            over.alpha_composite(ci2, ((W - ci.width) // 2, H - ci.height + 6 + yoff))
        img = Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")
        # title and end cards
        if tt < TITLE + TITLE_FADE:
            u = ease((tt - TITLE) / TITLE_FADE)
            img = Image.blend(self.title, img, u) if u > 0 else self.title
        rec_end = TITLE + P["rec"]
        if tt > rec_end:
            u = ease((tt - rec_end) / END_FADE)
            img = Image.blend(img, self.end, u)
        return img


def render_chunk(args):
    src, P, lo, hi, out = args
    R = Renderer(Path(src))
    ff = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
         "-pix_fmt", "yuv420p", "-x264-params", "keyint=120", out],
        stdin=subprocess.PIPE,
    )
    for f in P["frames"][lo:hi]:
        ff.stdin.write(np.asarray(R.render(f, P), dtype=np.uint8).tobytes())
    ff.stdin.close()
    ff.wait()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--gif", help="also write a README GIF (shorter loop, 1200 px)")
    ap.add_argument("--gif-from", type=float, default=0)
    ap.add_argument("--gif-len", type=float, default=0)
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    a = ap.parse_args()
    src = Path(a.src)
    P = plan(src)
    n = len(P["frames"])
    with tempfile.TemporaryDirectory() as tmp:
        step = math.ceil(n / a.jobs)
        jobs = [(str(src), P, lo, min(n, lo + step), f"{tmp}/part{lo:06d}.mp4") for lo in range(0, n, step)]
        with Pool(a.jobs) as pool:
            parts = pool.map(render_chunk, jobs)
        lst = Path(tmp) / "list.txt"
        lst.write_text("".join(f"file '{p}'\n" for p in parts))
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                        "-c", "copy", "-movflags", "+faststart", a.out], check=True)
    print(f"{a.out}: {n} frames, {P['total']:.1f}s")
    if a.gif:
        ss = ["-ss", str(a.gif_from)] if a.gif_from else []
        tt = ["-t", str(a.gif_len)] if a.gif_len else []
        vf = ("fps=15,scale=1200:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=192:stats_mode=diff[p];"
              "[y][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *ss, *tt, "-i", a.out, "-vf", vf, a.gif], check=True)
        print(f"{a.gif}: {os.path.getsize(a.gif) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
