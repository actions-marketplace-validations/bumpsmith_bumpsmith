import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  /** Keep only the last N bytes of each stream (default 256 KiB). */
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Pipe stdout to this writable instead of capturing (for tar streams). */
  stdoutTo?: NodeJS.WritableStream;
  stdinFrom?: NodeJS.ReadableStream;
}

/** Run a program with an argv array. Never uses a shell. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const max = opts.maxBytes ?? 256 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    const keep = (buf: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([buf, chunk]);
      return next.length > max ? next.subarray(next.length - max) : next;
    };
    if (opts.stdoutTo) child.stdout.pipe(opts.stdoutTo);
    else child.stdout.on("data", (c: Buffer) => (out = keep(out, c)));
    child.stderr.on("data", (c: Buffer) => (err = keep(err, c)));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 137 : 1),
        stdout: out.toString("utf8"),
        stderr: err.toString("utf8"),
        durationMs: Date.now() - started,
      });
    });
    if (opts.stdinFrom) opts.stdinFrom.pipe(child.stdin);
    else if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function runOk(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.exitCode !== 0)
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.slice(-2000)}`);
  return r;
}
