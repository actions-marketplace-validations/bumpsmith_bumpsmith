import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchJson } from "../util/http.ts";
import { runOk } from "../util/proc.ts";

const PKG_CACHE = join(process.cwd(), ".cache", "pkgs");

interface NpmVersionDoc {
  dist: { tarball: string; integrity?: string; shasum?: string };
}

/**
 * Download and unpack a published npm package into the cache, verifying the
 * registry's integrity hash. Returns the package root directory.
 * Package contents are only parsed (never executed) on the host.
 */
export async function fetchNpmPackage(name: string, version: string): Promise<string> {
  const safe = `${name.replace("/", "__")}@${version}`;
  const dir = join(PKG_CACHE, safe);
  const root = join(dir, "package");
  if (existsSync(join(root, "package.json"))) return root;

  const doc = await fetchJson<NpmVersionDoc>(
    `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`,
    { cacheSeconds: 86_400 },
  );
  const res = await fetch(doc.dist.tarball, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`tarball download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (doc.dist.integrity?.startsWith("sha512-")) {
    const got = `sha512-${createHash("sha512").update(buf).digest("base64")}`;
    if (got !== doc.dist.integrity) throw new Error(`integrity mismatch for ${name}@${version}`);
  } else if (doc.dist.shasum) {
    const got = createHash("sha1").update(buf).digest("hex");
    if (got !== doc.dist.shasum) throw new Error(`shasum mismatch for ${name}@${version}`);
  }

  await mkdir(dir, { recursive: true });
  const tgz = join(dir, "pkg.tgz");
  await writeFile(tgz, buf);
  // bsdtar/GNU tar refuse absolute paths and ".." entries by default.
  await runOk("tar", ["-xzf", tgz, "-C", dir]);
  // Some tarballs use a top folder other than "package/".
  if (!existsSync(root)) {
    const { readdir, rename } = await import("node:fs/promises");
    const entries = (await readdir(dir)).filter((e) => e !== "pkg.tgz");
    if (entries.length === 1 && entries[0]) await rename(join(dir, entries[0]), root);
  }
  return root;
}

export async function readPackageJson(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}
