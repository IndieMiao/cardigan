import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  type CardId,
  finishRun,
  reviewRunWakeDisposition,
} from "@cardigan/domain";
import { unwrap } from "@cardigan/mcp-server";
import { moveNotification } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
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
    const dispatcher = new Dispatcher({
      ...f.options,
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
      ).toEqual([]);
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

test("a cleaned verifier build allows recovery; an existing unreadable checkout, link or dirty work blocks it", async () => {
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
    tx.assignments.put(f.project, { ...owner, worktree_path: tree });
  });
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
