import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import type { Inventory } from "./inventory.ts";

/**
 * CycloneDX 1.7 bill of materials (INV-3), identifying every package by its Package URL.
 * Completeness: npm projects with package-lock.json get the full transitive graph; other
 * lockfiles get direct dependencies with the lowest version their range allows. The
 * "completeness" property records which applies.
 */

export function purl(ecosystem: "npm" | "pypi", name: string, version: string): string {
  if (ecosystem === "pypi")
    return `pkg:pypi/${encodeURIComponent(name.toLowerCase().replace(/[-_.]+/g, "-"))}@${encodeURIComponent(version)}`;
  const [scope, base] = name.startsWith("@") ? (name.split("/") as [string, string]) : [null, name];
  return `pkg:npm/${scope ? `${encodeURIComponent(scope)}/` : ""}${encodeURIComponent(base)}@${encodeURIComponent(version)}`;
}

export interface SbomComponent {
  name: string;
  version: string;
  purl: string;
  direct: boolean;
}

export async function collectComponents(
  inv: Inventory,
): Promise<{ components: SbomComponent[]; complete: boolean }> {
  const eco = inv.ecosystem;
  const lock = join(inv.root, "package-lock.json");
  if (eco === "npm" && existsSync(lock)) {
    const j = JSON.parse(await readFile(lock, "utf8")) as {
      packages?: Record<string, { version?: string; link?: boolean }>;
    };
    const out = new Map<string, SbomComponent>();
    for (const [path, p] of Object.entries(j.packages ?? {})) {
      if (!path || p.link || !p.version) continue;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const direct = path === `node_modules/${name}`;
      const key = `${name}@${p.version}`;
      const prev = out.get(key);
      out.set(key, {
        name,
        version: p.version,
        purl: purl("npm", name, p.version),
        direct: direct || !!prev?.direct,
      });
    }
    return { components: [...out.values()], complete: true };
  }
  const components: SbomComponent[] = [];
  for (const [name, range] of Object.entries(inv.dependencies)) {
    const v =
      semver.minVersion(range.replace(/^==/, ""))?.version ??
      range.replace(/^[=~^<>!]+/, "").trim();
    if (!v) continue;
    components.push({ name, version: v, purl: purl(eco, name, v), direct: true });
  }
  return { components, complete: false };
}

export function cycloneDx(opts: {
  repoFullName: string;
  commit: string;
  components: SbomComponent[];
  complete: boolean;
}) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "bumpsmith" }] },
      component: {
        type: "application",
        name: opts.repoFullName,
        version: opts.commit,
        "bom-ref": "root",
      },
      properties: [
        { name: "bumpsmith:completeness", value: opts.complete ? "transitive" : "direct-only" },
      ],
    },
    components: opts.components.map((c) => ({
      type: "library",
      "bom-ref": c.purl,
      name: c.name,
      version: c.version,
      purl: c.purl,
      scope: "required",
      properties: [{ name: "bumpsmith:direct", value: String(c.direct) }],
    })),
  };
}
