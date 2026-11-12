import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  legacyRequest,
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

const legacyDecisionRequest = {
  tool: "record_decision",
  params: {
    decision_id: "q(95)",
    option: "go",
    rationale: "confirmed",
    raw_quote: "go",
  },
};
const currentDecisionRequest = {
  ...legacyDecisionRequest,
  params: { ...legacyDecisionRequest.params, decision_id: "Q-95" },
};

/** A database at schema 17, holding pre-C-132 `q(n)` / `h(n)` records. */
function legacyDatabase() {
  const dataDir = tempDir("cardigan-idfmt-");
  const migrationsDir = tempDir("cardigan-idfmt-migrations-");
  for (const file of readdirSync(defaultMigrationsDir))
    if (/^00(0[1-9]|1[0-7])_/u.test(file))
      copyFileSync(join(defaultMigrationsDir, file), join(migrationsDir, file));
  const dbPath = join(dataDir, "cardigan.db");
  const old = Store.open({
    dbPath,
    migrationsDir,
    clock: { now: () => "2026-11-12T04:00:00.000Z" },
  });
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
      options: [{ key: "q(1)", description: "q(1)", impact: "x" }],
      resolution: { option: "q(1)", raw_quote: "h(16)", rationale: "q(95)" },
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
    "INSERT INTO timeline (project_id, id, card_id, event_seq, doc) VALUES ('p', 'C-1#2', 'C-1', 2, ?)",
    JSON.stringify({
      body: "q(95)",
      refs: [{ kind: "decision", id: "q(95)" }],
    }),
  );
  // Idempotency keys are arbitrary client strings: q(12) and Q-12 are distinct.
  for (const key of ["q(12)", "Q-12"])
    expect(
      old.runIdempotent(
        {
          project_id: "p",
          assignment_id: "A-1",
          key,
          request: { tool: "post_comment", params: { body: key } },
        } as never,
        () => ({ key }),
      ).ok,
    ).toBe(true);
  // A request the old server stored with the legacy id, response not yet seen.
  expect(
    old.runIdempotent(
      {
        project_id: "p",
        assignment_id: "A-1",
        key: "retry-same",
        request: legacyDecisionRequest,
      } as never,
      () => ({ id: "q(95)", key: "q(95)", status: "resolved" }),
    ).ok,
  ).toBe(true);
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
      // Option keys and the human's words keep their exact text.
      options: [{ key: "q(1)", description: "q(1)", impact: "x" }],
      resolution: { option: "q(1)", raw_quote: "h(16)", rationale: "q(95)" },
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
    // A body that is exactly an old number is still free text.
    expect(doc(db, "SELECT doc FROM timeline WHERE id = 'C-1#2'")).toEqual({
      body: "q(95)",
      refs: [{ kind: "decision", id: "Q-95" }],
    });
    expect(
      db
        .prepare("SELECT key FROM idempotency ORDER BY key")
        .all()
        .map((r) => r.key),
    ).toEqual(["Q-12", "q(12)", "retry-same"]);
    // The pre-upgrade request, retried after upgrade (now normalized), replays.
    let ran = 0;
    const retry = (key: string, request: unknown) =>
      store.runIdempotent(
        { project_id: "p", assignment_id: "A-1", key, request } as never,
        () => {
          ran += 1;
          return {};
        },
      );
    expect(retry("retry-same", currentDecisionRequest)).toEqual({
      ok: true,
      value: {
        value: { id: "Q-95", key: "Q-95", status: "resolved" },
        replayed: true,
      },
    });
    expect(retry("retry-same", legacyDecisionRequest)).toMatchObject({
      ok: true,
      value: { replayed: true },
    });
    // A different request under the same key still conflicts.
    expect(
      retry("retry-same", {
        ...currentDecisionRequest,
        params: { ...currentDecisionRequest.params, option: "stop" },
      }),
    ).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    expect(
      retry("q(12)", { tool: "post_comment", params: { body: "q(12)" } }),
    ).toMatchObject({
      ok: true,
      value: { replayed: true, value: { key: "q(12)" } },
    });
    expect(ran).toBe(0);
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

test("only reference columns and reference fields are rewritten", () => {
  expect(rewriteLegacyIds("q(3)", "id")).toBe("Q-3");
  expect(rewriteLegacyIds("h(3)", "human_action_id")).toBe("H-3");
  // Whole-value text in any other column is not a reference.
  expect(rewriteLegacyIds("q(3)", "key")).toBeUndefined();
  expect(rewriteLegacyIds("q(3)", "doc")).toBeUndefined();
  expect(rewriteLegacyIds("q(03)", "id")).toBeUndefined();
  expect(rewriteLegacyIds("Q-3", "id")).toBeUndefined();
  expect(rewriteLegacyIds("{not json q(3)")).toBeUndefined();
  expect(
    JSON.parse(
      rewriteLegacyIds(
        JSON.stringify({
          decision_id: "q(1)",
          blocked_ids: ["h(2)", "x q(2)"],
          open_decisions: ["q(3)"],
          superseded_by: "q(4)",
          basis: "q(5)",
          waiting_on: [
            { kind: "decision", ref: "q(6)", label: "等你拍板 q(6)" },
          ],
          nested: { refs: [{ kind: "human_action", id: "h(7)" }] },
          body: "q(8)",
          raw_quote: "h(9)",
          text: "q(10)",
          map: { "q(11)": "q(11)" },
          option: { key: "q(12)" },
        }),
      ) ?? "{}",
    ),
  ).toEqual({
    decision_id: "Q-1",
    blocked_ids: ["H-2", "x q(2)"],
    open_decisions: ["Q-3"],
    superseded_by: "Q-4",
    basis: "Q-5",
    waiting_on: [{ kind: "decision", ref: "Q-6", label: "等你拍板 q(6)" }],
    nested: { refs: [{ kind: "human_action", id: "H-7" }] },
    body: "q(8)",
    raw_quote: "h(9)",
    text: "q(10)",
    map: { "q(11)": "q(11)" },
    option: { key: "q(12)" },
  });
  expect(rewriteLegacyIds('{"a":"Q-1","b":[1,null,true]}')).toBeUndefined();
});

test("legacyRequest spells ids the way a pre-C-132 server stored them", () => {
  expect(
    legacyRequest({ a: "Q-95", b: ["H-1", "Q-01", "C-1"], c: { d: 1 } }),
  ).toEqual({ a: "q(95)", b: ["h(1)", "Q-01", "C-1"], c: { d: 1 } });
});
