import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMember, type Member, updateMember } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  defaultMigrationsDir,
  hashWebSessionToken,
  listMigrations,
  persistMemberEffect,
  ReadOnlyTransactionError,
  Store,
} from "./index.js";

const clock = { now: () => "2026-01-01T00:00:00.000Z" };
test("fresh and upgraded databases seed one global owner and lazily associate only valid sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cardigan-members-"));
  const legacy = join(dir, "legacy");
  // Build an actual v13 database, keeping the old session bytes until read.
  const migrationsDir = mkdtempSync(join(tmpdir(), "cardigan-members-schema-"));
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= 13,
  ))
    writeFileSync(
      join(
        migrationsDir,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  const old = Store.open({ dataDir: legacy, migrationsDir, clock });
  old.database
    .prepare(
      "INSERT INTO web_sessions (id_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
    )
    .run(
      hashWebSessionToken("old-session"),
      clock.now(),
      clock.now(),
      "2026-01-03T00:00:00.000Z",
    );
  old.database
    .prepare(
      "INSERT INTO web_sessions (id_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
    )
    .run(
      hashWebSessionToken("expired-session"),
      clock.now(),
      clock.now(),
      clock.now(),
    );
  old.close();
  try {
    for (const dataDir of [legacy, join(dir, "fresh")]) {
      const store = Store.open({ dataDir, clock });
      try {
        const owner = store.uow.read((tx) => tx.members.list())[0] as Member;
        expect(owner).toMatchObject({
          id: "M-1",
          name: "所有者",
          role: "owner",
          status: "active",
        });
        expect(
          store.uow.read((tx) => tx.global_events.listAfter(0)),
        ).toMatchObject([
          { type: "member_created", actor: { kind: "system" } },
        ]);
        expect(store.createWebSession().session.member_id).toBe(owner.id);
        if (dataDir === legacy) {
          const row = () =>
            store.database
              .prepare("SELECT member_id FROM web_sessions WHERE id_hash = ?")
              .get(hashWebSessionToken("old-session"));
          expect(row()?.member_id).toBeNull();
          expect(store.webSession("old-session")?.member_id).toBe(owner.id);
          expect(row()?.member_id).toBe(owner.id);
          expect(store.webSession("expired-session")).toBeUndefined();
          expect(
            store.database
              .prepare("SELECT member_id FROM web_sessions WHERE id_hash = ?")
              .get(hashWebSessionToken("expired-session"))?.member_id,
          ).toBeNull();
        }
        expect(store.migrate()).toEqual([]);
        expect(store.uow.read((tx) => tx.members.list())).toEqual([owner]);
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(migrationsDir, { recursive: true, force: true });
  }
});

test("global member writes, audit and IDs commit together; SQL and read transactions preserve the owner", () => {
  const store = Store.open({ dbPath: ":memory:", clock });
  try {
    store.createProject({ id: "one" });
    store.createProject({ id: "two" });
    const owner = store.uow.read((tx) => tx.members.list())[0] as Member;
    const before = store.uow.read((tx) => tx.global_events.listAfter(0));
    const rename = () =>
      store.uow.run((tx) => {
        const effect = updateMember(
          tx.members.list(),
          { kind: "human" },
          owner.id,
          { name: "邵杰" },
          { clock, ids: tx.global_ids },
        );
        if (!effect.ok) throw new Error(effect.error.message);
        persistMemberEffect(tx, effect.value);
        return effect.value;
      });
    expect(rename().data.name).toBe("邵杰");
    expect(store.getUpdates({ project_id: "one" }).events).toEqual([]);
    expect(store.getUpdates({ project_id: "two" }).events).toEqual([]);
    expect(() =>
      store.uow.run((tx) => {
        tx.members.put({ ...owner, name: "Rolled back" });
        tx.global_ids.nextMemberId();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.uow.read((tx) => tx.members.get(owner.id))?.name).toBe("邵杰");
    expect(store.uow.run((tx) => tx.global_ids.nextMemberId())).toBe("M-2");
    expect(store.uow.read((tx) => tx.global_events.listAfter(0))).toHaveLength(
      before.length + 1,
    );
    expect(() =>
      store.uow.read((tx) =>
        (tx.members as { put(member: Member): void }).put(owner),
      ),
    ).toThrow(ReadOnlyTransactionError);
    expect(() =>
      store.uow.run((tx) => tx.members.put({ ...owner, status: "inactive" })),
    ).toThrow("retain the active owner");
    expect(() =>
      store.database.prepare("DELETE FROM members WHERE id = ?").run(owner.id),
    ).toThrow("retain the active owner");
    expect(() =>
      store.uow.run((tx) =>
        tx.members.put({ ...owner, id: "M-3" as Member["id"] }),
      ),
    ).toThrow(/UNIQUE/);
    expect(
      store.uow.run((tx) =>
        createMember(
          tx.members.list(),
          { kind: "human" },
          { name: "Second", title: "所有者", role: "owner" },
          { clock, ids: tx.global_ids },
        ),
      ).ok,
    ).toBe(false);
  } finally {
    store.close();
  }
});
