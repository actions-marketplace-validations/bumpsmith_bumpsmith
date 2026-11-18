import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { repoConfig } from "../config/load.ts";
import { computeDebt } from "./debt.ts";
import { inventory } from "./inventory.ts";
import { collectComponents, cycloneDx } from "./sbom.ts";

/**
 * Upgrade debt for a repository (no AI: only package names are looked up on the public
 * registry). Writes .bumpsmith/debt.json and a CycloneDX SBOM, as `bumpsmith scan` does.
 */
export async function scanRepository(dir: string) {
  const inv = await inventory(dir);
  const { components, complete } = await collectComponents(inv);
  const resolved = new Map(components.filter((c) => c.direct).map((c) => [c.name, c.version]));
  const cfg = await repoConfig(dir);
  const report = await computeDebt({
    inv,
    commit: "working-tree",
    resolved,
    botPrs: [],
    unsupported: [],
    minReleaseAgeDays: cfg.release_age_days,
  });
  const outDir = join(dir, ".bumpsmith");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "sbom.cdx.json"),
    JSON.stringify(
      cycloneDx({ repoFullName: basename(dir), commit: "working-tree", components, complete }),
      null,
      2,
    ),
  );
  await writeFile(join(outDir, "debt.json"), JSON.stringify(report, null, 2));
  return { inv, report };
}
