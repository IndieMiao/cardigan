import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  assign,
  claimDispatchStop,
  type Delivery,
  hasRunTarget,
  prepareDelivery,
  queueRun,
  recoverDispatch,
  startDispatchStop,
  submitDelivery,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { human, id, subject, value } from "./test-fixtures.js";

beforeEach(setup);
async function deliver() {
  const run = commit(dispatch(commit(queue())));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  const params = {
    work_item_id: item().id,
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [item(f.reviewer).id],
  };
  const proof = value(
    await prepareDelivery(f.state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return commit(submitDelivery(f.state, actor(), params, proof, f.io));
}

test.each([
  "initial",
  "followup",
  "decision_resumed",
  "rework",
  "fix",
] as const)(
  "invariants 11, 14: %s cannot queue a reviewer without a target, including human starts",
  (kind) => {
    const before = JSON.stringify(f.state);
    for (const caller of [human, system])
      expect(
        queueRun(
          f.state,
          caller,
          {
            assignment_id: f.reviewer.id,
            model: "fixture",
            agent_cli_version: "1",
            kind,
          },
          f.io,
        ),
      ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    expect(JSON.stringify(f.state)).toEqual(before);
    expect(f.state.runs).toEqual([]);
    expect(hasRunTarget(f.coder, f.state)).toBe(true);
  },
);

test("invariant 14: a queued reviewer waits after supersession and can reuse the Run for a new target", async () => {
  const delivery = await deliver();
  const queued = commit(queue(f.reviewer));
  f.state = { ...f.state, deliveries: [{ ...delivery, status: "superseded" }] };
  expect(dispatch(queued)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(
    queueRun(
      f.state,
      human,
      {
        assignment_id: f.reviewer.id,
        model: "fixture",
        agent_cli_version: "1",
        reuse_queued: true,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false });
  expect(f.state.runs.find((r) => r.id === queued.id)?.status).toBe("queued");
  f.state = {
    ...f.state,
    deliveries: [
      ...f.state.deliveries,
      { ...delivery, id: id("delivery", 999), supersedes: delivery.id },
    ],
  };
  expect(
    commit(
      queueRun(
        f.state,
        human,
        {
          assignment_id: f.reviewer.id,
          model: "fixture",
          agent_cli_version: "1",
          reuse_queued: true,
        },
        f.io,
      ),
    ).id,
  ).toBe(queued.id);
  // A separate runtime avoids the coder's occupied worktree in this fixture.
  expect(
    commit(
      dispatch(queued, {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "reviewer",
        agent_name: "reviewer",
      }),
    ).status,
  ).toBe("dispatched");
});

test("invariant 14: code and acceptance targets stay in their own card, work item and stream", async () => {
  const delivery = await deliver();
  const acceptance = f.state.work_items.find((w) => w.role_id === "pm");
  if (!acceptance) throw new Error("Missing acceptance item");
  const pm = commit(
    assign(
      f.state,
      human,
      { work_item_id: acceptance.id, role_id: "pm" },
      f.io,
    ),
  );
  const check = (candidate: Delivery, code: boolean, completion: boolean) => {
    const state = { ...f.state, deliveries: [candidate] };
    expect(hasRunTarget(f.reviewer, state)).toBe(code);
    expect(hasRunTarget(pm, state)).toBe(completion);
  };
  check(delivery, true, false);
  check({ ...delivery, status: "superseded" }, false, false);
  check({ ...delivery, work_item_id: id("work_item", 999) }, false, false);
  check({ ...delivery, kind: "card_completion" }, false, false);
  const completion: Delivery = {
    ...delivery,
    kind: "card_completion",
    requested_verifiers: [acceptance.id],
  };
  check(completion, false, true);
  check({ ...completion, status: "superseded" }, false, false);
  check(
    { ...completion, requested_verifiers: [item(f.reviewer).id] },
    false,
    false,
  );
  const foreign = {
    ...item(),
    id: id("work_item", 999),
    card_id: id("card", 999),
  };
  expect(
    hasRunTarget(pm, {
      work_items: [...f.state.work_items, foreign],
      deliveries: [{ ...completion, work_item_id: foreign.id }],
    }),
  ).toBe(false);
  // Non-Git deliveries are valid for roles without a readonly Git worktree.
  check(
    { ...completion, subject: { kind: "doc_version", value: "v1" } },
    false,
    true,
  );
});

test("dispatch recovery settles the stopped verifier without requeuing a withdrawn target", async () => {
  const delivery = await deliver();
  const run = commit(
    dispatch(commit(queue(f.reviewer)), {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "reviewer",
      agent_name: "reviewer",
    }),
  );
  const later = new Date(Date.parse(f.io.clock.now()) + 600000).toISOString();
  f.io = { ...f.io, clock: { now: () => later } };
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        reason: "dispatch_timeout",
        lease_ms: 60000,
      },
      f.io,
    ),
  );
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("Missing stop fence");
  commit(
    startDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        attempt_id: stop.attempt_id,
      },
      f.io,
    ),
  );
  f.state = { ...f.state, deliveries: [{ ...delivery, status: "superseded" }] };
  expect(
    commit(
      recoverDispatch(
        f.state,
        system,
        {
          run_id: run.id,
          timeout_ms: 600000,
          failed_attempts: 0,
          max_failures: 5,
          stop_id: stop.attempt_id,
          stopped_runtime: stop.runtime_ref,
        },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs.filter((r) => r.assignment_id === f.reviewer.id)).toEqual(
    [expect.objectContaining({ id: run.id, status: "cancelled" })],
  );
  expect(
    f.state.runs.find((r) => r.id === run.id)?.dispatch_stop,
  ).toBeUndefined();
  expect(f.state.events.some((e) => e.type === "run_dispatch_recovered")).toBe(
    false,
  );
});
