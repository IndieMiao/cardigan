import { finishRun, reportBlocker, updateWorkItem } from "@cardigan/domain";
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
function precheck(status: "passed" | "running") {
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: status === "passed" ? "precheck_finished" : "precheck_started",
      actor: { kind: "system", project_id: f.project },
      created_at: f.clock.now(),
      payload: { attempt_id: "fixture-precheck", status },
    }),
  );
}
function allowBlocker() {
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, { role_id: "coder", role_version: 1 });
    if (!role) throw new Error("Missing fixture role");
    tx.roles.put(f.project, {
      ...role,
      allowed_tools: [...role.allowed_tools, "report_blocker"],
    });
  });
}
function blockForPrecheck(target: ReturnType<typeof f.create>) {
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
  return run;
}
test("SQLite restart retains structured blockers and aggregates two resumptions into one PM notice", () => {
  const one = f.create(),
    two = f.create();
  allowBlocker();
  precheck("passed");
  for (const target of [one, two]) blockForPrecheck(target);
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

test.each(["blocked", "error", "unknown"] as const)(
  "author finish(blocked) → precheck finish → resume rings a new Run on an alive/%s terminal",
  async (agent) => {
    const target = f.create();
    allowBlocker();
    f.apply((s, a, p) =>
      updateWorkItem(
        s,
        a,
        { work_item_id: target.item.id, manual_assign: true },
        p,
      ),
    );
    precheck("running");
    const previous = blockForPrecheck(target);
    for (const card_id of [undefined, target.card.id])
      f.store.advanceRouterCursor(
        f.project,
        card_id ?? PROJECT_EVENT_STREAM,
        f.store.getUpdates({
          project_id: f.project,
          ...(card_id ? { card_id } : {}),
        }).latest_seq,
      );
    const wake = vi.fn<DispatcherOptions["runtime"]["wake"]>(
      async (_ref, _text, opts) => {
        expect(opts?.if_idle).toBeUndefined();
        expect(opts?.observed_guard).toBeUndefined();
        expect(opts?.before_send?.()).toBe(true);
        return { ok: true, value: { sent: true } };
      },
    );
    const options: DispatcherOptions = {
      store: f.store,
      clock: f.clock,
      runtime: {
        status: async () => ({
          ok: true,
          value: { process: "alive", agent, observed_seq: 1 },
        }),
        wake,
      } as DispatcherOptions["runtime"],
      snapshot: vi.fn(),
      startRun: vi.fn(),
    };
    await new Dispatcher(options).tick();
    expect(wake).not.toHaveBeenCalled();
    precheck("passed");
    await new Dispatcher(options).tick();
    await new Dispatcher(options).tick();
    const resume = f
      .state()
      .events.find((e) => e.type === "work_item_resume_requested");
    expect(resume?.id).toBeDefined();
    const followups = f
      .state()
      .runs.filter(
        (r) => r.id !== previous.id && r.assignment_id === target.assignment.id,
      );
    expect(followups).toMatchObject([
      { status: "dispatched", trigger_event_id: resume?.id },
    ]);
    expect(
      f.store.listNotifications({
        project_id: f.project,
        assignment_id: target.assignment.id,
      }),
    ).toContainEqual(
      expect.objectContaining({
        status: "belled",
        run_id: followups[0]?.id,
        event_id: resume?.id,
      }),
    );
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]?.[1]).toContain(`run=${followups[0]?.id}`);
    expect(options.startRun).not.toHaveBeenCalled();
  },
);

test.each(["explicit", "conflict", "blocked"])(
  "Dispatcher observes baseline and prepares it before one followup wake (%s)",
  async (mode) => {
    const { target, run } = wait();
    if (mode !== "explicit")
      f.store.uow.run((tx) => {
        const finished = tx.runs.get(f.project, run.id)!;
        const { wait_for: _wait, ...withoutWait } = finished;
        tx.runs.put(f.project, withoutWait);
        tx.events.append(f.project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.project, target.card.id),
          card_id: target.card.id,
          type: "precheck_finished",
          actor: { kind: "system", project_id: f.project },
          created_at: f.clock.now(),
          payload: {
            attempt_id: "conflict",
            card_id: target.card.id,
            assignment_id: target.assignment.id,
            work_item_id: target.item.id,
            head_sha: "c".repeat(40),
            base_sha: next,
            status: "environment_failed",
            failure_kind: "candidate_conflict",
            branch: "agent/fixture",
            machine_id: "local",
          },
        });
        if (mode === "blocked")
          tx.work_items.put(f.project, {
            ...tx.work_items.get(f.project, target.item.id)!,
            status: "blocked",
            reported_blocker: {
              reason: "Precheck merge conflict，需要同步新基线",
              needs: "role",
              reported_by: `assignment:${target.assignment.id}`,
              reported_at: f.clock.now(),
            },
          });
      });
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
    const beforeWake = vi.fn(
      async () => `当前基线 origin/main：${next}（已由主机同步）。`,
    );
    const options: DispatcherOptions = {
      store: f.store,
      clock: f.clock,
      baselineForWait,
      beforeWake,
      runtime: {
        status: vi.fn(async () => ({
          ok: true,
          value: { process: "alive", agent: "idle", observed_seq: 1 },
        })),
        wake,
        release: async () => ({ ok: true, value: undefined }),
        interrupt: async () => ({ ok: true, value: undefined }),
      } as unknown as DispatcherOptions["runtime"],
      snapshot: async () => ({
        model: "fixture",
        agent_cli_version: "fixture",
      }),
      startRun: async () => {
        throw new Error("Existing session must be reused");
      },
    };
    await new Dispatcher(options).tick();
    expect(wake).not.toHaveBeenCalled();
    baselineForWait.mockResolvedValue({ branch: "main", sha: next });
    await new Dispatcher(options).tick();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(beforeWake).toHaveBeenCalledTimes(1);
    expect(beforeWake.mock.invocationCallOrder[0]).toBeLessThan(
      wake.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(wake.mock.calls)).toContain(next);
    expect(
      f.state().work_items.find((w) => w.id === target.item.id)
        ?.reported_blocker,
    ).toBeUndefined();
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
  },
);
