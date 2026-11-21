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

test("restart after a read-only claim lets a queued Run wake the same live session once", async () => {
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
  await f.dispatcher.tick();
  await f.dispatcher.tick();
  expect(f.state().runs.find((r) => r.id === queued)?.status).toBe(
    "dispatched",
  );
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.startRun).not.toHaveBeenCalled();
  expect(retire).toHaveBeenCalledOnce();
  expect(f.owner().runtime_ref).toEqual(owner.runtime_ref);
  expect(f.store.verifyToken(token.token)).toBeTruthy();
});

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
