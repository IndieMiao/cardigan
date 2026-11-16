import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee, Run } from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { createGlobalRepositories } from "./employees.js";
import { defaultMigrationsDir, listMigrations } from "./migrate.js";
import { Store } from "./store.js";
import {
  assignment,
  card,
  project_id,
  timelineEntry,
  withTempStore,
} from "./test-support.js";

afterEach(() => vi.restoreAllMocks());

test("machine snapshots invalidate across connections, preserve unchanged rows and discard rollback", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    const read = () => store.uow.read((tx) => tx.machines.list(project_id));
    const before = read();
    const local = before[0];
    if (!local) throw new Error("missing local");
    expect(read()).toBe(before);
    const other = Store.open({ dataDir });
    try {
      other.uow.run((tx) =>
        tx.machines.put(project_id, {
          ...local,
          id: "worker-a",
          herdr_machine: "worker-a",
          label: "Worker A",
        }),
      );
      const added = read();
      expect(added).toHaveLength(2);
      expect(added.find((m) => m.id === "local")).toBe(local);
      const remote = added.find((m) => m.id === "worker-a");
      if (!remote) throw new Error("missing remote");
      expect(() =>
        store.uow.run((tx) => {
          tx.machines.put(project_id, { ...remote, status: "draining" });
          expect(
            tx.machines.list(project_id).find((m) => m.id === remote.id)
              ?.status,
          ).toBe("draining");
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(read()).toBe(added);
      other.uow.run((tx) =>
        tx.machines.put(project_id, { ...remote, status: "offline" }),
      );
      expect(read().find((m) => m.id === remote.id)?.status).toBe("offline");
      other.database
        .prepare("DELETE FROM machines WHERE id = ?")
        .run(remote.id);
      expect(read()).toEqual(before);
    } finally {
      other.close();
    }
  });
});

test("upgrading a populated v16 store backfills employee activity without rewriting entities", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-snapshot-upgrade-"));
  const migrationsDir = join(dataDir, "migrations");
  mkdirSync(migrationsDir);
  for (const m of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version < 17,
  ))
    writeFileSync(
      join(
        migrationsDir,
        `${String(m.version).padStart(4, "0")}_${m.name}.sql`,
      ),
      m.sql,
    );
  let store = Store.open({ dataDir, migrationsDir });
  try {
    store.uow.run((tx) => {
      tx.employees.put({
        id: "E-1",
        name: "Fixture",
        title: "Coder",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: null,
        status: "active",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      } as Employee);
      tx.assignments.put(
        project_id,
        assignment({ employee_id: "E-1" as never }),
      );
      tx.runs.put(project_id, {
        id: "R-1",
        assignment_id: "A-1",
        trigger_event_id: "event",
        status: "unknown",
      } as Run);
    });
    const raw = store.database
      .prepare("SELECT doc FROM assignments UNION ALL SELECT doc FROM runs")
      .all();
    const expected = store.uow.read((tx) => tx.employees.assignmentActivity());
    expect(store.uow.read((tx) => tx.cachedCommandState)).toBeUndefined();
    store.close();
    store = Store.open({ dataDir });
    expect(store.uow.read((tx) => tx.employees.assignmentActivity())).toEqual(
      expected,
    );
    expect(
      store.database
        .prepare("SELECT doc FROM assignments UNION ALL SELECT doc FROM runs")
        .all(),
    ).toEqual(raw);
    const activity = store.uow.read((tx) => tx.employees.assignmentActivity());
    store.migrate();
    expect(store.uow.read((tx) => tx.employees.assignmentActivity())).toEqual(
      activity,
    );
    store.uow.run((tx) => {
      const run = tx.runs.get(project_id, "R-1" as never);
      if (!run) throw new Error("missing run");
      tx.runs.put(project_id, { ...run, status: "completed" });
    });
    expect(
      store.uow.read((tx) => tx.employees.assignmentActivity())[0]
        ?.unfinished_runs,
    ).toBe(0);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("timeline decodes only changed rows and preserves SQL ordering, deletes, reinserts and rollback", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      for (let i = 1; i <= 100; i++)
        tx.timeline.put(project_id, timelineEntry({ event_seq: i }));
    });
    const read = () => store.uow.read((tx) => tx.timeline.list(project_id));
    const before = read();
    const parse = vi.spyOn(JSON, "parse");
    expect(read()).toBe(before);
    expect(parse).not.toHaveBeenCalled();
    const other = Store.open({ dataDir });
    try {
      other.uow.run((tx) =>
        tx.timeline.put(
          project_id,
          timelineEntry({ event_seq: 5, body: "updated" }),
        ),
      );
      parse.mockClear();
      const updated = read();
      expect(parse).toHaveBeenCalledTimes(1);
      expect(updated.find((e) => e.event_seq === 4)).toBe(
        before.find((e) => e.event_seq === 4),
      );
      expect(before.find((e) => e.event_seq === 5)?.body).toBe(
        "fictional comment",
      );
      other.database.prepare("DELETE FROM timeline WHERE id = ?").run("C-1#6");
      expect(read()).toHaveLength(99);
      other.uow.run((tx) =>
        tx.timeline.put(
          project_id,
          timelineEntry({ event_seq: 6, body: "reinserted" }),
        ),
      );
      const raw = other.database
        .prepare("SELECT doc FROM timeline WHERE project_id = ?")
        .all(project_id)
        .map((row) => JSON.parse(String(row.doc)));
      expect(read()).toEqual(raw);
      expect(() =>
        store.uow.run((tx) => {
          tx.timeline.put(
            project_id,
            timelineEntry({ event_seq: 5, body: "rolled back" }),
          );
          expect(
            tx.timeline.list(project_id).find((e) => e.event_seq === 5)?.body,
          ).toBe("rolled back");
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      // Reuse the same revision after rollback: pending snapshots must not survive.
      other.uow.run((tx) =>
        tx.timeline.put(
          project_id,
          timelineEntry({ event_seq: 5, body: "committed" }),
        ),
      );
      expect(read().find((e) => e.event_seq === 5)?.body).toBe("committed");
    } finally {
      other.close();
    }
  });
});

test("incremental employee contributions match the original query across projects and lifecycle changes", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => {
      tx.employees.put({
        id: "E-1" as never,
        name: "Fixture",
        title: "Coder",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: null,
        status: "active",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      });
      tx.employees.put({
        id: "E-2" as never,
        name: "Idle",
        title: "Coder",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: null,
        status: "active",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      });
      tx.assignments.put(
        project_id,
        assignment({ employee_id: "E-1" as never }),
      );
      tx.assignments.put(
        "other" as never,
        assignment({
          employee_id: "E-1" as never,
          scope: "standing",
          standing_mode: "office",
          external: true,
          created_at: "2026-02-01",
        }),
      );
    });
    const read = () =>
      store.uow.read((tx) => tx.employees.assignmentActivity());
    const check = () =>
      expect(read()).toEqual(
        createGlobalRepositories(
          store.database,
          "read",
        ).employees.assignmentActivity(),
      );
    check();
    const initial = read();
    expect(read()).toBe(initial);
    const run = {
      id: "R-1",
      assignment_id: "A-1",
      trigger_event_id: "event",
      status: "queued",
    } as Run;
    const other = Store.open({ dataDir });
    try {
      other.uow.run((tx) => tx.runs.put(project_id, run));
      check();
      expect(read()[0]?.unfinished_runs).toBe(1);
      other.uow.run((tx) =>
        tx.runs.put(project_id, { ...run, status: "unknown" }),
      );
      check();
      const active = read();
      other.uow.run((tx) =>
        tx.runs.put(project_id, { ...run, heartbeat_at: "2026-02-01" }),
      );
      expect(read()).toBe(active);
      expect(() =>
        store.uow.run((tx) => {
          tx.runs.put(project_id, { ...run, status: "completed" });
          expect(tx.employees.assignmentActivity()[0]?.unfinished_runs).toBe(0);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      check();
      other.uow.run((tx) =>
        tx.runs.put(project_id, { ...run, status: "cancelled" }),
      );
      check();
      other.uow.run((tx) =>
        tx.assignments.put(
          "other" as never,
          assignment({
            employee_id: "E-1" as never,
            scope: "standing",
            standing_mode: "office",
            external: true,
            status: "released",
          }),
        ),
      );
      check();
      expect(read()[0]?.has_external_standing_assignment).toBe(false);
      other.database.exec("DELETE FROM runs; DELETE FROM assignments");
      check();
      expect(read()[0]?.last_assigned_at).toBeNull();
    } finally {
      other.close();
    }
  });
});

test("C-300 global active assignment loads invalidate cached command state on status changes and rollback", () => {
  withTempStore((store) => {
    store.createProject({ id: "other-load" });
    store.uow.run((tx) => {
      tx.employees.put({
        id: "E-1",
        name: "Reviewer",
        title: "Reviewer",
        bio: "",
        avatar: null,
        role_id: "reviewer",
        launch_profile_ref: null,
        status: "active",
        created_at: "2031-01-01",
        updated_at: "2031-01-01",
      } as Employee);
      for (const project of [project_id, "other-load"])
        tx.assignments.put(
          project,
          assignment({ employee_id: "E-1" as never }),
        );
    });
    const read = () =>
      store.uow.read((tx) =>
        tx.cachedCommandState?.(project_id, () => ({
          project_id,
          employee_activity: tx.employees.assignmentActivity(),
          roles: [],
          cards: [],
          work_items: [],
          assignments: [],
          runs: [],
          deliveries: [],
          reviews: [],
          decisions: [],
          human_actions: [],
          attachments: [],
          cursors: [],
          events: [],
          timeline: [],
        })),
      );
    expect(read()?.employee_activity?.[0]?.active_assignments).toBe(2);
    expect(() =>
      store.uow.run((tx) => {
        tx.assignments.put(
          "other-load",
          assignment({ employee_id: "E-1" as never, status: "released" }),
        );
        expect(tx.employees.assignmentActivity()?.[0]?.active_assignments).toBe(
          1,
        );
        throw new Error("rollback load");
      }),
    ).toThrow("rollback load");
    expect(read()?.employee_activity?.[0]?.active_assignments).toBe(2);
    for (const status of ["suspended", "active", "released"] as const) {
      store.uow.run((tx) =>
        tx.assignments.put(
          "other-load",
          assignment({ employee_id: "E-1" as never, status }),
        ),
      );
      expect(read()?.employee_activity?.[0]?.active_assignments).toBe(
        status === "active" ? 2 : 1,
      );
      expect(store.uow.read((tx) => tx.employees.assignmentActivity())).toEqual(
        createGlobalRepositories(
          store.database,
          "read",
        ).employees.assignmentActivity?.(),
      );
    }
  });
});

test("C-383 host owner and cancellation audit survive cross-connection refresh and reopen", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    const action = store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      const id = tx.ids.next(project_id, "human_action");
      const action = {
        id,
        key: id,
        card_id: card().id,
        requested_by: "human" as const,
        instructions: "Evidence",
        why_human: "Host access",
        expected_return: "Result",
        blocked_work_items: [],
        status: "open" as const,
        triage: "host" as const,
        host_operator: "external" as const,
        host_assignment_id: assignment().id,
      };
      tx.human_actions.put(project_id, action);
      return action;
    });
    const other = Store.open({ dataDir });
    const closed = {
      ...action,
      status: "cancelled" as const,
      cancellation: {
        reason: "Card cancelled",
        source: "card_cancelled" as const,
        by: "system" as const,
        at: "2030-01-01T00:00:00Z",
      },
    };
    try {
      expect(
        other.uow.read((tx) => tx.human_actions.get(project_id, action.id)),
      ).toEqual(action);
      store.uow.run((tx) => tx.human_actions.put(project_id, closed));
      expect(
        other.uow.read((tx) => tx.human_actions.get(project_id, action.id)),
      ).toEqual(closed);
    } finally {
      other.close();
    }
    const reopened = Store.open({ dataDir });
    try {
      expect(
        reopened.uow.read((tx) => tx.human_actions.get(project_id, action.id)),
      ).toEqual(closed);
    } finally {
      reopened.close();
    }
  });
});
