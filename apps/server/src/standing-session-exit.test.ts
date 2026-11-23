import {
  type Assignment,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type HOST_OPS_TOOLS,
  hostOpsPending,
  type Runtime,
  type RuntimeObservation,
} from "@cardigan/domain";
import {
  HostOpsService,
  STANDING_EXIT_STEP,
  standingExitSteps,
  UpstreamHealthMonitor,
} from "@cardigan/host";
import {
  authenticate,
  hostOpsTools,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";

// C-625: the old session of a standing PM restart leaves reliably when idle,
// is never signalled while busy, and the restart settles exactly once.
let f: ReturnType<typeof dispatchFixture>;
let ops: Assignment;
let context: ToolContext;
let service: HostOpsService;
let process_: RuntimeObservation["process"];
let agent: RuntimeObservation["agent"];
let runtime: Runtime;
const policy = { grace_ms: 60_000, overdue_ms: 300_000, settle_ms: 1 };
const snapshot = vi.fn(async () => ({
  model: "fixture",
  agent_cli_version: "fixture",
}));

beforeEach(() => {
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
  const issued = f.store.issueToken({
    project_id: f.project,
    assignment_id: ops.id,
    role: {
      role_version: ops.role_version,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
    },
  });
  context = {
    store: f.store,
    identity: unwrap(authenticate(f.store, issued.token)),
  };
  process_ = "alive";
  agent = "idle";
  // Like the incident: neither the exit command nor anything else ends the
  // session unless a test says so.
  runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: process_, agent, observed_seq: 7 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    retire_idle: vi.fn(async () => {
      process_ = "exited";
      return {
        ok: true,
        value: {
          outcome: "exited",
          signalled: {
            pid: 2678027,
            signals: ["HUP", "TERM"],
            exit_code: 143,
            exit_reason: "signaled",
          },
        },
      };
    }),
  } as unknown as Runtime;
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    standingExit: policy,
  });
});
afterEach(async () => {
  await service.close();
  f.close();
});

async function call(name: (typeof HOST_OPS_TOOLS)[number], input: object) {
  const tool = hostOpsTools({ hostOps: service.tools }).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error("Missing tool");
  return tool.handler(tool.input.parse(input), context);
}

/** A standing PM whose Run is still open while its session sits idle. */
function standingPm(harness: string | undefined = "claude-code") {
  f.create(); // Registers the PM role.
  const pm: Assignment = {
    ...ops,
    id: "A-90" as never,
    role_id: "pm",
    standing_mode: "ops",
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  const run = f.session(pm, false);
  if (harness)
    f.store.uow.run((tx) => {
      const r = tx.runs.list(f.project).find((v) => v.id === run.id);
      if (r) tx.runs.put(f.project, { ...r, harness: harness as never });
    });
  return { pm, run };
}
async function restart(pm: Assignment, key = "restart") {
  await call("host_ops_restart_standing_pm", {
    assignment_id: pm.id,
    reason: "context restart",
    idempotency_key: key,
  });
}
/** Each drain claims the action for 60 s; the next one starts after it. */
async function drain(ms = 60_000) {
  f.advance(ms);
  await service.tick();
}
const steps = (actionId: string) =>
  standingExitSteps(f.state().events, actionId).map((s) => s.step);
const actionId = () => {
  const taken = f
    .state()
    .events.find((e) => e.type === "host_ops_action_taken");
  if (!taken) throw new Error("Missing action");
  return taken.id;
};
function expectSettledOnce(pm: Assignment) {
  const state = f.state();
  expect(hostOpsPending(state.events, pm.id)).toBe(false);
  expect(
    state.events.filter((e) => e.type === "standing_session_restarted"),
  ).toHaveLength(1);
  expect(
    state.events.filter((e) => e.type === "host_ops_action_finished"),
  ).toHaveLength(1);
  expect(
    state.runs.filter(
      (r) =>
        r.assignment_id === pm.id &&
        !["completed", "failed", "cancelled"].includes(r.status),
    ),
  ).toHaveLength(1);
  expect(state.assignments.find((a) => a.id === pm.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
}

test("an idle session that exits on the exit command settles without any signal", async () => {
  const { pm, run } = standingPm();
  vi.mocked(runtime.wake).mockImplementation(async () => {
    process_ = "exited";
    return { ok: true, value: { sent: true } };
  });
  await restart(pm);
  await service.tick();
  expect(runtime.wake).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ terminal_ref: expect.any(String) }),
    "/exit",
    expect.objectContaining({ if_idle: true }),
  );
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(steps(actionId())).toEqual(["exit_command", "exited"]);
  const exitStep = f
    .state()
    .events.find(
      (e) =>
        e.type === STANDING_EXIT_STEP &&
        (e.payload as { step: string }).step === "exit_command",
    );
  expect(exitStep?.payload).toMatchObject({
    command: "/exit",
    sent: true,
    idle_basis: "terminal_status_idle",
    observed_seq: 7,
  });
  expect(
    f.state().events.findLast((e) => e.type === STANDING_EXIT_STEP)?.payload,
  ).toMatchObject({ step: "exited", method: "exit_command" });
  expectSettledOnce(pm);
  // The old open Run was replaced; the session's work is handed over.
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
});

test("an idle session that ignores the exit command is signalled once after the grace period, with evidence", async () => {
  const { pm } = standingPm();
  await restart(pm);
  await service.tick();
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(hostOpsPending(f.state().events, pm.id)).toBe(true);
  // The guard on the operation is not relaxed while it waits.
  await expect(restart(pm, "again")).rejects.toMatchObject({
    code: "illegal_transition",
  });
  // Within the grace period nothing is signalled and no command is re-sent.
  await drain(30_000);
  await drain(20_000);
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  await drain(60_000);
  expect(runtime.retire_idle).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      project_id: f.project,
      assignment_id: pm.id,
      report_signals: true,
    }),
  );
  expect(runtime.release).not.toHaveBeenCalled();
  expect(steps(actionId())).toEqual(["exit_command", "terminate", "exited"]);
  expect(
    f.state().events.findLast((e) => e.type === STANDING_EXIT_STEP)?.payload,
  ).toMatchObject({ step: "exited", method: "terminate" });
  const terminate = f
    .state()
    .events.find(
      (e) =>
        e.type === STANDING_EXIT_STEP &&
        (e.payload as { step: string }).step === "terminate",
    );
  expect(terminate?.payload).toMatchObject({
    outcome: "exited",
    pid: 2678027,
    signals: ["HUP", "TERM"],
    exit_code: 143,
    exit_reason: "signaled",
    terminal_ref: expect.any(String),
  });
  expect(terminate?.created_at).toBe(f.clock.now());
  expectSettledOnce(pm);
  // Later patrols neither restart again nor signal again.
  await drain();
  await drain();
  expect(runtime.retire_idle).toHaveBeenCalledTimes(1);
  expectSettledOnce(pm);
});

test("a busy session is never signalled; host operations are reminded once at the threshold", async () => {
  const { pm } = standingPm();
  agent = "working";
  await restart(pm);
  await service.tick();
  for (let i = 0; i < 6; i++) await drain();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, pm.id)).toBe(true);
  expect(steps(actionId())).toEqual(["busy", "overdue"]);
  const overdue = f
    .state()
    .events.find(
      (e) =>
        e.type === STANDING_EXIT_STEP &&
        (e.payload as { step: string }).step === "overdue",
    );
  expect(overdue?.payload).toMatchObject({
    reason: "old_session_busy",
    host_ops_assignment_id: ops.id,
  });
  const reminders = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.event_id === overdue?.id);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]?.recipient).toEqual({
    kind: "assignment",
    assignment_id: ops.id,
  });
  // A blocked prompt is not idle either.
  agent = "blocked";
  await drain();
  expect(runtime.wake).not.toHaveBeenCalled();
  // Once the turn ends the normal exit path completes the restart.
  agent = "idle";
  vi.mocked(runtime.wake).mockImplementation(async () => {
    process_ = "exited";
    return { ok: true, value: { sent: true } };
  });
  await drain();
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expectSettledOnce(pm);
  expect(steps(actionId())).toEqual([
    "busy",
    "overdue",
    "exit_command",
    "exited",
  ]);
});

test("a session that turns busy after the exit command is not signalled", async () => {
  const { pm } = standingPm();
  await restart(pm);
  await service.tick();
  agent = "working";
  await drain(120_000);
  await drain();
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, pm.id)).toBe(true);
});

test("a harness without a known exit command is never typed into; an idle one is signalled", async () => {
  const { pm } = standingPm("pi");
  await restart(pm);
  await service.tick();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(runtime.retire_idle).toHaveBeenCalledTimes(1);
  expect(steps(actionId())).toEqual(["terminate", "exited"]);
  expectSettledOnce(pm);
});

test("a kept terminal falls back to one terminal kill after the grace period", async () => {
  const { pm } = standingPm();
  vi.mocked(runtime.retire_idle!).mockResolvedValue({
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: { stage: "get", reason: "kept_terminal" },
    },
  });
  vi.mocked(runtime.release).mockImplementation(async () => {
    process_ = "exited";
    return { ok: true, value: undefined };
  });
  await restart(pm);
  await service.tick();
  await drain();
  expect(runtime.release).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    force: true,
  });
  expect(steps(actionId())).toEqual([
    "exit_command",
    "terminal_kill",
    "exited",
  ]);
  expectSettledOnce(pm);
});

test("a signal that does not end the session is not repeated; host operations are reminded", async () => {
  const { pm } = standingPm();
  vi.mocked(runtime.retire_idle!).mockResolvedValue({
    ok: true,
    value: {
      outcome: "timeout",
      evidence: { stage: "TERM", reason: "still_live" },
    },
  });
  await restart(pm);
  await service.tick();
  for (let i = 0; i < 6; i++) await drain();
  expect(runtime.retire_idle).toHaveBeenCalledTimes(1);
  expect(runtime.release).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, pm.id)).toBe(true);
  expect(steps(actionId())).toEqual(["exit_command", "terminate", "overdue"]);
  // The process later exits on its own: settled once, by observation only.
  process_ = "exited";
  await drain();
  expectSettledOnce(pm);
  expect(runtime.retire_idle).toHaveBeenCalledTimes(1);
});

test("an inconclusive interaction holds an idle session only until the threshold, then the restart completes", async () => {
  const { pm, run } = standingPm();
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "claude-code",
        upstream: {
          group: "relay",
          probe_url: "https://gateway.example.invalid",
        },
      },
    },
    profiles: { fixture: { harness: "claude-code", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 1_000_000 },
    },
  });
  // A Claude session idle at its prompt reads as an inconclusive interaction.
  runtime.interaction = vi.fn(async () => ({
    ok: true as const,
    value: "unknown" as const,
  }));
  const monitor = new UpstreamHealthMonitor(
    config,
    runtime,
    f.clock,
    async () => ({ status: "reachable" }),
    f.store,
  );
  f.store.uow.run((tx) => {
    for (const r of tx.runs.list(f.project))
      tx.runs.put(f.project, { ...r, launch_profile_ref: "fixture" });
  });
  await service.close();
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    upstreamMonitor: monitor,
    standingExit: policy,
  });
  await restart(pm);
  // The PM's open Run is then marked inactive while its session sits idle.
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: "run_inactive",
      actor: { kind: "system", project_id: f.project },
      created_at: f.clock.now(),
      payload: {
        assignment_id: pm.id,
        run_id: run.id,
        reason: "mcp_inactivity",
      },
    }),
  );
  vi.mocked(runtime.wake).mockImplementation(async () => {
    process_ = "exited";
    return { ok: true, value: { sent: true } };
  });
  const settledWorkers = async () => {
    await service.tick();
    await vi.waitFor(() =>
      expect(
        f.state().events.filter((e) => e.type === "host_ops_action_claimed")
          .length,
      ).toBeGreaterThan(claims),
    );
    await new Promise((r) => setTimeout(r, 50));
    claims = f
      .state()
      .events.filter((e) => e.type === "host_ops_action_claimed").length;
  };
  let claims = 0;
  await settledWorkers();
  for (let i = 0; i < 3; i++) {
    f.advance(60_000);
    await settledWorkers();
  }
  // Held by the diagnosis, as in the incident: nothing typed or signalled.
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, pm.id)).toBe(true);
  expect(
    f
      .state()
      .events.some(
        (e) =>
          e.type === "host_ops_action_deferred" &&
          (e.payload as { reason?: string }).reason ===
            "upstream_recovery_not_ready",
      ),
  ).toBe(true);
  f.advance(150_000);
  await service.tick();
  await vi.waitFor(() => expectSettledOnce(pm));
  expect(runtime.wake).toHaveBeenCalledTimes(1);
  expect(steps(actionId())).toEqual(["exit_command", "exited"]);
  await service.close();
});

test("an exit command refused at the send slot is retried; an uncertain one starts the grace period", async () => {
  const { pm } = standingPm();
  vi.mocked(runtime.wake).mockResolvedValue({
    ok: true,
    value: { sent: false, withdrawn: true },
  });
  await restart(pm);
  await service.tick();
  await drain();
  expect(runtime.wake).toHaveBeenCalledTimes(2);
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  expect(steps(actionId())).toEqual(["exit_command"]);
  // A failed send does not prove nothing was typed: no third command.
  vi.mocked(runtime.wake).mockImplementation(async (_ref, _bell, options) => {
    options?.before_send?.();
    return {
      ok: false,
      error: { code: "runtime_timeout", message: "fixture" },
    };
  });
  await drain();
  await drain(30_000);
  expect(runtime.wake).toHaveBeenCalledTimes(3);
  expect(runtime.retire_idle).not.toHaveBeenCalled();
  await drain();
  expect(runtime.retire_idle).toHaveBeenCalledTimes(1);
  expect(steps(actionId())).toEqual([
    "exit_command",
    "exit_command",
    "terminate",
    "exited",
  ]);
  expectSettledOnce(pm);
});
