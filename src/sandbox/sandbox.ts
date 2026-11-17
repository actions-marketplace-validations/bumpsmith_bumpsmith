import type { Ecosystem } from "../schemas/job.ts";

/**
 * One isolated, disposable environment per job (PRD §10 execution plane). It holds the
 * repository at one commit and nothing else: no tokens, no keys, no customer secrets.
 * Network is off except while installing, and then reaches only the read-only registry
 * mirror. Implementations: DockerSandbox (local development and tests) and E2BSandbox
 * (Firecracker micro-VMs in production).
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutSec?: number;
  /** Attach the registry-only network for the duration of the command. */
  network?: boolean;
  input?: string;
  cwd?: string;
}

export interface Sandbox {
  readonly id: string;
  /** Service sidecars that started and answered their readiness probe. */
  readonly startedServices?: string[];
  /** Service sidecars that could not start, with the reason. */
  readonly failedServices?: string[];
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Run a check, restoring package.json afterwards if the check's scripts rewrote it. */
  execCheck(argv: string[], opts?: ExecOptions & { guardManifest?: boolean }): Promise<ExecResult>;
  /** Copy a host directory into the sandbox (default /workspace). */
  copyIn(hostDir: string, dest?: string): Promise<void>;
  copyOut(hostDir: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateOptions {
  ecosystem: Ecosystem;
  /** Node major for npm projects (22 default). */
  nodeMajor?: 22 | 24;
  /** Label used to find and clean up sandboxes of a job after a crash. */
  label?: string;
  /** Databases and caches the tests need, started as sidecars on the sandbox's localhost. */
  services?: import("./services.ts").ServiceSpec[];
  /** Extra environment for every command (literal values from the repo's CI job). */
  env?: Record<string, string>;
}

export type SandboxFactory = (opts: CreateOptions) => Promise<Sandbox>;

/** Directories never copied in or out and never part of a patch (bsdtar matches any depth). */
export const EXPORT_EXCLUDES = [
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".turbo",
  ".pnpm-store",
  ".yarn/cache",
  ".git",
  ".bumpsmith-cache",
  // Bumpsmith's own output (CLI runs, scans) lives inside the repository being upgraded.
  ".bumpsmith",
];

/**
 * Arguments for creating a tar archive of a host directory that leave out EXPORT_EXCLUDES
 * at any depth. Works with both bsdtar (macOS) and GNU tar (Linux CI runners): plain
 * names (no leading "./") are matched against any path component by both.
 */
export function hostTarCreateArgs(dir: string): string[] {
  const macOnly = process.platform === "darwin" ? ["--no-mac-metadata"] : [];
  return [...macOnly, "-cf", "-", ...EXPORT_EXCLUDES.map((e) => `--exclude=${e}`), "-C", dir, "."];
}
