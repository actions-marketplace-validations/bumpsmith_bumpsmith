import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_PATHS, parseConfig } from "./repo-config.ts";

/** The repository's .bumpsmith.yml (problems go to stderr), or the safe defaults. */
export async function repoConfig(dir: string) {
  for (const f of CONFIG_PATHS) {
    try {
      const r = parseConfig(await readFile(join(dir, f), "utf8"));
      for (const p of r.problems)
        process.stderr.write(`${f}:${p.line ?? "?"} ${p.path} ${p.message}\n`);
      return r.config;
    } catch {
      // not present
    }
  }
  return parseConfig(null).config;
}
