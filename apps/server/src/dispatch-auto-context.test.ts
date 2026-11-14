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
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof dispatchFixture>,
  ops: Assignment,
  service: HostOpsService,
  runtime: Runtime;
const snapshot = async () => ({
  model: "fixture",
  agent_cli_version: "fixture",
});
beforeEach(async () => {
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
  await service.close();
  f.close();
});
const results = () =>
  f.state().events.filter((e) => e.type === "context_session_restart_result");

test.each(["throws", "never_dispatches", "throws_after_dispatch", "snapshot"])(
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
