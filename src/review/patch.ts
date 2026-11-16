import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { EXPORT_EXCLUDES } from "../sandbox/sandbox.ts";
import { run } from "../util/proc.ts";

/** Copy a host tree without .git and dependency folders (used for the "before" side of the diff). */
export async function snapshot(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const excludes = EXPORT_EXCLUDES.flatMap((e) => [`--exclude=./${e}`, `--exclude=*/${e}`]);
  await new Promise<void>((resolve, reject) => {
    const pack = spawn("tar", ["--no-mac-metadata", "-cf", "-", ...excludes, "-C", src, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const unpack = spawn("tar", ["-xf", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let errText = "";
    pack.stderr.on("data", (d: Buffer) => (errText += d));
    unpack.stderr.on("data", (d: Buffer) => (errText += d));
    pack.stdout.pipe(unpack.stdin);
    unpack.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`snapshot failed: ${errText}`)),
    );
    pack.on("error", reject);
    unpack.on("error", reject);
  });
}

/**
 * Unified diff computed on the trusted host. The repository's own git config,
 * attributes, external diff drivers and textconv filters are never consulted.
 */
export async function computePatch(
  workDir: string,
  beforeName: string,
  afterName: string,
): Promise<string> {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LC_ALL: "C",
  };
  const r = await run(
    "git",
    [
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--",
      beforeName,
      afterName,
    ],
    { cwd: workDir, env, maxBytes: 64 * 1024 * 1024 },
  );
  if (r.exitCode > 1) throw new Error(`git diff failed: ${r.stderr}`);
  // Rewrite only header lines; added/removed content is never touched.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const side = `(?:${esc(beforeName)}|${esc(afterName)})`;
  const prefixed = new RegExp(`(^|\\s)([ab])/${side}/`, "g");
  const bare = new RegExp(`^(---|\\+\\+\\+) ${side}/`);
  return r.stdout
    .split("\n")
    .map((line) => {
      if (/^(diff --git |--- |\+\+\+ |rename (from|to) |copy (from|to) )/.test(line)) {
        return line
          .replace(prefixed, "$1$2/")
          .replace(bare, (_m, mark: string) => `${mark} ${mark === "---" ? "a" : "b"}/`);
      }
      return line;
    })
    .join("\n");
}

export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  added: string[];
  removed: string[];
  binary: boolean;
}

/** Minimal unified-diff parser for policy checks. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      cur = {
        path: header[2] ?? header[1] ?? "",
        status: "modified",
        added: [],
        removed: [],
        binary: false,
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch"))
      cur.binary = true;
    else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line === "--- /dev/null") cur.status = "added";
      if (line === "+++ /dev/null") cur.status = "deleted";
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m?.[1]) cur.path = m[1];
    } else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

/** Keep only the file sections of a unified diff whose path passes `keep`. */
export function filterPatch(
  patch: string,
  keep: (path: string) => boolean,
): { patch: string; excluded: string[] } {
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "));
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const sec of sections) {
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(sec)?.[1] ?? "";
    if (keep(path)) kept.push(sec);
    else excluded.push(path);
  }
  return { patch: kept.join(""), excluded };
}
