import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtMessageItem } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  claimExtMessage,
  groupExtMessage,
  listExtMessages,
  projectExtMessage,
  settleExtMessage,
} from "./ext-message.js";
import { defaultMigrationsDir, listMigrations, migrate } from "./migrate.js";
import { Store } from "./store.js";
import { withTempStore } from "./test-support.js";

const at = "2026-01-01T00:00:00.000Z";
const item: ExtMessageItem = {
  project_id: "fictional",
  event_id: "event-1",
  card_id: "C-1",
  item_id: "Q-1",
  kind: "decision",
  sensitive: false,
  handled: false,
  ready: true,
};
test("migration upgrades an existing schema without rewriting existing notifications", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const m of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 25,
    ))
      db.exec(m.sql);
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    db.exec(
      listMigrations(defaultMigrationsDir).find((m) => m.version === 25)!.sql,
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toHaveLength(before.length + 2);
    expect(listExtMessages(db)).toEqual([]);
  } finally {
    db.close();
  }
});
test.each([
  ["rate:queued", "queued", "quiet-id", "rate:fixed-id"],
  ["queued", "rate:queued", "rate:fixed-id", "quiet-id"],
] as const)(
  "%s cannot change payload class before a claim",
  (owned, other, wrong, frozen) =>
    withTempStore((store) =>
      store.uow.run(() => {
        const db = store.database;
        const row = () => listExtMessages(db)[0]!;
        projectExtMessage(db, item, "fake", at);
        const stale = row();
        groupExtMessage(db, stale, owned);
        groupExtMessage(db, stale, other);
        groupExtMessage(db, row(), other);
        groupExtMessage(db, row(), wrong);
        expect(row().digest_id).toBe(owned);
        groupExtMessage(db, row(), frozen);
        expect(row().digest_id).toBe(frozen);
      }),
    ),
);

test("replay is unique per item and channel, transactional and terminal rows cannot be claimed", () =>
  withTempStore((store) => {
    store.uow.run(() => {
      projectExtMessage(store.database, item, "fake", at);
      projectExtMessage(
        store.database,
        { ...item, event_id: "later-event" },
        "fake",
        at,
      );
      projectExtMessage(store.database, item, "second", at);
    });
    expect(listExtMessages(store.database)).toHaveLength(2);
    expect(() =>
      store.uow.run(() => {
        projectExtMessage(
          store.database,
          { ...item, item_id: "Q-2" },
          "fake",
          at,
        );
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(listExtMessages(store.database)).toHaveLength(2);
    const row = listExtMessages(store.database)[0]!;
    expect(
      claimExtMessage(
        store.database,
        row,
        "lease-1",
        at,
        "2026-01-01T00:00:10.000Z",
        "2026-01-01T00:00:40.000Z",
      ),
    ).toBe(true);
    expect(claimExtMessage(store.database, row, "lease-2", at, at, at)).toBe(
      false,
    );
    expect(
      settleExtMessage(
        store.database,
        { ...row, attempts: 1, lease_id: "wrong" },
        "sent",
        null,
        at,
        at,
      ),
    ).toBe(false);
    expect(
      settleExtMessage(
        store.database,
        { ...row, attempts: 1, lease_id: "lease-1" },
        "sent",
        null,
        at,
        at,
      ),
    ).toBe(true);
    const sent = listExtMessages(store.database)[0]!;
    expect(claimExtMessage(store.database, sent, "lease-3", at, at, at)).toBe(
      false,
    );
    expect(migrate(store.database)).toEqual([]);
  }));

test.each([25, 26])(
  "digest migration preserves v%s pending/terminal budgets and reopens idempotently",
  (previousVersion) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      for (const migration of listMigrations(defaultMigrationsDir).filter(
        (m) => m.version <= previousVersion,
      )) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_version VALUES (?,?,?)").run(
          migration.version,
          migration.name,
          at,
        );
      }
      for (const status of ["pending", "sent", "failed", "skipped"]) {
        db.prepare(`INSERT INTO ext_message_outbox
        (project_id,item_kind,item_id,channel,event_id,status,attempts,next_attempt_at,updated_at)
        VALUES ('fictional','decision',?,'fake','event-1',?,2,?,?)`).run(
          status,
          status,
          at,
          at,
        );
      }
      const before = listExtMessages(db);
      const digestUpgrade = migrate(db).filter((migration) =>
        ["machine_registry", "ext_message_digest"].includes(migration.name),
      );
      expect(digestUpgrade).toEqual(
        [
          { version: 26, name: "machine_registry" },
          { version: 27, name: "ext_message_digest" },
        ].filter((migration) => migration.version > previousVersion),
      );
      expect(listExtMessages(db)).toEqual(
        before.map((r) => ({ ...r, digest_id: null })),
      );
      expect(migrate(db)).toEqual([]);
      projectExtMessage(db, item, "fake", at, true);
      projectExtMessage(db, item, "fake", at, false);
      expect(
        listExtMessages(db).find((r) => r.item_id === "Q-1")?.digest_id,
      ).toBe("queued");
    } finally {
      db.close();
    }
  },
);

test("digest upgrade rolls back its column and preserves registered machines and outbox data on retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-digest-migration-"));
  const migrations = listMigrations(defaultMigrationsDir);
  for (const migration of migrations.filter((m) => m.version <= 26))
    writeFileSync(
      join(
        dir,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir: dir, migrationsDir: dir });
  try {
    store.createProject({ id: "fictional", name: "Fictional" });
    store.database
      .prepare(`INSERT INTO ext_message_outbox
      (project_id,item_kind,item_id,channel,event_id,status,attempts,next_attempt_at,updated_at)
      VALUES ('fictional','decision','history','fake','event-1','pending',2,?,?)`)
      .run(at, at);
    const machines = store.database.prepare("SELECT * FROM machines").all();
    expect(machines).toHaveLength(1);
    const history = listExtMessages(store.database);
    const digest = migrations.find((m) => m.version === 27);
    if (!digest) throw new Error("Missing digest migration");
    const path = join(dir, "0027_ext_message_digest.sql");
    writeFileSync(path, `${digest.sql}\nSELECT * FROM missing_digest_table;`);
    expect(() => store.migrate()).toThrow("missing_digest_table");
    expect(store.schemaVersion()).toBe(26);
    expect(
      store.database
        .prepare("PRAGMA table_info(ext_message_outbox)")
        .all()
        .map((c) => c.name),
    ).not.toContain("digest_id");
    expect(listExtMessages(store.database)).toEqual(history);
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual(
      machines,
    );
    writeFileSync(path, digest.sql);
    expect(store.migrate()).toEqual([
      { version: 27, name: "ext_message_digest" },
    ]);
    expect(listExtMessages(store.database)).toEqual(
      history.map((r) => ({ ...r, digest_id: null })),
    );
    projectExtMessage(store.database, item, "fake", at, true);
    const grouped = listExtMessages(store.database);
    expect(grouped.find((r) => r.item_id === item.item_id)?.digest_id).toBe(
      "queued",
    );
    store.close();
    store = Store.open({ dataDir: dir });
    expect(store.migrate()).toEqual([]);
    expect(listExtMessages(store.database)).toEqual(grouped);
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual(
      machines,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
