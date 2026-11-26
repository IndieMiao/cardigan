import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { LATEST_BUDGET_SQL } from "./github-budget-journal.js";
import { HOST_WIDE_EVENTS_SQL, hostWideEventDocs } from "./host-wide-events.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function open(): Store {
  const root = mkdtempSync(join(tmpdir(), "cg-host-wide-events-"));
  roots.push(root);
  return Store.open({ dbPath: join(root, "state.sqlite") });
}
function plan(store: Store, sql: string, ...args: string[]): string {
  return store.database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String(row.detail))
    .join("\n");
}
function event(
  store: Store,
  project: string,
  stream: string,
  seq: number,
  type: string,
  doc: object,
) {
  store.database
    .prepare(
      "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, ?, NULL, ?, ?, ?, ?)",
    )
    .run(
      project,
      `${project}-${stream}-${seq}`,
      stream,
      seq,
      type,
      JSON.stringify(doc),
    );
}

test("C-793: host-wide job reads and the budget lookup use indexes without planner statistics", () => {
  const store = open();
  try {
    expect(
      store.database
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'",
        )
        .get()?.n,
    ).toBe(0);
    const jobs = plan(store, HOST_WIDE_EVENTS_SQL, "probe_job");
    expect(jobs).not.toMatch(/^SCAN events\b/mu);
    expect(jobs).toMatch(
      /SEARCH events USING INDEX \w+ \(project_id=\? AND type=\?\)/u,
    );
    const budget = plan(store, LATEST_BUDGET_SQL, "github");
    expect(budget).toMatch(
      /SEARCH global_events USING INDEX global_events_by_type \(type=\?\)/u,
    );
    expect(budget).not.toMatch(/TEMP B-TREE/u);
  } finally {
    store.close();
  }
});

test("C-793: host-wide job reads keep every project, including unregistered ones, in seq order", () => {
  const store = open();
  try {
    store.createProject({ id: "beta" });
    event(store, "beta", "card:C-1", 2, "probe_job", {
      actor: { kind: "system" },
      payload: { id: "b2" },
    });
    event(store, "alpha", "card:C-1", 3, "probe_job", {
      actor: { kind: "system" },
      payload: { id: "a3" },
    });
    event(store, "alpha", "card:C-1", 1, "probe_job", {
      actor: { kind: "system" },
      payload: { id: "a1" },
    });
    event(store, "gamma", "card:C-9", 4, "comment_posted", {
      actor: { kind: "system" },
      payload: { id: "x" },
    });
    event(store, "gamma", "card:C-9", 5, "probe_job", {
      actor: { kind: "system" },
      payload: { id: "g5" },
    });
    expect(
      hostWideEventDocs<{ id: string }>(store.database, "probe_job").map(
        (doc) => doc.payload.id,
      ),
    ).toEqual(["a1", "b2", "a3", "g5"]);
    expect(hostWideEventDocs(store.database, "macos_check_job")).toEqual([]);
  } finally {
    store.close();
  }
});

test("C-793: plans stay on the indexes after PRAGMA optimize gathers statistics", () => {
  const store = open();
  try {
    store.database.exec("BEGIN");
    for (let i = 0; i < 3000; i += 1) {
      event(
        store,
        `p${i % 5}`,
        `card:C-${i % 40}`,
        i + 1,
        i % 50 ? "comment_posted" : "probe_job",
        {
          actor: { kind: "system" },
          payload: { id: String(i) },
        },
      );
      store.database
        .prepare(
          "INSERT INTO global_events (id, seq, type, doc) VALUES (?, ?, ?, ?)",
        )
        .run(
          `g${i}`,
          100_000 + i,
          i % 20 ? "member_added" : "github_rest_budget",
          JSON.stringify({ payload: { executor: "github" } }),
        );
    }
    store.database.exec("COMMIT");
    store.database.exec("PRAGMA optimize=0x10002");
    expect(
      store.database.prepare("SELECT count(*) AS n FROM sqlite_stat1").get()?.n,
    ).toBeGreaterThan(0);
    expect(plan(store, HOST_WIDE_EVENTS_SQL, "probe_job")).toMatch(
      /SEARCH events USING (COVERING )?INDEX \w+ \(project_id=\? AND type=\?/u,
    );
    expect(plan(store, LATEST_BUDGET_SQL, "github")).toMatch(
      /SEARCH global_events USING INDEX global_events_by_type \(type=\?\)/u,
    );
    expect(hostWideEventDocs(store.database, "probe_job")).toHaveLength(60);
  } finally {
    store.close();
  }
});
