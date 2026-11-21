import {
  acknowledgeRun,
  beginIdleSessionRetirement,
  cancelHumanAction,
  completeHumanAction,
  dispatchRun,
  finishRun,
  postComment,
  prechecks,
  prepareCheck,
  prepareDelivery,
  recordPrecheck,
  reportBlocker,
  requestCheck,
  requestHumanAction,
  stopWorkItemAssignment,
  submitDelivery,
  triageHumanAction,
  updateWorkItem,
} from "@cardigan/domain";
import * as host from "@cardigan/host";
import { defaultRoleDefinition } from "@cardigan/roles";
import { PROJECT_EVENT_STREAM, writeRole } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { value } from "../../../packages/domain/src/commands/test-fixtures.js";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
function setup(upgrade = true, complete = true) {
  const f = dispatchFixture();
  fixtures.push(f);
  const target = f.create();
  f.session(target.assignment, complete);
  for (const stream of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      stream ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(stream ? { card_id: stream } : {}),
      }).latest_seq,
    );
  if (upgrade)
    f.store.uow.run((tx) =>
      writeRole(
        tx,
        f.project,
        {
          ...defaultRoleDefinition("coder", {
            harness: "pi",
            launch_profile_ref: "fixture",
          }),
          version: 2,
        },
        { mode: "update" },
      ),
    );
  let busy = false;
  let probes = 0;
  const runtime: DispatcherOptions["runtime"] = {
    status: vi.fn(async () => {
      probes++;
      return !busy && upgrade && probes % 2 === 0
        ? {
            ok: false,
            error: {
              code: "runtime_unavailable",
              message: "synthetic confirmation failure",
            },
          }
        : {
            ok: true,
            value: {
              process: busy || !upgrade ? "alive" : "exited",
              agent: busy ? "working" : "idle",
              observed_seq: 1,
            },
          };
    }),
    release: vi.fn(),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun = vi.fn(
    async ({
      run,
      assignment,
    }: Parameters<NonNullable<DispatcherOptions["startRun"]>>[0]) => {
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
  const onError = vi.fn();
  const snapshot = vi.fn(async () => ({
    model: "fixture",
    agent_cli_version: "1",
    launch_profile_ref: "current-profile",
    harness: "pi" as const,
    effort: "high",
  }));
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    onError,
    snapshot,
  });
  const comment = () =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Continue",
        },
        p,
      ),
    );
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  return {
    ...f,
    target,
    runtime,
    dispatcher,
    startRun,
    onError,
    snapshot,
    comment,
    owner,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

test("idle retirement defers bells and the next legal wake starts exactly one replacement session", async () => {
  const f = setup(false);
  f.store.touchAssignmentActivity(f.project, f.owner().id, f.clock.now());
  f.advance(60 * 60_000 + 1);
  let finish!: () => void;
  f.runtime.retire_idle = async (_ref, options) => {
    expect(options.before_signal()).toBe(true);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: true, value: { outcome: "exited" } };
  };
  const retirement = host.upgradeIdleAssignmentRoles(
    f.store,
    f.project,
    f.runtime,
    f.clock,
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  f.comment();
  await f.dispatcher.tick();
  expect(f.startRun).not.toHaveBeenCalled();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  finish();
  await retirement;
  expect(f.owner().runtime_ref).toBeNull();
  await f.dispatcher.tick();
  await f.dispatcher.tick();
  expect(f.startRun).toHaveBeenCalledOnce();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

async function recoveredWaitingRun() {
  const f = setup(false),
    owner = f.owner(),
    system = { kind: "system" as const, project_id: f.project };
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: owner.id,
    role: { role_version: owner.role_version, allowed_tools: ["get_card"] },
  });
  f.store.touchAssignmentActivity(f.project, owner.id, f.clock.now());
  f.advance(60 * 60_000 + 1);
  const retire = vi
    .fn<NonNullable<typeof f.runtime.retire_idle>>()
    .mockResolvedValue({
      ok: true,
      value: {
        outcome: "withdrawn",
        evidence: { stage: "probe", reason: "pidfd_unavailable" },
      },
    });
  f.runtime.retire_idle = retire;
  f.runtime.observe_retirement = vi
    .fn<NonNullable<typeof f.runtime.observe_retirement>>()
    .mockResolvedValue({ ok: true, value: "alive" });
  await host.upgradeIdleAssignmentRoles(f.store, f.project, f.runtime, f.clock);
  f.advance(60_000);
  f.apply(
    (s, a, p) => beginIdleSessionRetirement(s, a, owner.id, 60, p),
    system,
  );
  expect(f.owner().idle_retirement).toMatchObject({
    phase: "stopping",
    observe_only: true,
  });
  // Crash after commit, before I/O. New business work arrives during the interruption.
  f.comment();
  const trigger = f
    .state()
    .events.filter((e) => e.type === "comment_posted")
    .at(-1)!;
  const queued = f.store.uow.run((tx) => {
    const id = tx.ids.next(f.project, "run");
    tx.runs.put(f.project, {
      id,
      assignment_id: owner.id,
      role_version: owner.role_version,
      trigger_event_id: trigger.id,
      kind: "followup",
      status: "queued",
      model: "fixture",
      agent_cli_version: "1",
      queue_entered_at: f.clock.now(),
      outcome: null,
      summary: "",
    });
    return id;
  });
  await host.upgradeIdleAssignmentRoles(f.store, f.project, f.runtime, f.clock);
  expect(f.owner().idle_retirement).toMatchObject({ phase: "waiting" });
  return { f, queued, retire, owner, token };
}

function waitNotices(f: ReturnType<typeof setup>) {
  const notices = f
    .state()
    .events.filter((e) => e.type === "session_maintenance_attention");
  return f.store
    .listNotifications({ project_id: f.project, recipient_kind: "pm_ops" })
    .filter((n) => notices.some((e) => e.id === n.event_id));
}

test("restart after a read-only claim lets a queued Run wake the same live session once", async () => {
  const { f, queued, retire, owner, token } = await recoveredWaitingRun();
  vi.mocked(f.runtime.status).mockResolvedValueOnce({
    ok: false,
    error: { code: "runtime_not_found", message: "snapshot gap" },
  });
  await f.dispatcher.tick();
  expect(waitNotices(f)).toMatchObject([{ status: "pending" }]);
  expect(f.owner().idle_retirement?.dispatch_wait).toMatchObject({
    source: "snapshot",
    status: "runtime_not_found",
  });
  expect(f.startRun).not.toHaveBeenCalled();
  expect(f.state().runs.find((r) => r.id === queued)?.status).toBe("queued");
  await f.dispatcher.tick();
  await f.dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === queued)?.status).toBe(
    "dispatched",
  );
  await host.upgradeIdleAssignmentRoles(f.store, f.project, f.runtime, f.clock);
  expect(waitNotices(f)).toMatchObject([{ status: "resolved" }]);
  expect(f.owner().idle_retirement?.dispatch_wait).toBeUndefined();
  expect(f.owner().idle_retirement?.evidence?.reason).toBe("pidfd_unavailable");
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(
    vi.mocked(f.runtime.wake).mock.calls[0]?.[2]?.retirement_owner,
  ).toEqual({ project_id: f.project, assignment_id: owner.id });
  expect(f.startRun).not.toHaveBeenCalled();
  expect(retire).toHaveBeenCalledOnce();
  expect(f.owner().runtime_ref).toEqual(owner.runtime_ref);
  expect(f.store.verifyToken(token.token)).toBeTruthy();
});

async function retirementWakeToRetry(firstWake: "withdrawn" | "queue_timeout") {
  const fixture = await recoveredWaitingRun();
  const { f, queued } = fixture;
  vi.mocked(f.runtime.status).mockResolvedValueOnce({
    ok: false,
    error: { code: "runtime_not_found", message: "snapshot gap" },
  });
  await f.dispatcher.tick();
  const wait = f.owner().idle_retirement?.dispatch_wait;
  expect(wait?.event_id).toBeTruthy();

  const wake = vi.mocked(f.runtime.wake);
  wake.mockResolvedValueOnce(
    firstWake === "withdrawn"
      ? { ok: true, value: { sent: false, withdrawn: true } }
      : {
          ok: false,
          error: {
            code: "runtime_queue_timeout",
            message: "pre-send timeout",
          },
        },
  );
  await f.dispatcher.tick();
  expect(wake).toHaveBeenCalledOnce();
  expect(f.state().runs.find((r) => r.id === queued)?.status).toBe(
    "dispatched",
  );
  expect(waitNotices(f)).toMatchObject([
    { event_id: wait?.event_id, status: "pending" },
  ]);

  return { ...fixture, wake, wait };
}

test.each(["withdrawn", "queue_timeout"] as const)(
  "a confirmed retry after %s resolves the original retirement wait",
  async (firstWake) => {
    const { f, queued, owner, token, wake, wait } =
      await retirementWakeToRetry(firstWake);
    wake.mockImplementationOnce(async (ref, _bell, options) => {
      expect(ref).toEqual(owner.runtime_ref);
      expect(options?.retirement_owner).toEqual({
        project_id: f.project,
        assignment_id: owner.id,
      });
      expect(await options?.before_send?.()).toBe(true);
      return { ok: true, value: { sent: true } };
    });
    f.advance(31_000);
    await f.dispatcher.tick();
    expect(wake).toHaveBeenCalledTimes(2);
    const actor = f.actorFor(f.owner());
    f.apply((s, a, p) => acknowledgeRun(s, a, { run_id: queued }, p), actor);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: queued, outcome: "completed", summary: "resumed" },
          p,
        ),
      actor,
    );
    await host.upgradeIdleAssignmentRoles(
      f.store,
      f.project,
      f.runtime,
      f.clock,
    );
    expect(waitNotices(f)).toMatchObject([
      { event_id: wait?.event_id, status: "resolved" },
    ]);
    expect(f.owner().idle_retirement?.dispatch_wait).toBeUndefined();
    expect(
      f.state().events.filter((e) => e.type === "retirement_dispatch_resumed"),
    ).toMatchObject([
      {
        payload: {
          assignment_id: owner.id,
          run_id: queued,
          retirement_wait_event_id: wait?.event_id,
        },
      },
    ]);
    expect(f.owner().runtime_ref).toEqual(owner.runtime_ref);
    expect(f.store.verifyToken(token.token)).toBeTruthy();
    expect(f.startRun).not.toHaveBeenCalled();
  },
);

test("a Run acknowledged before the retry sends is not a guarded wake receipt", async () => {
  const { f, queued, wake, wait } = await retirementWakeToRetry("withdrawn");
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime: f.runtime,
    startRun: f.startRun,
    snapshot: f.snapshot,
    beforeWake: async () => {
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: queued }, p),
        f.actorFor(f.owner()),
      );
    },
  });
  f.advance(31_000);
  await dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === queued)?.status).toBe("running");
  expect(wake).toHaveBeenCalledOnce(); // The first, withdrawn call only.
  expect(f.owner().idle_retirement?.dispatch_wait).toEqual(wait);
  expect(
    f.state().events.some((e) => e.type === "retirement_dispatch_resumed"),
  ).toBe(false);
});

test.each([
  "runtime_not_found",
  "runtime_unavailable",
  "exited",
  "owner_conflict",
] as const)(
  "retirement-held Run with %s waits for exact exit before one fresh launch",
  async (missing) => {
    const { f, queued, retire, owner, token } = await recoveredWaitingRun();
    if (missing === "owner_conflict")
      vi.mocked(f.runtime.observe_retirement!).mockResolvedValue({
        ok: false,
        error: { code: "runtime_conflict", message: "owner changed" },
      });
    else if (missing === "exited")
      vi.mocked(f.runtime.status).mockResolvedValue({
        ok: true,
        value: { process: "exited", agent: "done", observed_seq: 2 },
      });
    else
      vi.mocked(f.runtime.status).mockResolvedValue({
        ok: false,
        error: { code: missing, message: "missing snapshot" },
      });
    for (let i = 0; i < 5; i++) {
      f.advance(15 * 60_000);
      await host.upgradeIdleAssignmentRoles(
        f.store,
        f.project,
        f.runtime,
        f.clock,
      );
      await f.dispatcher.tick();
    }
    const detail =
      missing === "owner_conflict"
        ? { source: "owner", status: "runtime_conflict" }
        : { source: "snapshot", status: missing };
    expect(f.owner().idle_retirement).toMatchObject({
      failures: 2,
      phase: "waiting",
      dispatch_wait: detail,
      evidence: {
        reason: "pidfd_unavailable",
        observation:
          missing === "owner_conflict" ? "runtime_conflict" : "alive",
      },
    });
    const notices = waitNotices(f);
    expect(notices).toMatchObject([{ status: "pending" }]);
    const event = f.state().events.find((e) => e.id === notices[0]?.event_id);
    expect(event?.payload).toMatchObject({
      evidence: detail,
      notice: expect.stringContaining("hc get 只读核对"),
    });
    expect(JSON.stringify(event?.payload)).not.toMatch(
      /owner changed|missing snapshot|cardigan assignment stop/,
    );
    expect(
      f.state().events.some((e) => e.type === "queued_runtime_unavailable"),
    ).toBe(false);
    expect(f.state().runs.find((r) => r.id === queued)).toMatchObject({
      status: "queued",
      queue_reason: "runtime_unavailable",
    });
    expect(f.owner().runtime_ref).toEqual(owner.runtime_ref);
    expect(f.store.verifyToken(token.token)).toBeTruthy();
    expect(f.startRun).not.toHaveBeenCalled();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    vi.mocked(f.runtime.observe_retirement!).mockResolvedValue({
      ok: true,
      value: "exited",
    });
    await f.dispatcher.tick();
    expect(f.owner().runtime_ref).toBeNull();
    expect(f.store.verifyToken(token.token)).toBeUndefined();
    await f.dispatcher.tick();
    await f.dispatcher.tick();
    expect(retire).toHaveBeenCalledOnce();
    expect(f.startRun).toHaveBeenCalledOnce();
    expect(f.startRun.mock.calls[0]?.[0].run.id).toBe(queued);
    expect(f.startRun.mock.calls[0]?.[0].replacement).toBeUndefined();
    expect(f.runtime.release).not.toHaveBeenCalled();
    const caller = f.actorFor(f.owner());
    f.apply((s, a, p) => acknowledgeRun(s, a, { run_id: queued }, p), caller);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: queued, outcome: "completed", summary: "Resumed" },
          p,
        ),
      caller,
    );
    await host.upgradeIdleAssignmentRoles(
      f.store,
      f.project,
      f.runtime,
      f.clock,
    );
    expect(waitNotices(f)).toMatchObject([
      { event_id: event?.id, status: "resolved" },
    ]);
    expect(f.owner().idle_retirement).toBeUndefined();
  },
);

test.each(["triage", "legacy", "complete", "cancel"] as const)(
  "upgraded human-action recovery via %s dispatches once even when the follow-up is deferred",
  async (entry) => {
    const f = setup(true, false);
    const owner = f.owner();
    f.store.uow.run((tx) => {
      const role = tx.roles.get(f.project, {
        role_id: owner.role_id,
        role_version: owner.role_version,
      });
      if (!role) throw new Error("Missing role");
      tx.roles.put(f.project, {
        ...role,
        allowed_tools: [...role.allowed_tools, "request_human_action"],
      });
    });
    const caller = f.actorFor(owner);
    const action = f.apply(
      (s, a, p) =>
        requestHumanAction(
          s,
          a,
          {
            card_id: f.target.card.id,
            instructions: "Configure account",
            why_human: "Account access",
            expected_return: "Ready",
            blocks_merge: true,
            prerequisite: "external_account",
            blocked_work_items: [f.target.item.id],
          },
          p,
        ),
      caller,
    );
    const previous = f.state().runs.find((r) => r.assignment_id === owner.id);
    if (!previous) throw new Error("Missing old Run");
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: previous.id,
            outcome: "blocked",
            summary: "Await prerequisite",
          },
          p,
        ),
      caller,
    );
    const history = f.state().runs;
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "exited", agent: "idle", observed_seq: 2 },
    });
    await host.upgradeIdleAssignmentRoles(
      f.store,
      f.project,
      f.runtime,
      f.clock,
    );
    expect(f.owner().role_version).toBe(2);
    if (entry === "triage")
      f.apply((s, a, p) =>
        triageHumanAction(
          s,
          a,
          {
            human_action_id: action.id,
            disposition: "human",
            blocks_merge: false,
            rationale: "Collect evidence after deployment",
            title: "Field evidence",
            summary: "Follow up",
            why_human: "Physical access",
            instructions: "Collect evidence",
            expected_outcome: "Recorded",
            expected_return: "Evidence",
          },
          p,
        ),
      );
    else if (entry === "legacy") {
      const {
        blocks_merge: _blocks,
        prerequisite: _prerequisite,
        ...legacy
      } = action;
      f.store.uow.run((tx) => tx.human_actions.put(f.project, legacy));
      // The real system-maintenance consumer performs legacy reclassification.
    } else if (entry === "complete")
      f.apply((s, a, p) =>
        completeHumanAction(
          s,
          a,
          { human_action_id: action.id, text: "Ready" },
          p,
        ),
      );
    else
      f.apply((s, a, p) =>
        cancelHumanAction(
          s,
          a,
          { human_action_id: action.id, reason: "No longer needed" },
          p,
        ),
      );
    await f.dispatcher.tick([f.project]);
    expect(
      f.state().work_items.find((w) => w.id === f.target.item.id)?.status,
    ).toBe("in_progress");
    if (["triage", "legacy"].includes(entry))
      expect(f.state().human_actions[0]).toMatchObject({
        ready_when: { kind: "card_merged" },
        status: "open",
      });
    expect(f.startRun).toHaveBeenCalledTimes(1);
    const next = f.state().runs.find((r) => r.id !== previous.id);
    expect(next).toMatchObject({
      status: "dispatched",
      role_version: 2,
      model: "fixture",
      launch_profile_ref: "current-profile",
    });
    expect(
      f.store.listNotifications({
        project_id: f.project,
        assignment_id: owner.id,
      }),
    ).toHaveLength(1);
    if (!next) throw new Error("Missing resumed Run");
    const freshCaller = f.actorFor(f.owner());
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: next.id }, p),
      freshCaller,
    );
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: next.id, outcome: "completed", summary: "Resumed" },
          p,
        ),
      freshCaller,
    );
    await f.dispatcher.tick([f.project]);
    expect(f.startRun).toHaveBeenCalledTimes(1);
    expect(f.state().runs.filter((r) => r.id === previous.id)).toEqual(history);
    expect(f.onError).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "an upgraded blocked work item resumes with current settings and respects human stop=%s",
  async (stopped) => {
    const f = setup(true, false);
    const owner = f.owner();
    f.store.uow.run((tx) => {
      const role = tx.roles.get(f.project, {
        role_id: owner.role_id,
        role_version: owner.role_version,
      });
      if (!role) throw new Error("Missing role");
      tx.roles.put(f.project, {
        ...role,
        allowed_tools: [...role.allowed_tools, "report_blocker"],
      });
    });
    const oldActor = f.actorFor(owner);
    if (oldActor.kind !== "assignment") throw new Error("Expected owner");
    f.apply(
      (s, a, p) =>
        reportBlocker(
          s,
          a,
          {
            work_item_id: f.target.item.id,
            reason: "Old role lacks precheck",
            needs: "role",
          },
          p,
        ),
      oldActor,
    );
    const old = f.state().runs.find((r) => r.assignment_id === owner.id)!;
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          {
            run_id: old.id,
            outcome: "blocked",
            summary: "Waiting for role upgrade",
          },
          p,
        ),
      oldActor,
    );
    const historical = f.state().runs.find((r) => r.id === old.id);
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: {
        process: "exited",
        agent: "idle",
        observed_seq: 2,
      },
    });
    await f.dispatcher.tick([f.project]);
    expect(f.owner().role_version).toBe(2);
    expect(
      f.state().work_items.find((w) => w.id === f.target.item.id)?.status,
    ).toBe("blocked");
    expect(f.startRun).not.toHaveBeenCalled();
    if (stopped)
      f.apply((s, a, p) =>
        stopWorkItemAssignment(
          s,
          a,
          {
            assignment_id: owner.id,
            reason: "Keep stopped after upgrade",
          },
          p,
        ),
      );
    f.apply((s, a, p) =>
      updateWorkItem(
        s,
        a,
        {
          work_item_id: f.target.item.id,
          status: "in_progress",
        },
        p,
      ),
    );
    expect(
      f.state().work_items.find((w) => w.id === f.target.item.id),
    ).toMatchObject({ status: "in_progress" });
    expect(
      f.state().work_items.find((w) => w.id === f.target.item.id)
        ?.reported_blocker,
    ).toBeUndefined();
    await f.dispatcher.tick([f.project]);
    if (stopped) {
      expect(f.startRun).not.toHaveBeenCalled();
      expect(f.state().runs).toEqual([historical]);
      expect(
        f.store.listNotifications({
          project_id: f.project,
          assignment_id: owner.id,
          status: "pending",
        }),
      ).toHaveLength(1);
      return;
    }
    expect(f.startRun).toHaveBeenCalledTimes(1);
    expect(f.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: owner.id, role_version: 2 }),
      f.project,
    );
    const resumed = f
      .state()
      .runs.find((r) => r.id !== old.id && r.assignment_id === owner.id)!;
    expect(resumed).toMatchObject({
      status: "dispatched",
      kind: "followup",
      role_version: 2,
      model: "fixture",
      agent_cli_version: "1",
      launch_profile_ref: "current-profile",
      harness: "pi",
      effort: "high",
    });
    expect(
      f.state().events.find((e) => e.id === resumed.trigger_event_id)?.type,
    ).toBe("work_item_resume_requested");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: resumed.id }, p),
      f.actorFor(f.owner()),
    );
    await f.dispatcher.tick([f.project]);
    expect(f.startRun).toHaveBeenCalledTimes(1);
    expect(f.state().runs.find((r) => r.id === old.id)).toEqual(historical);
    expect(f.onError).not.toHaveBeenCalled();

    // Synthetic Git/CI proof: exercise the restored owner's real domain gates,
    // independently of production prechecks and the eventual deployment check.
    const resumedOwner = f.owner();
    f.store.uow.run((tx) => {
      tx.cards.put(f.project, { ...f.target.card, flow_version: 3 });
      tx.assignments.put(f.project, {
        ...resumedOwner,
        branch: "agent/resumed",
        worktree_path: f.dataDir,
      });
    });
    const currentActor = f.actorFor(f.owner());
    const params = { work_item_id: f.target.item.id };
    const head = "a".repeat(40);
    const proof = value(
      await prepareCheck(f.state(), currentActor, params, {
        head: async () => head,
      }),
    );
    f.apply((s, a, p) => requestCheck(s, a, params, proof, p), currentActor);
    const check = prechecks(f.state().events).at(-1);
    if (!check) throw new Error("Missing requested precheck");
    const startedCheck = {
      ...check,
      status: "running" as const,
      candidate_sha: "b".repeat(40),
      tree_sha: "c".repeat(40),
      base_sha: "d".repeat(40),
    };
    f.apply((s, a, p) => recordPrecheck(s, a, startedCheck, p), {
      kind: "system",
      project_id: f.project,
    });
    const delivery = {
      ...params,
      kind: "code" as const,
      summary: "Resumed work",
      subject: { kind: "git_head" as const, value: head },
      requested_verifiers: f
        .state()
        .work_items.filter(
          (w) =>
            w.kind === "verify" &&
            w.target_work_item_id === params.work_item_id,
        )
        .map((w) => w.id),
    };
    const stateForDelivery = () => ({
      ...f.state(),
      project_settings: { merge_gate_enabled: true },
    });
    const verifier = { verify: async () => ({ ok: true as const, value: [] }) };
    expect(
      await prepareDelivery(
        stateForDelivery(),
        currentActor,
        delivery,
        verifier,
      ),
    ).toMatchObject({ ok: false, error: { message: "请先 request_check" } });
    f.apply(
      (s, a, p) =>
        recordPrecheck(
          s,
          a,
          {
            ...startedCheck,
            status: "passed",
            candidate_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
            base_sha: "d".repeat(40),
            checks: [{ name: "synthetic", status: "passed", exit_code: 0 }],
          },
          p,
        ),
      { kind: "system", project_id: f.project },
    );
    const receipt = value(
      await prepareDelivery(
        stateForDelivery(),
        currentActor,
        delivery,
        verifier,
      ),
    );
    const delivered = f.apply(
      (s, a, p) =>
        submitDelivery(
          { ...s, project_settings: { merge_gate_enabled: true } },
          a,
          delivery,
          receipt,
          p,
        ),
      currentActor,
    );
    expect(delivered.status).toBe("submitted");
    expect(delivered.run_id).toBe(resumed.id);
  },
);

test("upgrade fences keep bells pending; human stop clears the old reference and start can resume after settlement", async () => {
  const f = setup();
  f.comment();
  await f.dispatcher.tick([f.project]);
  expect(f.owner().role_upgrade).toBeDefined();
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      status: "pending",
    }),
  ).toHaveLength(1);
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
  expect(f.startRun).not.toHaveBeenCalled();
  // A retry before the backoff expires must not touch the old terminal again.
  f.advance(59_000);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  const ref = f.owner().runtime_ref!;
  const human = { kind: "human" as const, project_id: f.project };
  f.apply(
    (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        { assignment_id: f.target.assignment.id, reason: "Human stopped" },
        p,
      ),
    human,
  );
  f.apply(
    (s, a, p) =>
      stopWorkItemAssignment(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          reason: "Human stopped",
          released_runtime_ref: ref,
        },
        p,
      ),
    human,
  );
  f.advance(1_000);
  await f.dispatcher.tick([f.project]);
  expect(f.owner()).toMatchObject({
    role_version: 2,
    runtime_ref: null,
    runtime_state: "idle",
  });
  expect(f.owner().role_upgrade).toBeUndefined();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.startRun).not.toHaveBeenCalled(); // A human stop remains a stop.
  const queued = f.apply(
    (s, a, p) =>
      hostQueue(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          kind: "initial",
          model: "fixture",
          agent_cli_version: "1",
        },
        p,
      ),
    human,
  );
  // Human CLI start queues and dispatches directly; it does not wait for an automatic bell.
  const replacementRef = f.refFor(f.owner());
  const started = f.apply(
    (s, a, p) =>
      dispatchRun(s, a, { run_id: queued.id, runtime_ref: replacementRef }, p),
    human,
  );
  expect(started.role_version).toBe(2);
  await f.dispatcher.tick([f.project]);
  expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
    "dispatched",
  );
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
});

test("repeated exit confirmation failures back off and notify only PM once after fifteen minutes", async () => {
  const f = setup();
  f.comment();
  await f.dispatcher.tick([f.project]);
  for (let i = 0; i < 6; i++) await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  for (let i = 0; i < 6; i++) {
    f.advance(300_000);
    await f.dispatcher.tick([f.project]);
  }
  const alerts = f
    .state()
    .events.filter((e) => e.type === "assignment_role_upgrade_delayed");
  expect(alerts).toHaveLength(1);
  const notices = f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.event_id === alerts[0]!.id);
  expect(notices).toMatchObject([{ recipient: { kind: "pm_ops" } }]);
  expect(notices).toHaveLength(1);
  expect(f.state().human_actions).toEqual([]);
  expect(
    f.state().events.filter((e) => e.type === "dispatch_rejected"),
  ).toEqual([]);
});

test("a terminal still working outside its completed Run keeps its role and token", async () => {
  const f = setup();
  f.setBusy(true);
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: f.target.assignment.id,
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  await f.dispatcher.tick([f.project]);
  expect(f.owner().role_upgrade).toBeUndefined();
  expect(f.owner().role_version).toBe(1);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.store.verifyToken(token.token)).toBeTruthy();
});

test("maintenance failures are isolated and the scan is throttled for sixty seconds", async () => {
  const f = setup(false);
  const scan = vi
    .spyOn(host, "upgradeIdleAssignmentRoles")
    .mockRejectedValueOnce(new Error("synthetic role read failure"));
  f.comment();
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.onError).toHaveBeenCalledOnce();
  for (let i = 0; i < 4; i++) {
    f.advance(1_000);
    await f.dispatcher.tick([f.project]);
  }
  expect(scan).toHaveBeenCalledOnce();
  f.advance(56_000);
  await f.dispatcher.tick([f.project]);
  expect(scan).toHaveBeenCalledTimes(2);
});

import { queueRun as hostQueue } from "@cardigan/domain";
