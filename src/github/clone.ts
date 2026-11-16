import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOk } from "../util/proc.ts";
import { type SanitizeResult, sanitizeCheckout } from "../util/safe-fs.ts";

/**
 * Fetch one commit of a repository with a short-lived read-only token, on the control
 * plane (the token never enters a sandbox). Hardening:
 *  - the token travels in GIT_CONFIG_* environment variables, never argv (visible in ps)
 *    and never written to .git/config;
 *  - no system/global config, no credential helper, no hooks, no submodules, no
 *    file:// or ext:: transports, no prompts;
 *  - shallow fetch of exactly the requested commit;
 *  - the checkout is sanitised (escaping symlinks removed, size bounded).
 */
export async function cloneAtCommit(opts: {
  token: string;
  fullName: string;
  sha: string;
  dest: string;
  apiHost?: string;
  timeoutMs?: number;
}): Promise<SanitizeResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.fullName))
    throw new Error("invalid repository name");
  if (!/^[0-9a-f]{40}$/.test(opts.sha)) throw new Error("invalid commit sha");
  const host = opts.apiHost ?? "github.com";
  const home = await mkdtemp(join(tmpdir(), "bumpsmith-git-home-"));
  const basic = Buffer.from(`x-access-token:${opts.token}`).toString("base64");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "protocol.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_CONFIG_KEY_4: "protocol.https.allow",
    GIT_CONFIG_VALUE_4: "always",
    GIT_CONFIG_KEY_5: "submodule.recurse",
    GIT_CONFIG_VALUE_5: "false",
  };
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  try {
    await mkdir(opts.dest, { recursive: true });
    await runOk("git", ["init", "--quiet", opts.dest], { env, timeoutMs });
    await runOk(
      "git",
      [
        "-C",
        opts.dest,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        `https://${host}/${opts.fullName}.git`,
        opts.sha,
      ],
      { env, timeoutMs },
    );
    await runOk("git", ["-C", opts.dest, "checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      env,
      timeoutMs,
    });
    return await sanitizeCheckout(opts.dest);
  } catch (err) {
    // Never let the token surface through an error message.
    const msg = (err as Error).message
      .split(opts.token)
      .join("[token]")
      .split(basic)
      .join("[token]");
    throw new Error(`clone failed: ${msg}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
