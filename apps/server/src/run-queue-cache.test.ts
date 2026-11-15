import type {
  Assignment,
  Event,
  ProjectId,
  QueuedRun,
  Run,
} from "@cardigan/domain";
import {
  dispatchTier,
  isRunCapacityExempt,
  queueRun,
  runQueuePositions,
} from "@cardigan/domain";
import { readRunQueue, runCapacitySnapshot } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  beginLaunchAttempt,
  finishBellAttempt,
  type ReadRepositories,
  type Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";

/**
 * C-230: the capacity queue is built from cached snapshot lists and reused
 * while they are unchanged. The pre-C-230 SQL is kept verbatim as the oracle;
 * every read below must match it, including the transaction's own writes,
 * appended events, and the state after a rollback.
 */
function legacyQueue(store: Store, tx: ReadRepositories) {
  const rows = store.database
    .prepare(`SELECT r.project_id, r.doc AS run, a.doc AS owner,
      e.doc AS cause, w.card_id, json_extract(c.doc, '$.priority') AS priority FROM runs r
    JOIN assignments a ON a.project_id = r.project_id AND a.id = r.assignment_id
    JOIN events e ON e.project_id = r.project_id AND e.id = r.trigger_event_id
    LEFT JOIN work_items w ON w.project_id = a.project_id AND w.id = json_extract(a.doc, '$.work_item_id')
    LEFT JOIN cards c ON c.project_id = w.project_id AND c.id = w.card_id
    WHERE json_extract(r.doc, '$.status') = 'queued' AND json_extract(r.doc, '$.queue_reason') = 'concurrency_limit'
      AND json_extract(a.doc, '$.status') = 'active' AND NOT EXISTS (
        SELECT 1 FROM bell_attempts b WHERE b.project_id = r.project_id AND b.run_id = r.id AND b.finished_at IS NULL
      )`)
    .all();
  const queue: QueuedRun[] = [];
  const states = new Map(
    store.listProjects().map((p) => [p.id, loadCommandState(tx, p.id)]),
  );
  for (const row of rows) {
    const owner = JSON.parse(String(row.owner)) as Assignment;
    if (isRunCapacityExempt(owner)) continue;
    const run = JSON.parse(String(row.run)) as Run;
    const cause = JSON.parse(String(row.cause)) as Event;
    const card = row.card_id ?? cause.card_id;
    const state = states.get(String(row.project_id));
    if (!state) throw new Error("Missing queue project");
    queue.push({
      ...dispatchTier(state, owner, run, cause),
      priority: Number(row.priority ?? 0),
      project_id: String(row.project_id),
      assignment_id: owner.id,
      machine_id: owner.machine_id,
      run_id: run.id,
      trigger_event_id: cause.id,
      created_at: cause.created_at,
      ...(card ? { card_id: String(card) } : {}),
    });
  }
  return runQueuePositions(queue);
}

let f: ReturnType<typeof dispatchFixture>;
let owners: ReturnType<typeof f.create>[];
let runs: Run[];
beforeEach(() => {
  f = dispatchFixture();
  owners = [];
  runs = [];
  for (let i = 0; i < 5; i++) {
    const created = f.create();
    owners.push(created);
    f.advance(1000);
    runs.push(waiting(created.assignment));
  }
});
afterEach(() => f.close());

/** Queue a Run for `a` and mark it as waiting for capacity. */
function waiting(a: Assignment, project: ProjectId = f.project): Run {
  return f.store.uow.run((tx) => {
    const effect = unwrap(
      queueRun(
        loadCommandState(tx, project),
        { kind: "human", project_id: project },
        { assignment_id: a.id, model: "m", agent_cli_version: "1" },
        { clock: f.clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    const run = { ...effect.data, queue_reason: "concurrency_limit" as const };
    tx.runs.put(project, run);
    return run;
  });
}

function expectOracle(label: string) {
  const expected = f.store.uow.read((tx) => legacyQueue(f.store, tx));
  expect(readRunQueue(f.store), label).toEqual(expected);
  // Twice: the second read is served from the cache.
  expect(readRunQueue(f.store), `${label} (cached)`).toEqual(expected);
  expect(
    f.store.uow.read((tx) => runCapacitySnapshot(f.store, tx).queue),
    `${label} (capacity)`,
  ).toEqual(expected);
  return expected;
}

const setPriority = (index: number, priority: number) =>
  f.store.uow.run((tx) => {
    const card = tx.cards.get(f.project, owners[index]?.card.id as never);
    if (!card) throw new Error("Missing card");
    tx.cards.put(f.project, { ...card, priority });
  });

test("C-230: cached queue matches the former SQL across priority, owner and run changes", () => {
  const initial = expectOracle("initial");
  expect(initial.map((r) => r.run_id)).toEqual(runs.map((r) => r.id));
  expect(initial.map((r) => r.ahead)).toEqual([0, 1, 2, 3, 4]);

  setPriority(3, 3);
  setPriority(1, -1);
  expect(expectOracle("priority").map((r) => r.run_id)).toEqual(
    [3, 0, 2, 4, 1].map((i) => runs[i]?.id),
  );

  // An unfinished launch attempt hides its Run; finishing it shows it again.
  const attempt = {
    id: "attempt-1",
    project_id: f.project,
    assignment_id: owners[0]?.assignment.id as never,
    run_id: runs[0]?.id as never,
    started_at: f.clock.now(),
    lease_until: new Date(Date.parse(f.clock.now()) + 60_000).toISOString(),
  };
  f.store.uow.run(() => beginLaunchAttempt(f.store.database, attempt));
  expect(expectOracle("reserved").map((r) => r.run_id)).not.toContain(
    runs[0]?.id,
  );
  f.store.uow.run(() =>
    finishBellAttempt(
      f.store.database,
      f.project,
      attempt.id,
      "failed",
      f.clock.now(),
    ),
  );
  expect(expectOracle("released attempt").map((r) => r.run_id)).toContain(
    runs[0]?.id,
  );

  // A released owner drops out; a cleared queue_reason drops out.
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...(owners[2]?.assignment as Assignment),
      status: "released",
    }),
  );
  f.store.uow.run((tx) => {
    const { queue_reason: _reason, ...rest } = runs[4] as Run;
    tx.runs.put(f.project, rest);
  });
  expect(expectOracle("released and cleared").map((r) => r.run_id)).toEqual(
    [3, 0, 1].map((i) => runs[i]?.id),
  );

  // A standing PM never queues for capacity, even with a queued Run row.
  f.store.uow.run((tx) => {
    const a = owners[1]?.assignment as Assignment;
    const { work_item_id: _item, ...base } = a as Assignment & {
      work_item_id: string;
    };
    tx.assignments.put(f.project, {
      ...base,
      scope: "standing",
      role_id: "pm",
      standing_mode: "ops",
    } as Assignment);
  });
  expect(expectOracle("standing pm").map((r) => r.run_id)).toEqual(
    [3, 0].map((i) => runs[i]?.id),
  );
});

test("C-230: reads inside a write transaction see its own writes and events; rollback restores", () => {
  const before = expectOracle("before");
  const extra = f.create();
  const committedBefore = expectOracle("after create");
  expect(committedBefore).toEqual(before);

  expect(() =>
    f.store.uow.run((tx) => {
      // Warm the cache with the committed snapshot inside the transaction.
      expect(runCapacitySnapshot(f.store, tx).queue).toEqual(before);
      // Write-then-read: a new Run with a newly appended trigger event.
      const effect = unwrap(
        queueRun(
          loadCommandState(tx, f.project),
          { kind: "human", project_id: f.project },
          {
            assignment_id: extra.assignment.id,
            model: "m",
            agent_cli_version: "1",
          },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project, effect);
      tx.runs.put(f.project, {
        ...effect.data,
        queue_reason: "concurrency_limit",
      });
      const card = tx.cards.get(f.project, extra.card.id);
      if (!card) throw new Error("Missing card");
      tx.cards.put(f.project, { ...card, priority: 5 });
      const inside = runCapacitySnapshot(f.store, tx).queue;
      expect(inside).toEqual(legacyQueue(f.store, tx));
      expect(inside[0]?.run_id).toBe(effect.data.id);
      expect(readRunQueue(f.store, tx)).toEqual(inside);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");

  // The rolled-back Run, event and priority are gone again.
  expect(expectOracle("after rollback")).toEqual(before);

  // Committing the same kind of write is visible afterwards.
  const run = waiting(extra.assignment);
  const after = expectOracle("after commit");
  expect(after.map((r) => r.run_id)).toContain(run.id);
});

test("C-230: every project is included and ordered across projects", () => {
  const other = "second-project" as ProjectId;
  f.store.createProject({ id: other, name: "Second" });
  f.store.uow.run((tx) => {
    for (const role of tx.roles.list(f.project)) tx.roles.put(other, role);
  });
  // Copy one owner into the other project with its own card and run.
  const source = owners[0] as (typeof owners)[number];
  f.store.uow.run((tx) => {
    tx.cards.put(other, { ...source.card, project_id: other, priority: 2 });
    const item = tx.work_items.get(f.project, source.item.id);
    if (!item) throw new Error("Missing item");
    tx.work_items.put(other, { ...item, project_id: other });
    tx.assignments.put(other, { ...source.assignment, project_id: other });
  });
  f.advance(1000);
  const run = waiting(source.assignment, other);
  const queue = expectOracle("two projects");
  expect(queue[0]).toMatchObject({ project_id: other, run_id: run.id });
  expect(queue.map((r) => r.ahead)).toEqual([0, 1, 2, 3, 4, 5]);
});
