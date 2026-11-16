import { lstat, readdir, readlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Host-side defence for untrusted checkouts. A repository can contain symlinks such as
 * `docs/x -> /etc/passwd` or `a -> ../../..`; any host code that later reads "files in the
 * repo" (inventory, impact analysis, patch computation) could then read outside it and
 * leak host files into a prompt or a PR. After every clone we remove symlinks whose
 * target escapes the checkout and refuse special files, and we bound size and file count.
 */

export interface SanitizeResult {
  removedSymlinks: string[];
  files: number;
  bytes: number;
}

export interface SanitizeLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: SanitizeLimits = { maxFiles: 250_000, maxBytes: 3 * 1024 ** 3 };

export class CheckoutTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutTooLarge";
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function sanitizeCheckout(
  rootDir: string,
  limits: SanitizeLimits = DEFAULT_LIMITS,
): Promise<SanitizeResult> {
  const root = resolve(rootDir);
  const out: SanitizeResult = { removedSymlinks: [], files: 0, bytes: 0 };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const entry of await readdir(dir)) {
      if (dir === root && entry === ".git") continue;
      const p = join(dir, entry);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = await readlink(p);
        const resolved = isAbsolute(target) ? target : resolve(dirname(p), target);
        if (isAbsolute(target) || !inside(root, resolved)) {
          await unlink(p);
          out.removedSymlinks.push(relative(root, p));
        }
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!st.isFile()) {
        // FIFOs, sockets, devices: git never creates these; something is wrong.
        await unlink(p);
        out.removedSymlinks.push(relative(root, p));
        continue;
      }
      out.files += 1;
      out.bytes += st.size;
      if (out.files > limits.maxFiles)
        throw new CheckoutTooLarge(`more than ${limits.maxFiles} files`);
      if (out.bytes > limits.maxBytes)
        throw new CheckoutTooLarge(`more than ${limits.maxBytes} bytes`);
    }
  }
  return out;
}

/** Resolve a repo-relative path and refuse anything that leaves the root. */
export function containedPath(rootDir: string, rel: string): string {
  const root = resolve(rootDir);
  const p = resolve(root, rel);
  if (!inside(root, p)) throw new Error(`path escapes repository: ${rel}`);
  return p;
}
