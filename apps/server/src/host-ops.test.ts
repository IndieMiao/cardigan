import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  requestDecision,
  type ToolName,
  upstreamIncident,
} from "@cardigan/domain";
import {
  HostOpsService,
  runCapacitySnapshot,
  scrubRunCredentials,
  UpstreamHealthMonitor,
} from "@cardigan/host";
import {
  authenticate,
  hostOpsTools,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import {
  compileAssignmentLaunch,
  parseLaunchConfig,
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
import { contextUsageRevision } from "./web/read.js";

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
  runtime.verifyExit = async (ref) => {
    const observed = await runtime.status(ref);
    return {
      ok: true,
      value: {
        ref,
        state: observed.ok
          ? observed.value.process
          : observed.error.code === "runtime_not_found"
            ? "exited"
            : "unknown",
      },
    };
  };
  snapshot.mockClear();
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
  });
});
afterEach(async () => {
  await service.close();
  f.close();
});
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

test("C-137: diagnostics stay within P2a-10 categories and omit Needs You decisions and human actions", async () => {
  const { card } = f.create();
  const decision = f.apply((s, a, p) =>
    requestDecision(
      s,
      a,
      {
        card_id: card.id,
        category: "general",
        kind: "choose",
        question: "C137-DECISION-QUESTION",
        context: "C137-DECISION-CONTEXT",
        options: [{ key: "go", description: "go", impact: "i" }],
        recommended: "go",
        affected_cards: [card.id],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: { changed: "c", impact: "i", risk: "无" },
      },
      p,
    ),
  ) as { id: string };
  f.store.uow.run((tx) =>
    tx.human_actions.put(f.project, {
      id: "H-9" as never,
      card_id: card.id,
      instructions: "C137-HUMAN-INSTRUCTIONS",
      why_human: "C137-WHY-HUMAN",
      expected_return: "Result",
      blocked_work_items: [],
      status: "open" as const,
      requested_by: "system" as const,
    }),
  );
  const diagnostics = (await call("host_ops_read_diagnostics", {})) as Record<
    string,
    unknown
  >;
  expect(diagnostics).not.toHaveProperty("needs_you");
  expect(Object.keys(diagnostics).sort()).toEqual(
    [
      "actions",
      "attention",
      "context_thresholds",
      "escalated",
      "findings",
      "lost",
      "merge_stalls",
      "patrol_runs",
      "paused",
      "queued",
      "runs",
      "sessions",
    ].sort(),
  );
  const text = JSON.stringify(diagnostics);
  for (const leaked of [
    decision.id,
    "C137-DECISION-QUESTION",
    "C137-DECISION-CONTEXT",
    "H-9",
    "C137-HUMAN-INSTRUCTIONS",
    "C137-WHY-HUMAN",
  ])
    expect(text).not.toContain(leaked);
});

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

test("C-211 a failing context patrol is reported and the same tick still drains host_ops actions", async () => {
  const { assignment, run } = dispatched();
  await call("host_ops_cancel_run", {
    run_id: run.id,
    reason: "Stop stalled run",
    idempotency_key: "cancel-patrol",
  });
  const errors: unknown[] = [];
  const patrolling = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    contextUsage: {
      get execution(): never {
        throw new Error("context cache unreadable");
      },
    },
    onError: (error) => errors.push(error),
  });
  await patrolling.tick();
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("context cache unreadable");
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(hostOpsPending(f.state().events, assignment.id)).toBe(false);
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

test("C-212: external host actions and deferred ones do not wake host_ops until shown to it", () => {
  const { card } = f.create();
  const base = {
    card_id: card.id,
    instructions: "Deploy",
    why_human: "Needs host",
    expected_return: "Result",
    blocked_work_items: [],
    status: "open" as const,
    triage: "host" as const,
    requested_by: "system" as const,
  };
  const put = (
    action: typeof base & Record<string, unknown> & { id: never },
    payload: Record<string, unknown>,
  ) =>
    f.store.uow.run((tx) => {
      tx.human_actions.put(f.project, action);
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, card.id),
        card_id: card.id,
        type: "human_action_requested",
        actor: { kind: "system", project_id: f.project },
        payload: {
          human_action_id: action.id,
          disposition: "host",
          ...payload,
        },
        created_at: f.clock.now(),
      });
    });
  const wakes = () => {
    routeProjectEvents(f.store, f.project);
    return f.store
      .listNotifications({ project_id: f.project })
      .filter(
        (n) =>
          n.kind === "human_action" &&
          n.recipient.kind === "assignment" &&
          n.recipient.assignment_id === ops.id,
      ).length;
  };
  put({ ...base, id: "H-2" as never, host_operator: "external" }, {});
  const deferred = {
    ...base,
    id: "H-3" as never,
    host_operator: "host_ops",
    ready_when: { kind: "manual" },
  };
  put(deferred, {});
  expect(wakes()).toBe(0);
  put(
    {
      ...deferred,
      ready_released: { at: f.clock.now(), by: "system", reason: "可以执行" },
    },
    { released: true },
  );
  expect(wakes()).toBe(1);
});

test("C-212/V-823: a card merge writes one readable ready entry per waiting item on the item's own card", () => {
  const { card: waiting } = f.create();
  const { card: source } = f.create();
  const base = {
    card_id: waiting.id,
    instructions: "Deploy",
    why_human: "Needs host",
    expected_return: "Result",
    blocked_work_items: [],
    status: "open" as const,
    triage: "host" as const,
    requested_by: "system" as const,
    ready_when: { kind: "card_merged" as const, card_id: source.id },
  };
  f.store.uow.run((tx) => {
    tx.human_actions.put(f.project, {
      ...base,
      id: "H-7" as never,
      key: "H-7" as never,
      host_operator: "host_ops",
    });
    tx.human_actions.put(f.project, {
      ...base,
      id: "H-8" as never,
      key: "H-8" as never,
      host_operator: "external",
    });
  });
  routeProjectEvents(f.store, f.project);
  const before = f.store.listNotifications({ project_id: f.project }).length;
  const merge = () =>
    f.store.uow.run((tx) => {
      const card = tx.cards.get(f.project, source.id);
      if (!card) throw new Error("Missing card");
      tx.cards.put(f.project, { ...card, status: "done" });
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, source.id),
        card_id: source.id,
        type: "card_merged",
        actor: { kind: "system", project_id: f.project },
        payload: { merge_sha: "a".repeat(40) },
        created_at: f.clock.now(),
      });
    });
  merge();
  routeProjectEvents(f.store, f.project);
  routeProjectEvents(f.store, f.project);
  const state = f.state();
  const ready = state.events.filter((e) => e.type === "needs_you_item_ready");
  expect(
    ready.map((e) => [
      e.card_id,
      (e.payload as { human_action_id?: string }).human_action_id,
      (e.payload as { source_card_id?: string }).source_card_id,
    ]),
  ).toEqual([
    [waiting.id, "H-7", source.id],
    [waiting.id, "H-8", source.id],
  ]);
  // Readable on the item's card timeline.
  expect(
    state.timeline
      .filter((t) =>
        ready.some((e) => e.seq === t.event_seq && t.card_id === waiting.id),
      )
      .map((t) => [
        t.human_action_id,
        t.body.includes(t.human_action_id ?? "?"),
      ]),
  ).toEqual([
    ["H-7", true],
    ["H-8", true],
  ]);
  // Every bell points at the item's card and its ready event.
  const fresh = f.store
    .listNotifications({ project_id: f.project })
    .slice(before)
    .filter((n) => ready.some((e) => e.id === n.event_id));
  expect(fresh.length).toBeGreaterThan(0);
  expect(fresh.every((n) => n.card_id === waiting.id)).toBe(true);
  // host_ops is woken for H-7 only; H-8 belongs to an external operator.
  expect(
    fresh
      .filter(
        (n) =>
          n.recipient.kind === "assignment" &&
          n.recipient.assignment_id === ops.id,
      )
      .map((n) => n.event_id),
  ).toEqual([ready[0]?.id]);
  // A replayed merge event does not announce the items again.
  merge();
  routeProjectEvents(f.store, f.project);
  expect(
    f.state().events.filter((e) => e.type === "needs_you_item_ready"),
  ).toHaveLength(2);
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
  // C-216: host-ops actions come from the Store's cached event streams; a
  // backend without that port re-reads each stream. Both must agree.
  const occupied = () =>
    f.store.uow.read((tx) => {
      expect(tx.events.listStreams).toBeTypeOf("function");
      const cached = runCapacitySnapshot(f.store, tx).occupied.get("local");
      const fallback = runCapacitySnapshot(f.store, {
        ...tx,
        events: { listAfter: tx.events.listAfter },
      }).occupied.get("local");
      expect(cached).toBe(fallback);
      return cached;
    });
  expect(occupied()).toBe(1);
  await service.tick();
  expect(occupied()).toBe(0);
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

test("delivery failures stay read-only and outside patrol work; missing context is stale", async () => {
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
        context_usage_estimated: false,
        context_tokens: null,
        stale: true,
        status: "missing",
      }),
    ]),
  });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(
    resolveServerConfig({ CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS: "65000" })
      .contextUsageStaleAfterMs,
  ).toBe(65000);
  expect(() =>
    resolveServerConfig({ CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS: "-1" }),
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

test.each(["codex", "pi"] as const)(
  "%s context patrol delivers handoff once, guards restart and observes fresh replacement usage (simulated)",
  async (harness) => {
    const { assignment, run, card } = dispatched();
    const execution = { mode: "local" as const, dataDir: f.dataDir };
    const { runDir } = executionPaths(execution, f.project, assignment.id);
    f.store.uow.run((tx) => {
      const stored = tx.runs.get(f.project, run.id);
      if (!stored) throw new Error("Missing fixture Run");
      tx.runs.put(f.project, { ...stored, harness });
    });
    service = new HostOpsService({
      store: f.store,
      runtime,
      snapshot: async () => ({ ...(await snapshot()), harness }),
      clock: f.clock,
      contextUsage: { execution, staleAfterMs: 60000 },
    });
    const sample = async (id: string, tokens: number) => {
      const dir =
        harness === "codex"
          ? join(runDir, "codex", "sessions")
          : join(runDir, "pi", "context-usage");
      await mkdir(dir, { recursive: true });
      const text =
        harness === "codex"
          ? [
              { type: "session_meta", payload: { id, cwd: runDir } },
              {
                type: "event_msg",
                timestamp: f.clock.now(),
                payload: {
                  type: "token_count",
                  info: {
                    last_token_usage: { total_tokens: tokens },
                    total_token_usage: { total_tokens: 1000000 },
                    model_context_window: 1000,
                  },
                },
              },
            ]
              .map((v) => JSON.stringify(v))
              .join("\n")
          : JSON.stringify({
              agent: "pi",
              session_id: id,
              cwd: runDir,
              model: "fixture",
              context_tokens: tokens,
              context_window_size: 1000,
              used_percentage: tokens / 10,
              updated_at: f.clock.now(),
            });
      await writeFile(
        join(
          dir,
          harness === "codex" ? `rollout-${id}.jsonl` : `pi-${id}.json`,
        ),
        text,
      );
    };
    await sample("session-1", 800);
    // Reading diagnostics remains read-only.
    expect(await call("host_ops_read_diagnostics", {})).toMatchObject({
      context_thresholds: {
        handoff_remaining_pct: 20,
        restart_remaining_pct: 15,
      },
      sessions: expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.id,
          context_tokens: 800,
          level: "handoff",
        }),
      ]),
    });
    expect(
      f.state().events.filter((e) => e.type === "context_usage_notice"),
    ).toHaveLength(0);
    await service.tick();
    const notices = () =>
      f.state().events.filter((e) => e.type === "context_usage_notice");
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .some(
          (n) =>
            n.event_id === notices()[0]?.id &&
            n.recipient.kind === "assignment" &&
            n.recipient.assignment_id === assignment.id &&
            n.card_id === card.id,
        ),
    ).toBe(true);
    const request = {
      assignment_id: assignment.id,
      context_session_id: "session-1",
      reason: "Context low; handoff recorded",
      idempotency_key: "context-restart",
    };
    await expect(
      call("host_ops_restart_assignment", request),
    ).rejects.toMatchObject({ code: "stale_target" });
    f.advance(30000);
    await sample("session-1", 850);
    await service.tick();
    await vi.waitFor(() => expect(notices()).toHaveLength(2));
    await call("host_ops_restart_assignment", request);
    await service.tick();
    expect(runtime.release).toHaveBeenCalledTimes(1);
    const replacement = f
      .state()
      .runs.find(
        (r) => r.assignment_id === assignment.id && r.status === "queued",
      );
    expect(replacement).toBeDefined();
    expect(
      f.state().assignments.find((a) => a.id === assignment.id)?.session_ref,
    ).toBeUndefined();
    await expect(
      call("host_ops_restart_assignment", {
        ...request,
        idempotency_key: "different-key",
      }),
    ).rejects.toBeDefined();
    f.advance(1000);
    await sample("session-2", 0);
    expect(await call("host_ops_read_diagnostics", {})).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.id,
          session_id: "session-2",
          context_tokens: 0,
          used_percentage: 0,
          level: null,
        }),
      ]),
    });
    const finished = f
      .state()
      .events.find((e) => e.type === "host_ops_action_finished");
    expect(finished?.payload).toMatchObject({
      context_usage: { session_id: "session-1", used_percentage: 85 },
      result: "new_session_queued",
    });
  },
);

test("C-232: the Workbench reads the last poll's fresh samples from memory, dropping stale or unknown ones", async () => {
  const { assignment, run } = dispatched();
  const execution = { mode: "local" as const, dataDir: f.dataDir };
  const { runDir } = executionPaths(execution, f.project, assignment.id);
  f.store.uow.run((tx) => {
    const stored = tx.runs.get(f.project, run.id);
    if (!stored) throw new Error("Missing fixture Run");
    tx.runs.put(f.project, { ...stored, harness: "pi" });
  });
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    contextUsage: { execution, staleAfterMs: 60000 },
  });
  const dir = join(runDir, "pi", "context-usage");
  await mkdir(dir, { recursive: true });
  const sample = (tokens: number | null) =>
    writeFile(
      join(dir, "pi-session-1.json"),
      JSON.stringify({
        agent: "pi",
        session_id: "session-1",
        cwd: runDir,
        model: "fixture",
        context_tokens: tokens,
        context_window_size: tokens === null ? null : 1000,
        used_percentage: tokens === null ? null : tokens / 10,
        updated_at: f.clock.now(),
      }),
    );
  // C-232 rework: the SSE `context` revision is derived from this view, so
  // each change below must move it while no event is written.
  const revision = () => contextUsageRevision(service.contextUsage(f.project));
  const events = () => f.state().events.length;
  const eventCount = events();
  const empty = revision();
  await sample(420);
  // Nothing is read on demand: before the first poll there is no sample.
  expect(service.contextUsage(f.project).size).toBe(0);
  await service.tick();
  await vi.waitFor(() =>
    expect(service.contextUsage(f.project).get(assignment.id)).toMatchObject({
      assignment_id: assignment.id,
      session_id: "session-1",
      context_tokens: 420,
      context_window_size: 1000,
      source: "pi_turn_end:getContextUsage",
    }),
  );
  const first = revision();
  expect(first).not.toBe(empty);
  // A new normal reading (no threshold, so no notice event).
  f.advance(31000);
  await sample(650);
  await service.tick();
  await vi.waitFor(() => expect(revision()).not.toBe(first));
  const changed = revision();
  expect(changed).not.toBe(first);
  // Past the stale limit the cached reading disappears even without a poll.
  f.advance(61000);
  expect(service.contextUsage(f.project).size).toBe(0);
  expect(revision()).toBe(empty);
  // A newer unknown sample replaces the old one on the next poll.
  await sample(420);
  await service.tick();
  await vi.waitFor(() => expect(service.contextUsage(f.project).size).toBe(1));
  expect(revision()).not.toBe(empty);
  f.advance(31000);
  await sample(null);
  await service.tick();
  await vi.waitFor(() => expect(service.contextUsage(f.project).size).toBe(0));
  expect(revision()).toBe(empty);
  // None of these changes was a business event the stream could carry.
  expect(events()).toBe(eventCount);
});

test("pi high watermark becomes non-actionable immediately when the installed extension reports unknown usage", async () => {
  const { assignment, run } = dispatched();
  const execution = { mode: "local" as const, dataDir: f.dataDir };
  const { runDir } = executionPaths(execution, f.project, assignment.id);
  f.store.uow.run((tx) => {
    const stored = tx.runs.get(f.project, run.id);
    if (!stored) throw new Error("Missing fixture Run");
    tx.runs.put(f.project, { ...stored, harness: "pi" });
  });
  const compiled = compileAssignmentLaunch({
    assignment: { assignment_id: assignment.id, run_id: run.id },
    role: {
      role_id: "coder",
      harness: "pi",
      launch_profile: "fixture",
      worktree: "none",
      allowed_tools: [],
      core_prompt: "fixture",
    },
    launch: parseLaunchConfig({
      profiles: { fixture: { harness: "pi", model: "fixture" } },
    }),
    mcp: { url: "http://localhost/mcp" },
    run_dir: runDir,
    work_dir: runDir,
    first_prompt: "fixture",
    secrets: {},
  });
  const extension = compiled.files.find((file) =>
    file.path.endsWith("cardigan-context-usage.js"),
  );
  if (!extension) throw new Error("Missing generated pi extension");
  await mkdir(join(runDir, "pi"), { recursive: true });
  const script = join(runDir, "pi", "context-fixture.mjs");
  await writeFile(script, extension.content);
  let onTurnEnd: (event: unknown, ctx: unknown) => Promise<void> =
    async () => {};
  (await import(pathToFileURL(script).href)).default({
    on: (event: string, callback: typeof onTurnEnd) => {
      expect(event).toBe("turn_end");
      onTurnEnd = callback;
    },
  });
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    contextUsage: { execution },
  });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(runDir, "pi"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(f.clock.now()));
    const ctx = {
      cwd: runDir,
      model: { id: "fixture" },
      sessionManager: {
        getSessionId: () => "same-session",
        getSessionFile: () => undefined,
      },
    };
    await onTurnEnd(
      {},
      {
        ...ctx,
        getContextUsage: () => ({
          tokens: 850,
          contextWindow: 1000,
          percent: 85,
        }),
      },
    );
    expect(await call("host_ops_read_diagnostics", {})).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.id,
          status: "fresh",
          used_percentage: 85,
          level: "restart",
        }),
      ]),
    });
    f.advance(1000);
    vi.setSystemTime(new Date(f.clock.now()));
    await onTurnEnd(
      {},
      {
        ...ctx,
        getContextUsage: () => ({
          tokens: null,
          contextWindow: 1000,
          percent: null,
        }),
      },
    );
    expect(await call("host_ops_read_diagnostics", {})).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          assignment_id: assignment.id,
          session_id: "same-session",
          updated_at: f.clock.now(),
          status: "missing",
          stale: true,
          used_percentage: null,
          level: null,
        }),
      ]),
    });
    await service.tick();
    expect(
      f.state().events.some((e) => e.type === "context_usage_notice"),
    ).toBe(false);
    await expect(
      call("host_ops_restart_assignment", {
        assignment_id: assignment.id,
        context_session_id: "same-session",
        reason: "Previous sample was high",
        idempotency_key: "unknown-pi-context",
      }),
    ).rejects.toMatchObject({ code: "stale_target" });
    expect(runtime.release).not.toHaveBeenCalled();
    expect(
      f.state().events.some((e) => e.type === "host_ops_action_taken"),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

function upstreamService(probeConfigured = true) {
  let reachable = true;
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "pi",
        upstream: {
          group: "relay",
          probe_url: "https://gateway.example.invalid",
        },
      },
    },
    profiles: { fixture: { harness: "pi", provider: "relay" } },
    ...(probeConfigured
      ? {
          upstream_health: {
            probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
          },
        }
      : {}),
  });
  const monitor = new UpstreamHealthMonitor(
    config,
    runtime,
    f.clock,
    async () =>
      reachable
        ? { status: "reachable" }
        : { status: "unreachable", failure: "connection_error" },
  );
  f.store.uow.run((tx) => {
    for (const run of tx.runs.list(f.project))
      tx.runs.put(f.project, { ...run, launch_profile_ref: "fixture" });
  });
  service = new HostOpsService({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
    upstreamMonitor: monitor,
  });
  return {
    monitor,
    sample: async (healthy: boolean) => {
      reachable = healthy;
      f.advance(100);
      monitor.schedule();
      await vi.waitFor(() =>
        expect(monitor.diagnostics(f.state()).providers[0]?.status).toBe(
          healthy ? "reachable" : "unreachable",
        ),
      );
    },
  };
}
function markInactive(assignment: Assignment, runId: string) {
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: "run_inactive",
      actor: { kind: "system", project_id: f.project },
      created_at: f.clock.now(),
      payload: {
        assignment_id: assignment.id,
        run_id: runId,
        reason: "mcp_inactivity",
      },
    }),
  );
}

test("C-213: a failed probe blocks a restart without stopping a terminal", async () => {
  const target = dispatched();
  const { sample } = upstreamService();
  await sample(false);
  const view = (await call("host_ops_read_diagnostics", {})) as {
    upstream_health: { sessions: unknown[] };
  };
  expect(view.upstream_health.sessions).toContainEqual(
    expect.objectContaining({
      assignment_id: target.assignment.id,
      cause: "upstream_unreachable",
      action: "wait",
    }),
  );
  await expect(
    call("host_ops_restart_assignment", {
      assignment_id: target.assignment.id,
      reason: "recover",
      idempotency_key: "outage",
    }),
  ).rejects.toThrow("upstream_unreachable");
  expect(runtime.release).not.toHaveBeenCalled();
  expect(f.state().human_actions).toHaveLength(1);
  await service.close();
});

test("C-213: an upstream incident never withdraws an explicit Run cancellation", async () => {
  const target = dispatched();
  const { sample } = upstreamService();
  await sample(false);
  await call("host_ops_read_diagnostics", {});
  expect(upstreamIncident(f.state(), "relay")).toBeDefined();
  await call("host_ops_cancel_run", {
    run_id: target.run.id,
    reason: "stop this Run explicitly",
    idempotency_key: "cancel-during-outage",
  });
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(true);
  await service.tick();
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(f.state().runs.find((r) => r.id === target.run.id)?.status).toBe(
    "cancelled",
  );
  expect(
    f.state().runs.filter((r) => r.assignment_id === target.assignment.id),
  ).toHaveLength(1);
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(false);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_action_finished"),
  ).not.toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        result: "withdrawn_upstream_changed",
      }),
    }),
  );
  await service.close();
});

test("C-213: patrol observes working sessions before clustering, without waiting in the global tick", async () => {
  for (let n = 0; n < 3; n++) f.session(f.create().assignment, false);
  const { monitor } = upstreamService(false);
  f.advance(15 * 60_000);
  await new Dispatcher({
    store: f.store,
    runtime,
    snapshot,
    clock: f.clock,
  }).tick();
  expect(
    f.state().events.filter((e) => e.type === "run_inactive"),
  ).toHaveLength(3);
  let finish!: (value: Awaited<ReturnType<Runtime["status"]>>) => void;
  const observation = new Promise<Awaited<ReturnType<Runtime["status"]>>>(
    (resolve) => {
      finish = resolve;
    },
  );
  vi.mocked(runtime.status).mockClear().mockReturnValue(observation);
  const reconcile = vi.spyOn(monitor, "reconcile");
  try {
    await service.tick();
    expect(runtime.status).toHaveBeenCalledTimes(3);
    expect(reconcile).not.toHaveBeenCalled();
    expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
    await service.tick();
    expect(runtime.status).toHaveBeenCalledTimes(3);
    f.advance(1);
  } finally {
    finish({
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 1 },
    });
  }
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
  expect(f.state().human_actions).toEqual([]);
  expect(
    monitor
      .diagnostics(f.state())
      .sessions.filter((s) => s.cause === "agent_busy"),
  ).toHaveLength(3);
  // No read-diagnostics request was needed to protect a later patrol either.
  f.advance(1_000);
  await service.tick();
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  expect(f.state().human_actions).toEqual([]);
  await service.close();
});

test("C-213: a failed stop-time observation defers recovery and continues other operations", async () => {
  const target = dispatched();
  const other = dispatched();
  const { monitor, sample } = upstreamService();
  markInactive(target.assignment, target.run.id);
  await sample(true);
  await call("host_ops_restart_assignment", {
    assignment_id: target.assignment.id,
    reason: "recover",
    idempotency_key: "observation-race",
  });
  await call("host_ops_cancel_run", {
    run_id: other.run.id,
    reason: "cancel another Run",
    idempotency_key: "independent-cancel",
  });
  const observe = monitor.observe.bind(monitor);
  const observationStarted = Promise.withResolvers<void>();
  const failObservation = Promise.withResolvers<void>();
  vi.spyOn(monitor, "observe").mockImplementation(async (state, only) => {
    if (only === target.assignment.id) {
      observationStarted.resolve();
      await failObservation.promise;
      throw new Error("private observation failure");
    }
    return observe(state, only);
  });
  try {
    // C-286: tick() does not join restart workers. Keep the target observation
    // pending until the independent cancellation and the tick have completed.
    await expect(service.tick()).resolves.toBeUndefined();
    await observationStarted.promise;
    expect(f.state().runs.find((r) => r.id === other.run.id)?.status).toBe(
      "cancelled",
    );
    expect(runtime.release).toHaveBeenCalledWith(f.refFor(other.assignment), {
      force: true,
    });
    expect(
      f.state().events.some((e) => e.type === "host_ops_action_deferred"),
    ).toBe(false);
  } finally {
    failObservation.resolve();
  }
  // The background worker's persisted failure is the assertion boundary.
  await vi.waitFor(() =>
    expect(f.state().events).toContainEqual(
      expect.objectContaining({
        type: "host_ops_action_deferred",
        payload: expect.objectContaining({
          reason: "upstream_observation_failed",
        }),
      }),
    ),
  );
  expect(f.state().runs.find((r) => r.id === target.run.id)?.status).toBe(
    "dispatched",
  );
  expect(f.state().runs.find((r) => r.id === other.run.id)?.status).toBe(
    "cancelled",
  );
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(true);
  expect(JSON.stringify(f.state().events)).not.toContain(
    "private observation failure",
  );
});

test("C-213: dormant sessions do not keep recovered outages or their human notices open", async () => {
  const active = f.create().assignment;
  const dormant = f.create().assignment;
  f.session(active, false);
  f.session(dormant, true);
  const { sample } = upstreamService();
  await sample(false);
  await call("host_ops_read_diagnostics", {});
  const first = upstreamIncident(f.state(), "relay");
  expect(first?.assignment_ids).toEqual([active.id]);
  f.advance(600_000);
  await sample(true);
  expect(f.store.touchAssignmentActivity(f.project, active.id)).toBe(true);
  await call("host_ops_read_diagnostics", {});
  expect(upstreamIncident(f.state(), "relay")).toBeUndefined();
  expect(f.state().human_actions.filter((h) => h.status === "open")).toEqual(
    [],
  );
  expect(runtime.release).not.toHaveBeenCalled();
  await sample(false);
  await call("host_ops_read_diagnostics", {});
  expect(upstreamIncident(f.state(), "relay")?.id).not.toBe(first?.id);
  expect(upstreamIncident(f.state(), "relay")?.assignment_ids).toEqual([
    active.id,
  ]);
  await service.close();
});

test("C-213: line failure after accepting a restart is rechecked before stopping; the old request is withdrawn", async () => {
  const target = dispatched();
  const { sample } = upstreamService();
  markInactive(target.assignment, target.run.id);
  await sample(true);
  await call("host_ops_restart_assignment", {
    assignment_id: target.assignment.id,
    reason: "single idle session",
    idempotency_key: "before-outage",
  });
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(true);
  await sample(false);
  await service.tick();
  await vi.waitFor(() =>
    expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(false),
  );
  expect(runtime.release).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(false);
  expect(f.state().events).toContainEqual(
    expect.objectContaining({
      type: "host_ops_action_finished",
      payload: expect.objectContaining({
        result: "withdrawn_upstream_changed",
      }),
    }),
  );
  await service.close();
});

test("C-213: runtime work is not classified as a stuck Agent merely because MCP has been quiet", async () => {
  const target = dispatched();
  const { sample } = upstreamService();
  markInactive(target.assignment, target.run.id);
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "working", observed_seq: 2 },
  });
  await sample(true);
  const view = (await call("host_ops_read_diagnostics", {})) as {
    upstream_health: { sessions: unknown[] };
  };
  expect(view.upstream_health.sessions).toContainEqual(
    expect.objectContaining({
      assignment_id: target.assignment.id,
      cause: "agent_busy",
      action: "none",
    }),
  );
  await expect(
    call("host_ops_restart_assignment", {
      assignment_id: target.assignment.id,
      reason: "MCP quiet",
      idempotency_key: "busy",
    }),
  ).rejects.toThrow("agent_busy");
  expect(runtime.release).not.toHaveBeenCalled();
  await service.close();
});

test("C-213: recovered lines permit one restart per session", async () => {
  const targets = [dispatched(), dispatched(), dispatched()];
  const first = targets[0];
  const witness = targets[2];
  if (!first || !witness) throw new Error("Missing fixture targets");
  const { sample } = upstreamService();
  for (const target of targets) markInactive(target.assignment, target.run.id);
  await sample(true);
  await call("host_ops_read_diagnostics", {});
  expect(
    f.state().events.filter((e) => e.type === "upstream_incident_started"),
  ).toHaveLength(1);
  const restart = (key: string) =>
    call("host_ops_restart_assignment", {
      assignment_id: first.assignment.id,
      reason: "recover the affected session",
      idempotency_key: key,
    });
  await expect(restart("too-soon")).rejects.toThrow("upstream_suspected");
  f.advance(600_000);
  await expect(restart("no-witness")).rejects.toThrow("upstream_suspected");
  f.store.uow.run((tx) => {
    const current = tx.assignments.get(f.project, witness.assignment.id);
    if (!current) throw new Error("Missing witness");
    tx.assignments.put(f.project, {
      ...current,
      last_mcp_activity_at: f.clock.now(),
    });
  });
  await restart("recover-once");
  await service.tick();
  await vi.waitFor(() =>
    expect(hostOpsPending(f.state().events, first.assignment.id)).toBe(false),
  );
  expect(runtime.release).toHaveBeenCalledTimes(1);
  await expect(restart("duplicate")).rejects.toThrow(
    "recovery_already_requested",
  );
  await service.close();
});

test.each(["current", "expired", "replaced", "new_failure"] as const)(
  "C-297: same-line harness-only recovery evidence is rechecked through restart execution (%s)",
  async (witnessState) => {
    const targets = [f.create(), f.create(), f.create()];
    const first = targets[0],
      witness = targets[2];
    if (!first || !witness) throw new Error("Missing fixture targets");
    const runs = targets.map((t) => f.session(t.assignment, false));
    const { monitor } = upstreamService(false);
    await service.close();
    const execution = { mode: "local" as const, dataDir: f.dataDir };
    service = new HostOpsService({
      store: f.store,
      runtime,
      snapshot,
      clock: f.clock,
      upstreamMonitor: monitor,
      contextUsage: { execution },
    });
    f.store.uow.run((tx) => {
      for (const run of tx.runs.list(f.project))
        tx.runs.put(f.project, { ...run, harness: "codex" });
    });
    f.advance(15 * 60_000);
    for (const run of runs) {
      const assignment = targets.find(
        (t) => t.assignment.id === run.assignment_id,
      )?.assignment;
      if (assignment) markInactive(assignment, run.id);
    }
    await call("host_ops_read_diagnostics", {});
    const incident = upstreamIncident(f.state(), "relay");
    expect(incident).toBeDefined();
    f.advance(10 * 60_000);
    const dir = executionPaths(
      execution,
      f.project,
      witness.assignment.id,
    ).runDir;
    const folder = join(dir, "codex", "sessions");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "rollout-2030-01-01.jsonl"),
      [
        { type: "session_meta", payload: { id: "witness-session", cwd: dir } },
        {
          type: "event_msg",
          timestamp: f.clock.now(),
          payload: { type: "token_count", info: null },
        },
      ]
        .map((v) => JSON.stringify(v))
        .join("\n"),
    );
    const view = (await call("host_ops_read_diagnostics", {})) as {
      upstream_health: { sessions: unknown[] };
    };
    expect(view.upstream_health.sessions).toContainEqual(
      expect.objectContaining({
        assignment_id: first.assignment.id,
        action: "restart_once",
        evidence: expect.arrayContaining(["activity_recovered"]),
      }),
    );
    const request = (idempotency_key: string) =>
      call("host_ops_restart_assignment", {
        assignment_id: first.assignment.id,
        reason: "recover using same-line harness progress",
        idempotency_key,
      });
    await request("harness-witness");
    expect(hostOpsPending(f.state().events, first.assignment.id)).toBe(true);
    if (witnessState === "expired") f.advance(600_001);
    if (witnessState === "replaced") {
      f.advance(1);
      f.store.uow.run((tx) =>
        tx.events.append(f.project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.project),
          actor: { kind: "system", project_id: f.project },
          type: "session_replaced",
          created_at: f.clock.now(),
          payload: { assignment_id: witness.assignment.id },
        }),
      );
    }
    if (witnessState === "new_failure") {
      f.advance(1);
      const targetDir = executionPaths(
        execution,
        f.project,
        first.assignment.id,
      ).runDir;
      const targetFolder = join(targetDir, "codex", "sessions");
      await mkdir(targetFolder, { recursive: true });
      await writeFile(
        join(targetFolder, "rollout-2030-01-01.jsonl"),
        [
          {
            type: "session_meta",
            payload: { id: "target-session", cwd: targetDir },
          },
          {
            type: "event_msg",
            timestamp: f.clock.now(),
            payload: { type: "error", codex_error_info: "stream_disconnected" },
          },
        ]
          .map((v) => JSON.stringify(v))
          .join("\n"),
      );
    }
    await service.tick();
    if (witnessState === "current") {
      await vi.waitFor(() =>
        expect(hostOpsPending(f.state().events, first.assignment.id)).toBe(
          false,
        ),
      );
      expect(runtime.release).toHaveBeenCalledExactlyOnceWith(
        f.refFor(first.assignment),
        { force: true },
      );
      expect(
        f
          .state()
          .runs.filter(
            (r) =>
              r.assignment_id === first.assignment.id && r.status === "queued",
          ),
      ).toHaveLength(1);
      await expect(request("harness-witness-duplicate")).rejects.toThrow(
        "recovery_already_requested",
      );
    } else {
      await vi.waitFor(() =>
        expect(f.state().events).toContainEqual(
          expect.objectContaining({
            type: "host_ops_action_deferred",
            payload: expect.objectContaining({
              reason: "upstream_recovery_not_ready",
            }),
          }),
        ),
      );
      expect(runtime.release).not.toHaveBeenCalled();
      await expect(request("harness-witness-invalid")).rejects.toThrow(
        "awaiting_activity_recovery",
      );
    }
    // No fresh MCP/heartbeat or new Run supplied the recovery witness.
    const currentWitness = f
      .state()
      .assignments.find((a) => a.id === witness.assignment.id);
    expect(currentWitness?.last_mcp_activity_at).toBeUndefined();
  },
);

test.each([
  [5 * 60_000, "human"],
  [15 * 60_000, "human"],
  [15 * 60_000 + 1, "restart_once"],
] as const)(
  "C-213: real watchdog reports silence beginning %i ms after recovery as %s across service recreation",
  async (lastActivityAfterMs, action) => {
    const { assignment } = f.create();
    const original = f.session(assignment, false);
    const { sample } = upstreamService();
    await sample(true);
    const dispatcher = new Dispatcher({
      store: f.store,
      runtime,
      snapshot,
      clock: f.clock,
    });
    f.advance(15 * 60_000);
    await dispatcher.tick();
    expect(f.state().events).toContainEqual(
      expect.objectContaining({
        type: "run_inactive",
        payload: expect.objectContaining({ run_id: original.id }),
      }),
    );
    const restart = (key: string) =>
      call("host_ops_restart_assignment", {
        assignment_id: assignment.id,
        reason: "recover the inactive session",
        idempotency_key: key,
      });
    await restart("initial-recovery");
    await service.tick();
    await vi.waitFor(() =>
      expect(hostOpsPending(f.state().events, assignment.id)).toBe(false),
    );
    const recoveredAt = f.clock.now();
    expect(runtime.release).toHaveBeenCalledTimes(1);
    const nextRun = f
      .state()
      .runs.find(
        (r) => r.assignment_id === assignment.id && r.id !== original.id,
      );
    if (!nextRun) throw new Error("Recovery did not queue a replacement");
    // Include a real dispatch delay and start the replacement via domain commands.
    alive = true;
    f.advance(1_000);
    f.apply((s, a, p) =>
      dispatchRun(
        s,
        a,
        { run_id: nextRun.id, runtime_ref: f.refFor(assignment) },
        p,
      ),
    );
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: nextRun.id }, p),
      f.actorFor(assignment),
    );
    f.advance(lastActivityAfterMs - 1_000);
    expect(f.store.touchAssignmentActivity(f.project, assignment.id)).toBe(
      true,
    );
    f.advance(15 * 60_000 - 1);
    await dispatcher.tick();
    const alert = () =>
      f
        .state()
        .events.find(
          (e) =>
            e.type === "run_inactive" &&
            (e.payload as { run_id?: string }).run_id === nextRun.id,
        );
    expect(alert()).toBeUndefined();
    f.advance(1);
    await dispatcher.tick();
    expect(alert()?.created_at).toBe(f.clock.now());
    expect(Date.parse(f.clock.now()) - Date.parse(recoveredAt)).toBe(
      lastActivityAfterMs + 15 * 60_000,
    );
    await service.close();
    upstreamService();
    const view = (await call("host_ops_read_diagnostics", {})) as {
      upstream_health: { sessions: unknown[] };
    };
    expect(view.upstream_health.sessions).toContainEqual(
      expect.objectContaining({
        assignment_id: assignment.id,
        action,
      }),
    );
    if (action === "human") {
      await expect(restart("recurred")).rejects.toThrow("复发须交人");
      expect(
        f.state().events.filter((e) => e.type === "upstream_recovery_recurred"),
      ).toHaveLength(1);
      expect(
        f
          .state()
          .human_actions.some((h) =>
            h.instructions.includes(`${assignment.id} 在恢复后`),
          ),
      ).toBe(true);
    } else {
      expect(
        f.state().events.some((e) => e.type === "upstream_recovery_recurred"),
      ).toBe(false);
      await restart("later-stall");
    }
    const notices = f.state().human_actions.length;
    await call("host_ops_read_diagnostics", {});
    expect(f.state().human_actions).toHaveLength(notices);
    expect(runtime.release).toHaveBeenCalledTimes(1);
    await service.close();
  },
);

test("C-213: an outage recovery is withdrawn when the target resumes before execution", async () => {
  const target = dispatched();
  const witness = dispatched();
  const { sample } = upstreamService();
  markInactive(target.assignment, target.run.id);
  await sample(false);
  await call("host_ops_read_diagnostics", {});
  f.advance(600_000);
  f.store.uow.run((tx) => {
    const current = tx.assignments.get(f.project, witness.assignment.id);
    if (!current) throw new Error("Missing witness");
    tx.assignments.put(f.project, {
      ...current,
      last_mcp_activity_at: f.clock.now(),
    });
  });
  await sample(true);
  await call("host_ops_restart_assignment", {
    assignment_id: target.assignment.id,
    reason: "recover",
    idempotency_key: "recover-before-resume",
  });
  f.advance(1);
  f.store.uow.run((tx) => {
    const current = tx.assignments.get(f.project, target.assignment.id);
    if (!current) throw new Error("Missing target");
    tx.assignments.put(f.project, {
      ...current,
      last_mcp_activity_at: f.clock.now(),
    });
  });
  await service.tick();
  await vi.waitFor(() =>
    expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(false),
  );
  expect(runtime.release).not.toHaveBeenCalled();
  expect(hostOpsPending(f.state().events, target.assignment.id)).toBe(false);
  expect(f.state().events).toContainEqual(
    expect.objectContaining({
      type: "host_ops_action_finished",
      payload: expect.objectContaining({ result: "withdrawn_recovered" }),
    }),
  );
  await service.close();
});
