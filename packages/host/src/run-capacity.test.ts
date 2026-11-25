import type { Assignment, Run } from "@cardigan/domain";
import { beginLaunchAttempt, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assignment,
  card,
  fixture,
  now,
  role as roleFixture,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { hasEarlierCapacityWait, runCapacitySnapshot } from "./run-capacity.js";

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
    const card =
      owner.work_item_id &&
      tx.work_items.get(project, owner.work_item_id)?.card_id;
    const event = {
      ...(card ? { card_id: card } : {}),
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "run_queued",
      actor: { kind: "system" as const, project_id: project },
      payload: { run_id: execution.id, assignment_id: owner.id },
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
  "C-296 %s startup and stop reservations of unfinished Runs count once, with the same exemption as live Runs; C-620 an ended turn's idle session counts none",
  (role) => {
    const owner = role === "coder" ? assignment(1) : standing(1, role);
    const limited = role === "coder" ? 1 : 0;
    store.uow.run((tx) => {
      const item = fixture().work_items[0];
      if (!item) throw new Error("Missing fixture");
      tx.cards.put("first", { ...card(), project_id: "first" });
      tx.work_items.put("first", {
        ...item,
        requirements: {
          capabilities: ["godot>=3", "blender"],
          tags: ["unrelated"],
        },
      });
      tx.roles.put("first", {
        ...roleFixture(role),
        required_capabilities: ["godot=4", "ios.simulator"],
      });
    });
    const slots = () =>
      store.uow.read((tx) =>
        [
          ...runCapacitySnapshot(
            store,
            tx,
            () =>
              new Map([
                ["godot", 1],
                ["ios.simulator", 1],
                ["unrelated", 1],
              ]),
          )
            .resourcesForMachine("local")
            .values(),
        ].map((slot) => slot.occupied),
      );
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
      { ...execution, status: "dispatched" },
      { ...execution, status: "acked" },
      { ...execution, status: "queued" },
      {
        ...execution,
        inactivity_stop: {
          attempt_id: "stop",
          runtime_ref: ref,
          stopping: true,
          lease_until: now,
        },
      },
      {
        // Cancelled from outside under a pending stop: may still execute.
        ...execution,
        status: "cancelled",
        dispatch_stop: {
          attempt_id: execution.trigger_event_id,
          runtime_ref: ref,
          stopping: true,
          lease_until: now,
          reason: "dispatch_timeout",
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
      expect(slots()).toEqual([limited, limited, 0]);
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
    // C-620: the turn ended with a business result. Its session may still be
    // stopping or awaiting recycle, but it holds no admission or resource slot.
    for (const variant of [
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
        status: "failed",
        launch_publication: {
          generation: "g",
          phase: "stopping",
        } as unknown as Run["launch_publication"],
      },
    ] as Run[]) {
      store.uow.run((tx) => tx.runs.put("first", variant));
      expect(counts()).toEqual([0, 0, 0]);
      expect(slots()).toEqual([0, 0, 0]);
    }
    store.uow.run((tx) =>
      tx.runs.put("first", { ...execution, status: "completed" }),
    );
    expect(counts()).toEqual([0, 0, 0]);
    const action = store.uow.run((tx) => {
      tx.runs.put("first", { ...execution, started_at: now });
      const id = tx.ids.nextEventId();
      tx.events.append("first", {
        id,
        seq: tx.ids.nextEventSequence("first"),
        type: "host_ops_action_taken",
        actor: { kind: "system", project_id: "first" },
        created_at: now,
        payload: {
          execution: true,
          assignment_id: owner.id,
          run_id: execution.id,
          runtime_ref: ref,
        },
      });
      return id;
    });
    expect(counts()).toEqual([1, limited, limited]); // intent and Run overlap
    expect(slots()).toEqual([limited, limited, 0]);
    // C-620: once the turn ends, the pending stop (unconfirmed exit, e.g. a
    // recycle that cannot be proven on a remote worker) holds no slot.
    store.uow.run((tx) =>
      tx.runs.put("first", {
        ...execution,
        started_at: now,
        status: "completed",
      }),
    );
    expect(counts()).toEqual([0, 0, 0]);
    expect(slots()).toEqual([0, 0, 0]);
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
    expect(slots()).toEqual([0, 0, 0]);
  },
);

test("a legacy occupant without admission history conservatively holds one of each configured resource; a known empty snapshot holds none", () => {
  const owner = assignment(1);
  seed(owner, run()); // project-only legacy journal, no trustworthy work-item history
  const slots = () =>
    store.uow.read((tx) =>
      [
        ...runCapacitySnapshot(
          store,
          tx,
          () =>
            new Map([
              ["godot", 2],
              ["blender", 3],
            ]),
        )
          .resourcesForMachine("local")
          .values(),
      ].map((s) => s.occupied),
    );
  expect(slots()).toEqual([1, 1]);
  store.uow.run((tx) =>
    tx.runs.put("first", { ...run(), status: "completed" }),
  );
  expect(slots()).toEqual([0, 0]);
  seed(owner, { ...run(2, 1), resource_keys: [] });
  expect(slots()).toEqual([0, 0]);
});

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

test("C-315 queue cache tracks formal deliveries, rollback and repository fallback without promoting a first followup", () => {
  const owner = assignment(1);
  const previous = { ...run(9, 1), status: "completed" as const };
  seed(owner, previous);
  seed(owner, {
    ...run(1),
    kind: "followup",
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  store.uow.run((tx) => {
    tx.work_items.put("first", {
      id: owner.work_item_id,
      card_id: "C-1",
      title: "Build",
      kind: "produce",
      role_id: "coder",
      status: "in_progress",
      required: true,
      depends_on: [],
      completion_criteria: [],
      assignment_id: owner.id,
    } as never);
  });
  expect(snapshot().queue[0]?.dispatch_tier).toBe(4);
  const deliver = (tx: Parameters<Parameters<typeof store.uow.run>[0]>[0]) => {
    tx.deliveries.put("first", {
      id: "D-1",
      work_item_id: owner.work_item_id,
      run_id: previous.id,
      kind: "code",
      summary: "Synthetic formal history",
      subject: { kind: "git_head", value: "a".repeat(40) },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted",
    } as never);
  };
  expect(() =>
    store.uow.run((tx) => {
      deliver(tx);
      expect(runCapacitySnapshot(store, tx).queue[0]?.dispatch_tier).toBe(3);
      throw new Error("rollback delivery");
    }),
  ).toThrow("rollback delivery");
  expect(snapshot().queue[0]?.dispatch_tier).toBe(4);
  store.uow.run(deliver);
  expect(snapshot().queue[0]?.dispatch_tier).toBe(3);
  store.uow.read((tx) => {
    const fallback = runCapacitySnapshot(store, {
      ...tx,
      events: { listAfter: tx.events.listAfter },
    });
    expect(fallback.queue).toEqual(runCapacitySnapshot(store, tx).queue);
  });
});

test("C-620 an earlier waiter whose owner cannot start a session now does not hold the queue; it regains its place when the fence clears", () => {
  const waiting = (n: number): Run => ({
    ...run(n),
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  const head = assignment(1);
  seed(head, waiting(1));
  seed(assignment(2), waiting(2));
  const blocks = () =>
    store.uow.read((tx) => {
      const { queue } = runCapacitySnapshot(store, tx);
      const later = queue.find((e) => e.assignment_id === "A-2");
      if (!later) throw new Error("Missing later waiter");
      return hasEarlierCapacityWait(tx, queue, later, "local", new Map(), now);
    });
  expect(blocks()).toBe(true);
  const put = (a: Assignment) =>
    store.uow.run((tx) => tx.assignments.put("first", a));
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t",
    agent_name: "a",
  };
  // Unconfirmed recycle of its old session.
  put({
    ...head,
    runtime_ref: ref,
    idle_retirement: {
      phase: "stopping",
      runtime_ref: ref,
      started_at: now,
      threshold_minutes: 30,
      failures: 0,
    },
  });
  expect(blocks()).toBe(false);
  put(head);
  expect(blocks()).toBe(true);
  // Another of its Runs is still active.
  store.uow.run((tx) =>
    tx.runs.put("first", { ...run(3, 1), status: "running" }),
  );
  expect(blocks()).toBe(false);
  store.uow.run((tx) =>
    tx.runs.put("first", { ...run(3, 1), status: "completed" }),
  );
  expect(blocks()).toBe(true);
  // A pending host operation (exit not confirmed).
  const action = store.uow.run((tx) => {
    const id = tx.ids.nextEventId();
    tx.events.append("first", {
      id,
      seq: tx.ids.nextEventSequence("first"),
      type: "host_ops_action_taken",
      actor: { kind: "system", project_id: "first" },
      created_at: now,
      payload: { execution: true, assignment_id: head.id, runtime_ref: ref },
    });
    return id;
  });
  expect(blocks()).toBe(false);
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
  expect(blocks()).toBe(true);
});
