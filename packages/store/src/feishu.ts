import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
export const digestFeishu = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const FEISHU_HEARTBEAT_MS = 60_000;
export function feishuStatus(db: DatabaseSync, now = Date.now()) {
  const row = db.prepare("SELECT * FROM feishu_runtime WHERE id=1").get();
  return {
    state: !row
      ? "disabled"
      : ["disabled", "failed", "stopped"].includes(String(row.state))
        ? String(row.state)
        : now - Number(row.heartbeat) > FEISHU_HEARTBEAT_MS
          ? "offline"
          : String(row.state),
    at: Number(row?.heartbeat ?? 0),
    bound: !!(row && feishuBinding(db, String(row.scope))),
  };
}
export function feishuBinding(db: DatabaseSync, scope: string) {
  return db
    .prepare(
      "SELECT b.* FROM feishu_bindings b JOIN members m ON m.id=b.member AND m.role='owner' AND m.status='active' WHERE b.scope=?",
    )
    .get(scope) as
    | {
        member: string;
        open_id: string;
        chat: string;
        generation: string;
        watermark: number;
      }
    | undefined;
}
export function feishuAudit(
  db: DatabaseSync,
  result: string,
  member: string | null = null,
  ref: string | null = null,
  now = Date.now(),
) {
  db.prepare(
    "INSERT INTO feishu_audit(at,result,member,ref) VALUES(?,?,?,?)",
  ).run(now, result, member, ref);
}
/** Caller owns BEGIN IMMEDIATE and has revalidated the Workbench session. */
export function manageFeishuBinding(
  db: DatabaseSync,
  member: string | null,
  action: "code" | "unbind",
  now = Date.now(),
) {
  if (
    !member ||
    !db
      .prepare(
        "SELECT 1 FROM members WHERE id=? AND role='owner' AND status='active'",
      )
      .get(member)
  )
    throw new Error("owner_required");
  if (action === "unbind") {
    db.prepare("DELETE FROM feishu_codes WHERE member=?").run(member);
    db.prepare("DELETE FROM feishu_bindings WHERE member=?").run(member);
    feishuAudit(db, "unbound", member);
    return { bound: false };
  }
  const runtime = db
    .prepare(
      "SELECT scope,code_ttl FROM feishu_runtime WHERE id=1 AND state='connected' AND heartbeat>=?",
    )
    .get(now - FEISHU_HEARTBEAT_MS);
  if (!runtime || feishuBinding(db, String(runtime.scope)))
    throw new Error("unavailable");
  const code = randomBytes(16).toString("hex"),
    expires = now + Number(runtime.code_ttl);
  db.prepare("INSERT OR REPLACE INTO feishu_codes VALUES(?,?,?,?)").run(
    runtime.scope!,
    member,
    digestFeishu(code),
    expires,
  );
  feishuAudit(db, "code_issued", member);
  return { bound: false, code, expires };
}
export function redeemFeishuCode(
  db: DatabaseSync,
  scope: string,
  openId: string,
  chat: string,
  code: string,
  now: number,
) {
  const row = db
    .prepare(
      "SELECT c.member FROM feishu_codes c JOIN members m ON c.member=m.id WHERE scope=? AND digest=? AND expires>? AND m.role='owner' AND m.status='active'",
    )
    .get(scope, digestFeishu(code), now);
  if (!row || feishuBinding(db, scope)) return false;
  db.prepare("DELETE FROM feishu_codes WHERE scope=?").run(scope);
  db.prepare(
    "INSERT OR REPLACE INTO feishu_bindings(scope,generation,member,open_id,chat,watermark) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM events))",
  ).run(scope, randomUUID(), row.member!, openId, chat);
  feishuAudit(db, "bound", String(row.member));
  return true;
}
