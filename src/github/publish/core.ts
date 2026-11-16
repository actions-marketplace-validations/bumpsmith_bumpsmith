import type { RepoConfig } from "../../config/repo-config.ts";
import type { JobRecord } from "../../pipeline.ts";
import { npmPeerDependencies } from "../../registry/registry.ts";
import { parsePatch } from "../../review/patch.ts";
import { applyRules } from "../../review/rules.ts";
import { sha256Hex } from "../../util/hash.ts";
import type { GitHubClient } from "../client.ts";
import { applyStrict, type FileChange, PatchError } from "./apply-patch.ts";
import { codeownersReviewers } from "./codeowners.ts";
import { branchName, neutralise, prBody, prTitle } from "./pr-body.ts";

/**
 * The publishing path, shared by the GitHub Action and the hosted service, so the
 * security-critical sequence exists exactly once. It trusts nothing about the patch:
 *   1. the patch must hash to the value recorded when it was reviewed;
 *   2. the plain-code diff rules are re-run here;
 *   3. files are rebuilt from the base commit + patch with a strict, no-fuzz applier
 *      (no renames, mode changes, symlinks or binaries);
 *   4. the commit is created through the API without author/committer (GitHub signs it);
 *   5. an existing branch is moved only if its head is a commit Bumpsmith wrote;
 *   6. a PR a user closed for this branch is never reopened.
 */

export interface PublishInput {
  gh: GitHubClient;
  owner: string;
  repo: string;
  baseSha: string;
  patch: string;
  patchSha256: string;
  record: JobRecord;
  outcome: string;
  confidence: "high" | "medium" | "low";
  config: RepoConfig;
  ecosystem: "npm" | "pypi";
  packageName: string;
  toVersion: string;
  jobId: string;
  /** Name used in command hints, e.g. "bumpsmith" or an App slug. */
  commandPrefix: string;
  rescueOf: number | null;
  /** Is this branch head a commit Bumpsmith wrote (and nobody pushed on top)? */
  isOurHead(sha: string): Promise<boolean>;
  peerDependencies?: (pkg: string, version: string) => Promise<string[]>;
}

export type PublishResult =
  | {
      state: "published";
      prId: string;
      prNumber: number;
      url: string;
      commitSha: string;
      branch: string;
      verified: boolean;
      draft: boolean;
      updated: boolean;
      files: number;
      extras: string[];
    }
  | { state: "blocked"; reason: string }
  | { state: "skipped"; reason: string }
  | { state: "human_touched"; branch: string; prNumber: number | null };

const RANK = { low: 0, medium: 1, high: 2 } as const;

async function readBaseFile(
  gh: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const r = await gh.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
      headers: { accept: "application/vnd.github.raw+json" },
    });
    return typeof r.data === "string"
      ? r.data
      : Buffer.from(r.data as unknown as ArrayBuffer).toString("utf8");
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** File mode at the base commit (keeps executables executable); walks one tree per level. */
async function baseMode(
  gh: GitHubClient,
  owner: string,
  repo: string,
  rootTree: string,
  path: string,
): Promise<string | null> {
  let tree = rootTree;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const entries = (
      await gh.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: tree,
      })
    ).data.tree;
    const e = entries.find((x) => x.path === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.mode ?? null;
    if (e.type !== "tree" || !e.sha) return null;
    tree = e.sha;
  }
  return null;
}

export function draftReason(
  outcome: string,
  confidence: "high" | "medium" | "low",
  config: RepoConfig,
): string | null {
  if (outcome !== "ready")
    return "checks or review did not fully pass; see Verification and Not verified.";
  if (RANK[confidence] < RANK[config.pull_requests.draft_below])
    return `confidence ${confidence} is below this repository's threshold (${config.pull_requests.draft_below}).`;
  return null;
}

export async function publishPatch(input: PublishInput): Promise<PublishResult> {
  const { gh, owner, repo, record, config } = input;

  // 1. Integrity.
  if (!input.patch.trim()) return { state: "skipped", reason: "no patch" };
  if (sha256Hex(input.patch) !== input.patchSha256)
    return { state: "blocked", reason: "patch hash mismatch" };

  // 2. Independent re-run of the plain-code rules.
  if (!record.change_record) return { state: "blocked", reason: "no Change Record" };
  const peers =
    input.ecosystem === "npm"
      ? await (input.peerDependencies ?? npmPeerDependencies)(input.packageName, input.toVersion)
      : [];
  const blocks = applyRules({
    ecosystem: input.ecosystem,
    packageName: input.packageName,
    files: parsePatch(input.patch),
    record: record.change_record,
    edits: record.edits ?? [],
    peerDependencies: peers,
    protectedPaths: config.rules.protected_paths,
  }).filter((f) => f.severity === "block");
  if (blocks.length)
    return { state: "blocked", reason: `rule ${blocks[0]?.rule} blocked publication` };

  const branch = branchName(input.ecosystem, input.packageName, input.toVersion);
  const prior = (
    await gh.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "all",
      per_page: 100,
    })
  ).data;
  // 6. Never reopen what a user closed.
  if (prior.some((p) => p.state === "closed" && !p.merged_at))
    return { state: "skipped", reason: "a pull request for this upgrade was closed by a user" };
  const open = prior.find((p) => p.state === "open") ?? null;

  // 3. Rebuild files from the base commit + reviewed patch.
  let changes: FileChange[];
  try {
    changes = await applyStrict(input.patch, (p) =>
      readBaseFile(gh, owner, repo, p, input.baseSha),
    );
  } catch (err) {
    if (err instanceof PatchError) return { state: "blocked", reason: err.message };
    throw err;
  }
  const meta = (await gh.request("GET /repos/{owner}/{repo}", { owner, repo })).data;
  const baseCommit = (
    await gh.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: input.baseSha,
    })
  ).data;
  const tree: { path: string; mode: "100644" | "100755"; type: "blob"; sha: string | null }[] = [];
  for (const c of changes) {
    if (c.content === null) {
      tree.push({ path: c.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const mode = c.isNew ? "100644" : await baseMode(gh, owner, repo, baseCommit.tree.sha, c.path);
    if (!c.isNew && mode !== "100644" && mode !== "100755")
      return { state: "blocked", reason: `unexpected file type at ${c.path}` };
    let blob: { data: { sha: string } };
    try {
      blob = await gh.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: Buffer.from(c.content, "utf8").toString("base64"),
        encoding: "base64",
      });
    } catch (err) {
      // Secret-scanning push protection: never bypass; a human must look.
      if ((err as { status?: number }).status === 409)
        return {
          state: "blocked",
          reason: "GitHub push protection detected a secret in the change",
        };
      throw err;
    }
    tree.push({
      path: c.path,
      mode: (mode ?? "100644") as "100644" | "100755",
      type: "blob",
      sha: blob.data.sha,
    });
  }

  // 4. Commit without author/committer/signature: GitHub signs it as the app.
  const newTree = (
    await gh.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree,
    })
  ).data;
  const message = `${prTitle(record)}\n\nGenerated-By: Bumpsmith (${record.model})\nBumpsmith-Job: ${input.jobId}\nBumpsmith-Patch-SHA256: ${input.patchSha256}`;
  const commit = (
    await gh.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message,
      tree: newTree.sha,
      parents: [input.baseSha],
    })
  ).data;
  const verified = Boolean(
    (commit as { verification?: { verified?: boolean } }).verification?.verified,
  );

  // 5. Branch: create, or move only if the current head is ours.
  let currentHead: string | null = null;
  try {
    currentHead = (
      await gh.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner,
        repo,
        ref: `heads/${branch}`,
      })
    ).data.object.sha;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
  }
  if (currentHead) {
    if (!(await input.isOurHead(currentHead)))
      return { state: "human_touched", branch, prNumber: open?.number ?? null };
    await gh.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
      force: true,
    });
  } else {
    await gh.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  }

  // Pull request (draft below the configured confidence).
  const draft = draftReason(input.outcome, input.confidence, config);
  const title = prTitle(record);
  const body = prBody({
    job: record,
    appSlug: input.commandPrefix,
    rescueOf: input.rescueOf,
    draftReason: draft,
  });
  const pr = open
    ? (
        await gh.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner,
          repo,
          pull_number: open.number,
          title,
          body,
        })
      ).data
    : (
        await gh.request("POST /repos/{owner}/{repo}/pulls", {
          owner,
          repo,
          title,
          body,
          head: branch,
          base: meta.default_branch,
          draft: draft !== null,
          maintainer_can_modify: false,
        })
      ).data;

  // Best effort extras: never undo the PR if these fail.
  const extras: string[] = [];
  try {
    await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner,
      repo,
      issue_number: pr.number,
      labels: [...config.pull_requests.labels, "ai-generated"],
    });
  } catch {
    extras.push("labels failed");
  }
  if (!draft && !open) {
    try {
      const { users, teams } = await codeownersReviewers(
        gh,
        owner,
        repo,
        input.baseSha,
        changes.map((c) => c.path),
      );
      if (users.length || teams.length)
        await gh.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
          owner,
          repo,
          pull_number: pr.number,
          reviewers: users.slice(0, 10),
          team_reviewers: teams.slice(0, 5),
        });
    } catch {
      extras.push("reviewer request failed");
    }
  }
  if (input.rescueOf && !open) {
    try {
      await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: input.rescueOf,
        body: `Bumpsmith opened #${pr.number} with this same upgrade plus the code changes it needs (confidence ${input.confidence}). This pull request was left open; close it once #${pr.number} is merged.`,
      });
    } catch {
      extras.push("rescue link failed");
    }
  }
  return {
    state: "published",
    prId: String(pr.id),
    prNumber: pr.number,
    url: pr.html_url,
    commitSha: commit.sha,
    branch,
    verified,
    draft: draft !== null,
    updated: open !== null,
    files: changes.length,
    extras,
  };
}

/** Comment text when no safe fix could be produced (needs human). */
export function needsHumanComment(record: JobRecord, product = "Bumpsmith"): string {
  const lines = [
    `${product} looked at this upgrade (${record.input.packageName} ${record.from ?? ""} → ${record.input.to}) and could not produce a verified fix.`,
    "",
    `**Why it stopped:** ${neutralise(record.notes.join(" ") || record.error || "the checks or the independent review did not pass.", 600)}`,
  ];
  const items = record.impact?.items ?? [];
  if (items.length) {
    lines.push("", "**Places in this repository the upgrade affects:**", "");
    for (const i of items.slice(0, 15)) lines.push(`- \`${i.file}:${i.line}\` (${i.change_id})`);
    if (items.length > 15) lines.push(`- … and ${items.length - 15} more`);
  }
  lines.push("", `<sub>🤖 Generated by an AI agent (${product}). No changes were pushed.</sub>`);
  return lines.join("\n");
}

/**
 * Without a database (GitHub Action): a branch head is ours if the commit carries our
 * patch trailer and was authored by a bot account (the app or github-actions).
 */
export async function headWrittenByBumpsmith(
  gh: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  const c = (await gh.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref: sha }))
    .data;
  const author = c.author?.login ?? "";
  return (
    /\nBumpsmith-Patch-SHA256: [0-9a-f]{64}\b/.test(c.commit.message) && author.endsWith("[bot]")
  );
}
