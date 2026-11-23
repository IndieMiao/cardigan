import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  abortDispatch,
  acknowledgeRun,
  finishRun,
  queueRun,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

test.each(["blocked", "error"] as const)(
  "a system-ended turn on alive/%s remains pending; silence does not authorize replacement",
  checkStalledTurn,
);

async function checkStalledTurn(agent: "unknown" | "blocked" | "error") {
  vi.stubEnv("CARDIGAN_DISPATCH_STALL_MS", "600000");
  const f = setup();
  const a = f.target.assignment;
  // A system-ended turn still requires an idle terminal; an author-ended turn does not.
  f.session(a, false);
  const q = f.apply((s, actor, p) =>
    requestDecision(
      s,
      actor,
      {
        card_id: f.target.card.id,
        category: "general",
        kind: "choose",
        decider: "human",
        question: "Continue?",
        context: "fixture",
        blocking: true,
        affected_cards: [f.target.card.id],
        affected_work_items: [f.target.item.id],
        options: [
          { key: "go", description: "Continue", impact: "Resume work" },
        ],
        recommended: "go",
        plain_summary: { changed: "等待确认", impact: "暂缓", risk: "无" },
      },
      p,
    ),
  );
  f.apply((s, actor, p) =>
    recordDecision(
      s,
      actor,
      {
        decision_id: q.id,
        option: "go",
        rationale: "fixture",
        raw_quote: "go",
      },
      p,
    ),
  );
  // No outstanding Run: the prior decision follow-up was cancelled before it started.
  const followup = f.latest();
  expect(followup.status).toBe("queued");
  f.apply((s, actor, p) =>
    abortDispatch(s, actor, { run_id: followup.id, reason: "fixture" }, p),
  );
  f.skipEvents();
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, a.id);
    if (!owner) throw new Error("missing target");
    tx.assignments.put(f.project, {
      ...owner,
      worktree_path: path,
      last_mcp_activity_at: f.clock.now(),
    });
  });
  f.advance(60 * 60_000);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent, observed_seq: 1 },
  });
  const resumed = f.event(
    "work_item_resume_requested",
    { assignment_id: a.id, work_item_id: f.target.item.id },
    a,
    f.target.card.id,
  );
  const dispatcher = new Dispatcher(f.options);
  await dispatcher.tick();
  await dispatcher.tick();
  expect(
    info.mock.calls.filter(([s]) =>
      String(s).includes(`wake_guard:alive/${agent}`),
    ),
  ).toHaveLength(1);
  f.advance(599999);
  expect((await f.view()).dispatch_stalls).toEqual([]);
  f.advance(1);
  await dispatcher.tick();
  expect(f.notes().find((n) => n.event_id === resumed.id)?.status).toBe(
    "pending",
  );
  f.runtime.observe_retirement = async () => ({ ok: true, value: "alive" });
  const rows = (await f.view()).dispatch_stalls;
  expect(rows).toMatchObject([
    {
      kind: "notification_backlog",
      assignment_id: a.id,
      workspace: "clean",
      terminal_state: agent,
      can_restart: false,
    },
  ]);
  const cause = rows.find((r) => r.kind === "notification_backlog")
    ?.cause_id as string;
  await expect(f.restart(a, cause)).rejects.toMatchObject({
    code: "stale_target",
    details: {
      reason: "turn_end_unconfirmed",
      workspace: "clean",
      process_state: "alive",
      terminal_state: agent,
    },
  });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(f.runtime.release).not.toHaveBeenCalledWith(
    f.refFor(a),
    expect.anything(),
  );
  // Separate positive control: only a fresh terminal observation changes the decision, not the clock.
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "alive", agent: "done", observed_seq: 2 },
  });
  expect(
    (await f.view()).dispatch_stalls.find((r) => r.cause_id === cause)
      ?.can_restart,
  ).toBe(true);
  await f.restart(a, cause);
  await f.restart(a, cause);
  expect(
    f.state().events.filter((e) => e.type === "host_ops_action_taken"),
  ).toHaveLength(1);
  // ACK of the original notification must invalidate the stop.
  expect(
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: a.id,
      card_id: f.target.card.id,
      up_to_seq: resumed.seq,
    }).ok,
  ).toBe(true);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().events.find((e) => e.type === "host_ops_action_finished")
        ?.payload,
    ).toMatchObject({ result: "withdrawn_stall_changed" }),
  );
  expect(f.runtime.release).not.toHaveBeenCalledWith(
    f.refFor(a),
    expect.anything(),
  );
  await dispatcher.close();
}

test("a lost terminal reference is not evidence of a never-provisioned session", async () => {
  const f = setup();
  const a = f.target.assignment;
  f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, a.id);
    if (!owner) throw new Error("missing target");
    tx.assignments.put(f.project, {
      ...owner,
      runtime_state: "lost",
      runtime_ref: null,
      session_ref: "previous",
    });
  });
  f.advance(1);
  const cause = f.event("instruction_issued", {
    work_item_id: f.target.item.id,
  });
  f.advance(600_000);
  expect((await f.view()).dispatch_stalls).toMatchObject([
    { cause_id: cause.id, can_restart: false },
  ]);
  await expect(f.restart(a, cause.id)).rejects.toMatchObject({
    code: "stale_target",
  });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
});

test("a lost instruction bell remains visible with no notification; dirty files and missing evidence cannot authorize a restart", async () => {
  const f = setup();
  f.advance(1);
  const a = f.target.assignment;
  const e = f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610000);
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  const owner = f.state().assignments.find((v) => v.id === a.id) as Assignment;
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...owner, worktree_path: path }),
  );
  expect((await f.view()).dispatch_stalls).toEqual([
    expect.objectContaining({
      cause_id: e.id,
      workspace: "unknown",
      can_restart: false,
    }),
  ]);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  writeFileSync(join(path, "private-name"), "untracked");
  const view = await f.view();
  expect(view.dispatch_stalls).toEqual([
    expect.objectContaining({
      cause_id: e.id,
      workspace: "dirty",
      can_restart: false,
    }),
  ]);
  expect(JSON.stringify(view.dispatch_stalls)).not.toContain("private-name");
  await expect(f.restart(a, e.id)).rejects.toMatchObject({
    code: "stale_target",
    details: { reason: "workspace_unconfirmed", workspace: "dirty" },
  });
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("a waiting retirement keeps its session even when the host sees an idle terminal and an overdue note", async () => {
  const f = setup(),
    a = f.target.assignment;
  f.store.uow.run((tx) => {
    const owner = tx.assignments.get(f.project, a.id);
    if (!owner?.runtime_ref) throw Error("missing session");
    tx.assignments.put(f.project, {
      ...owner,
      idle_retirement: {
        phase: "waiting",
        runtime_ref: owner.runtime_ref,
        started_at: f.clock.now(),
        threshold_minutes: 60,
        failures: 1,
      },
    });
  });
  f.advance(1);
  const event = f.event("fixture", {}, a, f.target.card.id);
  const note = f.notes().find((n) => n.event_id === event.id);
  if (!note) throw Error("missing note");
  f.advance(600_000);
  expect((await f.view()).dispatch_stalls).toMatchObject([
    {
      cause_id: note.id,
      restart_blocked: "session_maintenance",
      can_restart: false,
    },
  ]);
  await expect(f.restart(a, note.id)).rejects.toMatchObject({
    code: "stale_target",
    details: { reason: "stall_not_current" },
  });
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test.each(["ops", "office"] as const)(
  "stopped managed standing PM %s receives the right restart; a new Run clears attention",
  async (mode) => {
    const f = setup();
    const a = { ...f.pm(), standing_mode: mode };
    f.store.uow.run((tx) => tx.assignments.put(f.project, a));
    f.event("fixture", {}, mode === "ops" ? "pm_ops" : "pm_office");
    f.advance(65 * 60_000);
    const [row] = (await f.view()).dispatch_stalls;
    expect(row).toMatchObject({
      kind: "standing_backlog",
      assignment_id: a.id,
      card_id: null,
      age_ms: 65 * 60_000,
      workspace: "no_worktree",
      can_restart: true,
    });
    await f.restart(a, row?.cause_id as string);
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.some((r) => r.assignment_id === a.id && r.status === "queued"),
      ).toBe(true),
    );
    expect(
      (await f.view()).dispatch_stalls.filter((s) => s.assignment_id === a.id),
    ).toEqual([]);
  },
);

test.each([
  ["card", false, "project"],
  ["project", false, "other card"],
  ["card", true, "project"],
  ["project", true, "other card"],
  ["card", true, "other card"],
] as const)(
  "a standing PM recovery keeps the %s stream through queued dispatch (already read: %s, competing stream: %s)",
  async (stream, alreadyRead, competitor) => {
    const f = setup();
    f.ownTerminals();
    const pm = { ...f.pm(), standing_mode: "office" as const };
    const card = f.target.card;
    const sourceCard = stream === "card" ? card.id : undefined;
    const otherCard =
      competitor === "other card" ? f.create().card.id : undefined;
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, {
        ...pm,
        runtime_state: "idle",
        runtime_ref: f.refFor(pm),
        session_ref: "old",
      }),
    );
    const source = f.event(
      sourceCard ? "comment_posted" : "project_created",
      {},
      pm,
      sourceCard,
    );
    f.skipEvents();
    f.advance(660000);
    vi.mocked(f.runtime.status).mockResolvedValueOnce({
      ok: true,
      value: { process: "unknown", agent: "unknown", observed_seq: 1 },
    });
    const dispatcher = new Dispatcher(f.options);
    try {
      await dispatcher.tick();
      const note = f.store
        .listNotifications({ project_id: f.project, assignment_id: pm.id })
        .find((n) => n.event_id === source.id);
      if (!note) throw new Error("missing original notification");
      expect(note.status).toBe("needs_attention");
      expect(
        (await f.view()).dispatch_stalls.find((s) => s.cause_id === note.id),
      ).toMatchObject({ card_id: sourceCard ?? null, can_restart: true });
      await f.restart(pm, note.id);
      await f.service.tick();
      const queued = await vi.waitFor(() => {
        const r = f
          .state()
          .runs.find((r) => r.assignment_id === pm.id && r.status === "queued");
        if (!r) throw new Error("recovery not queued");
        return r;
      });
      // An acknowledged delivery can still have a queued capacity retry with no pending note.
      if (alreadyRead) {
        const trigger = f
          .state()
          .events.find((e) => e.id === queued.trigger_event_id);
        if (!trigger) throw new Error("missing replacement trigger");
        expect(
          f.store.ackEvents({
            project_id: f.project,
            assignment_id: pm.id,
            card_id: sourceCard ?? PROJECT_EVENT_STREAM,
            up_to_seq: trigger.seq,
          }).ok,
        ).toBe(true);
        f.store.uow.run((tx) =>
          tx.runs.put(f.project, {
            ...queued,
            queue_reason: "concurrency_limit",
          }),
        );
      }
      const startRun = f.options.startRun;
      if (!startRun) throw new Error("missing launch fixture");
      const start = () =>
        vi.mocked(startRun).mock.calls.filter(([p]) => p.run.id === queued.id);
      f.store.uow.run((tx) =>
        tx.cards.put(f.project, {
          ...card,
          hold: {
            set_by: "system",
            reason: "paused",
            resume_condition: "test",
            set_at: f.clock.now(),
          },
        }),
      );
      if (sourceCard) {
        await dispatcher.tick();
        expect(start()).toHaveLength(0);
        expect(f.state().runs.find((r) => r.id === queued.id)?.status).toBe(
          "queued",
        );
        f.store.uow.run((tx) => tx.cards.put(f.project, card));
      }
      const competing = f.event("fixture_notice", {}, pm, otherCard);
      await dispatcher.tick();
      expect(start()).toHaveLength(1);
      expect(start()[0]?.[0].bell).toContain(
        sourceCard ? `card=${sourceCard} ` : `project=${f.project} `,
      );
      expect(
        f.state().events.find((e) => e.id === queued.trigger_event_id)?.card_id,
      ).toBe(sourceCard);
      const receipt = f
        .state()
        .runs.find((r) => r.id === queued.id)?.bell_delivery;
      expect(receipt?.run_id).toBe(queued.id);
      expect(receipt?.card_id).toBe(sourceCard);
      const otherNote = () =>
        f.store
          .listNotifications({ project_id: f.project, assignment_id: pm.id })
          .find((n) => n.event_id === competing.id);
      expect(otherNote()).toMatchObject({ status: "pending", attempts: 0 });

      const actor = f.actorFor(pm);
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: queued.id }, p),
        actor,
      );
      f.apply(
        (s, a, p) =>
          finishRun(
            s,
            a,
            { run_id: queued.id, outcome: "completed", summary: "Recovered" },
            p,
          ),
        actor,
      );
      await dispatcher.tick();
      const delivered = otherNote();
      expect(delivered?.run_id).toBeDefined();
      expect(delivered?.run_id).not.toBe(queued.id);
      expect(delivered?.card_id).toBe(otherCard);
    } finally {
      await dispatcher.close();
    }
  },
);

test.each([false, true])(
  "a standing stream is rechecked when its queue changes during launch preparation (same stream: %s)",
  checkQueueChanged,
);

async function checkQueueChanged(sameStream: boolean) {
  const f = setup();
  const pm = f.pm();
  const notice = f.event("fixture_project_notice", {}, pm);
  const dispatcher = new Dispatcher({
    ...f.options,
    snapshot: async (a, project) => {
      const snapshot = await f.options.snapshot(a, project);
      if (a.id === pm.id) {
        const source = f.event(
          "fixture_queue_notice",
          {},
          pm,
          sameStream ? undefined : f.target.card.id,
        );
        f.apply((state, actor, ports) =>
          queueRun(
            state,
            actor,
            {
              ...snapshot,
              assignment_id: pm.id,
              trigger_event_id: source.id,
            },
            ports,
          ),
        );
      }
      return snapshot;
    },
  });
  try {
    await dispatcher.tick();
    expect(
      f.state().runs.filter((r) => r.assignment_id === pm.id),
    ).toMatchObject([{ status: "queued" }]);
    expect(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: pm.id })
        .find((n) => n.event_id === notice.id),
    ).toMatchObject({ status: "pending", attempts: 0 });
  } finally {
    await dispatcher.close();
  }
}

test.each([false, true])(
  "patrol supervisor recovers its own overdue bell once, including after dispatch handoff=%s",
  async (handoff) => {
    const f = setup();
    f.ownTerminals();
    const a = f.ops;
    const ref = f.refFor(a);
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, {
        ...a,
        runtime_ref: ref,
        runtime_state: "idle",
        session_ref: "old",
      }),
    );
    f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
    f.advance(11 * 60000);
    if (handoff) {
      // Dispatcher wins the race to the deadline. Unknown process state is not proof it is safe to stop.
      vi.mocked(f.runtime.status).mockResolvedValueOnce({
        ok: true,
        value: { process: "unknown", agent: "unknown", observed_seq: 1 },
      });
      const dispatcher = new Dispatcher(f.options);
      try {
        await dispatcher.tick();
      } finally {
        await dispatcher.close();
      }
      expect(
        f.store.listNotifications({
          project_id: f.project,
          assignment_id: a.id,
          status: "needs_attention",
        }),
      ).toHaveLength(1);
      expect(f.runtime.release).not.toHaveBeenCalled();
    }
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f.state().events.some((e) => e.type === "host_ops_action_taken"),
      ).toBe(true),
    );
    await f.service.tick();
    await vi.waitFor(() =>
      expect(
        f
          .state()
          .runs.some((r) => r.assignment_id === a.id && r.status === "queued"),
      ).toBe(true),
    );
    // Owner-bound idle stop with kernel exit proof; never released by address.
    expect(f.runtime.retire_idle).toHaveBeenCalledOnce();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(
      f.state().assignments.find((v) => v.id === a.id)?.session_ref,
    ).toBeUndefined();
    await f.service.tick();
    expect(
      f.state().events.filter((e) => e.type === "dispatch_stall_attention"),
    ).toHaveLength(1);
    expect(
      f.state().events.filter((e) => e.type === "host_ops_action_taken"),
    ).toHaveLength(1);
    expect(
      f.store.listNotifications({
        project_id: f.project,
        recipient_kind: "pm_office",
      }),
    ).toHaveLength(1);
  },
);

test("unrelated escalations cannot authorize restarting a session", async () => {
  const f = setup();
  const a = f.ops;
  const event = f.event("host_ops_patrol_due", { assignment_id: a.id }, a);
  const note = f.store
    .listNotifications({ project_id: f.project, assignment_id: a.id })
    .find((n) => n.event_id === event.id);
  if (!note) throw Error("missing notification");
  f.store.moveNotification({
    project_id: f.project,
    id: note.id,
    event: "needs_attention",
    at: f.clock.now(),
  });
  f.advance(11 * 60000);
  expect((await f.view()).dispatch_stalls).toEqual([]);
  await f.service.tick();
  expect(f.state().events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
});

test("unconfirmed plan feedback points at the author, without guessing from words or requiring a bell", async () => {
  const f = setup();
  const { assignment: a, item, card } = f.target;
  f.advance(1);
  f.store.uow.run((tx) => {
    const v = tx.work_items
      .list(f.project)
      .find((w) => w.card_id === card.id && w.kind === "verify");
    if (v?.kind !== "verify") throw new Error("Missing verifier");
    const reviewer = tx.ids.next(f.project, "assignment");
    const q = tx.ids.next(f.project, "decision");
    const proposal = tx.ids.nextTimelineEntryId(f.project, card.id);
    const reply = tx.ids.nextTimelineEntryId(f.project, card.id);
    tx.work_items.put(f.project, {
      ...v,
      assignment_id: reviewer,
      review_plan_target: q,
    });
    tx.decisions.put(f.project, {
      id: q,
      key: q,
      kind: "choose",
      card_id: card.id,
      trigger: "review_limit",
      status: "resolved",
      raised_by: "system",
      decider: "role:pm",
      category: "general",
      question: "方向",
      context: "fixture",
      doc_refs: [],
      options: [],
      recommended: "change_approach",
      blocking: false,
      affected_cards: [card.id],
      affected_work_items: [v.id],
      review_intervention: {
        producer_id: item.id,
        proposal,
        review_id: tx.ids.next(f.project, "review"),
      },
      resolution: {
        option: "change_approach",
        rationale: "fixture",
        resolved_by: "system",
        via: "system_rule",
        raw_quote: "fixture",
        via_chain: [],
        at: f.clock.now(),
      },
    });
    tx.timeline.put(f.project, {
      id: reply,
      short_id: reply,
      card_id: card.id,
      type: "comment",
      author: `assignment:${reviewer}`,
      reply_to: proposal,
      event_seq: 13,
      refs: [],
      mentions: [],
      retracted: false,
      body: "这处需要调整",
      created_at: f.clock.now(),
    });
  });
  f.advance(10 * 60 * 60_000);
  const [row] = (await f.view()).dispatch_stalls;
  expect(row).toMatchObject({
    kind: "owner_not_woken",
    assignment_id: a.id,
    card_id: card.id,
    age_ms: 10 * 60 * 60_000,
  });
  f.store.uow.run((tx) => {
    const q = tx.decisions.list(f.project)[0];
    if (q?.review_intervention)
      tx.decisions.put(f.project, {
        ...q,
        review_intervention: {
          ...q.review_intervention,
          confirmation: tx.ids.nextTimelineEntryId(f.project, card.id),
        },
      });
  });
  expect((await f.view()).dispatch_stalls).toEqual([]);
});

test("worktree dirtied after an accepted request withdraws it before release, without a stuck fence", async () => {
  const f = setup();
  f.ownTerminals();
  const a = f
    .state()
    .assignments.find((a) => a.id === f.target.assignment.id) as Assignment;
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...a, worktree_path: path }),
  );
  f.advance(1);
  const e = f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610000);
  await f.restart(a, e.id);
  writeFileSync(join(path, "new"), "uncommitted");
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().events.find((ev) => ev.type === "host_ops_action_finished")
        ?.payload,
    ).toMatchObject({ result: "withdrawn_stall_changed" }),
  );
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.runtime.retire_idle).not.toHaveBeenCalled();
  expect(f.state().human_actions).toHaveLength(0);
});

test("an ordinary writer stall is not stopped by Ops until its committed branch backup is verified", async () => {
  const f = setup();
  f.ownTerminals();
  const a = f
    .state()
    .assignments.find((a) => a.id === f.target.assignment.id) as Assignment;
  const path = join(f.dataDir, "agent", "worktrees", f.project, a.id);
  const branch = "agent/test/ordinary-writer";
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", branch);
  const commit = (message: string) =>
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
  commit("base");
  const base = git("rev-parse", "HEAD");
  // A clean tree with a newer local commit: clean is not backed up.
  commit("local work");
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, {
      role_id: a.role_id,
      role_version: a.role_version,
    });
    if (!role) throw new Error("missing role");
    tx.roles.put(f.project, { ...role, worktree: "write" });
    tx.assignments.put(f.project, {
      ...a,
      worktree_path: path,
      branch,
      base_sha: base,
    });
  });
  f.advance(1);
  const e = f.event("instruction_issued", { work_item_id: f.target.item.id });
  f.advance(610000);
  expect((await f.view()).dispatch_stalls).toMatchObject([
    { cause_id: e.id, workspace: "clean", can_restart: true },
  ]);
  await f.restart(a, e.id);
  await f.service.tick();
  await vi.waitFor(() =>
    expect(
      f.state().events.find((ev) => ev.type === "host_ops_action_finished")
        ?.payload,
    ).toMatchObject({ reason: "workspace_backup_unconfirmed" }),
  );
  // No backup, no stop: the session, its binding and the checkout stay.
  expect(f.runtime.retire_idle).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(
    f
      .state()
      .events.filter((ev) => ev.type === "dispatch_stall_backup_verified"),
  ).toEqual([]);
  expect(f.state().assignments.find((v) => v.id === a.id)?.runtime_ref).toEqual(
    f.refFor(a),
  );
  expect(
    f
      .state()
      .runs.filter((r) => r.assignment_id === a.id && r.status === "queued"),
  ).toEqual([]);
  expect(git("log", "-1", "--format=%s")).toBe("local work");
});

test("C-618: a lost evidence-unblocked instruction to a delivered author stays visible; other instructions still wait", async () => {
  const f = setup();
  const item = f.target.item;
  f.store.uow.run((tx) =>
    tx.work_items.put(f.project, {
      ...(tx.work_items.get(f.project, item.id) as typeof item),
      status: "delivered",
    } as typeof item),
  );
  f.advance(1);
  const plain = f.event("instruction_issued", { work_item_id: item.id });
  f.advance(610000);
  expect((await f.view()).dispatch_stalls).toEqual([]);
  const evidence = f.event("instruction_issued", {
    work_item_id: item.id,
    evidence_unblocked: ["V-1"] as never,
  });
  f.advance(610000);
  const stalls = (await f.view()).dispatch_stalls;
  expect(stalls).toEqual([
    expect.objectContaining({ cause_id: evidence.id, kind: "owner_not_woken" }),
  ]);
  expect(stalls.some((s) => s.cause_id === plain.id)).toBe(false);
});
