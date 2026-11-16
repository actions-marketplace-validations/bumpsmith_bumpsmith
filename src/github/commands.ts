/**
 * Comment commands (PR-7): `@<app-slug> <command>`. Accepted only from accounts with write
 * access to the repository (checked against GitHub, never inferred from the comment);
 * every other comment is ignored and never shown to a model (T10).
 */

export type Command =
  | { name: "explain" }
  | { name: "retry" }
  | { name: "rebase" }
  | { name: "ignore_version" }
  | { name: "ignore_major" }
  | { name: "pause" }
  | { name: "resume" }
  | { name: "fix" };

const COMMANDS: [RegExp, Command][] = [
  [/^explain\b/, { name: "explain" }],
  [/^retry\b/, { name: "retry" }],
  [/^rebase\b/, { name: "rebase" }],
  [/^ignore this version\b/, { name: "ignore_version" }],
  [/^ignore this major( version)?\b/, { name: "ignore_major" }],
  [/^pause\b/, { name: "pause" }],
  [/^resume\b/, { name: "resume" }],
  [/^fix( this)?\b/, { name: "fix" }],
];

/** First command addressed to the app in a comment, if any. Quoted and code text is ignored. */
export function parseCommand(body: string, appSlug: string): Command | null {
  const slug = appSlug.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return null;
  let inFence = false;
  for (const raw of body.split("\n").slice(0, 200)) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith(">")) continue;
    const m = new RegExp(`^@${slug}(?:\\[bot\\])?\\s+(.+)$`, "i").exec(line);
    if (!m?.[1]) continue;
    const rest = m[1].toLowerCase().trim();
    for (const [re, cmd] of COMMANDS) if (re.test(rest)) return cmd;
    return null;
  }
  return null;
}

/** Permission levels that may command the app. */
export function canCommand(permission: string): boolean {
  return permission === "admin" || permission === "write" || permission === "maintain";
}
