import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  abortDispatch,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

test.each(["unknown", "blocked", "error"] as const)(
  "C-548: a system-ended turn on alive/%s hands off once, but silence does not authorize replacement",
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
  await dispatcher.tick(); // C-546 hands the refused notification to operations at the same deadline.
  expect(f.notes().some((n) => n.status === "needs_attention")).toBe(true);
  const handoffs = f
    .state()
    .events.filter((e) => e.type === "bell_wake_escalated");
  expect(handoffs).toMatchObject([
    {
      payload: {
        assignment_id: a.id,
        reason: "system_finished_turn",
        activity_source: `alive/${agent}`,
        activity_forwarded_to: f.ops.id,
      },
    },
  ]);
  expect(
    f.store
      .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
      .filter((n) => n.event_id === handoffs[0]?.id),
  ).toHaveLength(1);
  const rows = (await f.view()).dispatch_stalls;
  expect(rows).toEqual(
    expect.arrayContaining(
      ["resume_not_dispatched", "notification_backlog"].map((kind) =>
        expect.objectContaining({
          kind,
          assignment_id: a.id,
          card_id: f.target.card.id,
          age_ms: 600000,
          terminal_state: agent,
          workspace: "clean",
          can_restart: false,
        }),
      ),
    ),
  );
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
  // The row stays needs_attention after ACK. Its original stream cursor must invalidate the stop.
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

test.each([false, true])(
  "patrol supervisor recovers its own overdue bell once, including after dispatch handoff=%s",
  async (handoff) => {
    const f = setup();
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
    expect(f.runtime.release).toHaveBeenCalledOnce();
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
  expect(f.state().human_actions).toHaveLength(0);
});
