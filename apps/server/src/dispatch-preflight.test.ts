import { type Assignment, postComment, queueRun } from "@cardigan/domain";
import {
  agentCliVersion,
  RuntimeTargetError,
  RuntimeTargets,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import { startQueuedRun } from "./host-start.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture("worker");
});
afterEach(() => f.close());
function create(employee = false) {
  if (employee)
    f.store.uow.run((tx) =>
      tx.employees.put({
        id: "E-1",
        name: "Tester",
        title: "Developer",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: "fixture",
        status: "active",
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      }),
    );
  return f.create();
}
const notify = ({ card, item }: ReturnType<typeof create>) =>
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: card.id, work_item_id: item.id, body: "work" },
      p,
    ),
  );
const alerts = () =>
  f.state().events.filter((e) => e.type === "bell_delivery_failed");
const retry = (a: Assignment) =>
  f.state().assignments.find((row) => row.id === a.id)?.snapshot_retry;
const testOptions = () => ({
  ...f.options,
  deliveryRetryBaseMs: 100,
  maxRetries: 1,
});
const execution = {
  mode: "agent-ssh" as const,
  dataDir: "/unused",
  agentRoot: "/worker",
  gid: 1000,
  machine: "fixture",
  identityFile: "/unused/key",
  knownHostsFile: "/unused/known",
};

// Keep the real result/error wrapping from target check through version discovery.
test.each(["mcp_timeout", "remote_launch_disabled"])(
  "cold version target recheck: %s",
  async (reason) => {
    const target = create();
    notify(target);
    const rt: RuntimeTargets = Object.create(RuntimeTargets.prototype);
    const machine = f.state().machines?.find((m) => m.id === "worker");
    if (!machine) throw new Error("Missing worker fixture");
    const launch = vi
      .spyOn(rt, "forLaunch")
      .mockResolvedValueOnce({
        execution,
        session: "fixture",
        machine,
      })
      .mockRejectedValueOnce(new RuntimeTargetError(reason));
    const snapshot = vi
      .fn(f.options.snapshot)
      .mockImplementationOnce(async (a, p) => {
        const { execution } = await rt.forLaunch(p, a);
        return {
          model: "fixture",
          agent_cli_version: await agentCliVersion(
            {
              execution,
              captureLocal: vi.fn(),
              captureAgent: (command, args) =>
                rt.captureFor(p, a, command, args),
            },
            "pi",
          ),
        };
      });
    const d = new Dispatcher({ ...testOptions(), snapshot });
    await d.tick();
    expect(launch).toHaveBeenCalledTimes(2);
    const transient = reason === "mcp_timeout";
    expect(alerts()).toHaveLength(transient ? 0 : 1);
    f.advance(99);
    await d.tick();
    expect(snapshot).toHaveBeenCalledTimes(1);
    f.advance(1);
    await d.tick();
    expect(f.options.startRun).toHaveBeenCalledTimes(transient ? 1 : 0);
  },
);

test("target-wait Run with acknowledged inbox backs off across restart and alerts once on exhaustion", async () => {
  const { assignment, card } = create(true);
  const trigger = f
    .state()
    .events.find(
      (e) => e.card_id === card.id && e.type === "work_item_assigned",
    );
  if (!trigger) throw new Error("Missing assignment trigger");
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        trigger_event_id: trigger.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...run,
      dispatch_target_wait: { elapsed_ms: 15 },
    }),
  );
  f.skipEvents();
  const snapshot = vi
    .fn()
    .mockRejectedValue(new RuntimeTargetError("mcp_timeout"));
  const opts = { ...testOptions(), snapshot };
  await new Dispatcher(opts).tick();
  expect(retry(assignment)?.failures).toBe(1);
  expect(alerts()).toHaveLength(0);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: assignment.id,
      status: "pending",
    }),
  ).toHaveLength(0);
  f.advance(99);
  const d = new Dispatcher(opts);
  await d.tick();
  expect(snapshot).toHaveBeenCalledTimes(1);
  f.advance(1);
  await d.tick();
  await d.tick();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(alerts()).toHaveLength(1);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
});

test("capacity contenders skip a backing-off head but do not repeatedly probe a full machine", async () => {
  const first = create(true);
  notify(first);
  f.advance(1);
  const second = create();
  notify(second);
  let limit = 0;
  const snapshot = vi.fn(f.options.snapshot);
  const d = new Dispatcher({
    ...testOptions(),
    snapshot,
    runLimit: () => limit,
  });
  await d.tick();
  await d.tick();
  expect(snapshot).toHaveBeenCalledTimes(2);
  const queued = f.state().runs.filter((r) => r.status === "queued");
  expect(queued).toHaveLength(2);
  snapshot.mockImplementationOnce(async (owner) => {
    expect(owner.id).toBe(first.assignment.id);
    throw new RuntimeTargetError("machine_check_runtime_queue_timeout");
  });
  limit = 2;
  await d.tick();
  await d.tick();
  expect(retry(first.assignment)?.failures).toBe(1);
  expect(f.options.startRun).toHaveBeenCalledTimes(1);
  expect(f.options.startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      assignment: expect.objectContaining({ id: second.assignment.id }),
    }),
  );
  f.advance(100);
  await d.tick();
  expect(f.options.startRun).toHaveBeenCalledTimes(2);
  expect(
    f
      .state()
      .runs.filter((r) => queued.some((q) => q.id === r.id))
      .map((r) => r.status),
  ).toEqual(["dispatched", "dispatched"]);
});

test.each(["recover", "exhaust"])(
  "pre-token target recheck %s retains the original claimed Run",
  async (outcome) => {
    const target = create(true);
    notify(target);
    const rt: RuntimeTargets = Object.create(RuntimeTargets.prototype);
    const forLaunch = vi
      .spyOn(rt, "forLaunch")
      .mockRejectedValue(new RuntimeTargetError("mcp_protocol_error"));
    const opts = testOptions();
    const fail: typeof opts.startRun = (input) =>
      startQueuedRun(
        {
          store: f.store,
          runtime: rt,
          launch: { config: { profiles: {} }, secrets: {} },
          mcpUrl: "",
          dataDir: f.dataDir,
          clock: f.clock,
        },
        input,
      );
    const startRun = vi
      .fn(outcome === "recover" ? f.options.startRun : fail)
      .mockImplementationOnce(fail);
    const d = new Dispatcher({ ...opts, startRun });
    await d.tick();
    const id = startRun.mock.calls[0]?.[0].run.id;
    expect(f.state().runs.find((r) => r.id === id)?.status).toBe("queued");
    expect(retry(target.assignment)?.failures).toBe(1);
    expect(alerts()).toHaveLength(0);
    expect(
      f.store.uow.run((tx) =>
        tx.tokensForAssignment(f.project, target.assignment.id),
      ),
    ).toHaveLength(0);
    f.advance(99);
    await d.tick();
    expect(forLaunch).toHaveBeenCalledTimes(1);
    f.advance(1);
    await d.tick();
    await d.tick();
    expect(startRun.mock.calls.map(([input]) => input.run.id)).toEqual([
      id,
      id,
    ]);
    expect(retry(target.assignment)).toBeUndefined();
    expect(alerts()).toHaveLength(outcome === "recover" ? 0 : 1);
  },
);

test("shutdown during the final snapshot leaves the budget and inbox to the next dispatcher", async () => {
  const target = create();
  notify(target);
  const entered = Promise.withResolvers<void>();
  const probe = Promise.withResolvers<never>();
  const snapshot = vi
    .fn(f.options.snapshot)
    .mockRejectedValueOnce(new RuntimeTargetError("mcp_timeout"))
    .mockImplementationOnce(() => {
      entered.resolve();
      return probe.promise;
    });
  const opts = { ...testOptions(), snapshot };
  const d = new Dispatcher(opts);
  await d.tick();
  const budget = retry(target.assignment);
  f.advance(100);
  const tick = d.tick();
  await entered.promise;
  d.close();
  probe.reject(new RuntimeTargetError("mcp_timeout"));
  await tick;
  expect(retry(target.assignment)).toEqual(budget);
  expect(alerts()).toHaveLength(0);
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: target.assignment.id,
      status: "pending",
    }).length,
  ).toBeGreaterThan(0);
  await new Dispatcher(opts).tick();
  expect(f.options.startRun).toHaveBeenCalledTimes(1);
});
