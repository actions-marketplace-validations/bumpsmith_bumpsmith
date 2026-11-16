import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import ts from "typescript";
import { fetchNpmPackage, readPackageJson } from "./npm-tarball.ts";

export interface ExportSig {
  name: string;
  kind: string;
  signature: string;
}

export interface EntryPoint {
  subpath: string; // "." or "./async"
  typesFile: string | null;
  exports: ExportSig[];
}

export interface ApiDiffItem {
  subpath: string;
  name: string | null; // null = the whole entry point
  status: "removed_entry" | "added_entry" | "removed" | "added" | "changed";
  before: string | null;
  after: string | null;
}

export interface ApiDiff {
  package: string;
  from: string;
  to: string;
  hasTypes: boolean;
  items: ApiDiffItem[];
}

type ExportsField = string | null | { [k: string]: ExportsField } | ExportsField[];

/** Pick the type-definition file for one export condition tree. */
function findTypes(node: ExportsField): string | null {
  if (node === null) return null;
  if (typeof node === "string") return /\.d\.[cm]?ts$/.test(node) ? node : null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = findTypes(n);
      if (t) return t;
    }
    return null;
  }
  if (typeof node.types === "string") return node.types;
  for (const key of ["import", "default", "node", "require"]) {
    const t = key in node ? findTypes(node[key] ?? null) : null;
    if (t) return t;
  }
  return null;
}

function guessTypesFromJs(root: string, js: string | null): string | null {
  if (!js) return null;
  for (const ext of [".d.ts", ".d.mts", ".d.cts"]) {
    const candidate = js.replace(/\.[cm]?js$/, ext);
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

function firstString(node: ExportsField): string | null {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const v of Object.values(node)) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  if (Array.isArray(node)) for (const v of node) if (firstString(v)) return firstString(v);
  return null;
}

/** List public entry points and their .d.ts files (subpath exports aware). */
export async function entryPoints(
  root: string,
): Promise<{ subpath: string; typesFile: string | null }[]> {
  const pkg = await readPackageJson(root);
  const exportsField = pkg.exports as ExportsField | undefined;
  const out: { subpath: string; typesFile: string | null }[] = [];
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    const keys = Object.keys(exportsField);
    const isConditionMap = keys.every((k) => !k.startsWith("."));
    const map: Record<string, ExportsField> = isConditionMap ? { ".": exportsField } : exportsField;
    for (const [subpath, target] of Object.entries(map)) {
      if (subpath.includes("*") || subpath === "./package.json") continue;
      const types = findTypes(target) ?? guessTypesFromJs(root, firstString(target));
      out.push({ subpath, typesFile: types ? normalize(types) : null });
    }
  } else if (typeof exportsField === "string") {
    out.push({ subpath: ".", typesFile: guessTypesFromJs(root, exportsField) });
  }
  if (!out.some((e) => e.subpath === ".")) {
    const t = (pkg.types ?? pkg.typings) as string | undefined;
    const main = (pkg.main as string | undefined) ?? "index.js";
    const types =
      t ??
      guessTypesFromJs(root, main) ??
      (existsSync(join(root, "index.d.ts")) ? "index.d.ts" : null);
    out.push({ subpath: ".", typesFile: types ? normalize(types) : null });
  }
  return out;
}

const PRINT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

/**
 * Printed types contain `import("/abs/path/to/pkg@1.2.3/...").Name` qualifiers that differ
 * between versions (and leak local paths). Strip them so only real type changes remain.
 */
export function stripImportQualifiers(sig: string): string {
  return sig.replace(/import\("[^"]*"\)\./g, "");
}

/** Exported names and printed signatures of one .d.ts entry file. */
export function exportsOf(file: string): ExportSig[] {
  const program = ts.createProgram([file], {
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    types: [],
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  if (!sf) return [];
  const moduleSym = checker.getSymbolAtLocation(sf);
  if (!moduleSym) return [];
  const out: ExportSig[] = [];
  for (const sym of checker.getExportsOfModule(moduleSym)) {
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const decl = target.declarations?.[0];
    let kind = "unknown";
    let signature = "";
    if (
      target.flags &
      (ts.SymbolFlags.Function |
        ts.SymbolFlags.Variable |
        ts.SymbolFlags.Class |
        ts.SymbolFlags.Enum)
    ) {
      kind =
        target.flags & ts.SymbolFlags.Function
          ? "function"
          : target.flags & ts.SymbolFlags.Class
            ? "class"
            : target.flags & ts.SymbolFlags.Enum
              ? "enum"
              : "variable";
      const type = decl
        ? checker.getTypeOfSymbolAtLocation(target, decl)
        : checker.getDeclaredTypeOfSymbol(target);
      signature = stripImportQualifiers(checker.typeToString(type, undefined, PRINT_FLAGS));
    } else if (target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      kind = target.flags & ts.SymbolFlags.Interface ? "interface" : "type";
      signature = decl
        ? decl
            .getText()
            .replace(/\s+/g, " ")
            .replace(/^export\s+(declare\s+)?/, "")
        : "";
    } else if (decl) {
      signature = decl.getText().replace(/\s+/g, " ").slice(0, 2000);
    }
    out.push({ name: sym.getName(), kind, signature });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function describe(name: string, version: string): Promise<EntryPoint[]> {
  const root = await fetchNpmPackage(name, version);
  const eps = await entryPoints(root);
  return eps.map((ep) => {
    const file = ep.typesFile ? join(root, ep.typesFile) : null;
    return {
      subpath: ep.subpath,
      typesFile: ep.typesFile,
      exports: file && existsSync(file) ? exportsOf(file) : [],
    };
  });
}

/** Compute the type-level API diff between two published versions (CHG-3). */
export async function npmApiDiff(name: string, from: string, to: string): Promise<ApiDiff> {
  const [a, b] = await Promise.all([describe(name, from), describe(name, to)]);
  const items: ApiDiffItem[] = [];
  const bMap = new Map(b.map((e) => [e.subpath, e]));
  const aMap = new Map(a.map((e) => [e.subpath, e]));
  for (const ea of a) {
    const eb = bMap.get(ea.subpath);
    if (!eb) {
      items.push({
        subpath: ea.subpath,
        name: null,
        status: "removed_entry",
        before: ea.typesFile,
        after: null,
      });
      continue;
    }
    const bx = new Map(eb.exports.map((x) => [x.name, x]));
    for (const xa of ea.exports) {
      const xb = bx.get(xa.name);
      if (!xb)
        items.push({
          subpath: ea.subpath,
          name: xa.name,
          status: "removed",
          before: xa.signature,
          after: null,
        });
      else if (xb.signature !== xa.signature)
        items.push({
          subpath: ea.subpath,
          name: xa.name,
          status: "changed",
          before: xa.signature,
          after: xb.signature,
        });
    }
    const ax = new Set(ea.exports.map((x) => x.name));
    for (const xb of eb.exports)
      if (!ax.has(xb.name))
        items.push({
          subpath: ea.subpath,
          name: xb.name,
          status: "added",
          before: null,
          after: xb.signature,
        });
  }
  for (const eb of b)
    if (!aMap.has(eb.subpath))
      items.push({
        subpath: eb.subpath,
        name: null,
        status: "added_entry",
        before: null,
        after: eb.typesFile,
      });
  const hasTypes = [...a, ...b].some((e) => e.exports.length > 0);
  return { package: name, from, to, hasTypes, items };
}

export function importSpecifier(pkg: string, subpath: string): string {
  return subpath === "." ? pkg : `${pkg}/${subpath.replace(/^\.\//, "")}`;
}

/** Plain-text rendering used as an evidence source for the Extractor. */
export function renderApiDiff(diff: ApiDiff): string {
  if (!diff.items.length)
    return `No type-level differences found between ${diff.from} and ${diff.to}.`;
  const lines = [`Type-definition diff for ${diff.package} ${diff.from} -> ${diff.to}`];
  for (const it of diff.items) {
    const spec = importSpecifier(diff.package, it.subpath);
    if (it.status === "removed_entry") lines.push(`REMOVED ENTRY POINT "${spec}"`);
    else if (it.status === "added_entry") lines.push(`ADDED ENTRY POINT "${spec}"`);
    else if (it.status === "removed")
      lines.push(`REMOVED export ${it.name} from "${spec}": ${it.before}`);
    else if (it.status === "added") lines.push(`ADDED export ${it.name} to "${spec}": ${it.after}`);
    else lines.push(`CHANGED ${it.name} in "${spec}": ${it.before}  =>  ${it.after}`);
  }
  return lines.join("\n");
}
