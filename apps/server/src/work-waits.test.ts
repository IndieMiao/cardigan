import { finishRun, reportBlocker } from "@cardigan/domain";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());
const base = "a".repeat(40),
  next = "b".repeat(40);
function wait() {
  const target = f.create();
  const run = f.session(target.assignment, false);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...(tx.assignments.get(f.project, target.assignment.id) ??
        target.assignment),
      base_sha: base,
    }),
  );
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        {
          run_id: run.id,
          outcome: "completed",
          summary: "Wait for baseline",
          wait_for: { kind: "baseline_updated" },
        },
        p,
      ),
    f.actorFor(target.assignment),
  );
  return { target, run };
}
function settlePrecheck() {
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: "precheck_finished",
      actor: { kind: "system", project_id: f.project },
      created_at: f.clock.now(),
      payload: { attempt_id: "fixture-precheck", status: "passed" },
    }),
  );
}
test("SQLite restart retains structured blockers and aggregates two resumptions into one PM notice", () => {
  const one = f.create(),
    two = f.create();
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, { role_id: "coder", role_version: 1 });
    if (!role) throw new Error("Missing fixture role");
    tx.roles.put(f.project, {
      ...role,
      allowed_tools: [...role.allowed_tools, "report_blocker"],
    });
  });
  settlePrecheck();
  for (const target of [one, two]) {
    const run = f.session(target.assignment, false);
    // Fixture role permits this newly exercised tool; production uses the unchanged registered scope.
    const actor = {
      ...f.actorFor(target.assignment),
      allowed_tools: ["report_blocker" as const, "finish_run" as const],
    };
    f.apply(
      (s, a, p) =>
        reportBlocker(
          s,
          a,
          {
            work_item_id: target.item.id,
            reason: "Wait check",
            needs: "role",
            resume_when: {
              kind: "precheck_finished",
              target_id: "fixture-precheck",
            },
          },
          p,
        ),
      actor,
    );
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "blocked", summary: "Wait" },
          p,
        ),
      f.actorFor(target.assignment),
    );
  }
  const restarted = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    runSystemRules(restarted, f.project, f.clock);
    routeProjectEvents(restarted, f.project, { clock: f.clock });
    runSystemRules(restarted, f.project, f.clock);
    routeProjectEvents(restarted, f.project, { clock: f.clock });
    const state = f.state();
    expect(
      state.work_items
        .filter((w) => [one.item.id, two.item.id].includes(w.id))
        .map((w) => w.status),
    ).toEqual(["in_progress", "in_progress"]);
    const summaries = state.events.filter(
      (e) => e.type === "work_waits_resumed",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload).toMatchObject({
      work_item_ids: [one.item.id, two.item.id],
    });
    const notifications = restarted.listNotifications({
      project_id: f.project,
    });
    expect(
      notifications.filter((n) => n.event_id === summaries[0]?.id),
    ).toMatchObject([{ recipient: { kind: "pm_ops" } }]);
    expect(
      notifications.filter((n) =>
        state.events.some(
          (e) => e.id === n.event_id && e.type === "work_item_resume_requested",
        ),
      ),
    ).toHaveLength(2);
  } finally {
    restarted.close();
  }
});

test("Dispatcher observes baseline, persists a followup and wakes the original author once", async () => {
  const { target, run } = wait();
  for (const card_id of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      card_id ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(card_id ? { card_id } : {}),
      }).latest_seq,
    );
  const wake = vi.fn(async () => ({ ok: true, value: { sent: true } }));
  const baselineForWait = vi.fn(async () => ({ branch: "main", sha: base }));
  const options: DispatcherOptions = {
    store: f.store,
    clock: f.clock,
    baselineForWait,
    runtime: {
      status: vi.fn(async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      })),
      wake,
      release: async () => ({ ok: true, value: undefined }),
      interrupt: async () => ({ ok: true, value: undefined }),
    } as unknown as DispatcherOptions["runtime"],
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    startRun: async () => {
      throw new Error("Existing session must be reused");
    },
  };
  await new Dispatcher(options).tick();
  expect(wake).not.toHaveBeenCalled();
  baselineForWait.mockResolvedValue({ branch: "main", sha: next });
  await new Dispatcher(options).tick();
  expect(wake).toHaveBeenCalledTimes(1);
  const followups = f
    .state()
    .runs.filter(
      (r) => r.assignment_id === target.assignment.id && r.id !== run.id,
    );
  expect(followups).toHaveLength(1);
  expect(followups[0]).toMatchObject({
    kind: "followup",
    status: "dispatched",
  });
  await new Dispatcher(options).tick();
  expect(wake).toHaveBeenCalledTimes(1);
});
