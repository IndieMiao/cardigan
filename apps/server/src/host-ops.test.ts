import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Assignment,
  acknowledgeRun,
  assign,
  completeHumanAction,
  createHostOpsAssignment,
  dispatchRun,
  HOST_OPS_ROLE_TOOLS,
  type HOST_OPS_TOOLS,
  hostOpsExitConfirmation,
  hostOpsPending,
  queueRun,
  type Runtime,
  type ToolName,
} from "@cardigan/domain";
import {
  HostOpsService,
  runCapacitySnapshot,
  scrubRunCredentials,
} from "@cardigan/host";
import {
  authenticate,
  hostOpsTools,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import {
  SECRETS_FILE_NAME,
  START_FILE_NAME,
  TOKEN_FILE_NAME,
} from "@cardigan/roles";
import { executionPaths } from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { resolveServerConfig } from "./config.js";
import { Dispatcher } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { patrolHostOps } from "./host-ops-patrol.js";

let f: ReturnType<typeof dispatchFixture>,
  ops: Assignment,
  context: ToolContext,
  runtime: Runtime;
let service: HostOpsService;
let alive: boolean;
const snapshot = vi.fn(async () => ({
  model: "fixture",
  agent_cli_version: "fixture",
}));
const connect = (
  a: Assignment,
  allowed_tools: readonly ToolName[] = HOST_OPS_ROLE_TOOLS,
): ToolContext => {
  const issued = f.store.issueToken({
    project_id: f.project,
    assignment_id: a.id,
    role: { role_version: a.role_version, allowed_tools },
  });
  return {
    store: f.store,
    identity: unwrap(authenticate(f.store, issued.token)),
    revalidateToken: () => {
      if (!f.store.verifyToken(issued.token)) throw new Error("Token revoked");
    },
  };
};
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
  context = connect(ops);
  alive = true;
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
      expect(
        f.state().events.some((e) => e.type === "host_ops_action_taken"),
      ).toBe(true);
      alive = false;
      return { ok: true, value: undefined };
    }),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
  } as unknown as Runtime;
  snapshot.mockClear();
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
  });
});
afterEach(() => f.close());
async function call(
  name: (typeof HOST_OPS_TOOLS)[number],
  input: object,
  c = context,
) {
  const tool = hostOpsTools({ hostOps: service.tools }).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error("Missing tool");
  return tool.handler(tool.input.parse(input), c);
}
function dispatched() {
  const { assignment, card } = f.create();
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.apply((s, a, p) =>
    dispatchRun(s, a, { run_id: run.id, runtime_ref: f.refFor(assignment) }, p),
  );
  return { assignment, card, run };
}

test("fake Agent: patrol discovers dispatched Run; MCP restart goes through host and dispatcher to running", async () => {
  const { assignment, run } = dispatched();
  f.advance(1_800_000);
  patrolHostOps(f.store, f.project, f.clock);
  const notes = f.store.listNotifications({ project_id: f.project });
  expect(
    notes.some(
      (n) =>
        n.recipient.kind === "assignment" &&
        n.recipient.assignment_id === ops.id,
    ),
  ).toBe(true);
  const diagnostics = (await call("host_ops_read_diagnostics", {})) as {
    runs: { id: string; status: string }[];
  };
  expect(diagnostics.runs).toContainEqual(
    expect.objectContaining({ id: run.id, status: "dispatched" }),
  );
  const request = {
    assignment_id: assignment.id,
    reason: "Stalled dispatch",
    idempotency_key: "restart",
  };
  const accepted = await call("host_ops_restart_assignment", request);
  expect(await call("host_ops_restart_assignment", request)).toEqual(accepted);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(runtime.release).not.toHaveBeenCalled();
  await new Dispatcher({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    hostOpsTick: () => service.tick(),
    startRun: async ({ assignment, run }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: {
              ...f.refFor(assignment),
              terminal_ref: `replacement-${run.id}`,
            },
          },
          p,
        ),
      );
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
        f.actorFor(assignment),
      );
    },
  }).tick();
  const state = f.state();
  expect(state.runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(
    state.runs.filter(
      (r) => r.assignment_id === assignment.id && r.status === "running",
    ),
  ).toHaveLength(1);
  expect(
    state.events.filter((e) => e.type === "host_ops_action_taken"),
  ).toHaveLength(1);
  expect(runtime.release).toHaveBeenCalledWith(f.refFor(assignment), {
    force: true,
  });
});

test("cancel waits for proven exit; restart of the service resumes the durable action and revokes only target credentials", async () => {
  const { assignment, run } = dispatched();
  const targetContext = connect(assignment, ["finish_run"]);
  vi.mocked(runtime.release).mockImplementation(async () => ({
    ok: false,
    error: { code: "runtime_unavailable", message: "Unavailable" },
  }));
  await call("host_ops_cancel_run", {
    run_id: run.id,
    reason: "Stop stalled run",
    idempotency_key: "cancel",
  });
  await service.tick();
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
  expect(hostOpsPending(f.state().events, assignment.id)).toBe(true);
  expect(() => targetContext.revalidateToken?.()).not.toThrow();
  const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    alive = false;
    f.advance(60_000);
    const restarted = new HostOpsService({
      store: reopened,
      runtime,
      snapshot,
      clock: f.clock,
    });
    await restarted.tick();
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "cancelled",
    );
    expect(
      f.state().runs.filter((r) => r.assignment_id === assignment.id),
    ).toHaveLength(1);
    expect(() => targetContext.revalidateToken?.()).toThrow();
    expect(() => context.revalidateToken?.()).not.toThrow();
  } finally {
    reopened.close();
  }
});

test("target withdrawal while stopping a reviewer settles credentials without queuing a replacement", async () => {
  const source = f.create();
  const sourceRun = f.session(source.assignment);
  const item = f
    .state()
    .work_items.find(
      (w) => w.kind === "verify" && w.target_work_item_id === source.item.id,
    );
  if (!item) throw new Error("Missing reviewer work item");
  const reviewer = f.apply((s, a, p) =>
    assign(s, a, { work_item_id: item.id, role_id: item.role_id }, p),
  );
  const delivery = f.store.uow.run((tx) => {
    const delivery = {
      id: tx.ids.next(f.project, "delivery"),
      work_item_id: source.item.id,
      run_id: sourceRun.id,
      kind: "code" as const,
      summary: "Review target",
      subject: { kind: "git_head" as const, value: "a".repeat(40) },
      status: "accepted" as const,
      requested_verifiers: [item.id],
      evidence: [],
      attachments: [],
      known_gaps: [],
    };
    tx.deliveries.put(f.project, delivery);
    return delivery;
  });
  const oldRun = f.session(reviewer, false);
  const oldToken = connect(reviewer, ["finish_run"]);
  await call("host_ops_restart_assignment", {
    assignment_id: reviewer.id,
    reason: "Refresh review session",
    idempotency_key: "restart-reviewer",
  });
  vi.mocked(runtime.release).mockImplementationOnce(async () => {
    f.store.uow.run((tx) =>
      tx.deliveries.put(f.project, { ...delivery, status: "superseded" }),
    );
    alive = false;
    return { ok: true, value: undefined };
  });
  const scrubCredentials = vi.fn(async () => {});
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    scrubCredentials,
  });
  await service.tick();
  const state = f.state();
  expect(scrubCredentials).toHaveBeenCalledExactlyOnceWith(
    f.project,
    reviewer.id,
    f.refFor(reviewer),
  );
  expect(state.runs.filter((r) => r.assignment_id === reviewer.id)).toEqual([
    expect.objectContaining({ id: oldRun.id, status: "cancelled" }),
  ]);
  expect(hostOpsPending(state.events, reviewer.id)).toBe(false);
  expect(() => oldToken.revalidateToken?.()).toThrow();
  expect(() => context.revalidateToken?.()).not.toThrow();
  await service.tick();
  expect(runtime.release).toHaveBeenCalledOnce();
});

test("failed preflight and authorization have no events, cancellation, revocation or runtime effects", async () => {
  const { assignment, run } = dispatched();
  const before = f.state();
  await expect(
    call("host_ops_restart_assignment", {
      assignment_id: "A-9999",
      reason: "bad target",
      idempotency_key: "bad",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    call("host_ops_read_diagnostics", { project_id: "other" }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  const limited = connect(ops, ["host_ops_read_diagnostics"]);
  await expect(
    call(
      "host_ops_cancel_run",
      {
        run_id: run.id,
        reason: "missing permission",
        idempotency_key: "denied",
      },
      limited,
    ),
  ).rejects.toMatchObject({ code: "forbidden_tool" });
  expect(f.state()).toEqual(before);
  expect(snapshot).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().assignments.find((a) => a.id === assignment.id)?.runtime_ref,
  ).not.toBeNull();
});

test("target changed during async snapshot rejects the entire restart", async () => {
  const { assignment, run } = dispatched();
  snapshot.mockImplementationOnce(async () => {
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(assignment),
    );
    return { model: "fixture", agent_cli_version: "fixture" };
  });
  await expect(
    call("host_ops_restart_assignment", {
      assignment_id: assignment.id,
      reason: "raced",
      idempotency_key: "race",
    }),
  ).rejects.toMatchObject({ code: "stale_target" });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(runtime.release).not.toHaveBeenCalled();
});

test("standing restart replaces the PM session; other Assignment targets are rejected", async () => {
  f.create(); // Registers the PM role used by this project.
  const pm: Assignment = {
    ...ops,
    id: "A-90" as never,
    role_id: "pm",
    standing_mode: "ops",
    runtime_state: "idle",
    runtime_ref: { ...f.refFor(ops), terminal_ref: "pm-terminal" },
    session_ref: "old-session",
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  await expect(
    call("host_ops_restart_standing_pm", {
      assignment_id: ops.id,
      reason: "invalid",
      idempotency_key: "self",
    }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  await call("host_ops_restart_standing_pm", {
    assignment_id: pm.id,
    reason: "Refresh tools",
    idempotency_key: "pm",
  });
  await service.tick();
  expect(f.state().assignments.find((a) => a.id === pm.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
  expect(
    f.state().assignments.find((a) => a.id === pm.id)?.session_ref,
  ).toBeUndefined();
  expect(f.state().runs.find((r) => r.assignment_id === pm.id)?.status).toBe(
    "queued",
  );
  // C-154: an active PM is not paused and resumed, so nothing is handed over.
  expect(
    f
      .state()
      .events.some((e) =>
        ["assignment_paused", "assignment_resumed"].includes(e.type),
      ),
  ).toBe(false);
  expect(
    f.state().events.some((e) => e.type === "standing_session_restarted"),
  ).toBe(true);
});

test("C-152: a terminal on another runtime is settled only after a human confirms it exited", async () => {
  f.create(); // Registers the PM role used by this project.
  const pm: Assignment = {
    ...ops,
    id: "A-91" as never,
    role_id: "pm",
    standing_mode: "ops",
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  const oldRun = f.session(pm, false);
  // The terminal was started in local mode; the server runs agent-ssh.
  const localRef = f.refFor(pm);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...(tx.assignments.get(f.project, pm.id) as Assignment),
      runtime_state: "lost",
      runtime_ref: localRef,
    }),
  );
  const oldToken = connect(pm, ["finish_run"]);
  const scrub = vi.fn(async () => {});
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    scrubCredentials: scrub,
    ownsRuntimeRef: (ref) => ref.runtime_machine === "cardigan-agent",
    runtimeLabel: "agent-ssh（机器 cardigan-agent）",
    hcSession: "prod-hc",
  });
  await call("host_ops_restart_standing_pm", {
    assignment_id: pm.id,
    reason: "Recover lost PM",
    idempotency_key: "foreign",
  });
  const action = f
    .state()
    .events.find((e) => e.type === "host_ops_action_taken");
  if (!action) throw new Error("Missing action");

  await service.tick();
  f.advance(60_000); // The previous claim's lease expires.
  await service.tick();
  const state = f.state();
  // The server never touches a terminal it cannot observe.
  expect(runtime.status).not.toHaveBeenCalled();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(scrub).not.toHaveBeenCalled();
  expect(state.runs.find((r) => r.id === oldRun.id)?.status).not.toBe(
    "cancelled",
  );
  expect(() => oldToken.revalidateToken?.()).not.toThrow();
  const requested = state.human_actions.filter((h) => h.status === "open");
  expect(requested).toHaveLength(1);
  const first = requested[0];
  if (!first) throw new Error("Missing human action");
  expect(first.instructions).toContain(localRef.terminal_ref);
  expect(first.instructions).toMatch(/1\. [\s\S]*2\. [\s\S]*3\. [\s\S]*4\. /u);
  // C-153#3: the hc commands use the session registered in runtime.json.
  expect(first.instructions).toContain(
    `HC_SESSION=prod-hc HC_SOCKET="$XDG_RUNTIME_DIR/cardigan/prod-hc.sock" hc get ${localRef.terminal_ref} --json`,
  );
  expect(first.instructions).not.toContain("HC_SESSION=cardigan");
  expect(first.instructions).not.toContain("请替换会话名");
  expect(hostOpsExitConfirmation(state, action.id)).toEqual({
    status: "open",
    human_action_id: first.id,
  });
  expect(
    (await call("host_ops_read_diagnostics", {})) as { actions: unknown[] },
  ).toMatchObject({
    actions: [
      expect.objectContaining({
        status_reason: "terminal_exit_confirmation_requested",
      }),
    ],
  });

  f.apply((s, a, p) =>
    completeHumanAction(
      s,
      a,
      { human_action_id: first.id, text: "hc get t91: finished" },
      p,
    ),
  );
  f.advance(60_000);
  await service.tick();
  const settled = f.state();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(settled.runs.find((r) => r.id === oldRun.id)?.status).toBe(
    "cancelled",
  );
  expect(() => oldToken.revalidateToken?.()).toThrow();
  expect(scrub).toHaveBeenCalledExactlyOnceWith(f.project, pm.id, localRef);
  expect(hostOpsPending(settled.events, pm.id)).toBe(false);
  expect(settled.assignments.find((a) => a.id === pm.id)).toMatchObject({
    status: "active",
    runtime_ref: null,
  });
  expect(
    settled.runs.filter(
      (r) => r.assignment_id === pm.id && r.status === "queued",
    ),
  ).toHaveLength(1);
});

test("patrol uses persistent timing and one inbox notification; host handoff additionally notifies host_ops", () => {
  expect(resolveServerConfig({}).hostOpsPatrolIntervalMs).toBe(1_800_000);
  expect(
    resolveServerConfig({ CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS: "42" })
      .hostOpsPatrolIntervalMs,
  ).toBe(42);
  expect(() =>
    resolveServerConfig({ CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS: "0" }),
  ).toThrow();
  f.advance(1_799_999);
  patrolHostOps(f.store, f.project, f.clock);
  expect(f.state().events.some((e) => e.type === "host_ops_patrol_due")).toBe(
    false,
  );
  f.advance(1);
  patrolHostOps(f.store, f.project, f.clock);
  patrolHostOps(f.store, f.project, f.clock);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_patrol_due"),
  ).toHaveLength(1);
  const { card } = f.create();
  f.store.uow.run((tx) => {
    const action = {
      id: "H-1" as never,
      card_id: card.id,
      instructions: "Restart session",
      why_human: "Needs host",
      expected_return: "Result",
      blocked_work_items: [],
      status: "open" as const,
      triage: "host" as const,
      requested_by: "system" as const,
    };
    tx.human_actions.put(f.project, action);
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, card.id),
      card_id: card.id,
      type: "human_action_requested",
      actor: { kind: "system", project_id: f.project },
      payload: { human_action_id: action.id, disposition: "host" },
      created_at: f.clock.now(),
    });
  });
  routeProjectEvents(f.store, f.project);
  routeProjectEvents(f.store, f.project);
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .filter(
        (n) =>
          n.kind === "human_action" &&
          n.recipient.kind === "assignment" &&
          n.recipient.assignment_id === ops.id,
      ),
  ).toHaveLength(1);
});

test("two host consumers cannot stop the same terminal concurrently", async () => {
  const { run } = dispatched();
  await call("host_ops_cancel_run", {
    run_id: run.id,
    reason: "Stop once",
    idempotency_key: "concurrent",
  });
  let observed!: (result: Awaited<ReturnType<Runtime["status"]>>) => void;
  const delayed = new Promise<Awaited<ReturnType<Runtime["status"]>>>(
    (resolve) => {
      observed = resolve;
    },
  );
  vi.mocked(runtime.status).mockImplementationOnce(() => delayed);
  const first = service.tick();
  await vi.waitFor(() => expect(runtime.status).toHaveBeenCalledTimes(1));
  await new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
  }).tick();
  expect(runtime.release).not.toHaveBeenCalled();
  observed({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  await first;
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_action_finished"),
  ).toHaveLength(1);
});

test("pending terminal stop retains capacity if business cancellation finishes the Run first", async () => {
  const { run } = dispatched();
  await call("host_ops_cancel_run", {
    run_id: run.id,
    reason: "Stop",
    idempotency_key: "capacity",
  });
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, { ...run, status: "cancelled" }),
  );
  expect(
    f.store.uow.read((tx) =>
      runCapacitySnapshot(f.store, tx).occupied.get("local"),
    ),
  ).toBe(1);
  await service.tick();
  expect(
    f.store.uow.read((tx) =>
      runCapacitySnapshot(f.store, tx).occupied.get("local"),
    ),
  ).toBe(0);
});

test("credential cleanup failures remain recoverable without exposing host errors or launching a new Run", async () => {
  const { assignment, run } = dispatched();
  const scrub = vi.fn(async () => {
    throw new Error("Private host diagnostic");
  });
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    scrubCredentials: scrub,
  });
  await call("host_ops_restart_assignment", {
    assignment_id: assignment.id,
    reason: "Restart",
    idempotency_key: "scrub",
  });
  await service.tick();
  expect(scrub).toHaveBeenCalledWith(
    f.project,
    assignment.id,
    f.refFor(assignment),
  );
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
  const diagnostics = await call("host_ops_read_diagnostics", {});
  expect(diagnostics).toMatchObject({
    actions: [{ status_reason: "credential_cleanup_failed" }],
  });
  expect(JSON.stringify(f.state().events)).not.toContain(
    "Private host diagnostic",
  );
  scrub.mockImplementationOnce(async () => {});
  f.advance(60_000);
  await service.tick();
  expect(
    f
      .state()
      .runs.filter(
        (r) => r.assignment_id === assignment.id && r.status === "queued",
      ),
  ).toHaveLength(1);
});

test("delivery failures stay read-only and outside patrol work; context estimates are labelled", async () => {
  const { run } = dispatched();
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: "bell_delivery_attempt_failed",
      actor: { kind: "system", project_id: f.project },
      payload: { run_id: run.id },
      created_at: f.clock.now(),
    }),
  );
  const diagnostics = await call("host_ops_read_diagnostics", {});
  expect(diagnostics).toMatchObject({
    runs: [{ id: run.id, recovery_owner: "automatic" }],
    patrol_runs: [],
  });
  expect(diagnostics).toMatchObject({
    sessions: expect.arrayContaining([
      expect.objectContaining({
        context_usage_estimated: true,
        context_usage_threshold_pct: 80,
      }),
    ]),
  });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(
    resolveServerConfig({ CARDIGAN_HOST_OPS_CONTEXT_THRESHOLD_PCT: "65" })
      .hostOpsContextThresholdPct,
  ).toBe(65);
  expect(() =>
    resolveServerConfig({ CARDIGAN_HOST_OPS_CONTEXT_THRESHOLD_PCT: "101" }),
  ).toThrow();
});

test("a delayed credential scrub cannot outlive takeover and delete the replacement Run's files", async () => {
  const { assignment, run } = dispatched();
  const execution = { mode: "local" as const, dataDir: f.dataDir };
  const { runDir } = executionPaths(execution, f.project, assignment.id);
  const files = [START_FILE_NAME, SECRETS_FILE_NAME, TOKEN_FILE_NAME];
  await mkdir(runDir, { recursive: true });
  for (const name of files)
    await writeFile(join(runDir, name), "old non-sensitive fixture marker");
  let continueScrub!: () => void;
  const delayed = new Promise<void>((resolve) => {
    continueScrub = resolve;
  });
  const scrub = vi.fn(async () => {
    await delayed;
    await scrubRunCredentials(execution, f.project, assignment.id);
  });
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    scrubCredentials: scrub,
  });
  await call("host_ops_restart_assignment", {
    assignment_id: assignment.id,
    reason: "Restart",
    idempotency_key: "late-scrub",
  });
  const first = service.tick();
  const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await vi.waitFor(() => expect(scrub).toHaveBeenCalledOnce());
    f.advance(60_001);
    const secondScrub = vi.fn(() =>
      scrubRunCredentials(execution, f.project, assignment.id),
    );
    const second = new HostOpsService({
      store: reopened,
      runtime,
      snapshot,
      clock: f.clock,
      scrubCredentials: secondScrub,
    });
    await second.tick();
    expect(secondScrub).not.toHaveBeenCalled();
    expect(
      f.state().events.filter((e) => e.type === "host_ops_action_claimed"),
    ).toHaveLength(1);
    expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "dispatched",
    );
    continueScrub();
    await first;
    const replacement = f
      .state()
      .runs.find(
        (r) => r.assignment_id === assignment.id && r.status === "queued",
      );
    if (!replacement) throw new Error("Missing replacement Run");
    f.apply((s, a, p) =>
      dispatchRun(
        s,
        a,
        {
          run_id: replacement.id,
          runtime_ref: {
            ...f.refFor(assignment),
            terminal_ref: "replacement-terminal",
          },
        },
        p,
      ),
    );
    for (const name of files)
      await writeFile(
        join(runDir, name),
        "replacement non-sensitive fixture marker",
      );
    await second.tick();
    for (const name of files)
      expect(await readFile(join(runDir, name), "utf8")).toBe(
        "replacement non-sensitive fixture marker",
      );
    expect(f.state().runs.find((r) => r.id === replacement.id)?.status).toBe(
      "dispatched",
    );
    expect(
      f.state().events.filter((e) => e.type === "host_ops_action_finished"),
    ).toHaveLength(1);
  } finally {
    continueScrub();
    await first;
    reopened.close();
  }
});
