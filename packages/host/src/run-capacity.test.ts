import type { Assignment, Run } from "@cardigan/domain";
import { beginLaunchAttempt, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assignment,
  now,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { runCapacitySnapshot } from "./run-capacity.js";

let store: Store;
beforeEach(() => {
  store = Store.open({ dbPath: ":memory:" });
  for (const id of ["first", "second"]) store.createProject({ id });
});
afterEach(() => store.close());

function standing(n: number, role = "pm"): Assignment {
  const { work_item_id: _item, ...base } = assignment(n, role);
  return { ...base, scope: "standing" };
}
function seed(owner: Assignment, execution: Run, project = "first") {
  store.uow.run((tx) => {
    tx.assignments.put(project, owner);
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "run_queued",
      actor: { kind: "system" as const, project_id: project },
      payload: {},
      created_at: new Date(
        Date.parse(now) + Number(owner.id.slice(2)) * 1000,
      ).toISOString(),
    };
    tx.events.append(project, event);
    tx.runs.put(project, { ...execution, trigger_event_id: event.id });
  });
}
const snapshot = () => store.uow.read((tx) => runCapacitySnapshot(store, tx));
const counts = (machine = "local") => {
  const s = snapshot();
  return [
    s.allAgentOccupied.get(machine),
    s.agentOccupied.get(machine),
    s.occupied.get(machine),
  ];
};

test("C-296 absolute and limited occupancy share physical machine buckets across projects, including legacy owners", () => {
  seed({ ...standing(1), standing_mode: "office" }, run(1));
  seed(
    { ...standing(2), standing_mode: "ops" },
    { ...run(2), status: "dispatched" },
  );
  seed(standing(3), { ...run(3), status: "acked" }); // legacy PM without mode
  seed(standing(4, "host_ops"), run(4));
  const forgedLabels = {
    ...run(5),
    scope: "standing",
    role_id: "host_ops",
    capacity_exempt: true,
  };
  seed(assignment(5, "pm"), forgedLabels);
  seed(assignment(6, "host_ops"), run(6));
  seed(standing(7, "unknown"), run(7));
  const { scope: _scope, ...legacy } = assignment(8, "pm");
  seed(legacy as Assignment, run(8)); // no scope means no exemption
  seed({ ...assignment(9), status: "released" }, run(9));
  seed(standing(1, "host_ops"), run(1), "second"); // project-local IDs collide
  seed(assignment(2), run(2), "second");
  seed({ ...assignment(3), machine_id: "other" }, run(3), "second");
  for (const [i, status] of (
    ["queued", "unknown", "completed"] as const
  ).entries())
    seed(assignment(10 + i), { ...run(10 + i), status });
  expect(counts()).toEqual([11, 6, 6]);
  expect(counts("other")).toEqual([1, 1, 1]);
  const release = acquireMergeCheckCapacity(store, "first", "check");
  try {
    expect(counts()).toEqual([11, 6, 8]);
  } finally {
    release();
  }
});

test.each(["coder", "pm", "host_ops"])(
  "C-296 %s startup and stop reservations count once, with the same exemption as live Runs",
  (role) => {
    const owner = role === "coder" ? assignment(1) : standing(1, role);
    const limited = role === "coder" ? 1 : 0;
    const execution = run(1);
    const ref = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "fixture",
      agent_name: "fixture",
    };
    seed(owner, { ...execution, status: "queued" });
    store.uow.run(() => {
      beginLaunchAttempt(store.database, {
        id: "launch",
        project_id: "first",
        assignment_id: owner.id,
        run_id: execution.id,
        started_at: now,
        lease_until: new Date(Date.parse(now) + 60_000).toISOString(),
      });
    });
    const variants: Run[] = [
      execution,
      { ...execution, status: "queued" },
      {
        ...execution,
        status: "completed",
        inactivity_stop: {
          attempt_id: "stop",
          runtime_ref: ref,
          stopping: true,
          lease_until: now,
        },
      },
      {
        ...execution,
        status: "unknown",
        dispatch_stop: {
          attempt_id: execution.trigger_event_id,
          runtime_ref: ref,
          stopping: true,
          lease_until: now,
          reason: "dispatch_timeout",
        },
      },
    ];
    for (const variant of variants) {
      store.uow.run((tx) => tx.runs.put("first", variant));
      expect(counts()).toEqual([1, limited, limited]);
      store.uow.read((tx) => {
        const fallback = runCapacitySnapshot(store, {
          ...tx,
          events: { listAfter: tx.events.listAfter },
        });
        const cached = runCapacitySnapshot(store, tx);
        expect(fallback.allAgentOccupied).toEqual(cached.allAgentOccupied);
        expect(fallback.agentOccupied).toEqual(cached.agentOccupied);
      });
    }
    store.uow.run((tx) =>
      tx.runs.put("first", { ...execution, status: "completed" }),
    );
    expect(counts()).toEqual([0, 0, 0]);
    const action = store.uow.run((tx) => {
      const id = tx.ids.nextEventId();
      tx.events.append("first", {
        id,
        seq: tx.ids.nextEventSequence("first"),
        type: "host_ops_action_taken",
        actor: { kind: "system", project_id: "first" },
        created_at: now,
        payload: { execution: true, assignment_id: owner.id, runtime_ref: ref },
      });
      return id;
    });
    expect(counts()).toEqual([1, limited, limited]);
    store.uow.run((tx) => tx.runs.put("first", execution));
    expect(counts()).toEqual([1, limited, limited]); // intent and Run overlap
    store.uow.run((tx) =>
      tx.runs.put("first", { ...execution, status: "completed" }),
    );
    store.uow.run((tx) =>
      tx.events.append("first", {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence("first"),
        type: "host_ops_action_finished",
        actor: { kind: "system", project_id: "first" },
        created_at: now,
        payload: { action_id: action },
      }),
    );
    expect(counts()).toEqual([0, 0, 0]);
  },
);

test("C-296 legacy capacity waits of exempt owners never affect ordinary queue positions", () => {
  for (const owner of [
    assignment(1),
    standing(2),
    standing(3, "host_ops"),
    assignment(4, "pm"),
    standing(5, "unknown"),
  ])
    seed(owner, {
      ...run(Number(owner.id.slice(2))),
      status: "queued",
      queue_reason: "concurrency_limit",
    });
  expect(snapshot().queue.map((r) => [r.assignment_id, r.ahead])).toEqual([
    ["A-1", 0],
    ["A-4", 1],
    ["A-5", 2],
  ]);
  expect(counts()).toEqual([0, 0, 0]);
});
