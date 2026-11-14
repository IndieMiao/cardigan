/**
 * M2.T1 (M2.1 part): acceptance tests for the launch commands, written from
 * docs/plans/phase-1-m2.md §5 (M2.1) and the development plan §10/§11, using
 * only the public exports of @cardigan/domain. Every command starts from a real
 * state built with `createCard` + `assign`.
 */
import { describe, expect, test } from "vitest";
import { machine } from "./commands/test-fixtures.js";
import {
  type Actor,
  type Assignment,
  abortDispatch,
  acknowledgeRun,
  assign,
  type Clock,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  type DomainError,
  dispatchRun,
  formatId,
  formatTimelineEntryId,
  type IdAllocator,
  type ProjectId,
  queueRun,
  type ReadableIdKind,
  type Result,
  type RoleReference,
  type Run,
  type RuntimeRef,
  type WorkItem,
} from "./index.js";

const project_id = "p-launch" as ProjectId;
const TID = (id: string) => id as never;

class TestClock implements Clock {
  #tick = 0;
  now(): string {
    this.#tick += 1;
    return `2026-01-01T00:${String(Math.floor(this.#tick / 60)).padStart(2, "0")}:${String(this.#tick % 60).padStart(2, "0")}.000Z`;
  }
}

class TestIds implements IdAllocator {
  readonly #counters = new Map<string, number>();
  readonly #sequences = new Map<string, number>();
  readonly #timeline = new Map<string, number>();
  #event = 0;
  #attachment = 0;

  #bump(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  next<K extends ReadableIdKind>(_project: ProjectId, kind: K) {
    const value = formatId(kind, this.#bump(this.#counters, kind));
    if (!value.ok) throw new Error(value.error.message);
    return value.value;
  }

  nextTimelineEntryId(
    _project: ProjectId,
    card_id: Parameters<typeof formatTimelineEntryId>[0],
  ) {
    const value = formatTimelineEntryId(
      card_id,
      this.#bump(this.#timeline, card_id),
    );
    if (!value.ok) throw new Error(value.error.message);
    return value.value;
  }

  nextEventId() {
    this.#event += 1;
    return `01J${String(this.#event).padStart(23, "0")}` as ReturnType<
      IdAllocator["nextEventId"]
    >;
  }

  nextEventSequence(_project: ProjectId, card_id?: string) {
    return this.#bump(this.#sequences, card_id ?? "<project>");
  }

  nextAttachmentId(_project: ProjectId) {
    this.#attachment += 1;
    return `attachment-${this.#attachment}` as ReturnType<
      IdAllocator["nextAttachmentId"]
    >;
  }
}

const keyOf = (entity: object): string =>
  "id" in entity
    ? String((entity as { id: string }).id)
    : `${(entity as { assignment_id: string }).assignment_id}/${(entity as { card_id: string }).card_id}`;

interface Harness {
  state: CommandState;
  ports: CommandPorts;
}

const roles: readonly RoleReference[] = [
  {
    role_id: "pm",
    role_version: 1,
    allowed_tools: [
      "submit_review",
      "create_card",
      "create_work_item",
      "update_work_item",
      "assign",
      "post_comment",
    ],
    capabilities: [],
  },
  {
    role_id: "coder",
    role_version: 1,
    allowed_tools: ["submit_delivery", "post_comment", "get_updates"],
    capabilities: [],
  },
  {
    role_id: "reviewer",
    role_version: 1,
    allowed_tools: ["submit_review"],
    capabilities: [],
  },
];

const human: Actor = { kind: "human", project_id };

function state(): CommandState {
  return {
    project_id,
    machines: [machine()],
    roles,
    events: [],
    timeline: [],
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
  };
}

function commit<T>(h: Harness, result: Result<CommandEffect<T>>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  const next: Record<string, unknown> = { ...h.state };
  for (const change of result.value.changes) {
    const list = [...(next[change.collection] as object[])];
    const index = list.findIndex(
      (entity) => keyOf(entity) === keyOf(change.entity),
    );
    if (index >= 0) list[index] = change.entity;
    else list.push(change.entity);
    next[change.collection] = list;
  }
  next.events = [...h.state.events, ...result.value.events];
  next.timeline = [...h.state.timeline, ...result.value.timeline];
  h.state = next as unknown as CommandState;
  return result.value.data;
}

function errorOf<T>(result: Result<T>): DomainError {
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
}

interface Fixture {
  readonly h: Harness;
  readonly workItem: WorkItem;
  readonly assignment: Assignment;
  readonly coder: Actor;
}

/** Real state: a dev card, one work item, one assignment. */
function fixture(): Fixture {
  const h: Harness = {
    state: state(),
    ports: { clock: new TestClock(), ids: new TestIds() },
  };
  const card = commit(
    h,
    createCard(
      h.state,
      human,
      {
        title: "Fictional launch card",
        goal: "Start a Run",
        acceptance_criteria: ["runs start"],
        source: { kind: "quote", text: "fictional" },
        repo: "example/repo",
        base_branch: "main",
      },
      h.ports,
    ),
  );
  const item = h.state.work_items.find(
    (candidate) => candidate.card_id === card.id,
  );
  if (item === undefined) throw new Error("template item missing");
  const assignment = commit(
    h,
    assign(
      h.state,
      human,
      { work_item_id: item.id, role_id: "coder" },
      h.ports,
    ),
  );
  return {
    h,
    workItem:
      h.state.work_items.find((candidate) => candidate.id === item.id) ?? item,
    assignment,
    coder: {
      kind: "assignment",
      project_id,
      assignment_id: assignment.id,
      role_id: "coder",
      role_version: 1,
      allowed_tools: roles[1]?.allowed_tools ?? [],
      capabilities: [],
    },
  };
}

const runtimeRef = (worktree_path?: string, branch?: string): RuntimeRef => ({
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: TID("t1"),
  agent_name: "coder-c1-w1-a1",
  ...(worktree_path === undefined ? {} : { worktree_path }),
  ...(branch === undefined ? {} : { branch }),
});

const BASE_SHA = "a".repeat(40);

function queue(h: Harness, assignment: Assignment = fixture().assignment): Run {
  return commit(
    h,
    queueRun(
      h.state,
      human,
      {
        assignment_id: assignment.id,
        model: "fictional-model",
        agent_cli_version: "0.0.1",
      },
      h.ports,
    ),
  );
}

function dispatch(
  h: Harness,
  run: Run,
  extra: Partial<Parameters<typeof dispatchRun>[2]> = {},
): Run {
  return commit(
    h,
    dispatchRun(
      h.state,
      human,
      {
        run_id: run.id,
        runtime_ref: runtimeRef("/srv/agent/worktrees/A-1", "agent/C-1/W-1"),
        base_sha: BASE_SHA,
        ...extra,
      },
      h.ports,
    ),
  );
}

describe("queueRun", () => {
  test("invariant 12: a queued Run snapshots role version, model and CLI version", () => {
    const f = fixture();
    const run = queue(f.h, f.assignment);

    expect(run.status).toBe("queued");
    expect(run.assignment_id).toBe(f.assignment.id);
    expect(run.role_version).toBe(f.assignment.role_version);
    expect(run.model).toBe("fictional-model");
    expect(run.agent_cli_version).toBe("0.0.1");
    expect(run.trigger_event_id.length).toBeGreaterThan(0);
    expect(f.h.state.events.some((event) => event.type === "run_queued")).toBe(
      true,
    );
  });

  test("invariant 4: an assignment with an unfinished Run cannot queue another", () => {
    const f = fixture();
    queue(f.h, f.assignment);
    expect(
      errorOf(
        queueRun(
          f.h.state,
          human,
          {
            assignment_id: f.assignment.id,
            model: "m",
            agent_cli_version: "c",
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("invariant_violation");
  });

  test("only the host side may queue a Run", () => {
    const f = fixture();
    const result = errorOf(
      queueRun(
        f.h.state,
        f.coder,
        {
          assignment_id: f.assignment.id,
          model: "m",
          agent_cli_version: "c",
        },
        f.h.ports,
      ),
    );
    expect(["unauthorized", "forbidden_tool"]).toContain(result.code);
  });

  test("an unknown assignment or an empty snapshot is refused", () => {
    const f = fixture();
    expect(
      errorOf(
        queueRun(
          f.h.state,
          human,
          {
            assignment_id: TID("A-99"),
            model: "m",
            agent_cli_version: "c",
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("not_found");
    expect(
      errorOf(
        queueRun(
          f.h.state,
          human,
          {
            assignment_id: f.assignment.id,
            model: "  ",
            agent_cli_version: "c",
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("validation_failed");
  });
});

describe("dispatchRun", () => {
  test("invariant 5: dispatch records the runtime, worktree and branch on the same assignment", () => {
    const f = fixture();
    const run = queue(f.h, f.assignment);
    const dispatched = dispatch(f.h, run);

    expect(dispatched.status).toBe("dispatched");
    const updated = f.h.state.assignments.find((a) => a.id === f.assignment.id);
    expect(updated?.runtime_state).toBe("running");
    expect(updated?.runtime_ref?.terminal_ref).toBe("t1");
    expect(updated?.worktree_path).toBe("/srv/agent/worktrees/A-1");
    expect(updated?.branch).toBe("agent/C-1/W-1");
    expect(updated?.base_sha).toBe(BASE_SHA);
    // Same assignment, no replacement.
    expect(f.h.state.assignments).toHaveLength(1);
    expect(
      f.h.state.events.some((event) => event.type === "run_dispatched"),
    ).toBe(true);
  });

  test("invariant 5: a restart reuses the recorded worktree and branch", () => {
    const f = fixture();
    const first = dispatch(f.h, queue(f.h, f.assignment));

    // Finish the first Run so a second one may start.
    commit(
      f.h,
      abortDispatch(
        f.h.state,
        human,
        { run_id: first.id, reason: "fictional restart" },
        f.h.ports,
      ),
    );
    const second = dispatch(f.h, queue(f.h, f.assignment));

    expect(second.status).toBe("dispatched");
    const updated = f.h.state.assignments.find((a) => a.id === f.assignment.id);
    expect(updated?.worktree_path).toBe("/srv/agent/worktrees/A-1");

    // A different worktree would replace the assignment's context.
    commit(
      f.h,
      abortDispatch(
        f.h.state,
        human,
        { run_id: second.id, reason: "again" },
        f.h.ports,
      ),
    );
    const third = queue(f.h, f.assignment);
    expect(
      errorOf(
        dispatchRun(
          f.h.state,
          human,
          {
            run_id: third.id,
            runtime_ref: runtimeRef(
              "/srv/agent/worktrees/other",
              "agent/C-1/W-1",
            ),
            base_sha: BASE_SHA,
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("invariant_violation");
  });

  test("dispatch validates the machine, the base SHA and an unknown Run", () => {
    const f = fixture();
    const run = queue(f.h, f.assignment);

    expect(
      errorOf(
        dispatchRun(
          f.h.state,
          human,
          {
            run_id: run.id,
            runtime_ref: {
              ...runtimeRef("/srv/agent/worktrees/A-1", "agent/C-1/W-1"),
              machine_id: TID("remote"),
            },
            base_sha: BASE_SHA,
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("validation_failed");

    expect(
      errorOf(
        dispatchRun(
          f.h.state,
          human,
          {
            run_id: run.id,
            runtime_ref: runtimeRef(
              "/srv/agent/worktrees/A-1",
              "agent/C-1/W-1",
            ),
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("validation_failed");

    expect(
      errorOf(
        dispatchRun(
          f.h.state,
          human,
          {
            run_id: TID("R-99"),
            runtime_ref: runtimeRef(
              "/srv/agent/worktrees/A-1",
              "agent/C-1/W-1",
            ),
            base_sha: BASE_SHA,
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("not_found");
  });

  test("invariant 12: a Run whose snapshot no longer matches the assignment is refused", () => {
    const f = fixture();
    const run = queue(f.h, f.assignment);
    // Simulate a Run that recorded another role version (e.g. a stale row).
    f.h.state = {
      ...f.h.state,
      runs: f.h.state.runs.map((candidate) =>
        candidate.id === run.id ? { ...candidate, role_version: 2 } : candidate,
      ),
    };
    expect(
      errorOf(
        dispatchRun(
          f.h.state,
          human,
          {
            run_id: run.id,
            runtime_ref: runtimeRef(
              "/srv/agent/worktrees/A-1",
              "agent/C-1/W-1",
            ),
            base_sha: BASE_SHA,
          },
          f.h.ports,
        ),
      ).code,
    ).toBe("invariant_violation");
  });

  test("only the host side may dispatch", () => {
    const f = fixture();
    const run = queue(f.h, f.assignment);
    expect(["unauthorized", "forbidden_tool"]).toContain(
      errorOf(
        dispatchRun(
          f.h.state,
          f.coder,
          {
            run_id: run.id,
            runtime_ref: runtimeRef(
              "/srv/agent/worktrees/A-1",
              "agent/C-1/W-1",
            ),
            base_sha: BASE_SHA,
          },
          f.h.ports,
        ),
      ).code,
    );
  });
});

describe("acknowledgeRun", () => {
  test("the agent's first call acknowledges the Run and starts its work item", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));
    expect(f.workItem.status).toBe("todo");

    const acked = commit(
      f.h,
      acknowledgeRun(f.h.state, f.coder, { run_id: dispatched.id }, f.h.ports),
    );
    expect(acked.status).toBe("running");
    expect(acked.started_at).toBeDefined();
    const item = f.h.state.work_items.find(
      (candidate) => candidate.id === f.workItem.id,
    );
    expect(item?.status).toBe("in_progress");
    expect(f.h.state.events.some((event) => event.type === "run_started")).toBe(
      true,
    );
  });

  test("a repeated acknowledgement is a no-op", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));
    commit(
      f.h,
      acknowledgeRun(f.h.state, f.coder, { run_id: dispatched.id }, f.h.ports),
    );
    const before = f.h.state.events.length;
    const again = commit(
      f.h,
      acknowledgeRun(f.h.state, f.coder, { run_id: dispatched.id }, f.h.ports),
    );
    expect(again.status).toBe("running");
    expect(f.h.state.events.length).toBe(before);
  });

  test("another assignment or an unknown Run cannot be acknowledged", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));
    const other: Actor = {
      ...(f.coder as Extract<Actor, { kind: "assignment" }>),
      assignment_id: TID("A-99"),
    };
    expect(["unauthorized", "not_found"]).toContain(
      errorOf(
        acknowledgeRun(f.h.state, other, { run_id: dispatched.id }, f.h.ports),
      ).code,
    );
    expect(
      errorOf(
        acknowledgeRun(f.h.state, f.coder, { run_id: TID("R-99") }, f.h.ports),
      ).code,
    ).toBe("not_found");
  });
});

describe("abortDispatch", () => {
  test("aborting cancels the Run and releases the runtime", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));

    const aborted = commit(
      f.h,
      abortDispatch(
        f.h.state,
        human,
        { run_id: dispatched.id, reason: "fictional failure" },
        f.h.ports,
      ),
    );
    expect(aborted.status).toBe("cancelled");
    expect(aborted.outcome).toBe("failed");
    expect(aborted.summary).toBe("fictional failure");
    expect(aborted.finished_at).toBeDefined();

    const assignment = f.h.state.assignments.find(
      (a) => a.id === f.assignment.id,
    );
    expect(assignment?.runtime_state).toBe("idle");
    expect(assignment?.runtime_ref).toBeNull();
  });

  test("aborting twice is a no-op and an unknown Run is not found", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));
    const first = commit(
      f.h,
      abortDispatch(
        f.h.state,
        human,
        { run_id: dispatched.id, reason: "first" },
        f.h.ports,
      ),
    );
    const again = commit(
      f.h,
      abortDispatch(
        f.h.state,
        human,
        { run_id: dispatched.id, reason: "second" },
        f.h.ports,
      ),
    );
    expect(again.status).toBe("cancelled");
    expect(again.summary).toBe(first.summary);

    expect(
      errorOf(
        abortDispatch(
          f.h.state,
          human,
          { run_id: TID("R-99"), reason: "x" },
          f.h.ports,
        ),
      ).code,
    ).toBe("not_found");
  });

  test("only the host side may abort a dispatch", () => {
    const f = fixture();
    const dispatched = dispatch(f.h, queue(f.h, f.assignment));
    expect(["unauthorized", "forbidden_tool"]).toContain(
      errorOf(
        abortDispatch(
          f.h.state,
          f.coder,
          { run_id: dispatched.id, reason: "x" },
          f.h.ports,
        ),
      ).code,
    );
  });
});
