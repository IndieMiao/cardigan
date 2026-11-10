import type { DatabaseSync } from "node:sqlite";
import type {
  GlobalRepositories,
  Member,
  MemberEffect,
  MemberRepository,
} from "@cardigan/domain";
import { ReadOnlyTransactionError } from "./read-only.js";

export function createMemberRepository(
  db: DatabaseSync,
  mode: "read" | "write",
): MemberRepository {
  return {
    get: (id) => {
      const row = db.prepare("SELECT doc FROM members WHERE id = ?").get(id);
      return row ? (JSON.parse(row.doc as string) as Member) : undefined;
    },
    list: () =>
      db
        .prepare(
          "SELECT doc FROM members ORDER BY CAST(substr(id, 3) AS INTEGER)",
        )
        .all()
        .map((row) => JSON.parse(row.doc as string) as Member),
    put: (member) => {
      if (mode === "read") throw new ReadOnlyTransactionError("members.put");
      db.prepare(
        "INSERT INTO members (id, role, status, doc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = excluded.role, status = excluded.status, doc = excluded.doc",
      ).run(member.id, member.role, member.status, JSON.stringify(member));
    },
  };
}
export function persistMemberEffect(
  tx: Pick<GlobalRepositories, "members" | "global_events">,
  effect: MemberEffect,
): void {
  for (const member of effect.members) tx.members.put(member);
  for (const event of effect.events) tx.global_events.append(event);
}
