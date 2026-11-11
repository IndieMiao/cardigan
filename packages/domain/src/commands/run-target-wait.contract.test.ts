import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  claimDispatchStop,
  dispatchTargetWaitMs,
  prepareDelivery,
  refreshRunTargetWait,
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
import { human, subject, value } from "./test-fixtures.js";

beforeEach(setup);
async function deliver() {
  if (!f.state.runs.some((r) => r.assignment_id === f.coder.id)) {
    const run = commit(dispatch(commit(queue())));
    commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  }
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
const withdraw = () => {
  f.state = {
    ...f.state,
    deliveries: f.state.deliveries.map((d) => ({ ...d, status: "superseded" })),
  };
};
const reviewerRef = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "reviewer",
  agent_name: "reviewer",
};

test.each(["queued", "dispatched"] as const)(
  "invariants 10, 11, 12: %s target wait preserves Run identity and only excludes actual wait time",
  async (status) => {
    await deliver();
    const run = commit(queue(f.reviewer));
    if (status === "dispatched") commit(dispatch(run, reviewerRef));
    let now = Date.parse(f.io.clock.now());
    f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
    const refresh = () =>
      commit(refreshRunTargetWait(f.state, system, { run_id: run.id }, f.io));
    expect(refresh()).toBe(false);
    withdraw();
    expect(refresh()).toBe(true);
    const events = f.state.events.length;
    now += 60 * 60_000;
    expect(refresh()).toBe(true);
    expect(f.state.events).toHaveLength(events);
    const waiting = f.state.runs.find((r) => r.id === run.id);
    if (!waiting) throw new Error("Missing Run");
    expect(waiting.status).toBe(status);
    expect(dispatchTargetWaitMs(waiting, f.io.clock.now())).toBe(60 * 60_000);
    await deliver();
    expect(refresh()).toBe(false);
    const resumed = f.state.runs.find((r) => r.id === run.id);
    if (!resumed) throw new Error("Missing Run");
    expect(resumed.dispatch_target_wait?.since).toBeUndefined();
    now += 30_000;
    expect(dispatchTargetWaitMs(resumed, f.io.clock.now())).toBe(60 * 60_000);
    withdraw();
    refresh();
    now += 10_000;
    await deliver();
    refresh();
    const again = f.state.runs.find((r) => r.id === run.id);
    if (!again) throw new Error("Missing Run");
    expect(dispatchTargetWaitMs(again, f.io.clock.now())).toBe(
      60 * 60_000 + 10_000,
    );
    expect(
      f.state.runs.filter((r) => r.assignment_id === f.reviewer.id),
    ).toHaveLength(1);
    if (status === "queued")
      expect(
        commit(dispatch(again, reviewerRef)).dispatch_target_wait,
      ).toBeUndefined();
  },
);

test("invariant 11: agents cannot manipulate wait timing; started Runs and producers do not enter target wait", async () => {
  await deliver();
  const queued = commit(queue(f.reviewer));
  const run = commit(dispatch(queued, reviewerRef));
  expect(
    refreshRunTargetWait(f.state, actor(f.reviewer), { run_id: run.id }, f.io),
  ).toMatchObject({ ok: false });
  commit(acknowledgeRun(f.state, actor(f.reviewer), { run_id: run.id }, f.io));
  withdraw();
  expect(
    commit(refreshRunTargetWait(f.state, human, { run_id: run.id }, f.io)),
  ).toBe(false);
  const producer = f.state.runs.find((r) => r.assignment_id === f.coder.id);
  if (!producer) throw new Error("Missing producer");
  expect(
    commit(
      refreshRunTargetWait(f.state, system, { run_id: producer.id }, f.io),
    ),
  ).toBe(false);
  expect(f.state.runs.every((r) => !r.dispatch_target_wait)).toBe(true);
});

test("invariant 11: target withdrawal during recovery preflight prevents the stop fence and preserves the dispatched Run", async () => {
  await deliver();
  const run = commit(dispatch(commit(queue(f.reviewer)), reviewerRef));
  const claim = () =>
    commit(
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
  const claimed = claim();
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("Missing stop claim");
  withdraw();
  expect(
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
    ),
  ).toBe(false);
  expect(claim()).toBeUndefined();
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "dispatched",
  });
  expect(
    f.state.runs.find((r) => r.id === run.id)?.dispatch_stop,
  ).toBeUndefined();
});
