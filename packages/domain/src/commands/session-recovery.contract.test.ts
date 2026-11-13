import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  acknowledgeRun,
  dispatchRun,
  finishRun,
  listNeedsYou,
  prepareDelivery,
  requestDecision,
  submitDelivery,
  submitReview,
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
import { human, subject, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

beforeEach(setup);
const start = (a = f.coder) => {
  const sent = commit(dispatch(commit(queue(a))));
  return commit(acknowledgeRun(f.state, actor(a), { run_id: sent.id }, f.io));
};
const end = (
  r: ReturnType<typeof start>,
  outcome: "completed" | "failed" | "blocked",
) =>
  commit(
    finishRun(
      f.state,
      actor(),
      { run_id: r.id, outcome, summary: "Finished" },
      f.io,
    ),
  );
const owner = (id = f.coder.id) => f.state.assignments.find((a) => a.id === id);

test.each(["completed", "failed", "blocked"] as const)(
  "M5.6 invariant 5: explicit %s ends runtime activity but retains the Session",
  (outcome) => {
    const run = start();
    end(run, outcome);
    expect(owner()).toMatchObject({ runtime_state: "idle", runtime_ref: ref });
  },
);

test("M5.6 invariants 5, 10: a blocking Decision ends the Run and returns the Assignment to idle", () => {
  const run = start();
  commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: item().card_id,
        kind: "choose",
        category: "general",
        question: "Choose direction",
        context: "Blocked",
        options: [{ key: "go", description: "Continue", impact: "Resume" }],
        recommended: "go",
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        affected_cards: [],
        affected_work_items: [item().id],
        blocking: true,
      },
      f.io,
    ),
  );
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "completed",
    outcome: "blocked",
  });
  expect(owner()?.runtime_state).toBe("idle");
  const repeated = value(
    finishRun(
      f.state,
      actor(),
      { run_id: run.id, outcome: "blocked", summary: "Waiting" },
      f.io,
    ),
  );
  expect(repeated.changes).toEqual([]);
});

test("M5.6 invariant 5: the review-limit implicit ending also returns runtime activity to idle", async () => {
  start();
  const params = {
    work_item_id: item().id,
    kind: "code" as const,
    subject,
    summary: "Ready",
    requested_verifiers: [item(f.reviewer).id],
  };
  const receipt = value(
    await prepareDelivery(f.state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const delivery = commit(
    submitDelivery(f.state, actor(), params, receipt, f.io),
  );
  end(f.state.runs[0] as ReturnType<typeof start>, "completed");
  const reviewer = item(f.reviewer);
  if (reviewer.kind !== "verify") throw new Error("Expected verifier");
  let reviewRun = start(f.reviewer);
  for (let round = 0; round < reviewer.max_review_rounds; round++) {
    commit(
      submitReview(
        f.state,
        actor(f.reviewer),
        {
          delivery_id: delivery.id,
          target_sha: subject.value,
          kind: "code",
          recheck_required: true,
          issues: [],
        },
        f.io,
      ),
    );
    if (round < reviewer.max_review_rounds - 1) {
      commit(
        finishRun(
          f.state,
          actor(f.reviewer),
          { run_id: reviewRun.id, outcome: "completed", summary: "Recheck" },
          f.io,
        ),
      );
      reviewRun = start(f.reviewer);
    }
  }
  expect(f.state.runs.find((r) => r.id === reviewRun.id)).toMatchObject({
    status: "completed",
    outcome: "blocked",
  });
  expect(owner(f.reviewer.id)?.runtime_state).toBe("idle");
});

test("M5.6 invariants 4, 5, 12: replacement dispatch records one system handoff and reuses the queued Run", () => {
  const previous = start();
  end(previous, "blocked");
  const queued = commit(queue()),
    replacement = { previous: ref, reason: "runtime_unavailable" as const };
  const nextRef = { ...ref, terminal_ref: "t2" };
  delete nextRef.agent_session_id;
  const effect = value(
    dispatchRun(
      f.state,
      system,
      { run_id: queued.id, runtime_ref: nextRef, replacement },
      f.io,
    ),
  );
  expect(effect.timeline).toContainEqual(
    expect.objectContaining({
      type: "handoff",
      author: "system",
      run_id: queued.id,
    }),
  );
  const body = effect.timeline[0]?.body;
  for (const text of [
    "运行时失联",
    "t1",
    previous.id,
    "blocked",
    "get_updates",
  ])
    expect(body).toContain(text);
  commit(
    dispatchRun(
      f.state,
      system,
      { run_id: queued.id, runtime_ref: nextRef, replacement },
      f.io,
    ),
  );
  expect(f.state.runs).toHaveLength(2);
  expect(owner()?.runtime_state).toBe("running");
  expect(owner()?.session_ref).toBeUndefined();
  expect(f.state.runs.at(-1)).toMatchObject({
    id: queued.id,
    model: queued.model,
    role_version: queued.role_version,
    agent_cli_version: queued.agent_cli_version,
  });
  expect(
    dispatchRun(
      f.state,
      system,
      { run_id: queued.id, runtime_ref: nextRef, replacement },
      f.io,
    ).ok,
  ).toBe(false);
});

test("P2a-10 A: a tool catalog replacement is system-only, keeps the queued snapshot and names its reason", () => {
  const previous = start();
  end(previous, "completed");
  const queued = commit(queue());
  const withCatalog = { ...queued, tool_catalog: "new-catalog" };
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) => (r.id === queued.id ? withCatalog : r)),
  };
  const replacement = {
    previous: ref,
    reason: "tool_catalog_changed" as const,
  };
  const nextRef = { ...ref, terminal_ref: "t2" };
  delete nextRef.agent_session_id;
  const before = JSON.stringify(f.state);
  // Not even the Assignment itself can ask for its own replacement.
  expect(
    dispatchRun(
      f.state,
      actor(),
      { run_id: queued.id, runtime_ref: nextRef, replacement },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    dispatchRun(
      f.state,
      human,
      { run_id: queued.id, runtime_ref: nextRef, replacement },
      f.io,
    ).ok,
  ).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
  const effect = value(
    dispatchRun(
      f.state,
      system,
      {
        run_id: queued.id,
        runtime_ref: nextRef,
        replacement,
        launch_snapshot: {
          model: queued.model,
          agent_cli_version: queued.agent_cli_version,
        },
      },
      f.io,
    ),
  );
  const body = effect.timeline[0]?.body;
  expect(body).toContain("部署后工具清单已变更");
  expect(body).not.toContain("运行时失联");
  commit(
    dispatchRun(
      f.state,
      system,
      {
        run_id: queued.id,
        runtime_ref: nextRef,
        replacement,
        launch_snapshot: {
          model: queued.model,
          agent_cli_version: queued.agent_cli_version,
        },
      },
      f.io,
    ),
  );
  expect(
    f.state.events.filter((e) => e.type === "session_replaced").at(-1)?.payload,
  ).toMatchObject({ reason: "tool_catalog_changed", run_id: queued.id });
  expect(f.state.runs.find((r) => r.id === queued.id)).toMatchObject({
    tool_catalog: "new-catalog",
    status: "dispatched",
  });
  expect(owner()?.runtime_ref).toMatchObject({ terminal_ref: "t2" });
});

test("P2a-10 A: a new terminal records the launch catalog and a reused session inherits it", () => {
  // `start` provisions on ref with a launch catalog, as the host does.
  const first = commit(queue());
  commit(
    dispatchRun(
      f.state,
      system,
      {
        run_id: first.id,
        runtime_ref: ref,
        base_sha: subject.value,
        launch_snapshot: {
          model: first.model,
          agent_cli_version: first.agent_cli_version,
          tool_catalog: "session-catalog",
        },
      },
      f.io,
    ),
  );
  commit(acknowledgeRun(f.state, actor(), { run_id: first.id }, f.io));
  expect(f.state.runs.find((r) => r.id === first.id)?.tool_catalog).toBe(
    "session-catalog",
  );
  end(
    f.state.runs.find((r) => r.id === first.id) as ReturnType<typeof start>,
    "completed",
  );
  // Any entry point that reuses the terminal (no runtime_ref) keeps it.
  const next = commit(queue());
  commit(dispatchRun(f.state, human, { run_id: next.id }, f.io));
  expect(f.state.runs.find((r) => r.id === next.id)?.tool_catalog).toBe(
    "session-catalog",
  );
});

test("M5.6 invariant 11: stale runtime replacement and Agent attempts are rejected without a handoff", () => {
  const previous = start();
  end(previous, "completed");
  const run = commit(queue()),
    before = JSON.stringify(f.state);
  for (const caller of [system, actor()])
    expect(
      dispatchRun(
        f.state,
        caller,
        {
          run_id: run.id,
          runtime_ref: { ...ref, terminal_ref: "t2" },
          replacement: {
            previous: { ...ref, terminal_ref: "stale" },
            reason: "runtime_not_found",
          },
        },
        f.io,
      ).ok,
    ).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
});

test("M5.6 listNeedsYou projects persisted runtime loss and latest Run without writes", () => {
  const run = start();
  // Runtime observations are external facts; model the monitor's persisted result after a real launch.
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_state: "lost" } : a,
    ),
    events: [
      ...f.state.events,
      ...["runtime_disconnected", "runtime_lost"].map((type, i) => ({
        id: f.io.ids.nextEventId(),
        seq: f.io.ids.nextEventSequence(f.state.project_id, item().card_id),
        card_id: item().card_id,
        type,
        actor: system,
        created_at: `2026-01-01T00:0${i}:00.000Z`,
        payload: { assignment_id: f.coder.id },
      })),
    ],
  };
  const effect = value(listNeedsYou(f.state, human));
  expect(effect.data.incidents).toMatchObject([
    {
      id: f.coder.id,
      runtime_state: "lost",
      disconnected_at: "2026-01-01T00:00:00.000Z",
      lost_at: "2026-01-01T00:01:00.000Z",
      last_run: { id: run.id },
    },
  ]);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toEqual([]);
});

test.each(["unknown", "lost"] as const)(
  "M5.6 invariant 4: %s cannot be replaced until its in-flight Run is explicitly ended",
  (runtime_state) => {
    const run = start();
    // External monitor observations never count as a business ending.
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.coder.id ? { ...a, runtime_state } : a,
      ),
      runs: f.state.runs.map((r) =>
        r.id === run.id ? { ...r, status: "unknown" } : r,
      ),
    };
    expect(queue().ok).toBe(false);
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: run.id, reason: "Host confirmed stop" },
        f.io,
      ),
    );
    const queued = commit(queue());
    commit(
      dispatchRun(
        f.state,
        system,
        {
          run_id: queued.id,
          runtime_ref: { ...ref, terminal_ref: "t2" },
          replacement: { previous: ref, reason: "runtime_not_found" },
        },
        f.io,
      ),
    );
    expect(owner()?.runtime_state).toBe("running");
    expect(f.state.runs).toHaveLength(2);
  },
);
