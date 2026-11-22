import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acknowledgeRun,
  dispatchRun,
  type Runtime,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import {
  listBellAttempts,
  PROJECT_EVENT_STREAM,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { Dispatcher } from "./dispatch.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";
import { startQueuedRun } from "./host-start.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());
function scenario() {
  const target = f.create(),
    previous = f.session(target.assignment, false);
  const decision = f.apply((s, a, p) =>
    requestDecision(
      s,
      a,
      {
        card_id: target.card.id,
        category: "general",
        kind: "choose",
        question: "Change behavior?",
        context: "Need direction",
        options: [{ key: "go", description: "Proceed", impact: "Resume" }],
        recommended: "go",
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        blocking: true,
        affected_cards: [target.card.id],
        affected_work_items: [target.item.id],
      },
      p,
    ),
  );
  for (const card of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      card ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card ? { card_id: card } : {}),
      }).latest_seq,
    );
  f.apply((s, a, p) =>
    recordDecision(
      s,
      a,
      {
        decision_id: decision.id,
        option: "go",
        rationale: "Approved",
        raw_quote: "go",
      },
      p,
    ),
  );
  const run = f.state().runs.find((r) => r.status === "queued");
  if (!run) throw new Error("No resumed Run");
  const runtime: Runtime = {
    status: vi.fn<Runtime["status"]>(async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "No core" },
    })),
    observe_retirement: vi.fn(async () => ({
      ok: true as const,
      value: "exited" as const,
    })),
    resume_or_replace: vi.fn(),
    provision: vi.fn<Runtime["provision"]>(
      async (_assignment, _role, _machine, launch) => {
        expect(
          unfinishedBellAttempts(f.store.database, f.project),
        ).toHaveLength(1);
        expect(launch.labels.run).toBe(run.id);
        return {
          ok: true,
          value: { ...f.refFor(target.assignment), terminal_ref: "t9" },
        };
      },
    ),
    wake: vi.fn(),
    release: vi.fn<Runtime["release"]>(async () => ({
      ok: true,
      value: undefined,
    })),
    interrupt: vi.fn(),
    human_entry: vi.fn(),
  };
  const host = {
    store: f.store,
    runtime,
    dataDir: f.dataDir,
    clock: f.clock,
    launch: {
      config: parseLaunchConfig({
        profiles: { fixture: { harness: "pi", model: "session-model" } },
      }),
      secrets: {},
    },
    mcpUrl: "http://localhost/mcp",
  };
  const options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({ model: "unused", agent_cli_version: "unused" }),
    startRun: (input: Parameters<typeof startQueuedRun>[1]) =>
      startQueuedRun(host, input),
  };
  return {
    target,
    previous,
    run,
    runtime,
    host,
    options,
    notes: () =>
      f.store.listNotifications({
        project_id: f.project,
        assignment_id: target.assignment.id,
      }),
  };
}

test.each(["runtime_not_found", "runtime_unavailable"] as const)(
  "M5.6 %s between Runs replaces the Session, commits a handoff and dispatches exactly the queued Run",
  async (code) => {
    const s = scenario();
    // Both snapshot errors still require a separate positive exit observation.
    // Only the old Session is lost; the replacement terminal is starting.
    vi.mocked(s.runtime.status).mockImplementation(async (ref) =>
      ref.terminal_ref === "t9"
        ? {
            ok: true,
            value: { process: "alive", agent: "idle", observed_seq: 1 },
          }
        : { ok: false, error: { code, message: "Lost" } },
    );
    expect(
      f.state().assignments.find((a) => a.id === s.target.assignment.id)
        ?.runtime_state,
    ).toBe("idle");
    await new Dispatcher(s.options).tick();
    await new Dispatcher(s.options).tick();
    expect(s.runtime.provision).toHaveBeenCalledOnce();
    expect(s.runtime.observe_retirement).toHaveBeenCalledOnce();
    expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
    expect(s.runtime.wake).not.toHaveBeenCalled();
    expect(f.state().runs).toHaveLength(2);
    expect(f.state().runs.find((r) => r.id === s.run.id)).toMatchObject({
      status: "dispatched",
      kind: "decision_resumed",
      model: s.run.model,
    });
    expect(
      f.state().assignments.find((a) => a.id === s.target.assignment.id),
    ).toMatchObject({
      runtime_state: "running",
      runtime_ref: { terminal_ref: "t9" },
    });
    const handoff = f.state().timeline.filter((e) => e.type === "handoff");
    expect(handoff).toHaveLength(1);
    expect(handoff[0]).toMatchObject({ author: "system", run_id: s.run.id });
    for (const word of [code, s.previous.id, "blocked", "get_updates"])
      expect(handoff[0]?.body).toContain(word);
    const first = readFileSync(
      join(f.dataDir, "runs", f.project, s.target.assignment.id, "first.md"),
      "utf8",
    );
    expect(first).toContain(`run=${s.run.id}`);
    expect(s.notes().every((n) => n.status === "belled")).toBe(true);
  },
);

test.each(["runtime_not_found", "runtime_unavailable"] as const)(
  "C-554 queued followup cannot replace a still-live owner on a %s snapshot",
  async (code) => {
    const s = scenario();
    vi.mocked(s.runtime.status).mockResolvedValue({
      ok: false,
      error: { code, message: "missing snapshot" },
    });
    s.runtime.observe_retirement = vi.fn(async () => ({
      ok: true,
      value: "alive",
    }));
    const d = new Dispatcher(s.options);
    try {
      await d.tick();
      expect(s.runtime.observe_retirement).toHaveBeenCalledWith(
        f.refFor(s.target.assignment),
        { project_id: f.project, assignment_id: s.target.assignment.id },
      );
      expect(s.runtime.provision).not.toHaveBeenCalled();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(s.runtime.release).not.toHaveBeenCalled();
      expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
        "queued",
      );
      expect(s.notes().map((n) => n.status)).toContain("pending");
    } finally {
      await d.close();
    }
  },
);
test.each([false, true])(
  "queued system-ended Run with a stopped core requires independent local exit proof (%s)",
  async (gone) => {
    const s = scenario();
    s.runtime.observe_retirement = vi.fn(async () => ({
      ok: false,
      error: { code: "runtime_unavailable", message: "core offline" },
    }));
    s.runtime.confirm_local_exit = vi.fn(async () => ({
      ok: true,
      value: gone,
    }));
    const d = new Dispatcher(s.options);
    try {
      await d.tick();
      expect(s.runtime.confirm_local_exit).toHaveBeenCalledWith(
        f.refFor(s.target.assignment),
        { project_id: f.project, assignment_id: s.target.assignment.id },
      );
      expect(s.runtime.provision).toHaveBeenCalledTimes(gone ? 1 : 0);
      expect(s.runtime.release).not.toHaveBeenCalled();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
        gone ? "dispatched" : "queued",
      );
    } finally {
      await d.close();
    }
  },
);

test.each(["dispatched", "running", "unknown"])(
  "M5.6 an in-flight %s Run prevents automatic replacement",
  async (status) => {
    const s = scenario();
    f.apply((state, a, p) => dispatchRun(state, a, { run_id: s.run.id }, p));
    if (status !== "dispatched")
      f.apply(
        (state, a, p) => acknowledgeRun(state, a, { run_id: s.run.id }, p),
        f.actorFor(s.target.assignment),
      );
    const events = runtimeEvents(),
      monitor = new RuntimeMonitor({
        store: f.store,
        runtime: events.source,
        clock: f.clock,
        lossGraceMs: 10,
      });
    try {
      monitor.reconcile();
      if (status === "unknown") {
        events.send({
          seq: 1,
          type: "lost",
          terminal_ref: f.refFor(s.target.assignment).terminal_ref,
        });
        await expect
          .poll(() => f.state().runs.find((r) => r.id === s.run.id)?.status)
          .toBe("unknown");
        f.advance(11);
        monitor.reconcile();
        expect(
          f.state().assignments.find((a) => a.id === s.target.assignment.id)
            ?.runtime_state,
        ).toBe("lost");
        expect(
          f.store.listNotifications({
            project_id: f.project,
            recipient_kind: "needs_you",
          }),
        ).toHaveLength(1);
        expect(
          f.store.listNotifications({
            project_id: f.project,
            recipient_kind: "pm_office",
          }),
        ).toHaveLength(1);
      }
      await new Dispatcher(s.options).tick();
      expect(s.runtime.resume_or_replace).not.toHaveBeenCalled();
      expect(s.runtime.provision).not.toHaveBeenCalled();
      // Probe unstarted dispatches for recovery and running sessions for idle
      // inbox delivery. An unreachable runtime must not be woken or replaced.
      expect(s.runtime.status).toHaveBeenCalledTimes(
        status === "unknown" ? 0 : 1,
      );
      expect(s.runtime.wake).not.toHaveBeenCalled();
      expect(f.state().runs).toHaveLength(2);
    } finally {
      await monitor.stop();
    }
  },
);

test("M5.6 failed replacement records failure, compensates and escalates once; cancelled Run attention resolves", async () => {
  const s = scenario();
  vi.mocked(s.runtime.provision).mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "Cannot restart" },
  });
  const dispatcher = new Dispatcher(s.options);
  await dispatcher.tick();
  const failed = s.notes();
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.every((n) => n.status === "delivery_failed")).toBe(true);
  const attempts = listBellAttempts(f.store.database, f.project).filter(
    (attempt) => attempt.run_id === s.run.id,
  );
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    outcome: "failed",
    finished_at: f.clock.now(),
  });
  expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
    "cancelled",
  );
  const tokens = f.store.uow.run((tx) =>
    tx.tokensForAssignment(f.project, s.target.assignment.id),
  );
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
  const cursors = f.state().cursors;
  f.advance(3600000);
  await dispatcher.tick();
  // C-56 clears obsolete attention after compensation cancels the Run. It must
  // retain the failed receipt and notification identity, without retrying it.
  expect(s.notes()).toEqual(
    failed.map((note) => ({
      ...note,
      status: "resolved",
      updated_at: f.clock.now(),
    })),
  );
  const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await new Dispatcher({ ...s.options, store: reopened }).tick();
    expect(listBellAttempts(reopened.database, f.project)).toEqual(attempts);
  } finally {
    reopened.close();
  }
  expect(f.state().cursors).toEqual(cursors);
  expect(s.runtime.provision).toHaveBeenCalledOnce();
  expect(s.notes().every((n) => n.status === "resolved")).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(f.state().runs.find((r) => r.id === s.run.id)?.status).toBe(
    "cancelled",
  );
  expect(f.state().runs).toHaveLength(2);
  expect(
    f.state().events.filter((e) => e.type === "bell_delivery_failed"),
  ).toHaveLength(1);
  expect(
    f
      .state()
      .events.filter((e) =>
        ["run_dispatch_recovered", "run_dispatch_stalled"].includes(e.type),
      ),
  ).toEqual([]);
  expect(f.state().timeline.filter((e) => e.type === "handoff")).toEqual([]);
  expect(
    f.store
      .listNotifications({
        project_id: f.project,
        recipient_kind: "pm_ops",
      })
      .filter(
        (n) =>
          f.state().events.find((e) => e.id === n.event_id)?.type ===
          "bell_delivery_failed",
      ),
  ).toHaveLength(1);
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, s.target.assignment.id))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
});
