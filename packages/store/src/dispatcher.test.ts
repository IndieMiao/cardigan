import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CardId, Run } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  advanceRouterCursor,
  beginBellAttempt,
  beginDispatchRetry,
  defaultMigrationsDir,
  finishBellAttempt,
  listBellAttempts,
  listMigrations,
  migrate,
  moveNotification,
  recordNotification,
  Store,
  unfinishedBellAttempts,
} from "./index.js";
import {
  assignment,
  card,
  event,
  project_id,
  withTempStore,
  workItem,
} from "./test-support.js";

const at = "2026-01-01T00:00:00.000Z",
  lease = "2026-01-01T00:01:00.000Z";
function append(store: Store, card_id?: CardId, project = project_id) {
  return store.uow.run((tx) => {
    if (card_id)
      tx.cards.put(project, card({ id: card_id, project_id: project }));
    const fact = event({
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card_id),
      card_id,
    });
    tx.events.append(project, fact);
    return fact;
  });
}
function seed(store: Store) {
  const fact = append(store, card().id);
  const run: Run = {
    id: "R-1" as never,
    assignment_id: assignment().id,
    trigger_event_id: fact.id,
    kind: "followup",
    status: "queued",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "fixture",
    outcome: null,
    summary: "",
  };
  store.uow.run((tx) => {
    tx.work_items.put(project_id, workItem());
    tx.assignments.put(project_id, assignment());
    tx.runs.put(project_id, run);
  });
  const input = {
    project_id,
    event_id: fact.id,
    recipient: { kind: "assignment" as const, assignment_id: assignment().id },
    card_id: card().id,
    seq: fact.seq,
    kind: "comment",
    at,
  };
  return { run, input };
}
const claim = (id: string) => ({
  project_id,
  id: "attempt-1",
  assignment_id: assignment().id,
  run_id: "R-1" as Run["id"],
  notification_ids: [id],
  started_at: at,
  lease_until: lease,
});

test("C-339: scoped histories preserve timestamp ties, project/Run isolation and fresh leases", () => {
  withTempStore((store, dataDir) => {
    const { run } = seed(store);
    const otherRun = {
      ...run,
      id: "R-2" as Run["id"],
      trigger_event_id: append(store, card().id).id,
    };
    store.uow.run((tx) => {
      tx.runs.put(project_id, { ...run, status: "dispatched" });
      tx.runs.put(project_id, { ...otherRun, status: "dispatched" });
      for (const [id, target] of [
        ["z-first", run],
        ["other-run", otherRun],
        ["a-last", run],
      ] as const) {
        beginDispatchRetry(store.database, {
          ...claim("unused"),
          id,
          run_id: target.id,
          notification_ids: [],
        });
        finishBellAttempt(store.database, project_id, id, "failed", at);
      }
    });
    // Upgrade an existing history from the preceding schema, rather than
    // exercising only an empty database that already has the new index.
    store.database.exec(
      "DROP INDEX bell_attempt_run_history; DELETE FROM schema_version WHERE version = 31",
    );
    const other = Store.open({ dataDir });
    try {
      expect(
        listBellAttempts(other.database, project_id, run.id).map((a) => a.id),
      ).toEqual(["z-first", "a-last"]);
      expect(
        listBellAttempts(other.database, "missing" as never, run.id),
      ).toEqual([]);
      expect(
        listBellAttempts(other.database, project_id, otherRun.id).map(
          (a) => a.id,
        ),
      ).toEqual(["other-run"]);
      const plan = other.database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM bell_attempts WHERE project_id = ? AND run_id = ? ORDER BY started_at, rowid",
        )
        .all(project_id, run.id);
      expect(JSON.stringify(plan)).toContain("bell_attempt_run_history");
      expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
      store.uow.run(() =>
        beginDispatchRetry(store.database, {
          ...claim("unused"),
          id: "active",
          run_id: otherRun.id,
          notification_ids: [],
        }),
      );
      expect(
        unfinishedBellAttempts(
          other.database,
          project_id,
          run.assignment_id,
        ).map((a) => a.id),
      ).toEqual(["active"]);
      expect(
        unfinishedBellAttempts(
          other.database,
          project_id,
          "A-missing" as never,
        ),
      ).toEqual([]);
      expect(() =>
        store.uow.run(() => {
          finishBellAttempt(store.database, project_id, "active", "sent", at);
          expect(
            unfinishedBellAttempts(
              store.database,
              project_id,
              run.assignment_id,
            ),
          ).toEqual([]);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(
        unfinishedBellAttempts(other.database, project_id, run.assignment_id),
      ).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

test("events, stream cursor, inbox, Run changes and delivery intent all roll back together", () => {
  withTempStore((store) => {
    const { run, input } = seed(store),
      before = store.getUpdates({ project_id, card_id: card().id }).events;
    expect(() =>
      store.uow.run((tx) => {
        const fact = event({
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project_id, card().id),
        });
        tx.events.append(project_id, fact);
        const n = recordNotification(store.database, {
          ...input,
          event_id: fact.id,
          seq: fact.seq,
        }).notification;
        beginBellAttempt(store.database, claim(n.id));
        tx.runs.put(project_id, { ...run, summary: "changed" });
        advanceRouterCursor(store.database, project_id, card().id, fact.seq);
        throw new Error("crash before commit");
      }),
    ).toThrow(/crash/);
    expect(store.getUpdates({ project_id, card_id: card().id }).events).toEqual(
      before,
    );
    expect(store.listNotifications({ project_id })).toEqual([]);
    expect(unfinishedBellAttempts(store.database, project_id)).toEqual([]);
    expect(store.routerCursor(project_id, card().id)).toBe(0);
    expect(store.uow.read((tx) => tx.runs.get(project_id, run.id))).toEqual(
      run,
    );
  });
});
test("upgrading leaves a pre-continuation intent bound to its original Run", () => {
  withTempStore((_current, dir) => {
    for (const m of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 42,
    ))
      writeFileSync(
        join(dir, `${String(m.version).padStart(4, "0")}_${m.name}.sql`),
        m.sql,
      );
    const old = Store.open({
      dbPath: join(dir, "legacy.db"),
      migrationsDir: dir,
    });
    try {
      const { run, input } = seed(old);
      const note = old.recordNotification(input).notification;
      old.database
        .prepare(
          `INSERT INTO bell_attempts (project_id, id, assignment_id, run_id, notification_ids, started_at, lease_until) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project_id,
          "legacy",
          run.assignment_id,
          run.id,
          JSON.stringify([note.id]),
          at,
          lease,
        );
      // The Run advancing after claim is not evidence that the intent was a continuation.
      old.uow.run((tx) =>
        tx.runs.put(project_id, { ...run, status: "running" }),
      );
      migrate(old.database);
      expect(unfinishedBellAttempts(old.database, project_id)).toEqual([
        { ...claim(note.id), id: "legacy", finished_at: null, outcome: null },
      ]);
      expect(migrate(old.database)).toEqual([]);
    } finally {
      old.close();
    }
  });
});
test("delivery intent survives reopening and excludes a competing sender for the Assignment", () => {
  withTempStore((store, dataDir) => {
    const { input } = seed(store),
      n = store.recordNotification(input).notification;
    const intent = claim(n.id);
    store.uow.run(() => beginBellAttempt(store.database, intent));
    const other = Store.open({ dataDir });
    try {
      expect(unfinishedBellAttempts(other.database, project_id)).toEqual([
        { ...intent, finished_at: null, outcome: null },
      ]);
      const second = other.recordNotification({
        ...input,
        recipient: { kind: "pm_ops" },
      }).notification;
      expect(() =>
        other.uow.run(() =>
          beginBellAttempt(other.database, {
            ...intent,
            id: "attempt-2",
            notification_ids: [second.id],
          }),
        ),
      ).toThrow(/UNIQUE/);
      expect(
        other.uow.run(() =>
          finishBellAttempt(
            other.database,
            project_id,
            intent.id,
            "failed",
            lease,
          ),
        ),
      ).toBe(true);
      expect(
        store.uow.run(() =>
          finishBellAttempt(
            store.database,
            project_id,
            intent.id,
            "sent",
            lease,
          ),
        ),
      ).toBe(false);
      expect(
        store.database
          .prepare("SELECT outcome FROM bell_attempts WHERE id = ?")
          .get(intent.id)?.outcome,
      ).toBe("failed");
      expect(unfinishedBellAttempts(store.database, project_id)).toEqual([]);
      store.uow.run(() =>
        beginBellAttempt(store.database, {
          ...intent,
          id: "attempt-2",
          started_at: lease,
          lease_until: "2026-01-01T00:02:00.000Z",
        }),
      );
      expect(unfinishedBellAttempts(other.database, project_id)).toHaveLength(
        1,
      );
    } finally {
      other.close();
    }
  });
});
test("invalid claims are rejected before any receipt is persisted", () => {
  withTempStore((store) => {
    const { input } = seed(store),
      n = store.recordNotification(input).notification;
    expect(() => beginBellAttempt(store.database, claim(n.id))).toThrow(
      /transaction/,
    );
    for (const invalid of [
      { lease_until: at },
      { notification_ids: [] },
      { notification_ids: [n.id, n.id] },
      { run_id: "R-99" as Run["id"] },
      { notification_ids: ["missing"] },
    ])
      expect(() =>
        store.uow.run(() =>
          beginBellAttempt(store.database, { ...claim(n.id), ...invalid }),
        ),
      ).toThrow();
    store.moveNotification({ project_id, id: n.id, event: "ack" });
    expect(() =>
      store.uow.run(() => beginBellAttempt(store.database, claim(n.id))),
    ).toThrow(/deliverable/);
    expect(unfinishedBellAttempts(store.database, project_id)).toEqual([]);
  });
});

test("a successful retry preserves the original failed delivery history across reopen", () => {
  withTempStore((store, dataDir) => {
    const { input, run } = seed(store);
    store.uow.run((tx) =>
      tx.runs.put(project_id, { ...run, status: "dispatched" }),
    );
    const n = store.recordNotification(input).notification;
    const first = claim(n.id);
    store.uow.run(() => {
      beginBellAttempt(store.database, first);
      finishBellAttempt(store.database, project_id, first.id, "failed", at);
      moveNotification(store.database, {
        project_id,
        id: n.id,
        event: "deliver_failed",
        at,
        patch: { run_id: run.id, attempts: 1 },
      });
    });
    const failed = listBellAttempts(store.database, project_id)[0];
    expect(failed).toMatchObject({
      id: first.id,
      outcome: "failed",
      finished_at: at,
    });
    expect(store.listNotifications({ project_id })[0]).toMatchObject({
      status: "delivery_failed",
      attempts: 1,
    });
    const second = {
      ...first,
      id: "attempt-2",
      started_at: lease,
      lease_until: "2026-01-01T00:02:00.000Z",
    };
    store.uow.run(() => {
      beginDispatchRetry(store.database, second);
      finishBellAttempt(store.database, project_id, second.id, "sent", lease);
      moveNotification(store.database, {
        project_id,
        id: n.id,
        event: "bell",
        at: lease,
        patch: { attempts: 2 },
      });
      expect(
        finishBellAttempt(store.database, project_id, first.id, "sent", lease),
      ).toBe(false);
    });
    const reopened = Store.open({ dataDir });
    try {
      expect(listBellAttempts(reopened.database, project_id)).toEqual([
        failed,
        { ...second, finished_at: lease, outcome: "sent" },
      ]);
      expect(reopened.listNotifications({ project_id })).toMatchObject([
        {
          id: n.id,
          event_id: n.event_id,
          recipient: n.recipient,
          run_id: run.id,
          status: "belled",
          attempts: 2,
        },
      ]);
      expect(unfinishedBellAttempts(reopened.database, project_id)).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

test("a logical PM notification cannot be claimed by another Assignment while delivery is in flight", () => {
  withTempStore((store) => {
    const fact = append(store);
    store.uow.run((tx) => {
      for (const suffix of [1, 2]) {
        const assignment_id = `A-${suffix}` as Run["assignment_id"];
        tx.assignments.put(project_id, {
          id: assignment_id,
          scope: "standing",
          role_id: "pm",
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: `fixture-${suffix}`,
          created_at: at,
        });
        tx.runs.put(project_id, {
          id: `R-${suffix}` as Run["id"],
          assignment_id,
          trigger_event_id: fact.id,
          kind: "followup",
          status: "queued",
          role_version: 1,
          model: "fixture",
          agent_cli_version: "fixture",
          outcome: null,
          summary: "",
        });
      }
    });
    const note = store.recordNotification({
      project_id,
      event_id: fact.id,
      seq: fact.seq,
      recipient: { kind: "pm_ops" },
      kind: "escalation",
      at,
    }).notification;
    store.uow.run(() => beginBellAttempt(store.database, claim(note.id)));
    expect(() =>
      store.uow.run(() =>
        beginBellAttempt(store.database, {
          ...claim(note.id),
          id: "attempt-other-owner",
          assignment_id: "A-2" as Run["assignment_id"],
          run_id: "R-2" as Run["id"],
        }),
      ),
    ).toThrow(/already in flight/);
  });
});
