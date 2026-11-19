// Tamper-evident audit log: append-only rows, each hashed together with the previous row's
// hash. Editing or deleting any row breaks the chain from that point, which verify() reports;
// removing the newest rows can't be seen from the chain alone, so exports anchor the head.
import { sha256 } from "./crypto.ts";
import { type Db, now } from "./db.ts";

export interface AuditEvent {
  orgId: string | null;
  actorId: string | null;
  actor: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

const GENESIS = "0".repeat(64);
const canonical = (r: {
  org_id: string | null;
  at: string;
  actor_id: string | null;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  detail: string;
}) => JSON.stringify([r.org_id, r.at, r.actor_id, r.actor, r.action, r.target, r.ip, r.detail]);

export function audit(db: Db, e: AuditEvent): void {
  const row = {
    org_id: e.orgId,
    at: now(),
    actor_id: e.actorId,
    actor: e.actor,
    action: e.action,
    target: e.target ?? null,
    ip: e.ip ?? null,
    detail: JSON.stringify(e.detail ?? {}),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const last = db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
      | { hash: string }
      | undefined;
    const prev = last?.hash ?? GENESIS;
    const hash = sha256(prev + canonical(row));
    db.prepare(
      "INSERT INTO audit (org_id, at, actor_id, actor, action, target, ip, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      row.org_id,
      row.at,
      row.actor_id,
      row.actor,
      row.action,
      row.target,
      row.ip,
      row.detail,
      prev,
      hash,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Recompute the chain. Returns the first broken sequence number, or null when intact. */
export function verifyAudit(db: Db): { ok: boolean; rows: number; brokenAt: number | null } {
  let prev = GENESIS;
  let rows = 0;
  for (const r of db.prepare("SELECT * FROM audit ORDER BY seq").all() as unknown as (Parameters<
    typeof canonical
  >[0] & { seq: number; prev_hash: string; hash: string })[]) {
    rows++;
    if (r.prev_hash !== prev || sha256(prev + canonical(r)) !== r.hash)
      return { ok: false, rows, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, rows, brokenAt: null };
}
