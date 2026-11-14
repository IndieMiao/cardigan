import {
  type Assignment,
  acknowledgeRun,
  beginAutomaticContextRestart,
  type ContextObservation,
  createHostOpsAssignment,
  dispatchRun,
  finishHostOpsAction,
  HOST_OPS_ROLE_TOOLS,
  hostOpsPending,
  type Runtime,
  recordContextUsageNotices,
} from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { recordNotification } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { Dispatcher } from "./dispatch.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

let f: ReturnType<typeof dispatchFixture>,
  ops: Assignment,
  service: HostOpsService,
  runtime: Runtime;
let monitor: RuntimeMonitor | undefined;
const snapshot = async () => ({
  model: "fixture",
  agent_cli_version: "fixture",
});
beforeEach(async () => {
  monitor = undefined;
  f = dispatchFixture();
  f.store.uow.run((tx) =>
    tx.roles.put(f.project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  ops = f.apply((s, a, p) => createHostOpsAssignment(s, a, {}, p)).assignment;
  const ref = { ...f.refFor(ops), agent_session_id: "old-session" };
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...ops,
      runtime_state: "idle",
      runtime_ref: ref,
    }),
  );
  const system = { kind: "system", project_id: f.project } as const;
  const usage: ContextObservation = {
    assignment_id: ops.id,
    runtime_key: JSON.stringify(ref),
    session_id: "old-session",
    agent: "pi",
    context_tokens: 850,
    context_window_size: 1000,
    used_percentage: 85,
    cwd: "/fixture",
    model: "fixture",
    transcript_path: null,
    updated_at: f.clock.now(),
    source: "fixture",
  };
  for (let i = 0; i < 2; i++)
    f.apply(
      (s, a, p) => recordContextUsageNotices(s, a, usage, 600000, p),
      system,
    );
  const intent = f.apply(
    (s, a, p) =>
      beginAutomaticContextRestart(
        s,
        a,
        {
          usage,
          stale_after_ms: 600000,
          snapshot: { model: "fixture", agent_cli_version: "fixture" },
        },
        p,
      ),
    system,
  );
  let alive = true;
  runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: {
        process: alive ? "alive" : "exited",
        agent: "idle",
        observed_seq: 1,
      },
    })),
    release: vi.fn(async () => {
      alive = false;
      return { ok: true, value: undefined };
    }),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
  } as unknown as Runtime;
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
  });
  if (!intent) throw new Error("Missing intent");
  // Dispatch tests start after the host has independently confirmed the old exit.
  const finished = f.apply(
    (s, a, p) => finishHostOpsAction(s, a, intent.action_id, p),
    system,
  );
  recordNotification(f.store.database, {
    project_id: f.project,
    event_id: finished.event.id,
    seq: finished.event.seq,
    kind: "assignment",
    at: f.clock.now(),
    recipient: { kind: "assignment", assignment_id: ops.id },
  });
});
afterEach(async () => {
  await monitor?.stop();
  await service.close();
  f.close();
});
const results = () =>
  f.state().events.filter((e) => e.type === "context_session_restart_result");

test.each(["throws", "never_dispatches", "throws_after_dispatch"])(
  "automatic replacement %s enters Needs You once and never restarts or retries its bell",
  async (failure) => {
    const startRun = vi.fn(
      async ({
        assignment,
        run,
      }: Parameters<
        ConstructorParameters<typeof Dispatcher>[0]["startRun"]
      >[0]) => {
        if (failure === "throws") throw new Error("fixture launch failure");
        if (failure === "throws_after_dispatch") {
          f.apply((s, a, p) =>
            dispatchRun(
              s,
              a,
              { run_id: run.id, runtime_ref: f.refFor(assignment) },
              p,
            ),
          );
          throw new Error("fixture after dispatch");
        }
      },
    );
    const options = {
      store: f.store,
      runtime,
      snapshot,
      clock: f.clock,
      startRun,
    };
    let dispatcher = new Dispatcher(options);
    await dispatcher.tick();
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ payload: { result: "failed" } });
    expect(f.state().human_actions).toHaveLength(1);
    expect(hostOpsPending(f.state().events, ops.id)).toBe(true);
    f.advance(600_001);
    dispatcher = new Dispatcher(options);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(startRun).toHaveBeenCalledOnce();
    expect(runtime.wake).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(results()).toHaveLength(1);
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === results()[0]?.id)
        .map((n) => n.recipient.kind)
        .sort(),
    ).toEqual(["needs_you", "pm_office", "pm_ops"]);
  },
);

test("an unstarted replacement times out without automatic recovery or a second stop", async () => {
  const startRun = vi.fn(
    async ({
      assignment,
      run,
    }: Parameters<
      ConstructorParameters<typeof Dispatcher>[0]["startRun"]
    >[0]) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    },
  );
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    startRun,
    dispatchTimeoutMs: 1000,
  });
  await dispatcher.tick();
  expect(results()).toHaveLength(0);
  f.advance(1001);
  await dispatcher.tick();
  expect(results()).toHaveLength(1);
  expect(f.state().human_actions).toHaveLength(1);
  expect(startRun).toHaveBeenCalledOnce();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().events.some((e) => e.type === "run_dispatch_recovered"),
  ).toBe(false);
});

test("a started replacement reports success after dispatch", async () => {
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    startRun: async ({ assignment, run }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
        f.actorFor(assignment),
      );
    },
  });
  await dispatcher.tick();
  await service.tick();
  expect(results()).toHaveLength(1);
  expect(results()[0]).toMatchObject({ payload: { result: "succeeded" } });
  expect(f.state().human_actions).toHaveLength(0);
  expect(
    f.state().events.filter((e) => e.type === "session_replaced"),
  ).toHaveLength(1);
});

function unstartedLaunch() {
  const startRun = vi.fn(
    async ({
      assignment,
      run,
    }: Parameters<
      ConstructorParameters<typeof Dispatcher>[0]["startRun"]
    >[0]) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: {
              ...f.refFor(assignment),
              terminal_ref: "new-terminal",
              agent_session_id: "new-session",
            },
          },
          p,
        ),
      );
    },
  );
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    startRun,
    dispatchTimeoutMs: 1000,
  });
  return { startRun, dispatcher };
}
function expectFailedLaunch() {
  expect(results()).toHaveLength(1);
  expect(results()[0]).toMatchObject({
    payload: {
      result: "failed",
      context_usage: { session_id: "old-session", used_percentage: 85 },
    },
  });
  expect(f.state().human_actions).toHaveLength(1);
  expect(f.state().human_actions[0]).toMatchObject({
    triage: "human",
    status: "open",
  });
  expect(hostOpsPending(f.state().events, ops.id)).toBe(true);
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === results()[0]?.id)
      .map((n) => n.recipient.kind)
      .sort(),
  ).toEqual(["needs_you", "pm_office", "pm_ops"]);
  expect(runtime.release).not.toHaveBeenCalled();
  expect(runtime.wake).not.toHaveBeenCalled();
}

test.each([false, true])(
  "startup timeout with historical recovery still fails once (active PM Ops=%s)",
  async (withPm) => {
    f.store.uow.run((tx) => {
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project),
        type: "run_dispatch_recovered",
        actor: { kind: "system", project_id: f.project },
        created_at: f.clock.now(),
        payload: { assignment_id: ops.id, reason: "dispatch_timeout" },
      });
      if (withPm)
        tx.assignments.put(f.project, {
          ...ops,
          id: tx.ids.next(f.project, "assignment"),
          role_id: "pm",
          standing_mode: "ops",
        });
    });
    const { startRun, dispatcher } = unstartedLaunch();
    await dispatcher.tick();
    f.advance(1001);
    await dispatcher.tick();
    await service.tick();
    expectFailedLaunch();
    expect(
      f.state().events.filter((e) => e.type === "run_dispatch_stalled"),
    ).toHaveLength(0);
    f.advance(600_000);
    await dispatcher.tick();
    await service.tick();
    expectFailedLaunch();
    expect(startRun).toHaveBeenCalledOnce();
  },
);

async function monitoredLaunch() {
  const launch = unstartedLaunch();
  await launch.dispatcher.tick();
  const events = runtimeEvents();
  monitor = new RuntimeMonitor({
    store: f.store,
    runtime: events.source,
    clock: f.clock,
  });
  monitor.reconcile();
  return { ...launch, events };
}

test("monitor observes exit before first MCP start and records one automatic failure on the running dispatcher", async () => {
  const { startRun, dispatcher, events } = await monitoredLaunch();
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: ops.id,
    role: {
      role_version: ops.role_version,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
    },
  });
  const ref = f.state().assignments.find((a) => a.id === ops.id)?.runtime_ref;
  events.send({ seq: 1, type: "finished", terminal_ref: "new-terminal" });
  await expect.poll(() => f.state().runs[0]?.status).toBe("unknown");
  await service.tick();
  await dispatcher.tick();
  expectFailedLaunch();
  f.advance(600_000);
  monitor?.reconcile();
  await dispatcher.tick();
  await service.tick();
  expectFailedLaunch();
  expect(startRun).toHaveBeenCalledOnce();
  expect(f.state().runs[0]?.started_at).toBeUndefined();
  expect(f.state().runs[0]?.status).toBe("unknown");
  expect(
    f.state().assignments.find((a) => a.id === ops.id)?.runtime_ref,
  ).toEqual(ref);
  expect(f.store.verifyToken(token.token)).toBeDefined();
});

async function exhaustSubscriptions(events: ReturnType<typeof runtimeEvents>) {
  for (let i = 0; i < 3; i++) {
    events.sessions.at(-1)?.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    monitor?.reconcile();
  }
  expect(f.state().runs[0]?.status).toBe("unknown");
}

test("subscription failures preserve the existing loss grace before failing an unstarted replacement", async () => {
  const { startRun, dispatcher, events } = await monitoredLaunch();
  await exhaustSubscriptions(events);
  await service.tick();
  expect(results()).toHaveLength(0);
  f.advance(299_999);
  monitor?.reconcile();
  await dispatcher.tick();
  await service.tick();
  expect(results()).toHaveLength(0);
  f.advance(1);
  monitor?.reconcile();
  await service.tick();
  expectFailedLaunch();
  expect(startRun).toHaveBeenCalledOnce();
  expect(
    f.state().assignments.find((a) => a.id === ops.id)?.runtime_state,
  ).toBe("lost");
});

test("reconnection within the loss grace and late events for another terminal do not fail the new launch", async () => {
  const { events } = await monitoredLaunch();
  events.send({ seq: 1, type: "finished", terminal_ref: "old-terminal" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(results()).toHaveLength(0);
  await exhaustSubscriptions(events);
  f.advance(20_000);
  events.send({
    seq: 2,
    type: "snapshot",
    observations: [
      {
        terminal_ref: "new-terminal",
        status: { process: "alive", agent: "idle", observed_seq: 2 },
      },
    ],
  });
  await expect
    .poll(
      () => f.state().assignments.find((a) => a.id === ops.id)?.runtime_state,
    )
    .toBe("idle");
  await service.tick();
  expect(results()).toHaveLength(0);
  expect(f.state().human_actions).toHaveLength(0);
});

test("a stale subscription cannot fail a successor even if the terminal name is reused", async () => {
  const { events } = await monitoredLaunch();
  f.store.uow.run((tx) => {
    const a = tx.assignments.get(f.project, ops.id);
    if (!a?.runtime_ref) throw new Error("Missing fixture");
    tx.assignments.put(f.project, {
      ...a,
      runtime_ref: { ...a.runtime_ref, agent_session_id: "successor-session" },
    });
  });
  events.send({ seq: 1, type: "finished", terminal_ref: "new-terminal" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.tick();
  expect(results()).toHaveLength(0);
  expect(f.state().runs[0]?.status).toBe("dispatched");
});

test("monitor exit after the first MCP start does not override the successful replacement", async () => {
  const { events } = await monitoredLaunch();
  const run = f.state().runs[0];
  if (!run) throw new Error("Missing run");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(ops),
  );
  events.send({ seq: 1, type: "finished", terminal_ref: "new-terminal" });
  await expect.poll(() => f.state().runs[0]?.status).toBe("unknown");
  await service.tick();
  expect(results()).toHaveLength(1);
  expect(results()[0]).toMatchObject({ payload: { result: "succeeded" } });
  expect(f.state().human_actions).toHaveLength(0);
  expect(hostOpsPending(f.state().events, ops.id)).toBe(false);
});
