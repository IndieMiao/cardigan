import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  migrateReadableIdFormat,
  rewriteLegacyIds,
} from "./id-format-migration.js";
import { defaultMigrationsDir, Store } from "./index.js";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A database at schema 17, holding pre-C-132 `q(n)` / `h(n)` records. */
function legacyDatabase() {
  const dataDir = tempDir("cardigan-idfmt-");
  const migrationsDir = tempDir("cardigan-idfmt-migrations-");
  for (const file of readdirSync(defaultMigrationsDir))
    if (/^00(0[1-9]|1[0-7])_/u.test(file))
      copyFileSync(join(defaultMigrationsDir, file), join(migrationsDir, file));
  const dbPath = join(dataDir, "cardigan.db");
  const old = Store.open({ dbPath, migrationsDir });
  expect(old.schemaVersion()).toBe(17);
  const db = old.database;
  const insert = (sql: string, ...values: (string | number | null)[]) =>
    db.prepare(sql).run(...values);
  insert(
    "INSERT INTO cards (project_id, id, doc) VALUES ('p', 'C-1', ?)",
    JSON.stringify({ id: "C-1", title: "见 q(95)" }),
  );
  insert(
    "INSERT INTO decisions (project_id, id, doc) VALUES ('p', 'q(95)', ?)",
    JSON.stringify({
      id: "q(95)",
      key: "q(95)",
      card_id: "C-1",
      question: "选 q(95) 还是 h(16)？",
      amends: "q(94)",
    }),
  );
  insert(
    "INSERT INTO human_actions (project_id, id, doc) VALUES ('p', 'h(16)', ?)",
    JSON.stringify({ id: "h(16)", key: "h(16)", instructions: "按 h(16) 做" }),
  );
  insert(
    "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES ('p', 'E1', 'C-1', 'C-1', 1, 'decision_resolved', ?)",
    JSON.stringify({
      payload: {
        decision_id: "q(95)",
        refs: [{ kind: "decision", id: "q(95)" }],
      },
      body: "q(95)：已拍板",
    }),
  );
  insert(
    "INSERT INTO timeline (project_id, id, card_id, event_seq, doc) VALUES ('p', 'C-1#1', 'C-1', 1, ?)",
    JSON.stringify({
      body: "旧评论引用 q(95) 和 h(16)",
      decision_id: "q(95)",
      refs: [
        { kind: "decision", id: "q(95)" },
        { kind: "human_action", id: "h(16)" },
      ],
    }),
  );
  insert(
    "INSERT INTO id_counters (project_id, kind, value) VALUES ('p', 'decision', 95), ('p', 'human_action', 16)",
  );
  old.close();
  return { dataDir, dbPath };
}

const doc = (db: DatabaseSync, sql: string) =>
  JSON.parse(String((db.prepare(sql).get() as { doc: string }).doc));

test("C-132: stored q(n) / h(n) become Q-n / H-n after a backup, and numbering continues", () => {
  const { dataDir, dbPath } = legacyDatabase();
  const store = Store.open({
    dbPath,
    clock: { now: () => "2026-11-12T05:00:00.000Z" },
  });
  try {
    const db = store.database;
    expect(
      db
        .prepare("SELECT id FROM decisions")
        .all()
        .map((r) => r.id),
    ).toEqual(["Q-95"]);
    expect(
      db
        .prepare("SELECT id FROM human_actions")
        .all()
        .map((r) => r.id),
    ).toEqual(["H-16"]);
    expect(doc(db, "SELECT doc FROM decisions")).toEqual({
      id: "Q-95",
      key: "Q-95",
      card_id: "C-1",
      // Free text keeps what was written.
      question: "选 q(95) 还是 h(16)？",
      amends: "Q-94",
    });
    expect(doc(db, "SELECT doc FROM events")).toEqual({
      payload: {
        decision_id: "Q-95",
        refs: [{ kind: "decision", id: "Q-95" }],
      },
      body: "q(95)：已拍板",
    });
    expect(doc(db, "SELECT doc FROM timeline")).toEqual({
      body: "旧评论引用 q(95) 和 h(16)",
      decision_id: "Q-95",
      refs: [
        { kind: "decision", id: "Q-95" },
        { kind: "human_action", id: "H-16" },
      ],
    });
    expect(doc(db, "SELECT doc FROM cards").title).toBe("见 q(95)");
    expect(
      store.uow.run((tx) => [
        tx.ids.next("p", "decision"),
        tx.ids.next("p", "human_action"),
      ]),
    ).toEqual(["Q-96", "H-17"]);

    // The backup is the untouched schema-17 database.
    const backups = readdirSync(dataDir).filter((f) => f.endsWith(".bak"));
    expect(backups).toEqual(["cardigan.db.pre-0018-20261112T050000000Z.bak"]);
    const backup = new DatabaseSync(join(dataDir, backups[0] as string), {
      readOnly: true,
    });
    try {
      expect(
        backup
          .prepare("SELECT id FROM decisions")
          .all()
          .map((r) => r.id),
      ).toEqual(["q(95)"]);
      expect(
        backup.prepare("SELECT MAX(version) AS v FROM schema_version").get(),
      ).toEqual({ v: 17 });
    } finally {
      backup.close();
    }

    // Idempotent: rerunning the rewrite changes nothing.
    expect(migrateReadableIdFormat(db)).toBe(0);
  } finally {
    store.close();
  }
  // Reopening neither migrates again nor takes another backup.
  Store.open({ dbPath }).close();
  expect(readdirSync(dataDir).filter((f) => f.endsWith(".bak"))).toHaveLength(
    1,
  );
});

test("a new database takes no backup", () => {
  const dataDir = tempDir("cardigan-idfmt-new-");
  Store.open({ dataDir }).close();
  expect(readdirSync(dataDir).filter((f) => f.endsWith(".bak"))).toEqual([]);
});

test("only whole id values are rewritten", () => {
  expect(rewriteLegacyIds("q(3)")).toBe("Q-3");
  expect(rewriteLegacyIds("h(3)")).toBe("H-3");
  expect(rewriteLegacyIds("见 q(3)")).toBeUndefined();
  expect(rewriteLegacyIds("q(03)")).toBeUndefined();
  expect(rewriteLegacyIds("Q-3")).toBeUndefined();
  expect(rewriteLegacyIds("{not json q(3)")).toBeUndefined();
  expect(rewriteLegacyIds('["q(1)","x q(2)",{"q(3)":"h(4)"}]')).toBe(
    '["Q-1","x q(2)",{"Q-3":"H-4"}]',
  );
  expect(rewriteLegacyIds('{"a":"Q-1","b":[1,null,true]}')).toBeUndefined();
});
