import {
  type Assignment,
  ATTACHED_HUMAN_WAIT_OVERDUE,
  ATTACHED_HUMAN_WAIT_REASON,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type HOST_OPS_TOOLS,
  notices,
  type Runtime,
} from "@cardigan/domain";
import { HostOpsService, tryHostOpsLock } from "@cardigan/host";
import {
  authenticate,
  hostOpsTools,
  type ToolContext,
  unwrap,
} from "@cardigan/mcp-server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";

/**
 * C-678: a session-ending host action waits while a human is attached to the
 * terminal. The wait is visible (reason, connection start, notices) and the
 * action continues by itself once the human detaches.
 */
let f: ReturnType<typeof dispatchFixture>;
let ops: Assignment;
let pm: Assignment;
let context: ToolContext;
let service: HostOpsService;
let alive: boolean;

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
  f.create(); // Registers the PM role used by this project.
  pm = {
    ...ops,
    id: "A-90" as never,
    role_id: "pm",
    standing_mode: "ops",
    runtime_state: "idle",
    runtime_ref: { ...f.refFor(ops), terminal_ref: "pm-terminal" },
    session_ref: "old-session",
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, pm));
  alive = true;
  const runtime = {
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
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    clock: f.clock,
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
const waits = () =>
  f
    .state()
    .events.filter(
      (e) =>
        e.type === "host_ops_action_deferred" &&
        (e.payload as { reason?: string }).reason ===
          ATTACHED_HUMAN_WAIT_REASON,
    );
const overdue = () =>
  f.state().events.filter((e) => e.type === ATTACHED_HUMAN_WAIT_OVERDUE);
const restarted = () =>
  f.state().events.some((e) => e.type === "standing_session_restarted");
const diagnostics = async () =>
  (
    (await call("host_ops_read_diagnostics", {})) as {
      actions: Record<string, unknown>[];
    }
  ).actions;

test("an attached human holds the restart with a visible reason; detaching lets it continue unchanged", async () => {
  const attachedAt = f.clock.now();
  const detach = await tryHostOpsLock(f.store, f.project, pm.id, "host-ops", {
    kind: "attach",
    mode: "interactive",
    started_at: attachedAt,
  });
  expect(detach).toBeDefined();
  try {
    await call("host_ops_restart_standing_pm", {
      assignment_id: pm.id,
      reason: "Context at restart threshold",
      idempotency_key: "restart",
    });
    await service.tick();
    await service.tick();
    expect(restarted()).toBe(false);
    // One wait fact, naming the attach mode and when the connection began.
    expect(waits()).toHaveLength(1);
    expect(waits()[0]?.payload).toMatchObject({
      assignment_id: pm.id,
      attach_mode: "interactive",
      attached_since: attachedAt,
      requested_by: `${ops.id}（主机运维）`,
      terminal_ref: "pm-terminal",
    });
    expect(waits()[0]?.payload).toMatchObject({
      notice: expect.stringContaining("Ctrl+\\"),
    });
    // The requesting Agent reads the reason, not a bare "pending".
    expect(await diagnostics()).toEqual([
      expect.objectContaining({
        tool: "host_ops_restart_standing_pm",
        status_reason: ATTACHED_HUMAN_WAIT_REASON,
        attached_since: attachedAt,
        attach_mode: "interactive",
        waiting_since: waits()[0]?.created_at,
      }),
    ]);
    // The requester is belled at once; the attached PM itself never is.
    const bells = f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === waits()[0]?.id);
    expect(bells.map((n) => n.recipient)).toEqual([
      { kind: "assignment", assignment_id: ops.id },
    ]);
    // Needs You learns of it only after ten minutes, and only once.
    f.advance(9 * 60_000);
    await service.tick();
    expect(overdue()).toHaveLength(0);
    f.advance(60_000);
    await service.tick();
    f.advance(60_000);
    await service.tick();
    expect(overdue()).toHaveLength(1);
    expect(overdue()[0]?.payload).toMatchObject({
      assignment_id: pm.id,
      terminal_ref: "pm-terminal",
      requested_by: `${ops.id}（主机运维）`,
      operation: "重启常驻 PM 会话",
    });
    expect(notices(f.state())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: overdue()[0]?.id,
          option: "Agent 终端有人连着，动作在等待断开",
          body: expect.stringContaining("pm-terminal"),
        }),
      ]),
    );
    expect(waits()).toHaveLength(1);
  } finally {
    await detach?.();
  }
  // Detached: the same request proceeds on the next drain without a resend.
  await service.tick();
  expect(restarted()).toBe(true);
  expect(await diagnostics()).toEqual([]);
});

test("a lock held by anything other than an attached human stays a plain pending action", async () => {
  const unlock = await tryHostOpsLock(f.store, f.project, pm.id);
  try {
    await call("host_ops_restart_standing_pm", {
      assignment_id: pm.id,
      reason: "Refresh tools",
      idempotency_key: "restart",
    });
    await service.tick();
    expect(waits()).toHaveLength(0);
    expect(await diagnostics()).toEqual([
      expect.objectContaining({ status_reason: "pending" }),
    ]);
  } finally {
    await unlock?.();
  }
});

test("a later attach session records its own start time", async () => {
  const first = await tryHostOpsLock(f.store, f.project, pm.id, "host-ops", {
    kind: "attach",
    mode: "observe",
    started_at: f.clock.now(),
  });
  await call("host_ops_restart_standing_pm", {
    assignment_id: pm.id,
    reason: "Refresh tools",
    idempotency_key: "restart",
  });
  await service.tick();
  await first?.();
  f.advance(1_000);
  const second = await tryHostOpsLock(f.store, f.project, pm.id, "host-ops", {
    kind: "attach",
    mode: "interactive",
    started_at: f.clock.now(),
  });
  try {
    await service.tick();
    expect(
      waits().map((e) => (e.payload as { attach_mode: string }).attach_mode),
    ).toEqual(["observe", "interactive"]);
    expect((await diagnostics())[0]).toMatchObject({
      attached_since: f.clock.now(),
      attach_mode: "interactive",
      waiting_since: waits()[0]?.created_at,
    });
  } finally {
    await second?.();
  }
});
