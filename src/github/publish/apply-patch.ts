import { applyPatch, parsePatch, type StructuredPatch } from "diff";

/**
 * Strict patch application for the Publisher (PRD §10: "the Publisher is the single place
 * where a patch can become a commit"). It rebuilds file contents from the *reviewed* patch
 * and the base commit, so what reaches GitHub is exactly what the rules and the reviewer
 * saw. No fuzz: a hunk that does not apply exactly is a failure. Renames, copies, mode
 * changes, symlinks and binary content are refused.
 */

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export interface FileChange {
  path: string;
  /** New content, or null when the file is deleted. */
  content: string | null;
  isNew: boolean;
}

const strip = (name: string | undefined) => (name ? name.replace(/^[ab]\//, "") : "");
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

/** Refuse git extended headers that mean anything other than a plain text edit. */
function assertPlainEdits(patchText: string): void {
  const forbidden = [
    [/^rename (from|to) /m, "renames are not allowed"],
    [/^copy (from|to) /m, "copies are not allowed"],
    [/^(old|new) mode /m, "file mode changes are not allowed"],
    [/^(new|deleted) file mode 1[^0]/m, "only regular files are allowed"],
    [/^(new|deleted) file mode 120000/m, "symlinks are not allowed"],
    [/^(new|deleted) file mode 160000/m, "submodules are not allowed"],
    [/^Binary files .* differ$/m, "binary changes are not allowed"],
    [/^GIT binary patch$/m, "binary changes are not allowed"],
  ] as const;
  for (const [re, why] of forbidden) if (re.test(patchText)) throw new PatchError(why);
}

export function patchFiles(patchText: string): StructuredPatch[] {
  assertPlainEdits(patchText);
  let files: StructuredPatch[];
  try {
    files = parsePatch(patchText);
  } catch (err) {
    throw new PatchError(`malformed patch: ${(err as Error).message.slice(0, 200)}`);
  }
  const seen = new Set<string>();
  for (const f of files) {
    const oldName = strip(f.oldFileName);
    const newName = strip(f.newFileName);
    if (!f.hunks.length) throw new PatchError(`empty change for ${newName || oldName}`);
    if (oldName !== "/dev/null" && newName !== "/dev/null" && oldName !== newName)
      throw new PatchError(`path changes are not allowed (${oldName} -> ${newName})`);
    const path = newName === "/dev/null" ? oldName : newName;
    if (!SAFE_PATH.test(path)) throw new PatchError(`unsafe path ${path}`);
    if (seen.has(path)) throw new PatchError(`file appears twice: ${path}`);
    seen.add(path);
  }
  return files;
}

/**
 * Apply every file of the patch to its base content. `readBase` returns the file at the
 * base commit, or null if it does not exist there.
 */
export async function applyStrict(
  patchText: string,
  readBase: (path: string) => Promise<string | null>,
): Promise<FileChange[]> {
  const out: FileChange[] = [];
  for (const f of patchFiles(patchText)) {
    const oldName = strip(f.oldFileName);
    const newName = strip(f.newFileName);
    const isNew = oldName === "/dev/null";
    const isDelete = newName === "/dev/null";
    const path = isDelete ? oldName : newName;
    const base = await readBase(path);
    if (isNew && base !== null) throw new PatchError(`${path} already exists at the base commit`);
    if (!isNew && base === null) throw new PatchError(`${path} does not exist at the base commit`);
    const result = applyPatch(base ?? "", f, { fuzzFactor: 0 });
    if (result === false) throw new PatchError(`patch does not apply cleanly to ${path}`);
    if (isDelete) {
      if (result !== "") throw new PatchError(`deletion of ${path} does not remove all content`);
      out.push({ path, content: null, isNew: false });
    } else out.push({ path, content: result, isNew });
  }
  return out;
}
