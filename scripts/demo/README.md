# Demo recordings

The walkthroughs in the README are recorded from the real dashboard, not mocked. They use:

- **A real repository.** It is the one from the `node-fetch` 2 → 3 benchmark task, checked out at the commit the run
  started from, so **Apply patch** really applies.
- **Real runs.** The history around it is one benchmark run per package, from `bench/runs/`.
- **Fictional people.** The accounts and names are invented.

```sh
pnpm tsx scripts/demo/record.ts hero      /tmp/demo/hero        # also: team, palette, hero-dark
python3 scripts/demo/compose.py /tmp/demo/hero /tmp/demo/hero.mp4
```

## How they are made

| File         | What it does                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `record.ts`  | Builds the demo workspace, signs in, drives a scene in Chromium (1440×900 at 2x), and records the frames with the DevTools screencast. It also logs camera and caption cues.                                                                                                                                                        |
| `human.ts`   | Moves the pointer the way a hand does (details below). It logs every position at about 60 Hz.                                                                                                                                                                                                                                       |
| `assets.ts`  | Draws the stage (background and browser window), the pointer, the captions and the title and end cards in Chromium, in the dashboard's Geist type.                                                                                                                                                                                  |
| `compose.py` | Renders the 1080p60 video. It places each page frame in the window and moves a camera that eases into the cues with a critically damped spring and leans towards the pointer. It draws the pointer and click rings from the 60 Hz log, then fades captions and cards. Chunks render in parallel and are joined without re-encoding. |

`human.ts` gives the pointer these traits:

- curved paths;
- a minimum-jerk speed profile;
- timing from Fitts's law;
- small overshoots on long moves;
- landing points that are never the exact centre;
- reading pauses with drift;
- uneven typing;
- trackpad-style scrolling.

## Publishing

- **The README** uses animated WebP files (`docs/media/*.webp`, under 10 MB each). To make one, scale the MP4 to
  1100 px at 12 fps and save it with Pillow at quality 58.
- **For an inline, playable video on GitHub,** drag `docs/media/hero.mp4` into a comment or the README editor on
  github.com. GitHub hosts it and returns a `user-attachments` URL.
- **For social posts,** use the 1080p60 masters.
