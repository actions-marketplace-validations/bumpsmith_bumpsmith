import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { isActionable } from "../change/extract.ts";
import type { ChangeRecord } from "../schemas/change-record.ts";
import type { Ecosystem, ImpactItem, ImpactMap, UpgradeClass } from "../schemas/job.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  ".cache",
]);
const JS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_FILE_BYTES = 1_000_000;

async function walk(root: string, exts: Set<string>): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await rec(p);
      } else if (exts.has(extname(e.name)) && !e.name.endsWith(".d.ts")) {
        if ((await stat(p)).size <= MAX_FILE_BYTES) out.push(p);
      }
    }
  }
  await rec(root);
  return out;
}

/** "pkg/sub:Name.member" -> { module: "pkg/sub", path: ["Name", "member"] } */
export function parseSymbol(s: string): { module: string; path: string[] } {
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return { module: s, path: [] };
  return {
    module: s.slice(0, idx),
    path: s
      .slice(idx + 1)
      .split(".")
      .filter(Boolean),
  };
}

interface Binding {
  local: string;
  imported: string | "*" | "default";
  module: string;
}

interface FileScan {
  file: string;
  bindings: Binding[];
  imports: { module: string; line: number; column: number; text: string }[];
  sf: ts.SourceFile;
}

function scanJs(file: string, text: string, pkg: string): FileScan | null {
  if (!text.includes(pkg)) return null;
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const bindings: Binding[] = [];
  const imports: FileScan["imports"] = [];
  const belongs = (m: string) => m === pkg || m.startsWith(`${pkg}/`);
  const pos = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf));

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      belongs(node.moduleSpecifier.text)
    ) {
      const module = node.moduleSpecifier.text;
      const p = pos(node);
      imports.push({ module, line: p.line + 1, column: p.character + 1, text: node.getText(sf) });
      const clause = node.importClause;
      if (clause?.name) bindings.push({ local: clause.name.text, imported: "default", module });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb))
        bindings.push({ local: nb.name.text, imported: "*", module });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          bindings.push({
            local: el.name.text,
            imported: (el.propertyName ?? el.name).text,
            module,
          });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      belongs(node.moduleSpecifier.text)
    ) {
      const p = pos(node);
      imports.push({
        module: node.moduleSpecifier.text,
        line: p.line + 1,
        column: p.character + 1,
        text: node.getText(sf),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0] as ts.Node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      const module = (node.arguments[0] as ts.StringLiteral).text;
      if (belongs(module)) {
        const p = pos(node);
        imports.push({ module, line: p.line + 1, column: p.character + 1, text: node.getText(sf) });
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent)) {
          if (ts.isIdentifier(parent.name))
            bindings.push({ local: parent.name.text, imported: "*", module });
          else if (ts.isObjectBindingPattern(parent.name))
            for (const el of parent.name.elements)
              if (ts.isIdentifier(el.name))
                bindings.push({
                  local: el.name.text,
                  imported:
                    el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : el.name.text,
                  module,
                });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imports.length ? { file, bindings, imports, sf } : null;
}

/** Find identifier uses of a local binding, optionally followed by a member path. */
function findUses(scan: FileScan, local: string, memberPath: string[]): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === local) {
      const parent = node.parent;
      const isDeclaration =
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        (ts.isBindingElement(parent) && parent.name === node);
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isDeclaration && !isPropertyName) {
        let cur: ts.Node = node;
        let ok = true;
        for (const m of memberPath) {
          const p = cur.parent;
          if (p && ts.isPropertyAccessExpression(p) && p.expression === cur && p.name.text === m)
            cur = p;
          else {
            ok = false;
            break;
          }
        }
        if (ok) hits.push(cur);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scan.sf);
  return hits;
}

function lineText(sf: ts.SourceFile, line: number): string {
  return (sf.text.split("\n")[line] ?? "").trim().slice(0, 200);
}

async function impactJs(
  root: string,
  record: ChangeRecord,
  pkg: string,
): Promise<{ items: ImpactItem[]; importing: string[] }> {
  const items: ImpactItem[] = [];
  const importing = new Set<string>();
  for (const file of await walk(root, JS_EXT)) {
    const scan = scanJs(file, await readFile(file, "utf8"), pkg);
    if (!scan) continue;
    const rel = relative(root, file);
    importing.add(rel);
    for (const change of record.changes.filter(isActionable)) {
      for (const sym of change.symbols) {
        const { module, path } = parseSymbol(sym);
        if (!path.length) {
          // Whole entry point: every import of it, plus every use of its bindings.
          for (const imp of scan.imports.filter((i) => i.module === module))
            items.push({
              file: rel,
              line: imp.line,
              column: imp.column,
              symbol: sym,
              change_id: change.id,
              snippet: imp.text.slice(0, 200),
              confidence: "high",
            });
          for (const b of scan.bindings.filter((x) => x.module === module))
            for (const n of findUses(scan, b.local, [])) {
              const p = scan.sf.getLineAndCharacterOfPosition(n.getStart(scan.sf));
              items.push({
                file: rel,
                line: p.line + 1,
                column: p.character + 1,
                symbol: sym,
                change_id: change.id,
                snippet: lineText(scan.sf, p.line),
                confidence: "high",
              });
            }
          continue;
        }
        const [head, ...rest] = path as [string, ...string[]];
        for (const b of scan.bindings.filter((x) => x.module === module)) {
          let member: string[] | null = null;
          if (b.imported === head) member = rest;
          else if (b.imported === "*" || b.imported === "default") member = path;
          if (!member) continue;
          for (const n of findUses(scan, b.local, member)) {
            const p = scan.sf.getLineAndCharacterOfPosition(n.getStart(scan.sf));
            items.push({
              file: rel,
              line: p.line + 1,
              column: p.character + 1,
              symbol: sym,
              change_id: change.id,
              snippet: lineText(scan.sf, p.line),
              confidence: b.imported === "*" || b.imported === "default" ? "medium" : "high",
            });
          }
        }
      }
    }
  }
  return { items, importing: [...importing].sort() };
}

/** Python: import-level scan (regex). Phase 0 limitation: no type-aware resolution. */
async function impactPy(
  root: string,
  record: ChangeRecord,
  pkg: string,
): Promise<{ items: ImpactItem[]; importing: string[] }> {
  const items: ImpactItem[] = [];
  const importing = new Set<string>();
  const mod = pkg.replace(/-/g, "_").toLowerCase();
  for (const file of await walk(root, new Set([".py"]))) {
    const text = await readFile(file, "utf8");
    if (!text.toLowerCase().includes(mod)) continue;
    const rel = relative(root, file);
    const lines = text.split("\n");
    const importsMod = lines.some((l) =>
      new RegExp(`^\\s*(from\\s+${mod}(\\.|\\s)|import\\s+${mod}(\\.|\\s|$|,))`, "i").test(l),
    );
    if (!importsMod) continue;
    importing.add(rel);
    for (const change of record.changes.filter(isActionable))
      for (const sym of change.symbols) {
        const { path } = parseSymbol(sym);
        const needle = path.at(-1);
        if (!needle) continue;
        lines.forEach((l, i) => {
          if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l))
            items.push({
              file: rel,
              line: i + 1,
              column: 1,
              symbol: sym,
              change_id: change.id,
              snippet: l.trim().slice(0, 200),
              confidence: "low",
            });
        });
      }
  }
  return { items, importing: [...importing].sort() };
}

function dedupe(items: ImpactItem[]): ImpactItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.file}:${i.line}:${i.change_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Map each breaking change to the places this repository uses it (IMP-1..4). */
export async function buildImpactMap(
  root: string,
  ecosystem: Ecosystem,
  pkg: string,
  record: ChangeRecord,
): Promise<ImpactMap> {
  const { items, importing } =
    ecosystem === "npm" ? await impactJs(root, record, pkg) : await impactPy(root, record, pkg);
  const unique = dedupe(items).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  let upgrade_class: UpgradeClass;
  let reason: string;
  if (!importing.length) {
    upgrade_class = "safe";
    reason = `No source file imports ${pkg}.`;
  } else if (!unique.length) {
    upgrade_class = "safe";
    reason = record.changes.length
      ? `${record.changes.length} breaking change(s) found upstream, but none of their symbols are used in this repository.`
      : "No breaking changes found upstream.";
  } else {
    const kinds = new Set(
      record.changes.filter((c) => unique.some((u) => u.change_id === c.id)).map((c) => c.kind),
    );
    upgrade_class =
      kinds.has("behavior_changed") || kinds.has("default_changed") ? "human" : "agent";
    reason = `${unique.length} affected location(s) in ${new Set(unique.map((u) => u.file)).size} file(s).`;
  }
  return {
    package: pkg,
    from: record.from,
    to: record.to,
    items: unique,
    files_importing_package: importing,
    upgrade_class,
    reason,
  };
}
