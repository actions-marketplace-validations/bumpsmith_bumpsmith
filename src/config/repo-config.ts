import { isMap, LineCounter, parseDocument } from "yaml";
import { z } from "zod";

/**
 * Repository configuration, `.bumpsmith.yml` (PRD §8.8, appendix B).
 *
 *  - Read only from the default branch, never a PR branch (CFG-4), so a pull request
 *    cannot change the rules it is judged by.
 *  - The file can only tighten safety rules, never loosen them (CFG-5): release age has a
 *    floor, protected paths are added to the hard denylist, auto-merge is not available.
 *  - Errors are reported with line numbers (CFG-3) as a check on the commit.
 */

export const CONFIG_PATHS = [".bumpsmith.yml", ".bumpsmith.yaml", ".github/bumpsmith.yml"];
export const MIN_RELEASE_AGE_DAYS = 3;
const MAX_CONFIG_BYTES = 64 * 1024;

// No shell: commands are split into argv. Metacharacters are refused outright.
const SHELL_META = /[;&|`$<>(){}\\\n]/;
const Command = z
  .string()
  .min(1)
  .max(300)
  .refine((c) => !SHELL_META.test(c), "must be a plain command without shell operators");

const PackageName = z
  .string()
  .regex(/^(@[a-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/, "invalid package name");
const Glob = z
  .string()
  .min(1)
  .max(200)
  .refine((g) => !g.includes(".."), "must not contain ..");

export const RepoConfigV1 = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().default(false),
    ecosystems: z
      .array(z.enum(["npm", "pypi"]))
      .min(1)
      .default(["npm", "pypi"]),
    paths: z
      .object({
        include: z.array(Glob).max(50).default([]),
        exclude: z.array(Glob).max(50).default([]),
      })
      .strict()
      .default({ include: [], exclude: [] }),
    schedule: z
      .object({
        timezone: z.string().max(64).default("UTC"),
        windows: z
          .array(
            z
              .string()
              .regex(
                /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))? \d{2}:\d{2}-\d{2}:\d{2}$/,
              ),
          )
          .max(14)
          .default([]),
      })
      .strict()
      .default({ timezone: "UTC", windows: [] }),
    limits: z
      .object({
        open_pull_requests: z.number().int().min(1).max(10).default(3),
        per_week: z.number().int().min(1).max(50).default(10),
      })
      .strict()
      .default({ open_pull_requests: 3, per_week: 10 }),
    release_age_days: z.number().int().min(0).max(90).default(MIN_RELEASE_AGE_DAYS),
    ignore: z
      .array(
        z
          .object({
            package: PackageName,
            versions: z.array(z.string().max(40)).max(20).default(["*"]),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    group: z
      .array(
        z
          .object({
            name: z.string().max(60),
            packages: z.array(z.string().max(120)).min(1).max(50),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    checks: z
      .object({
        install: Command.optional(),
        build: Command.optional(),
        typecheck: Command.optional(),
        lint: Command.optional(),
        test: Command.optional(),
      })
      .strict()
      .default({}),
    install_scripts: z
      .object({ allow: z.array(PackageName).max(50).default([]) })
      .strict()
      .default({ allow: [] }),
    pull_requests: z
      .object({
        labels: z.array(z.string().min(1).max(50)).max(10).default(["dependencies", "bumpsmith"]),
        draft_below: z.enum(["low", "medium", "high"]).default("medium"),
      })
      .strict()
      .default({ labels: ["dependencies", "bumpsmith"], draft_below: "medium" }),
    rules: z
      .object({ protected_paths: z.array(Glob).max(100).default([]) })
      .strict()
      .default({ protected_paths: [] }),
    automerge: z
      .object({ enabled: z.literal(false) })
      .strict()
      .default({ enabled: false }),
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigV1>;

export const DEFAULT_CONFIG: RepoConfig = RepoConfigV1.parse({ version: 1 });

export interface ConfigProblem {
  path: string;
  message: string;
  line: number | null;
}

export interface ConfigResult {
  config: RepoConfig;
  /** The file asked for something unsafe; these are the tightened values that apply. */
  adjustments: string[];
  problems: ConfigProblem[];
}

/**
 * Safety merge (CFG-5). Applied after validation; never loosens anything.
 *  - release_age_days below the floor is raised to the floor.
 *  - draft_below can only raise the threshold relative to the default.
 */
export function tighten(cfg: RepoConfig): { config: RepoConfig; adjustments: string[] } {
  const adjustments: string[] = [];
  const out = structuredClone(cfg);
  if (out.release_age_days < MIN_RELEASE_AGE_DAYS) {
    adjustments.push(`release_age_days raised to ${MIN_RELEASE_AGE_DAYS} (minimum)`);
    out.release_age_days = MIN_RELEASE_AGE_DAYS;
  }
  const rank = { low: 0, medium: 1, high: 2 } as const;
  if (rank[out.pull_requests.draft_below] < rank[DEFAULT_CONFIG.pull_requests.draft_below]) {
    adjustments.push(`draft_below raised to ${DEFAULT_CONFIG.pull_requests.draft_below} (minimum)`);
    out.pull_requests.draft_below = DEFAULT_CONFIG.pull_requests.draft_below;
  }
  return { config: out, adjustments };
}

/** Parse, validate and tighten a config file. Invalid files fall back to defaults (disabled). */
export function parseConfig(text: string | null): ConfigResult {
  if (text === null) return { config: DEFAULT_CONFIG, adjustments: [], problems: [] };
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
    return {
      config: DEFAULT_CONFIG,
      adjustments: [],
      problems: [{ path: "", message: "file is larger than 64 KB", line: 1 }],
    };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) {
    return {
      config: DEFAULT_CONFIG,
      adjustments: [],
      problems: doc.errors.slice(0, 20).map((e) => ({
        path: "",
        message: e.message.split("\n")[0] ?? "invalid YAML",
        line: lc.linePos(e.pos[0]).line,
      })),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 0 }); // aliases are refused (no "billion laughs")
  } catch {
    return {
      config: DEFAULT_CONFIG,
      adjustments: [],
      problems: [{ path: "", message: "YAML aliases are not allowed", line: 1 }],
    };
  }
  const parsed = RepoConfigV1.safeParse(data ?? {});
  if (!parsed.success) {
    const lineOf = (path: (string | number)[]): number | null => {
      for (let i = path.length; i > 0; i--) {
        const node = doc.getIn(path.slice(0, i), true) as
          | { range?: [number, number, number] }
          | undefined;
        if (node?.range) return lc.linePos(node.range[0]).line;
        // Missing key: point at the parent map.
        const parent = doc.getIn(path.slice(0, i - 1), true);
        if (isMap(parent) && parent.range) return lc.linePos(parent.range[0]).line;
      }
      return 1;
    };
    return {
      config: DEFAULT_CONFIG,
      adjustments: [],
      problems: parsed.error.issues.slice(0, 50).map((i) => ({
        path: i.path.join("."),
        message: i.message,
        line: lineOf(i.path as (string | number)[]),
      })),
    };
  }
  const { config, adjustments } = tighten(parsed.data);
  return { config, adjustments, problems: [] };
}

/** Split a configured command into argv (supports simple quoting; no shell). */
export function commandArgv(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of cmd.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Is this version of this package ignored by the config? */
export function configIgnores(cfg: RepoConfig, pkg: string, version: string): boolean {
  return cfg.ignore.some(
    (i) =>
      i.package === pkg &&
      i.versions.some(
        (v) =>
          v === "*" || v === version || (v.endsWith(".x") && version.startsWith(v.slice(0, -1))),
      ),
  );
}
