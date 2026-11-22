import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  abortDispatch,
  acknowledgeRun,
  type CardId,
  dispatchRun,
  finishRun,
  queueRun,
  type Run,
  recordDecision,
  requestDecision,
  reviewRunWakeDisposition,
} from "@cardigan/domain";
import { armBellReceipt, confirmBellWrite, launchRun } from "@cardigan/host";
import { unwrap } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { moveNotification, recordNotification } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { stalledTranscript } from "../test-support/dispatch.js";
import { setup } from "../test-support/dispatch-stalls.js";
import { loopbackFixture } from "../test-support/loopback-retirement.js";
import { Dispatcher } from "./dispatch.js";
import { patrolHostOps } from "./host-ops-patrol.js";

test.each(["pending", "belled"] as const)(
  "C-520#50: an unconsumed %s bell on a 13-hour running Run alerts Ops once, without replacing it",
  async (status) => {
    const f = setup();
    const { assignment: a, card, item } = f.target;
    const run = f.session(a, false);
    f.skipEvents();
    const instruction = f.event(
      "instruction_issued",
      { work_item_id: item.id },
      a,
      card.id,
    );
    const note = f.notes().find((n) => n.event_id === instruction.id);
    if (!note) throw new Error("missing notification");
    if (status === "belled")
      f.store.uow.run(() =>
        moveNotification(
          f.store.database,
          {
            project_id: f.project,
            id: note.id,
            event: "bell",
            patch: { run_id: run.id },
          },
          f.clock.now,
        ),
      );
    f.skipEvents();
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "unknown", observed_seq: 1 },
    });
    const frozen = f.state();
    const dispatcher = new Dispatcher({
      ...f.options,
      harnessActivity: (_p, id) => stalledTranscript(frozen, id),
      inactiveCancelAfterMs: null,
    });
    try {
      f.advance(13 * 60 * 60_000);
      await dispatcher.tick();
      await dispatcher.tick();
      const alerts = f
        .state()
        .events.filter(
          (e) =>
            e.type ===
            (status === "pending" ? "run_inbox_stalled" : "run_inactive"),
        );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        card_id: card.id,
        payload: {
          run_id: run.id,
          assignment_id: a.id,
          ...(status === "pending"
            ? { notification_ids: expect.arrayContaining([note.id]) }
            : { reason: "mcp_inactivity" }),
        },
      });
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter(
            (n) =>
              n.event_id === alerts[0]?.id && n.recipient.kind === "pm_ops",
          ),
      ).toMatchObject([{ recipient: { kind: "pm_ops" } }]);
      expect(
        (await f.view()).dispatch_stalls.filter(
          (s) => s.assignment_id === a.id,
        ),
      ).toMatchObject([
        {
          kind: "running_wait",
          restart_blocked: "client_execution_unconfirmed",
          can_restart: false,
        },
      ]);
      await expect(f.restart(a, instruction.id)).rejects.toThrow();
      expect(f.notes().find((n) => n.id === note.id)).toMatchObject({
        status,
        ...(status === "belled" ? { run_id: run.id } : {}),
      });
      expect(f.latest()).toMatchObject({ id: run.id, status: "running" });
      expect(f.runtime.release).not.toHaveBeenCalled();
    } finally {
      await dispatcher.close();
    }
  },
);

test("an instruction ACKed by the original Run is consumed only on its own card stream", async () => {
  const f = setup();
  const { assignment: a, card, item } = f.target;
  const run = f.session(a, false);
  f.advance(300_000);
  const issued = () =>
    f.event("instruction_issued", { work_item_id: item.id }, a, card.id);
  const read = issued();
  unwrap(
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: a.id,
      card_id: card.id,
      up_to_seq: read.seq,
    }),
  );
  const unread = issued();
  // Neither a higher project cursor nor another assignee's card cursor consumes this instruction.
  f.store.uow.run((tx) => {
    tx.cursors.put(f.project, {
      assignment_id: a.id,
      card_id: "" as CardId,
      acked_seq: unread.seq,
    });
    tx.cursors.put(f.project, {
      assignment_id: f.ops.id,
      card_id: card.id,
      acked_seq: unread.seq,
    });
  });
  f.apply(
    (s, actor, p) =>
      finishRun(
        s,
        actor,
        { run_id: run.id, outcome: "completed", summary: "fixture" },
        p,
      ),
    f.actorFor(a),
  );
  f.advance(900_000);
  expect(
    (await f.view()).dispatch_stalls.filter(
      (s) => s.kind === "owner_not_woken",
    ),
  ).toMatchObject([{ cause_id: unread.id, can_restart: true }]);
  await expect(f.restart(a, read.id)).rejects.toThrow();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

function reviewerFixture() {
  const f = setup();
  const { card } = f.target;
  const run_id = f.latest().id;
  const { a, item } = f.store.uow.run((tx) => {
    const item = tx.work_items
      .list(f.project)
      .find(
        (w) =>
          w.card_id === card.id &&
          w.kind === "verify" &&
          w.role_id === "reviewer",
      );
    if (item?.kind !== "verify") throw new Error("missing verifier");
    const id = tx.ids.next(f.project, "assignment");
    const owner: Assignment = {
      ...f.target.assignment,
      id,
      scope: "work_item",
      role_id: item.role_id,
      work_item_id: item.id,
    };
    const a = {
      ...owner,
      runtime_state: "idle" as const,
      runtime_ref: f.refFor(owner),
    };
    tx.assignments.put(f.project, a);
    tx.work_items.put(f.project, {
      ...item,
      status: "in_progress",
      assignment_id: id,
    });
    tx.deliveries.put(f.project, {
      id: tx.ids.next(f.project, "delivery"),
      work_item_id: f.target.item.id,
      run_id,
      kind: "code",
      summary: "fixture",
      subject: { kind: "git_head", value: "b".repeat(40) },
      status: "submitted",
      requested_verifiers: [item.id],
      known_gaps: [],
      evidence: [],
      attachments: [],
    });
    return { a, item };
  });
  const tree = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  const parent = join(f.dataDir, "agent", "builds", f.project);
  const build = join(parent, a.id);
  mkdirSync(tree, { recursive: true });
  mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init", "-q", tree]);
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, {
      role_id: a.role_id,
      role_version: a.role_version,
    });
    const owner = tx.assignments.get(f.project, a.id);
    if (!role || !owner) throw new Error("Missing owner");
    tx.roles.put(f.project, { ...role, worktree: "readonly" });
    tx.assignments.put(f.project, {
      ...owner,
      worktree_path: tree,
      base_sha: "b".repeat(40),
    });
  });
  return { f, a, card, item, tree, parent, build };
}

test("a cleaned verifier build allows recovery; an existing unreadable checkout, link or dirty work blocks it", async () => {
  const { f, a, card, item, tree, parent, build } = reviewerFixture();
  f.advance(1);
  const e = f.event(
    "instruction_issued",
    { work_item_id: item.id },
    undefined,
    card.id,
  );
  f.advance(610_000);
  const row = async () => (await f.view()).dispatch_stalls[0];
  symlinkSync(join(parent, "absent"), build);
  expect(await row()).toMatchObject({
    workspace: "unknown",
    can_restart: false,
  });
  rmSync(build);
  mkdirSync(build);
  expect(await row()).toMatchObject({
    workspace: "unknown",
    can_restart: false,
  });
  execFileSync("git", ["init", "-q", build]);
  writeFileSync(join(build, "change"), "keep");
  expect(await row()).toMatchObject({ workspace: "dirty", can_restart: false });
  rmSync(build, { recursive: true });
  writeFileSync(join(tree, "change"), "keep");
  expect(await row()).toMatchObject({ workspace: "dirty", can_restart: false });
  rmSync(join(tree, "change"));
  expect(await row()).toMatchObject({ workspace: "clean", can_restart: true });
  await f.restart(a, e.id);
  await f.service.tick();
  await vi.waitFor(() => expect(f.runtime.release).toHaveBeenCalledOnce());
});

function endedReviewer(discussWhileWaiting = false) {
  const fixture = reviewerFixture();
  return endReviewerTurn(
    fixture,
    fixture.f.session(fixture.a, false),
    discussWhileWaiting,
  );
}
function endReviewerTurn(
  { f, a, card, item, tree }: ReturnType<typeof reviewerFixture>,
  run: Run,
  discussWhileWaiting = false,
) {
  const q = f.apply((state, actor, ports) =>
    requestDecision(
      state,
      actor,
      {
        kind: "choose",
        category: "general",
        decider: "human",
        plain_summary: {
          changed: "等待继续审核",
          impact: "恢复审核",
          risk: "无",
        },
        question: "恢复审核？",
        context: "fixture",
        blocking: true,
        card_id: card.id,
        affected_cards: [card.id],
        affected_work_items: [item.id],
        options: [{ key: "go", description: "继续", impact: "恢复审核" }],
        recommended: "go",
      },
      ports,
    ),
  );
  f.advance(1);
  if (discussWhileWaiting) {
    const notice = f.event(
      "instruction_issued",
      { work_item_id: item.id },
      a,
      card.id,
    );
    f.skipEvents();
    return { f, a, card, item, notice, tree, run };
  }
  f.apply((state, actor, ports) =>
    recordDecision(
      state,
      actor,
      {
        decision_id: q.id,
        option: "go",
        rationale: "fixture",
        raw_quote: "go",
      },
      ports,
    ),
  );
  // This incident has no in-flight Run; retire any prequeued follow-up.
  const queued = f
    .state()
    .runs.find((r) => r.assignment_id === a.id && r.status === "queued");
  if (queued)
    f.apply((s, actor, p) =>
      abortDispatch(s, actor, { run_id: queued.id, reason: "fixture" }, p),
    );
  const notice = f
    .state()
    .events.find(
      (e) =>
        e.type === "decision_resolved" &&
        (e.payload as { decision_id: string }).decision_id === q.id,
    );
  if (!notice) throw new Error("missing resolved decision");
  f.store.uow.run(() =>
    recordNotification(f.store.database, {
      project_id: f.project,
      event_id: notice.id,
      seq: notice.seq,
      card_id: card.id,
      at: f.clock.now(),
      kind: "assignment",
      recipient: { kind: "assignment", assignment_id: a.id },
    }),
  );
  f.skipEvents();
  return { f, a, card, item, notice, tree, run };
}

test("H-192: a clean reviewer on a bound loopback SSH terminal recovers once from worker-side evidence", async () => {
  const fixture = reviewerFixture();
  const { f, a, card, tree } = fixture;
  f.store.uow.run((tx) =>
    tx.cards.put(f.project, { ...card, flow_version: 5 }),
  );
  const queue = () =>
    f.apply((s, actor, p) =>
      queueRun(
        s,
        actor,
        {
          assignment_id: a.id,
          model: "fixture-model",
          agent_cli_version: "fixture",
        },
        p,
      ),
    );
  const start = (run: Run) =>
    f.apply(
      (s, actor, p) => acknowledgeRun(s, actor, { run_id: run.id }, p),
      f.actorFor(a),
    );
  const worker = await loopbackFixture(f.dataDir, f.project, a.id);
  const { agentRoot } = worker.execution;
  for (const path of [
    agentRoot,
    ...["worktrees", "builds"].flatMap((area) => [
      join(agentRoot, area),
      join(agentRoot, area, f.project),
    ]),
  ])
    chmodSync(path, 0o2750);
  const launch = await launchRun(
    {
      store: f.store,
      runtime: worker.runtime,
      execution: worker.execution,
      clock: f.clock,
      dataDir: f.dataDir,
      mcpUrl: "http://localhost/mcp",
      launch: {
        config: parseLaunchConfig({
          profiles: { fixture: { harness: "pi", model: "fixture-model" } },
        }),
        secrets: {},
      },
    },
    {
      project: f.project,
      assignment_id: a.id,
      run: queue(),
      actor: { kind: "system", project_id: f.project },
      worktree: { path: tree, base_sha: "b".repeat(40) },
    },
  );
  expect(launch.runtime_ref.launch_generation).toBeUndefined();
  expect(launch.run.recovery_policy).toBeUndefined();
  expect(launch.run.recovery_runtime).toBeUndefined();
  expect(worker.labels).toEqual({
    cardigan: "1",
    project: f.project,
    assignment: a.id,
    run: launch.run.id,
  });
  expect(launch.run.bell_delivery?.runtime_ref).toEqual(launch.runtime_ref);
  start(launch.run);
  f.apply(
    (s, actor, p) =>
      finishRun(
        s,
        actor,
        { run_id: launch.run.id, outcome: "completed", summary: "fixture" },
        p,
      ),
    f.actorFor(a),
  );
  // The decision ends a later Run that reused this terminal, not its creating Run.
  f.advance(1000);
  const reused = queue();
  f.apply((s, actor, p) => dispatchRun(s, actor, { run_id: reused.id }, p));
  expect(
    armBellReceipt(f.store, f.project, reused.id, launch.runtime_ref, card.id),
  ).toBe(true);
  confirmBellWrite(f.store, f.project, reused.id, f.clock.now());
  start(reused);
  const { notice } = endReviewerTurn(fixture, reused);
  f.runtime.observe_retirement = worker.runtime.observe_retirement.bind(
    worker.runtime,
  );
  f.runtime.retire_idle = worker.runtime.retire_idle.bind(worker.runtime);
  vi.mocked(f.runtime.status).mockImplementation(
    worker.runtime.status.bind(worker.runtime),
  );
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    f.advance(600000);
    await dispatcher.tick();
    const row = async () =>
      (await f.view()).dispatch_stalls.find((s) => s.assignment_id === a.id);
    for (const evidence of [
      "conflict",
      "wrong-run",
      "unexpected-generation",
      "busy",
      "incomplete",
    ]) {
      worker.sample(evidence);
      expect(await row()).toMatchObject({
        workspace: "clean",
        can_restart: false,
      });
      await f.service.tick();
      f.advance(30_000);
    }
    expect(worker.signals).toEqual([]);
    worker.sample("matched");
    writeFileSync(join(tree, "pending-review"), "keep");
    expect(await row()).toMatchObject({
      terminal_owner: "confirmed",
      workspace: "dirty",
      can_restart: false,
    });
    await f.service.tick();
    expect(worker.signals).toEqual([]);
    rmSync(join(tree, "pending-review"));
    f.advance(30_000);
    expect(await row()).toMatchObject({
      workspace: "clean",
      process_state: "alive",
      terminal_owner: "confirmed",
      can_restart: true,
    });
    await vi.waitFor(
      async () => {
        await f.service.tick();
        expect(
          f.state().events.filter((e) => e.type === "host_ops_action_finished"),
        ).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    await f.service.tick();
    await dispatcher.tick();
    await f.service.tick();
    await dispatcher.tick();
    expect(worker.signals).toEqual(["TERM"]);
    expect(f.runtime.release).not.toHaveBeenCalled();
    const notes = f.store
      .listNotifications({ project_id: f.project, assignment_id: a.id })
      .filter((n) => n.event_id === notice.id);
    expect(notes).toMatchObject([{ status: "belled" }]);
    expect(
      f
        .state()
        .runs.filter(
          (r) =>
            r.assignment_id === a.id &&
            r.id !== launch.run.id &&
            r.id !== reused.id &&
            r.status !== "cancelled",
        ),
    ).toMatchObject([{ id: notes[0]?.run_id }]);
  } finally {
    await dispatcher.close();
  }
}, 20000);

test.each(["before request", "before signal", "after signal"])(
  "ordinary restart respects a reviewer pause %s",
  async (when) => {
    const { f, a, item } = endedReviewer(when === "before request");
    const request = () =>
      f.service.tools.execute(f.context, "host_ops_restart_assignment", {
        target_id: a.id,
        reason: "fixture",
        idempotency_key: "plain-restart",
      });
    const pause = () =>
      f.store.uow.run((tx) => {
        const w = tx.work_items.get(f.project, item.id);
        if (!w) throw new Error("missing verifier");
        tx.work_items.put(f.project, { ...w, status: "waiting_decision" });
      });
    if (when === "before request") {
      await expect(request()).rejects.toThrow(/等待拍板/);
      expect(
        f.state().events.some((e) => e.type === "host_ops_action_taken"),
      ).toBe(false);
    } else {
      await request();
      if (when === "before signal") pause();
      else {
        const release = vi.mocked(f.runtime.release).getMockImplementation();
        if (!release) throw new Error("missing release");
        vi.mocked(f.runtime.release).mockImplementationOnce(async (...args) => {
          pause();
          return release(...args);
        });
      }
      await f.service.tick();
      expect(
        f.state().events.filter((e) => e.type === "host_ops_action_finished"),
      ).toMatchObject([
        {
          payload: {
            result:
              when === "before signal"
                ? "withdrawn_review_wait"
                : "stopped_without_restart",
          },
        },
      ]);
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === a.id && r.status === "queued",
          ),
      ).toHaveLength(0);
      expect(f.state().work_items.find((w) => w.id === item.id)?.status).toBe(
        "waiting_decision",
      );
    }
    expect(f.runtime.release).toHaveBeenCalledTimes(
      when === "after signal" ? 1 : 0,
    );
  },
);

test("a paused reviewer's directed instruction recovers on independently proven local exit, not on an offline core alone", async () => {
  const { f, a, item, run, notice } = endedReviewer(true);
  const ref = f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, a.id),
      w = tx.work_items.get(f.project, item.id);
    if (!owner?.runtime_ref || !w) throw new Error("missing reviewer");
    const ref = {
      ...owner.runtime_ref,
      local_process_receipt: "fixture-receipt",
    };
    tx.assignments.put(f.project, { ...owner, runtime_ref: ref });
    tx.runs.put(f.project, {
      ...tx.runs.get(f.project, run.id)!,
      recovery_runtime: ref,
    });
    expect(w.status).toBe("waiting_decision");
    return ref;
  });
  const missing = {
    ok: false,
    error: { code: "runtime_unavailable", message: "offline" },
  } as const;
  vi.mocked(f.runtime.status).mockResolvedValue(missing);
  f.runtime.observe_retirement = vi.fn(async () => missing);
  const proof = vi.fn(async () => ({ ok: true as const, value: false }));
  f.runtime.confirm_local_exit = proof;
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    f.advance(600000);
    await dispatcher.tick();
    const row = async () =>
      (await f.view()).dispatch_stalls.find((s) => s.assignment_id === a.id);
    expect(await row()).toMatchObject({
      can_restart: false,
      terminal_owner: "unconfirmed",
    });
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(
        f.state().events.filter((e) => e.type === "bell_turn_recovery_failed"),
      ).toHaveLength(1);
    });
    await f.service.tick();
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "host_ops_action_taken" &&
            (e.payload as { assignment_id?: string }).assignment_id === a.id,
        ),
    ).toHaveLength(0);
    // C-573: an outstanding failure that nobody picked up is not a recovery.
    f.advance(15 * 60_000);
    await vi.waitFor(async () => {
      await f.service.tick();
      const escalation = f
        .state()
        .events.filter(
          (e) =>
            e.type === "dispatch_stall_handoff_overdue" &&
            (e.payload as { assignment_id: string }).assignment_id === a.id,
        );
      expect(escalation).toHaveLength(1);
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === escalation[0]?.id),
      ).toMatchObject([{ recipient: { kind: "pm_office" } }]);
    });
    expect(f.runtime.release).not.toHaveBeenCalled();
    f.advance(30_000); // Next scheduled patrol, same outstanding notice.
    proof.mockResolvedValue({ ok: true, value: true });
    expect(await row()).toMatchObject({
      can_restart: true,
      terminal_owner: "confirmed",
      process_state: "exited",
    });
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(
        f
          .state()
          .events.some(
            (e) =>
              e.type === "host_ops_action_finished" &&
              (e.payload as { assignment_id?: string }).assignment_id === a.id,
          ),
      ).toBe(true);
    });
    expect(
      f.state().events.filter((e) => e.type === "bell_turn_recovery_failed"),
    ).toHaveLength(1);
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "host_ops_action_taken" &&
            (e.payload as { assignment_id?: string }).assignment_id === a.id,
        ),
    ).toHaveLength(1);
    expect(proof).toHaveBeenCalledWith(ref, {
      project_id: f.project,
      assignment_id: a.id,
    });
    expect(f.runtime.release).not.toHaveBeenCalled();
    await dispatcher.tick();
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: a.id })
        .find((n) => n.event_id === notice.id)?.status,
    ).toBe("belled");
    expect(f.state().work_items.find((w) => w.id === item.id)?.status).toBe(
      "waiting_decision",
    );
  } finally {
    await dispatcher.close();
  }
});

test.each(["dirty", "unknown"])(
  "an exact missing terminal cannot start a notice-only Run on a %s workspace",
  async (workspace) => {
    const { f, a, card, item, tree } = endedReviewer();
    // The old decision's cancelled queue is unrelated to this fresh instruction.
    f.store.uow.run(() => {
      for (const n of f.store.listNotifications({
        project_id: f.project,
        assignment_id: a.id,
        status: "pending",
      }))
        moveNotification(
          f.store.database,
          { project_id: f.project, id: n.id, event: "ack" },
          f.clock.now,
        );
    });
    const notice = f.event(
      "instruction_issued",
      { work_item_id: item.id },
      a,
      card.id,
    );
    const original = () =>
      f.store
        .listNotifications({ project_id: f.project, assignment_id: a.id })
        .find((n) => n.event_id === notice.id);
    const missing = {
      ok: false,
      error: { code: "runtime_not_found", message: "missing" },
    } as const;
    vi.mocked(f.runtime.status).mockResolvedValue(missing);
    f.runtime.observe_retirement = vi.fn(async () => missing);
    if (workspace === "dirty") writeFileSync(join(tree, "keep"), "original");
    else rmSync(join(tree, ".git"), { recursive: true });
    const d = new Dispatcher(f.options);
    try {
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === a.id && r.status === "queued",
          ),
      ).toHaveLength(0);
      await d.tick();
      expect(f.options.startRun).not.toHaveBeenCalled();
      expect(original()?.status).toBe("pending");
      f.advance(600000);
      await d.tick();
      await vi.waitFor(async () => {
        await f.service.tick();
        expect(
          f
            .state()
            .events.filter((e) => e.type === "bell_turn_recovery_failed"),
        ).toMatchObject([{ payload: { workspace } }]);
      });
      const failure = f
        .state()
        .events.find((e) => e.type === "bell_turn_recovery_failed");
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === failure?.id)
          .map((n) => n.recipient),
      ).toEqual([{ kind: "pm_ops" }]);
      expect(original()).toMatchObject({ status: "pending", attempts: 0 });
      expect(f.options.startRun).not.toHaveBeenCalled();
      expect(f.runtime.release).not.toHaveBeenCalled();
      expect(f.state().human_actions).toHaveLength(0);
    } finally {
      await d.close();
    }
  },
);

test("an existing queued successor is preserved when both the snapshot and exact terminal row are missing", async () => {
  const { f, a, notice } = endedReviewer();
  const successor = f.apply((state, actor, ports) =>
    queueRun(
      state,
      actor,
      {
        assignment_id: a.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      ports,
    ),
  );
  const missing = {
    ok: false,
    error: { code: "runtime_not_found", message: "missing" },
  } as const;
  vi.mocked(f.runtime.status).mockResolvedValue(missing);
  f.runtime.observe_retirement = vi.fn(async () => missing);
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    // Repo-backed replacements require the patrol's workspace preflight.
    expect(f.options.startRun).not.toHaveBeenCalled();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.state().runs.find((r) => r.id === successor.id)?.status).toBe(
      "queued",
    );
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: a.id })
        .find((n) => n.event_id === notice.id)?.status,
    ).toBe("pending");
  } finally {
    await dispatcher.close();
  }
});

test.each([
  "automatic",
  "tool",
  "dirty",
  "owner_mismatch",
  "lost_observation",
  "in_flight",
  "queued_successor",
  "stop_refused",
  "dirty_in_slot",
  "dirty_at_exit",
  "exit_unconfirmed",
] as const)("C-554: overdue reviewer bell (%s)", async (mode) => {
  const { f, a, notice, tree, run } = endedReviewer();
  let exited = false;
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "unknown", observed_seq: 1 },
  });
  f.runtime.observe_retirement = vi.fn(async (ref, owner) => {
    if (
      mode === "owner_mismatch" ||
      owner.project_id !== f.project ||
      owner.assignment_id !== a.id ||
      ref.terminal_ref !== a.runtime_ref?.terminal_ref
    )
      return {
        ok: false as const,
        error: {
          code: "runtime_conflict" as const,
          message: "identity changed",
        },
      };
    return {
      ok: true as const,
      value: exited ? ("exited" as const) : ("alive" as const),
    };
  });
  const signaled = vi.fn();
  f.runtime.retire_idle = vi.fn(async (_ref, opts) => {
    if (mode === "stop_refused")
      return {
        ok: true,
        value: {
          outcome: "withdrawn",
          evidence: { stage: "confirm", reason: "terminal_busy" },
        },
      };
    if (!opts.system_finished_turn) throw new Error("missing system turn");
    if (mode === "dirty_at_exit") {
      writeFileSync(join(tree, "keep"), "original");
      exited = true; // The old terminal exited by itself, without a stop.
      return { ok: true, value: { outcome: "exited" } };
    }
    if (mode === "dirty_in_slot") {
      writeFileSync(join(tree, "keep"), "original");
      expect(opts.before_signal()).toBe(false); // No cached authorization.
      expect(await opts.workspace_preflight()).toBe(false);
      expect(opts.before_signal()).toBe(false);
      return {
        ok: true,
        value: {
          outcome: "withdrawn",
          evidence: { stage: "TERM", reason: "guard_changed" },
        },
      };
    }
    expect(await opts.workspace_preflight()).toBe(true);
    expect(opts.before_signal()).toBe(true);
    signaled();
    exited = mode !== "exit_unconfirmed";
    return exited
      ? { ok: true, value: { outcome: "exited" } }
      : {
          ok: true,
          value: {
            outcome: "timeout",
            evidence: { stage: "TERM", reason: "still_live" },
          },
        };
  });
  const dispatcher = new Dispatcher(f.options);
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  try {
    await dispatcher.tick();
    if (mode === "lost_observation") {
      vi.mocked(f.runtime.status).mockResolvedValue({
        ok: false,
        error: { code: "runtime_unavailable", message: "Lost" },
      });
      delete f.runtime.observe_retirement;
    }
    f.advance(599999);
    await dispatcher.tick();
    expect(events("bell_turn_recovery_due")).toHaveLength(0);
    f.advance(1);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(events("bell_turn_recovery_due")).toMatchObject([
      {
        payload: {
          run_id: run.id,
          activity_source:
            mode === "lost_observation"
              ? "runtime_unavailable"
              : "alive/unknown",
        },
      },
    ]);
    const cause = events("bell_turn_recovery_due")[0]?.id as string;
    if (mode === "dirty") writeFileSync(join(tree, "keep"), "original");
    const next =
      mode === "in_flight" || mode === "queued_successor"
        ? f.apply((state, actor, p) =>
            queueRun(
              state,
              actor,
              {
                assignment_id: a.id,
                model: "fixture",
                agent_cli_version: "fixture",
              },
              p,
            ),
          )
        : undefined;
    if (next && mode === "in_flight")
      f.store.uow.run((tx) =>
        tx.runs.put(f.project, { ...next, recovery_runtime: f.refFor(a) }),
      );
    const safe = [
      "automatic",
      "queued_successor",
      "tool",
      "exit_unconfirmed",
      "stop_refused",
      "dirty_in_slot",
      "dirty_at_exit",
    ].includes(mode);
    const row = (await f.view()).dispatch_stalls.find(
      (s) => s.cause_id === cause,
    );
    expect(row).toMatchObject({ can_restart: safe });
    if (mode === "tool") await f.restart(a, cause);
    await f.service.tick();
    if (["stop_refused", "dirty_in_slot", "dirty_at_exit"].includes(mode)) {
      await vi.waitFor(async () => {
        await f.service.tick();
        expect(events("host_ops_action_finished")).toMatchObject([
          {
            payload: {
              result: "withdrawn_stall_changed",
              reason:
                mode === "stop_refused" ? "terminal_busy" : "workspace=dirty",
            },
          },
        ]);
      });
      const id = events("host_ops_action_finished")[0]?.id;
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === id)
          .map((n) => n.recipient),
      ).toEqual([{ kind: "pm_ops" }]);
      expect(signaled).not.toHaveBeenCalled();
      expect(f.options.startRun).not.toHaveBeenCalled();
      expect(
        f.store
          .listNotifications({ project_id: f.project, assignment_id: a.id })
          .find((n) => n.event_id === notice.id)?.status,
      ).toBe("pending");
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === a.id && r.status === "queued",
          ),
      ).toHaveLength(0);
      expect(events("host_ops_action_deferred")).not.toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            reason: "automatic_context_stop_started",
          }),
        }),
      );
    } else if (safe) {
      await vi.waitFor(async () => {
        await f.service.tick();
        expect(signaled).toHaveBeenCalledTimes(1);
      });
      if (mode === "exit_unconfirmed") {
        await vi.waitFor(() =>
          expect(events("host_ops_action_deferred")).toContainEqual(
            expect.objectContaining({
              payload: expect.objectContaining({
                notify_pm: true,
                reason: "terminal_exit_unconfirmed",
              }),
            }),
          ),
        );
        expect(events("host_ops_action_finished")).toHaveLength(0);
      } else {
        await vi.waitFor(() =>
          expect(events("host_ops_action_finished")).toHaveLength(1),
        );
        expect(events("host_ops_action_taken")).toMatchObject([
          {
            actor: { kind: mode === "tool" ? "assignment" : "system" },
            payload: { assignment_id: a.id, system_finished_run_id: run.id },
          },
        ]);
        await dispatcher.tick();
        const original = f.store
          .listNotifications({ project_id: f.project, assignment_id: a.id })
          .find((n) => n.event_id === notice.id);
        expect(original).toMatchObject({ status: "belled", seq: notice.seq });
        expect(original?.run_id).not.toBe(run.id);
        if (next) expect(original?.run_id).toBe(next.id);
      }
    } else {
      await vi.waitFor(() =>
        expect(events("bell_turn_recovery_failed")).toHaveLength(1),
      );
      const failure = events("bell_turn_recovery_failed")[0];
      expect(failure?.payload).toMatchObject(
        mode === "dirty"
          ? { workspace: "dirty" }
          : mode === "in_flight"
            ? { restart_blocked: "unfinished_run" }
            : { terminal_owner: "unconfirmed" },
      );
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === failure?.id)
          .map((n) => n.recipient),
      ).toEqual([{ kind: "pm_ops" }]);
      expect(f.runtime.release).not.toHaveBeenCalled();
    }
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.state().human_actions).toHaveLength(0);
  } finally {
    await dispatcher.close();
  }
});

test.each(["timeout", "refused"] as const)(
  "standing PM Ops keeps the original notice and reports %s to Office",
  async (outcome) => {
    vi.stubEnv("CARDIGAN_DISPATCH_STALL_MS", "600000");
    const f = setup();
    const pm = { ...f.pm(), standing_mode: "ops" as const };
    f.store.uow.run((tx) => {
      tx.assignments.put(f.project, pm);
      const role = tx.roles.get(f.project, {
        role_id: pm.role_id,
        role_version: pm.role_version,
      });
      if (!role) throw new Error("Missing PM");
      tx.roles.put(f.project, {
        ...role,
        allowed_tools: [...role.allowed_tools, "request_decision"],
      });
    });
    const run = f.session(pm, false);
    f.apply(
      (s, actor, ports) =>
        requestDecision(
          s,
          actor,
          {
            kind: "choose",
            decider: "human",
            category: "general",
            blocking: true,
            question: "Continue?",
            context: "fixture",
            options: [{ key: "go", description: "Continue", impact: "Resume" }],
            recommended: "go",
            affected_cards: [],
            affected_work_items: [],
            plain_summary: { changed: "等待确认", impact: "暂停", risk: "无" },
          },
          ports,
        ),
      f.actorFor(pm),
    );
    expect(f.state().runs.find((r) => r.id === run.id)?.outcome).toBe(
      "blocked",
    );
    f.skipEvents();
    const notice = f.event("fixture", {}, pm);
    const original = () =>
      f.store
        .listNotifications({ project_id: f.project, assignment_id: pm.id })
        .find((n) => n.event_id === notice.id);
    f.runtime.observe_retirement = async () => ({ ok: true, value: "alive" });
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: { process: "alive", agent: "unknown", observed_seq: 1 },
    });
    const signal = vi.fn();
    f.runtime.retire_idle = vi.fn(async (_ref, opts) => {
      if (outcome === "refused")
        return {
          ok: true,
          value: {
            outcome: "withdrawn",
            evidence: { stage: "confirm", reason: "terminal_busy" },
          },
        };
      if (!opts.system_finished_turn) throw new Error("missing system turn");
      expect(await opts.workspace_preflight()).toBe(true);
      expect(opts.before_signal()).toBe(true);
      signal();
      return {
        ok: true,
        value: {
          outcome: "timeout",
          evidence: { stage: "TERM", reason: "still_live" },
        },
      };
    });
    const d = new Dispatcher(f.options);
    try {
      // Notification age is already past the standing deadline at the very first deferral.
      f.advance(610000);
      await d.tick();
      expect(original()?.status).toBe("pending");
      f.advance(600000);
      await d.tick();
      expect(original()?.status).toBe("pending");
      expect(
        f.state().events.filter((e) => e.type === "standing_inbox_stalled"),
      ).toEqual([]);
      expect(
        f.state().events.filter((e) => e.type === "bell_turn_recovery_due"),
      ).toHaveLength(1);
      const failure = () =>
        f
          .state()
          .events.find((e) =>
            outcome === "timeout"
              ? e.type === "host_ops_action_deferred" &&
                (e.payload as { notify_pm?: boolean }).notify_pm
              : e.type === "host_ops_action_finished" &&
                (e.payload as { reason?: string }).reason === "terminal_busy",
          );
      await vi.waitFor(async () => {
        await f.service.tick();
        expect(failure()).toBeDefined();
      });
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === failure()?.id)
          .map((n) => n.recipient),
      ).toEqual([{ kind: "pm_office" }]);
      f.advance(900000);
      await f.service.tick();
      expect(signal).toHaveBeenCalledTimes(outcome === "timeout" ? 1 : 0);
      expect(f.runtime.release).not.toHaveBeenCalled();
      expect(f.state().human_actions).toHaveLength(0);
    } finally {
      await d.close();
    }
  },
);

test("synthetic review handoff: reading the bell is not a restart; safe fresh evidence recovers its original assignment once", async () => {
  const { f, a, card, notice } = endedReviewer();
  const ref = f.refFor(a);
  f.working.add(ref.terminal_ref);
  const execute = vi.spyOn(f.service.tools, "execute");
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    f.advance(600000);
    await dispatcher.tick();
    const handoff = f
      .state()
      .events.find(
        (e) =>
          e.type === "bell_turn_recovery_due" &&
          (e.payload as { assignment_id?: string }).assignment_id === a.id,
      );
    expect(handoff).toMatchObject({
      payload: {
        reason: "system_finished_turn",
        activity_source: "alive/working",
      },
    });
    if (!handoff || handoff.card_id !== card.id)
      throw new Error("missing review handoff on the original card");
    const [note] = f.store
      .listNotifications({ project_id: f.project, assignment_id: a.id })
      .filter((n) => n.event_id === notice.id);
    if (!note) throw new Error("missing original notification");
    expect(note.status).toBe("pending");
    unwrap(
      f.store.ackEvents({
        project_id: f.project,
        assignment_id: f.ops.id,
        card_id: handoff.card_id,
        up_to_seq: handoff.seq,
      }),
    );
    const row = async () =>
      (await f.view()).dispatch_stalls.find(
        (s) => s.assignment_id === a.id && s.handoff_event_id === handoff.id,
      );
    expect(await row()).toMatchObject({
      cause_id: handoff.id,
      workspace: "clean",
      can_restart: false,
    });
    expect(
      f.state().events.some((e) => e.type === "host_ops_action_taken"),
    ).toBe(false);
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    // No prior attempt. Do not bypass the guard: only a new terminal observation enables this call.
    f.working.delete(ref.terminal_ref);
    let retired = false;
    f.runtime.retire_idle = vi.fn(async (_ref, opts) => {
      if (!opts.system_finished_turn) throw new Error("missing system turn");
      expect(await opts.workspace_preflight()).toBe(true);
      expect(opts.before_signal()).toBe(true);
      retired = true;
      return { ok: true, value: { outcome: "exited" } };
    });
    f.runtime.observe_retirement = async () => ({
      ok: true,
      value: retired ? "exited" : "alive",
    });
    const ready = await row();
    if (!ready?.can_restart)
      throw new Error("expected actionable review handoff");
    await f.restart(a, ready.cause_id);
    await f.restart(a, ready.cause_id);
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === a.id && r.status === "queued",
          ),
      ).toHaveLength(1),
    );
    expect(
      f.state().events.filter((e) => e.type === "host_ops_action_taken"),
    ).toMatchObject([
      { payload: { dispatch_stall_id: handoff.id, target_id: a.id } },
    ]);
    expect(f.runtime.retire_idle).toHaveBeenCalledOnce();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(
      f.state().assignments.find((owner) => owner.id === a.id)?.runtime_ref,
    ).toBeNull();
    expect((await row())?.can_restart).not.toBe(true);
    const queued = f
      .state()
      .runs.find((r) => r.assignment_id === a.id && r.status === "queued");
    expect(
      f.state().events.find((e) => e.type === "host_ops_action_finished"),
    ).toMatchObject({ payload: { assignment_id: a.id, run_id: queued?.id } });
    await dispatcher.tick();
    expect(f.options.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        assignment: expect.objectContaining({ id: a.id }),
        run: expect.objectContaining({ id: queued?.id }),
      }),
    );
  } finally {
    await dispatcher.close();
  }
});

test.each(["held", "consumed"])(
  "patrol skips the first %s cause and handles the other card once",
  async (reason) => {
    const f = setup();
    const cards = [f.target.card, f.create().card];
    for (const card of cards)
      f.event("host_ops_patrol_due", {}, f.ops, card.id);
    // Use the actual persisted dispatch order (per-stream seq, then id).
    const [firstNote, nextNote] = f.store.listNotifications({
      project_id: f.project,
      assignment_id: f.ops.id,
    });
    const card = cards.find((c) => c.id === firstNote?.card_id);
    if (!firstNote || !nextNote || !card)
      throw new Error("missing pending notification");
    if (reason === "held")
      f.store.uow.run((tx) =>
        tx.cards.put(f.project, {
          ...card,
          hold: {
            set_by: "system",
            reason: "hold",
            resume_condition: "test",
            set_at: f.clock.now(),
          },
        }),
      );
    else {
      // Previous recovery settled without consuming the original notification.
      const old = f.event("host_ops_action_taken", {
        assignment_id: f.ops.id,
        dispatch_stall_id: firstNote.id,
        tool: "host_ops_restart_assignment",
      });
      f.event("host_ops_action_finished", {
        assignment_id: f.ops.id,
        action_id: old.id,
      });
    }
    f.advance(610_000);
    expect(
      (await f.view()).dispatch_stalls.filter(
        (s) => s.assignment_id === f.ops.id,
      ),
    ).toEqual([
      expect.objectContaining({ cause_id: firstNote.id, can_restart: false }),
      expect.objectContaining({ cause_id: nextNote.id, can_restart: true }),
    ]);
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .events.some(
            (e) =>
              e.type === "host_ops_action_taken" &&
              (e.payload as { dispatch_stall_id?: string })
                .dispatch_stall_id === nextNote.id,
          ),
      ).toBe(true),
    );
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === f.ops.id && r.status === "queued",
          ),
      ).toHaveLength(1),
    );
    await f.service.tick();
    expect(
      f
        .state()
        .events.filter(
          (e) =>
            e.type === "host_ops_action_taken" &&
            (e.payload as { dispatch_stall_id?: string }).dispatch_stall_id ===
              nextNote.id,
        ),
    ).toHaveLength(1);
  },
);

test("an unacknowledged patrol notification cannot hide a new alert on the project stream", async () => {
  const f = setup();
  const pending = () =>
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: f.ops.id,
      statuses: ["pending"],
    });
  const ownRows = async () =>
    (await f.view()).dispatch_stalls.filter(
      (s) => s.assignment_id === f.ops.id,
    );
  const actions = () =>
    f
      .state()
      .events.filter((e) => e.type === "host_ops_action_taken")
      .map(
        (e) => (e.payload as { dispatch_stall_id: string }).dispatch_stall_id,
      );

  f.advance(1);
  patrolHostOps(f.store, f.project, f.clock, 1);
  const [old] = pending();
  if (!old) throw new Error("missing patrol notification");
  const taken = f.event("host_ops_action_taken", {
    assignment_id: f.ops.id,
    dispatch_stall_id: old.id,
    tool: "host_ops_restart_assignment",
  });
  f.event("host_ops_action_finished", {
    assignment_id: f.ops.id,
    action_id: taken.id,
  });

  // Let an unrelated missing bell reach the threshold and publish a real alert to Ops.
  f.advance(1_000);
  f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610_000);
  await f.service.tick();
  const next = pending().find((n) => n.id !== old.id);
  if (!next) throw new Error("missing stall attention notification");
  expect(f.state().events.find((e) => e.id === next.event_id)?.type).toBe(
    "dispatch_stall_attention",
  );
  expect(pending().map((n) => n.card_id)).toEqual([undefined, undefined]);
  expect(await ownRows()).toMatchObject([
    { cause_id: old.id, can_restart: false },
  ]);
  expect(actions()).toEqual([old.id]);

  f.advance(610_000);
  expect(await ownRows()).toMatchObject([
    { cause_id: next.id, can_restart: true },
  ]);
  await f.service.tick();
  await vi.waitFor(() => expect(actions()).toEqual([old.id, next.id]));
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f
        .state()
        .runs.filter(
          (r) => r.assignment_id === f.ops.id && r.status === "queued",
        ),
    ).toHaveLength(1),
  );
  f.advance(30_000);
  await f.service.tick();
  expect(actions()).toEqual([old.id, next.id]);
});

test.each(["ops", "office", "external"] as const)(
  "undelivered logical bells share the dispatcher resolver (%s)",
  async (mode) => {
    const f = setup();
    const legacy = f.pm();
    const a =
      mode === "external"
        ? f.store.uow.run((tx) => {
            const external = {
              ...legacy,
              id: tx.ids.next(f.project, "assignment"),
              standing_mode: "office" as const,
              external: true,
            };
            tx.assignments.put(f.project, external);
            return external;
          })
        : legacy;
    f.event("patrol_due", {}, mode === "ops" ? "pm_ops" : "pm_office");
    f.advance(610_000);
    expect((await f.view()).dispatch_stalls).toEqual([]);
    f.store.issueToken({
      project_id: f.project,
      assignment_id: a.id,
      role: {
        role_version: 1,
        allowed_tools: mode === "ops" ? ["whoami"] : ["record_decision"],
      },
    });
    const rows = (await f.view()).dispatch_stalls;
    if (mode === "external") {
      expect(rows).toEqual([]);
      return;
    }
    expect(rows).toMatchObject([
      { kind: "standing_backlog", assignment_id: a.id, can_restart: true },
    ]);
    await f.restart(a, rows[0]?.cause_id as string);
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.filter(
            (r) => r.assignment_id === a.id && r.status === "queued",
          ),
      ).toHaveLength(1),
    );
  },
);

function rejected(f: ReturnType<typeof setup>) {
  const { assignment: a, item, card } = f.target;
  const sha = "a".repeat(40);
  const run_id = f.latest().id;
  const [delivery, review] = f.store.uow.run((tx) => {
    const verifier = tx.work_items
      .list(f.project)
      .find((w) => w.card_id === card.id && w.kind === "verify");
    if (!verifier) throw new Error("missing verifier");
    const d = tx.ids.next(f.project, "delivery"),
      r = tx.ids.next(f.project, "review");
    tx.deliveries.put(f.project, {
      id: d,
      work_item_id: item.id,
      run_id,
      kind: "code",
      summary: "test",
      subject: { kind: "git_head", value: sha },
      status: "rejected",
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [verifier.id],
    });
    tx.reviews.put(f.project, {
      id: r,
      delivery_id: d,
      target_sha: sha,
      work_item_id: verifier.id,
      run_id,
      kind: "code",
      issues: [],
      verdict: "reject",
      blocking: true,
      recheck_required: false,
      attachments: [],
    });
    const current = tx.work_items.get(f.project, item.id);
    if (!current) throw new Error("missing producer");
    tx.work_items.put(f.project, { ...current, status: "changes_requested" });
    return [d, r] as const;
  });
  f.advance(1);
  const signal = f.event(
    "review_submitted",
    {
      review_id: review,
      delivery_id: delivery,
      verdict: "reject",
      rework_allowed: true,
    },
    a,
    card.id,
  );
  const pause = () =>
    f.store.uow.run((tx) => {
      const id = tx.ids.next(f.project, "decision");
      tx.decisions.put(f.project, {
        id,
        key: id,
        kind: "choose",
        card_id: card.id,
        trigger: "review_limit",
        status: "open",
        raised_by: "system",
        decider: "role:pm",
        category: "general",
        question: "方向",
        context: "fixture",
        doc_refs: [],
        options: [],
        recommended: "change_approach",
        blocking: true,
        affected_cards: [card.id],
        affected_work_items: [item.id],
        review_limit_group: {
          delivery_id: delivery,
          target_sha: sha,
          finding_ids: [],
          candidate_items: [item.id],
        },
      });
    });
  f.advance(610_000);
  return { signal, pause };
}

test.each([
  "before_request",
  "before_stop",
  "after_stop",
  "after_queue",
] as const)(
  "review pause %s does not authorize an unrelated followup",
  async (when) => {
    const f = setup();
    const a = f.target.assignment;
    const { signal, pause } = rejected(f);
    if (when === "before_request") {
      pause();
      const rows = (await f.view()).dispatch_stalls;
      expect(rows).toMatchObject([
        {
          kind: "notification_backlog",
          restart_blocked: "trigger_blocked",
          can_restart: false,
        },
      ]);
      for (const cause of [signal.id, rows[0]?.cause_id as string])
        await expect(f.restart(a, cause)).rejects.toThrow();
      expect(f.runtime.release).not.toHaveBeenCalled();
      return;
    }
    expect((await f.view()).dispatch_stalls).toContainEqual(
      expect.objectContaining({ cause_id: signal.id, can_restart: true }),
    );
    await f.restart(a, signal.id);
    if (when === "before_stop") pause();
    if (when === "after_stop") {
      const release = vi.mocked(f.runtime.release).getMockImplementation();
      if (!release) throw new Error("missing fixture release");
      vi.mocked(f.runtime.release).mockImplementationOnce(async (ref) => {
        pause();
        return release(ref);
      });
    }
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f.state().events.some((e) => e.type === "host_ops_action_finished"),
      ).toBe(true),
    );
    if (when === "after_queue") {
      const run = f.latest();
      expect(run.status).toBe("queued");
      pause();
      expect(reviewRunWakeDisposition(f.state(), a, run)).toBe("paused");
    } else {
      expect(f.state().runs.filter((r) => r.status === "queued")).toEqual([]);
      if (when === "before_stop")
        expect(f.runtime.release).not.toHaveBeenCalled();
    }
  },
);

test("withdrawn rejection cannot authorize a restart via its still-pending notification", async () => {
  const f = setup();
  const { signal } = rejected(f);
  f.store.uow.run((tx) => {
    const [r] = tx.reviews.list(f.project);
    if (!r) throw new Error("missing review");
    tx.reviews.put(f.project, {
      ...r,
      withdrawn: { at: f.clock.now(), rationale: "test" },
    });
  });
  expect((await f.view()).dispatch_stalls).toMatchObject([
    { kind: "notification_backlog", can_restart: false },
  ]);
  await expect(f.restart(f.target.assignment, signal.id)).rejects.toThrow();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("A-1800 replay: retained reviewer receives its original instruction after a failed turn recovery", async () => {
  const { f, a, item, notice, run } = endedReviewer(true);
  f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, a.id)!,
      old = tx.runs.get(f.project, run.id)!;
    tx.runs.put(f.project, { ...old, harness: "codex" });
    tx.assignments.put(f.project, {
      ...owner,
      idle_retirement: {
        phase: "waiting",
        runtime_ref: owner.runtime_ref!,
        started_at: f.clock.now(),
        threshold_minutes: 60,
        failures: 40,
        last_failure: "unavailable",
        evidence: {
          stage: "confirm",
          reason: "kept_terminal",
          observation: "alive",
        },
      },
    });
  });
  let ready = false;
  f.runtime.observe_prompt = vi.fn(async () => ({ ok: true, value: ready }));
  const dispatcher = new Dispatcher(f.options);
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  try {
    await dispatcher.tick();
    f.advance(600000);
    await dispatcher.tick();
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(events("bell_turn_recovery_failed")).toHaveLength(1);
    });
    expect(events("bell_turn_recovery_due")).toHaveLength(1);
    f.advance(30000);
    await f.service.tick();
    const alert = events("dispatch_stall_attention").filter(
      (e) =>
        (e.payload as { system_finished_run_id?: string })
          .system_finished_run_id === run.id,
    );
    expect(alert).toMatchObject([
      {
        payload: {
          restart_blocked: "session_maintenance",
          can_restart: false,
          next_step: expect.stringContaining("主机运维"),
        },
      },
    ]);
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
        .filter((n) => n.event_id === alert[0]?.id),
    ).toHaveLength(1);
    expect(f.runtime.wake).not.toHaveBeenCalled();
    ready = true;
    await dispatcher.tick();
    expect(events("retained_session_bell_sent")).toMatchObject([
      { payload: { assignment_id: a.id } },
    ]);
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: a.id })
        .find((n) => n.event_id === notice.id),
    ).toMatchObject({ status: "belled" });
    expect(f.runtime.wake).toHaveBeenCalledWith(
      f.refFor(a),
      expect.any(String),
      expect.objectContaining({
        prompt_binding: {
          project_id: f.project,
          assignment_id: a.id,
          harness: "codex",
        },
      }),
    );
    expect(f.state().work_items.find((w) => w.id === item.id)?.status).toBe(
      "waiting_decision",
    );
    expect(f.runtime.release).not.toHaveBeenCalled();
  } finally {
    await dispatcher.close();
  }
});

test.each(["waiting", "stopping"] as const)(
  "C-575 %s handoff keeps one queue; incomplete exit never releases the terminal",
  async (phase) => {
    const { f, a } = reviewerFixture();
    const queue = f.apply((s, actor, p) =>
      queueRun(
        s,
        actor,
        { assignment_id: a.id, model: "fixture", agent_cli_version: "fixture" },
        p,
      ),
    );
    const receipt = "c".repeat(32);
    f.store.uow.run((tx) => {
      const current = tx.assignments.get(f.project, a.id)!;
      const ref = { ...f.refFor(a), local_process_receipt: receipt };
      tx.assignments.put(f.project, {
        ...current,
        runtime_ref: ref,
        idle_retirement: {
          phase,
          started_at: f.clock.now(),
          runtime_ref: ref,
          handoff: true,
          threshold_minutes: 60,
          failures: 3,
        },
      });
    });
    let kernelExit = false;
    let terminalExit = phase === "stopping";
    f.runtime.observe_retirement = vi.fn(async () => ({
      ok: true as const,
      value: terminalExit ? ("exited" as const) : ("alive" as const),
    }));
    f.runtime.confirm_local_exit = vi.fn(async () => ({
      ok: true as const,
      value: kernelExit,
    }));
    vi.mocked(f.runtime.status).mockImplementation(async () => ({
      ok: true as const,
      value: {
        agent: "idle" as const,
        process: terminalExit ? ("exited" as const) : ("alive" as const),
        observed_seq: 1,
      },
    }));
    const signal = vi.fn();
    f.runtime.retire_idle = vi.fn(async (_r, opts) => {
      if (!(await opts.workspace_preflight()) || !opts.before_signal())
        throw new Error("unexpected refusal");
      signal();
      terminalExit = true;
      kernelExit = true;
      return { ok: true as const, value: { outcome: "exited" as const } };
    });
    if (phase === "stopping") {
      await f.service.tick();
      await f.service.tick();
      expect(
        f.state().assignments.find((o) => o.id === a.id)?.idle_retirement
          ?.phase,
      ).toBe("stopping");
      expect(f.runtime.retire_idle).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(
          f.state().events.filter((e) => e.type === "dispatch_stall_attention"),
        ).toHaveLength(1),
      );
      kernelExit = true;
      f.advance(60_000);
    }
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(
        f.state().assignments.find((o) => o.id === a.id)?.idle_retirement,
      ).toBeUndefined();
    });
    expect(f.state().runs.filter((r) => r.assignment_id === a.id)).toEqual([
      queue,
    ]);
    expect(
      f.state().events.filter((e) => e.type === "host_ops_action_taken"),
    ).toHaveLength(1);
    expect(signal).toHaveBeenCalledTimes(phase === "waiting" ? 1 : 0);
    expect(f.runtime.release).not.toHaveBeenCalled();
  },
);
