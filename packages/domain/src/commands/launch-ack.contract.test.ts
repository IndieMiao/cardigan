import { beforeEach, expect, test } from "vitest";
import {
  type Actor,
  abortDispatch,
  acknowledgeRun,
  assign,
  createCard,
  createWorkItem,
  dispatchRun,
  finishRun,
  prepareDelivery,
  queueRun,
  type Result,
  type Run,
  recordRunAckRefusal,
  startDependencyReadyRun,
  submitDelivery,
  submitReview,
  toolNames,
  transition,
  updateCard,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";
import {
  apply,
  human,
  id,
  now,
  role,
  subject,
  value,
} from "./test-fixtures.js";

const reject = (r: Result<unknown>, code: string) =>
  expect(r).toMatchObject({ ok: false, error: { code } });
beforeEach(setup);
const ack = (r: Run, a = f.coder) =>
  acknowledgeRun(f.state, actor(a), { run_id: r.id }, f.io);
const start = (a = f.coder, runtime_ref = ref) =>
  commit(ack(commit(dispatch(commit(queue(a)), runtime_ref)), a));
const stop = (r: Run, a = f.coder) =>
  commit(
    finishRun(
      f.state,
      actor(a),
      { run_id: r.id, outcome: "completed", summary: "Done" },
      f.io,
    ),
  );
async function deliver() {
  const p = {
    work_item_id: item().id,
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [item(f.reviewer).id],
  };
  const receipt = value(
    await prepareDelivery(f.state, actor(), p, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return commit(submitDelivery(f.state, actor(), p, receipt, f.io));
}

test("invariants 4, 12: queue, dispatch and first MCP acknowledgement activate real todo work once", () => {
  expect(f.state.work_items.every((w) => w.status === "todo")).toBe(true);
  const original = JSON.stringify(f.state);
  const queued = value(queue());
  expect(JSON.stringify(f.state)).toBe(original);
  expect(queued.data).toMatchObject({
    kind: "initial",
    status: "queued",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "1.2.3",
  });
  expect(queued.events[0]).toMatchObject({
    id: queued.data.trigger_event_id,
    type: "run_queued",
    card_id: item().card_id,
  });
  f.state = apply(f.state, queued);
  const sent = commit(dispatch(queued.data));
  expect(sent.status).toBe("dispatched");
  expect(item().status).toBe("todo");
  expect(f.state.assignments.find((a) => a.id === f.coder.id)).toMatchObject({
    runtime_state: "running",
    runtime_ref: ref,
    base_sha: subject.value,
  });
  const acknowledged = value(ack(sent));
  expect(acknowledged.data).toMatchObject({
    status: "running",
    started_at: now,
  });
  f.state = apply(f.state, acknowledged);
  expect(item().status).toBe("in_progress");
  expect(item(f.reviewer).status).toBe("todo");
  expect(value(ack(sent))).toMatchObject({
    changes: [],
    events: [],
    timeline: [],
  });
});

test("invariant 5: restart preserves Assignment, worktree and Session and snapshots the fixed role version", () => {
  stop(start());
  f.state = {
    ...f.state,
    roles: [...f.state.roles, { ...role("coder"), role_version: 2 }],
  };
  const next = start();
  expect(next.role_version).toBe(1);
  expect(f.state.assignments).toHaveLength(2);
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.assignments.find((a) => a.id === f.coder.id)).toMatchObject({
    session_ref: "session-1",
    worktree_path: ref.worktree_path,
    branch: ref.branch,
  });
});

test.each(["human", "system"] as const)(
  "%s host can queue and abort before dispatch, then retry",
  (kind) => {
    const host: Actor = { kind, project_id: f.state.project_id };
    const r = commit(
      queueRun(
        f.state,
        host,
        { assignment_id: f.coder.id, model: "m", agent_cli_version: "v" },
        f.io,
      ),
    );
    const aborted = commit(
      abortDispatch(
        f.state,
        host,
        { run_id: r.id, reason: "Provision failed" },
        f.io,
      ),
    );
    expect(aborted).toMatchObject({
      status: "cancelled",
      outcome: "failed",
      summary: "Provision failed",
      finished_at: now,
    });
    expect(item().status).toBe("todo");
    expect(queue().ok).toBe(true);
  },
);

test("abort after dispatch keeps worktree metadata, clears the terminal, and is repeatable", () => {
  const r = commit(dispatch(commit(queue())));
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: r.id, reason: "MCP failed" },
      f.io,
    ),
  );
  expect(f.state.assignments.find((a) => a.id === f.coder.id)).toMatchObject({
    runtime_state: "idle",
    runtime_ref: null,
    worktree_path: ref.worktree_path,
  });
  expect(
    value(
      abortDispatch(f.state, human, { run_id: r.id, reason: "Retry" }, f.io),
    ),
  ).toMatchObject({ changes: [], events: [] });
  start();
});

test("host commands reject Agents, cross-project actors and missing targets; ACK requires the owning Assignment", () => {
  const r = commit(queue());
  const calls = (a: Actor) => [
    queueRun(
      f.state,
      a,
      { assignment_id: f.coder.id, model: "m", agent_cli_version: "v" },
      f.io,
    ),
    dispatchRun(f.state, a, { run_id: r.id, runtime_ref: ref }, f.io),
    abortDispatch(f.state, a, { run_id: r.id, reason: "x" }, f.io),
  ];
  for (const a of [
    actor(),
    { ...human, project_id: "another" },
    { ...system, project_id: "another" },
  ])
    for (const result of calls(a)) reject(result, "unauthorized");
  for (const a of [
    human,
    system,
    actor(f.reviewer),
    { ...actor(), project_id: "another" },
  ])
    reject(acknowledgeRun(f.state, a, { run_id: r.id }, f.io), "unauthorized");
  reject(
    queueRun(
      f.state,
      human,
      {
        assignment_id: id("assignment", 999),
        model: "m",
        agent_cli_version: "v",
      },
      f.io,
    ),
    "not_found",
  );
  for (const result of [
    dispatchRun(
      f.state,
      human,
      { run_id: id("run", 999), runtime_ref: ref },
      f.io,
    ),
    abortDispatch(
      f.state,
      human,
      { run_id: id("run", 999), reason: "x" },
      f.io,
    ),
    acknowledgeRun(f.state, actor(), { run_id: id("run", 999) }, f.io),
  ])
    reject(result, "not_found");
});

test("invalid Run/runtime transitions, changed worktree/branch and blank abort reasons are refused", () => {
  const r = commit(queue());
  reject(ack(r), "illegal_transition");
  reject(
    abortDispatch(f.state, human, { run_id: r.id, reason: " " }, f.io),
    "validation_failed",
  );
  for (const runtime_state of ["unknown", "lost", "released"] as const)
    reject(
      dispatchRun(
        {
          ...f.state,
          assignments: f.state.assignments.map((a) => ({
            ...a,
            runtime_state,
          })),
        },
        human,
        { run_id: r.id, runtime_ref: ref, base_sha: subject.value },
        f.io,
      ),
      "illegal_transition",
    );
  const sent = commit(dispatch(r));
  reject(dispatch(sent), "illegal_transition");
  const running = commit(ack(sent));
  stop(running);
  reject(ack(running), "illegal_transition");
  reject(
    abortDispatch(
      f.state,
      human,
      { run_id: running.id, reason: "Too late" },
      f.io,
    ),
    "illegal_transition",
  );
  const next = commit(queue());
  for (const patch of [
    { worktree_path: "/fixture/other" },
    { branch: "other" },
  ])
    reject(dispatch(next, { ...ref, ...patch }), "invariant_violation");
});

function dependentAssignment() {
  const dependent = commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: item().card_id,
        title: "Dependent",
        kind: "produce",
        role_id: "coder",
        required: false,
        completion_criteria: ["Pass"],
        depends_on: [item().id],
      },
      f.io,
    ),
  );
  return commit(
    assign(
      f.state,
      human,
      { work_item_id: dependent.id, role_id: "coder" },
      f.io,
    ),
  );
}
const dependentRef = {
  ...ref,
  worktree_path: "/fixture/dependent",
  branch: "dependent",
};

test("C-735: a Run woken before its dependencies finish starts as a discussion and leaves the item todo", async () => {
  const a = dependentAssignment();
  const r = commit(dispatch(commit(queue(a)), dependentRef));
  const acknowledged = value(ack(r, a));
  expect(acknowledged.data).toMatchObject({ status: "running" });
  expect(acknowledged.events).toEqual([
    expect.objectContaining({
      type: "run_started",
      payload: expect.objectContaining({
        run_id: r.id,
        dependency_wait: { cards: [], work_items: [item().id] },
      }),
    }),
  ]);
  expect(acknowledged.changes.map((c) => c.collection)).toEqual(["runs"]);
  f.state = apply(f.state, acknowledged);
  expect(item(a).status).toBe("todo");
  // Dependency rules are unchanged: the waiting item still cannot deliver.
  const p = {
    work_item_id: item(a).id,
    kind: "code" as const,
    summary: "Early",
    subject,
    requested_verifiers: [],
  };
  const receipt = await prepareDelivery(f.state, actor(a), p, {
    verify: async () => ({ ok: true, value: [] }),
  });
  if (receipt.ok)
    reject(
      submitDelivery(f.state, actor(a), p, receipt.value, f.io),
      "invariant_violation",
    );
  else expect(receipt.error.code).toBe("invariant_violation");
  expect(item(a).status).toBe("todo");
  stop(r, a);
  expect(f.state.runs.find((x) => x.id === r.id)).toMatchObject({
    status: "completed",
    outcome: "completed",
  });
  expect(item(a).status).toBe("todo");
});

async function acceptDependency() {
  const producing = start();
  const delivery = await deliver();
  stop(producing);
  const reviewing = start(f.reviewer, {
    ...ref,
    worktree_path: "/fixture/review",
    branch: "review",
  });
  commit(
    submitReview(
      f.state,
      actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  stop(reviewing, f.reviewer);
  expect(item().status).toBe("accepted");
}

test("C-735: once the dependency is accepted the same Assignment's next Run starts the item", async () => {
  const a = dependentAssignment();
  stop(start(a, dependentRef), a);
  expect(item(a).status).toBe("todo");
  await acceptDependency();
  const r = commit(dispatch(commit(queue(a)), dependentRef));
  const acknowledged = value(ack(r, a));
  expect(acknowledged.events.at(-1)?.payload).not.toHaveProperty(
    "dependency_wait",
  );
  f.state = apply(f.state, acknowledged);
  expect(item(a).status).toBe("in_progress");
});

const later = (seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();
const startReady = (r: Run, by: Actor = system) =>
  startDependencyReadyRun(f.state, by, { run_id: r.id }, f.io);
/** The host sent this Run's bell into its session. */
function bellSent(r: Run, at = later(1)) {
  f.state = {
    ...f.state,
    runs: f.state.runs.map((x) =>
      x.id === r.id
        ? {
            ...x,
            bell_delivery: {
              run_id: r.id,
              card_id: item().card_id,
              runtime_ref: dependentRef,
              sent_at: at,
            },
          }
        : x,
    ),
  };
}
function activity(a: typeof f.coder, at: string) {
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((x) =>
      x.id === a.id ? { ...x, last_mcp_activity_at: at } : x,
    ),
  };
}
/** A Run left dispatched by refused acknowledgements before this fix. */
function legacyRefusedRun(a: typeof f.coder) {
  const r = commit(dispatch(commit(queue(a)), dependentRef));
  bellSent(r);
  activity(a, later(2));
  return r;
}

test("C-735: once prerequisites complete the system starts a Run its session could not acknowledge", async () => {
  const a = dependentAssignment();
  const r = legacyRefusedRun(a);
  // Prerequisites unfinished: nothing to start yet.
  expect(value(startReady(r))).toMatchObject({ data: undefined, changes: [] });
  await acceptDependency();
  expect(f.state.runs.find((x) => x.id === r.id)?.status).toBe("dispatched");
  reject(startReady(r, actor(a)), "unauthorized");
  const started = value(startReady(r));
  expect(started.data).toMatchObject({ status: "running", started_at: now });
  expect(started.events).toEqual([
    expect.objectContaining({
      type: "run_started",
      card_id: item(a).card_id,
      payload: {
        run_id: r.id,
        assignment_id: a.id,
        system_acknowledged: "dependencies_met",
      },
    }),
  ]);
  expect(started.timeline[0]?.body).toContain(item(a).id);
  f.state = apply(f.state, started);
  expect(item(a).status).toBe("in_progress");
  // The session's own later call is a no-op; a second sweep changes nothing.
  expect(value(ack(r, a)).changes).toEqual([]);
  expect(value(startReady(r)).changes).toEqual([]);
  stop(r, a);
  expect(f.state.runs.find((x) => x.id === r.id)?.status).toBe("completed");
});

test("C-735: the system start needs this Run's bell and a later sign of life, and leaves fenced Runs alone", async () => {
  const a = dependentAssignment();
  const r = commit(dispatch(commit(queue(a)), dependentRef));
  await acceptDependency();
  // No Card tool call since dispatch: an ordinary pending start.
  expect(value(startReady(r)).changes).toEqual([]);
  // A late call before this Run's bell was sent does not count, and neither
  // does any call while the bell is still unsent.
  activity(a, later(1));
  expect(value(startReady(r)).changes).toEqual([]);
  bellSent(r, later(2));
  expect(value(startReady(r)).changes).toEqual([]);
  f.state = {
    ...f.state,
    runs: f.state.runs.map((x) =>
      x.id === r.id
        ? {
            ...x,
            ack_refusal: {
              code: "invariant_violation",
              message: "x",
              at: later(3),
            },
          }
        : x,
    ),
  };
  const fenced = {
    ...f.state,
    runs: f.state.runs.map((x) =>
      x.id === r.id
        ? {
            ...x,
            dispatch_stop: {
              attempt_id: "E-1" as never,
              runtime_ref: null,
              lease_until: later(60),
              stopping: false,
              reason: "dispatch_timeout" as const,
            },
          }
        : x,
    ),
  };
  expect(
    value(startDependencyReadyRun(fenced, system, { run_id: r.id }, f.io))
      .changes,
  ).toEqual([]);
  // A recorded refusal is proof enough.
  commit(startReady(r));
  expect(f.state.runs.find((x) => x.id === r.id)).not.toHaveProperty(
    "ack_refusal",
  );
  expect(item(a).status).toBe("in_progress");
});

test("C-735: a prerequisite card added after dispatch also starts the Run as a discussion", () => {
  const other = commit(
    createCard(
      f.state,
      human,
      {
        title: "Prerequisite",
        goal: "First",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
      },
      f.io,
    ),
  );
  // Queueing already waits for prerequisite cards; one added after dispatch
  // reaches the acknowledgement.
  const r = commit(dispatch(commit(queue())));
  commit(
    updateCard(
      f.state,
      human,
      { card_id: item().card_id, depends_on_cards: [other.id] },
      f.io,
    ),
  );
  const acknowledged = value(ack(r));
  expect(acknowledged.events.at(-1)?.payload).toMatchObject({
    dependency_wait: { cards: [other.id], work_items: [] },
  });
  f.state = apply(f.state, acknowledged);
  expect(item().status).toBe("todo");
  expect(f.state.runs.find((x) => x.id === r.id)?.status).toBe("running");
});

test("C-735: a refused acknowledgement is recorded once with its reason and cleared when the Run starts", () => {
  const r = commit(dispatch(commit(queue())));
  const refusal = { run_id: r.id, code: "illegal_transition", message: "Why" };
  const recorded = value(recordRunAckRefusal(f.state, actor(), refusal, f.io));
  expect(recorded.data.ack_refusal).toEqual({
    code: "illegal_transition",
    message: "Why",
    at: now,
  });
  expect(recorded.events).toEqual([
    expect.objectContaining({
      type: "run_ack_refused",
      card_id: item().card_id,
      payload: {
        run_id: r.id,
        assignment_id: f.coder.id,
        code: "illegal_transition",
        message: "Why",
      },
    }),
  ]);
  expect(recorded.timeline[0]?.body).toContain("Why");
  f.state = apply(f.state, recorded);
  expect(
    value(recordRunAckRefusal(f.state, actor(), refusal, f.io)),
  ).toMatchObject({ changes: [], events: [], timeline: [] });
  reject(
    recordRunAckRefusal(f.state, actor(f.reviewer), refusal, f.io),
    "unauthorized",
  );
  commit(ack(r));
  const started = f.state.runs.find((x) => x.id === r.id);
  expect(started?.status).toBe("running");
  expect(started).not.toHaveProperty("ack_refusal");
  expect(
    value(recordRunAckRefusal(f.state, actor(), refusal, f.io)).changes,
  ).toEqual([]);
});

test("acknowledgement activates a reviewer made ready by a real delivery; rework starts through the same path", async () => {
  const first = start();
  const delivery = await deliver();
  stop(first);
  const review = start(f.reviewer, {
    ...ref,
    worktree_path: "/fixture/review",
    branch: "review",
  });
  expect(item(f.reviewer).status).toBe("in_progress");
  commit(
    submitReview(
      f.state,
      actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: subject.value,
        kind: "code",
        issues: [
          {
            severity: "major",
            description: "Bug",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
      f.io,
    ),
  );
  expect(item().status).toBe("changes_requested");
  start();
  expect(item().status).toBe("in_progress");
  expect(review.role_version).toBe(1);
});

test("acknowledgement accepts an acked Run and leaves delivered work intact on later launches", async () => {
  const r = commit(dispatch(commit(queue())));
  f.state = {
    ...f.state,
    runs: [{ ...r, status: value(transition("run", r.status, "acknowledge")) }],
  };
  const running = commit(ack(r));
  await deliver();
  stop(running);
  start();
  expect(item().status).toBe("delivered");
});

test("acknowledgement cannot bypass an exhausted verifier's review budget", async () => {
  const producing = start();
  const delivery = await deliver();
  stop(producing);
  const reviewRef = {
    ...ref,
    worktree_path: "/fixture/review",
    branch: "review",
  };
  const reviewing = start(f.reviewer, reviewRef);
  commit(
    submitReview(
      f.state,
      actor(f.reviewer),
      {
        delivery_id: delivery.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  stop(reviewing, f.reviewer);
  // Model a stale ready snapshot using its legal redelivery transition; never seed in_progress.
  f.state = {
    ...f.state,
    reviews: f.state.reviews.map((r) => ({ ...r, verdict: "reject" as const })),
    work_items: f.state.work_items.map((w) =>
      w.kind === "verify" && w.id === item(f.reviewer).id
        ? {
            ...w,
            status: value(transition("verify", w.status, "target_redelivered")),
            max_review_rounds: 1,
          }
        : w,
    ),
  };
  const next = commit(dispatch(commit(queue(f.reviewer)), reviewRef));
  reject(ack(next, f.reviewer), "illegal_transition");
  expect(f.state.runs.find((r) => r.id === next.id)?.status).toBe("dispatched");
});

test("standing Assignment launches without a worktree; internal commands never become MCP tools", () => {
  const { work_item_id: _work, ...fields } = f.coder;
  f.coder = { ...fields, scope: "standing" };
  f.state = { ...f.state, assignments: [f.coder, f.reviewer] };
  const r = commit(queue());
  const { worktree_path: _path, branch: _branch, ...runtime_ref } = ref;
  commit(dispatchRun(f.state, human, { run_id: r.id, runtime_ref }, f.io));
  const acknowledged = value(ack(r));
  expect(acknowledged.events[0]).not.toHaveProperty("card_id");
  expect(acknowledged.changes.map((c) => c.collection)).toEqual(["runs"]);
  expect(toolNames).not.toContain("acknowledge_run");
  reject(
    createCard(
      f.state,
      system,
      {
        title: "Forbidden",
        goal: "x",
        acceptance_criteria: ["x"],
        source: { kind: "quote", text: "x" },
        repo: "example/repo",
        base_branch: "main",
      },
      f.io,
    ),
    "unauthorized",
  );
});

test("abort can cancel an acknowledged startup without undoing work or deleting worktree metadata", () => {
  const r = start();
  const result = commit(
    abortDispatch(
      f.state,
      human,
      { run_id: r.id, reason: "Host startup failed" },
      f.io,
    ),
  );
  expect(result.status).toBe("cancelled");
  expect(item().status).toBe("in_progress");
  expect(queue().ok).toBe(true);
});

test("repeated acknowledgement after card cancellation remains a no-op", () => {
  const r = start();
  commit(
    updateCard(
      f.state,
      human,
      { card_id: item().card_id, status: "cancelled" },
      f.io,
    ),
  );
  expect(value(ack(r))).toMatchObject({
    changes: [],
    events: [],
    timeline: [],
  });
  expect(item().status).toBe("cancelled");
});

test.each(["acked", "unknown"] as const)(
  "abort cancels a %s startup through the transition table",
  (status) => {
    const r = commit(dispatch(commit(queue())));
    f.state = {
      ...f.state,
      runs: [
        {
          ...r,
          status: value(
            transition(
              "run",
              r.status,
              status === "acked" ? "acknowledge" : "connection_lost",
            ),
          ),
        },
      ],
    };
    expect(
      commit(
        abortDispatch(
          f.state,
          system,
          { run_id: r.id, reason: "Startup interrupted" },
          f.io,
        ),
      ).status,
    ).toBe("cancelled");
  },
);

test("invariant 12: ACK rejects inactive identity, corrupt snapshots and concurrent unfinished Runs", () => {
  const r = commit(dispatch(commit(queue())));
  for (const patch of [
    { role_version: 9 },
    { model: "" },
    { agent_cli_version: "" },
  ])
    reject(
      acknowledgeRun(
        { ...f.state, runs: [{ ...r, ...patch }] },
        actor(),
        { run_id: r.id },
        f.io,
      ),
      "invariant_violation",
    );
  const suspended = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({
      ...a,
      status: "suspended" as const,
    })),
  };
  reject(
    acknowledgeRun(suspended, actor(), { run_id: r.id }, f.io),
    "unauthorized",
  );
  f.state = {
    ...f.state,
    runs: [
      r,
      { ...r, id: id("run", 999), trigger_event_id: f.io.ids.nextEventId() },
    ],
  };
  reject(ack(r), "invariant_violation");
});
