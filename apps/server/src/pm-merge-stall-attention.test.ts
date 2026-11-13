import {
  type Actor,
  type Assignment,
  type Decision,
  type Delivery,
  listNeedsYou,
  PM_MERGE_STALL_KIND,
  type Runtime,
  resolveDelegatedDecision,
} from "@cardigan/domain";
import { readAttention } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import { escalatePmMergeStalls } from "./pm-merge-stall-attention.js";
import { needsYou } from "./web/read.js";

afterEach(() => vi.useRealTimers());

const minute = 60_000;

/** A card awaiting merge whose current completion PM Ops holds, check passed. */
function pmHeldMerge() {
  const f = dispatchFixture();
  const { card, item } = f.create();
  const completion = {
    id: "D-900",
    work_item_id: item.id,
    run_id: "R-900",
    kind: "card_completion",
    summary: "Done",
    subject: { kind: "git_head", value: "a".repeat(40) },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "accepted",
  } as unknown as Delivery;
  const decision = {
    id: "Q-900",
    key: "Q-900",
    card_id: card.id,
    raised_by: "system",
    trigger: "merge_confirmation",
    kind: "approve",
    target: { delivery_id: completion.id },
    category: "general",
    question: `将 ${card.id} 合并到 main？`,
    context: "Done",
    options: [
      { key: "merge", description: "合并", impact: "更新基线" },
      { key: "hold", description: "暂缓合并", impact: "继续等待" },
    ],
    recommended: "merge",
    affected_cards: [card.id],
    affected_work_items: [],
    blocking: true,
    decider: "role:pm",
    doc_refs: [],
    status: "open",
  } as unknown as Decision;
  f.store.uow.run((tx) => {
    const current = tx.cards.get(f.project, card.id);
    if (!current) throw new Error("Missing card");
    tx.cards.put(f.project, { ...current, status: "awaiting_merge" });
    tx.deliveries.put(f.project, completion);
    tx.decisions.put(f.project, decision);
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, card.id),
      card_id: card.id,
      type: "merge_check_finished",
      actor: { kind: "system", project_id: f.project },
      payload: {
        card_id: card.id,
        completion_id: completion.id,
        attempt_id: "attempt-1",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        status: "passed",
        checks: [],
      },
      created_at: f.clock.now(),
    });
  });
  const options = {
    store: f.store,
    clock: f.clock,
    runtime: { status: vi.fn(), wake: vi.fn() } as unknown as Runtime,
    snapshot: vi.fn(),
    startRun: vi.fn(),
  };
  return { f, card, decision, options };
}

test("a PM-held merge confirmation stalled past 60 minutes alerts PM Ops once, shows in diagnostics and as a Needs You notice", async () => {
  const { f, card, decision, options } = pmHeldMerge();
  try {
    f.advance(60 * minute);
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toEqual([]);
    expect(
      readAttention(f.store, f.project, f.clock.now()).merge_stalls,
    ).toEqual([]);
    f.advance(5 * minute);
    await new Dispatcher(options).tick();
    // A restarted dispatcher reuses the durable fact.
    await new Dispatcher(options).tick();
    f.advance(30 * minute);
    await new Dispatcher(options).tick();
    const events = f
      .state()
      .events.filter((e) => e.type === PM_MERGE_STALL_KIND);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      card_id: card.id,
      decision_id: decision.id,
      waited_ms: 65 * minute,
      notice: `PM 持有的合并确认已停留 65 分钟（${card.id}）`,
    });
    const notes = f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === events[0]?.id);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipient: { kind: "pm_ops" },
          status: "pending",
        }),
        expect.objectContaining({
          recipient: { kind: "needs_you" },
          status: "needs_attention",
        }),
      ]),
    );
    expect(notes).toHaveLength(2);
    // host_ops_read_diagnostics spreads readAttention: card and wait included.
    expect(
      readAttention(f.store, f.project, f.clock.now()).merge_stalls,
    ).toEqual([
      expect.objectContaining({
        card_id: card.id,
        decision_id: decision.id,
        waited_ms: 95 * minute,
      }),
    ]);
    expect(
      needsYou(f.state(), f.clock.now()).notices?.find(
        (n) => n.id === events[0]?.id,
      ),
    ).toMatchObject({
      option: "stalled",
      card_id: card.id,
      body: `PM 持有的合并确认已停留 65 分钟（${card.id}）`,
    });
    expect(options.startRun).not.toHaveBeenCalled();

    // Handled: no new alert, and the open markers are resolved.
    f.store.uow.run((tx) =>
      tx.decisions.put(f.project, { ...decision, status: "resolved" }),
    );
    f.advance(120 * minute);
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toHaveLength(1);
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === events[0]?.id)
        .map((n) => n.status),
    ).toEqual(["resolved", "resolved"]);
    expect(
      readAttention(f.store, f.project, f.clock.now()).merge_stalls,
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("the escalation honours the suppression extension point", () => {
  const { f, options } = pmHeldMerge();
  try {
    f.advance(2 * 60 * minute);
    const state = f.state();
    f.store.uow.run((tx) =>
      escalatePmMergeStalls(tx, options.store, state, f.clock.now(), {
        suppressed: () => true,
      }),
    );
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("C-180: a real PM hold suppresses an existing alert, survives dispatcher restart and re-alerts only after expiry plus the threshold", async () => {
  const { f, card, decision, options } = pmHeldMerge();
  try {
    const base = f.state().assignments[0];
    if (!base) throw new Error("Missing assignment");
    const { work_item_id: _work, ...standing } = base;
    const ops: Assignment = {
      ...standing,
      id: "A-900" as Assignment["id"],
      scope: "standing",
      standing_mode: "ops",
      role_id: "pm",
    };
    f.store.uow.run((tx) => {
      tx.assignments.put(f.project, ops);
      const role = tx.roles.get(f.project, {
        role_id: "pm",
        role_version: ops.role_version,
      });
      if (!role) throw new Error("Missing PM role");
      tx.roles.put(f.project, {
        ...role,
        allowed_tools: ["resolve_delegated_decision", "list_needs_you"],
      });
    });
    const actor: Actor = {
      ...f.actorFor(ops),
      allowed_tools: ["resolve_delegated_decision", "list_needs_you"],
    } as Actor;
    f.advance(61 * minute);
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toHaveLength(1);
    f.apply(
      (s, a, p) =>
        resolveDelegatedDecision(
          s,
          a,
          {
            decision_id: decision.id,
            option: "hold",
            rationale: "等待核对",
          },
          p,
        ),
      actor,
    );
    f.advance(239 * minute);
    await new Dispatcher(options).tick();
    expect(f.state().decisions.find((q) => q.id === decision.id)?.status).toBe(
      "snoozed",
    );
    expect(
      readAttention(f.store, f.project, f.clock.now()).merge_stalls,
    ).toEqual([]);
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toHaveLength(1);
    f.advance(minute);
    await new Dispatcher(options).tick();
    await new Dispatcher(options).tick();
    expect(f.state().decisions.find((q) => q.id === decision.id)).toMatchObject(
      { status: "open", decider: "role:pm" },
    );
    const entries = f
      .state()
      .timeline.filter((t) => t.body.includes("暂缓已到期"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe(`暂缓已到期：等待核对（${card.id}）`);
    const needs = listNeedsYou(f.state(), actor, f.clock);
    if (!needs.ok) throw new Error(needs.error.message);
    expect(needs.value.data.pm_queue?.expired_snoozes).toEqual([
      expect.objectContaining({ body: entries[0]?.body }),
    ]);
    f.advance(60 * minute);
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toHaveLength(1);
    f.advance(1);
    await new Dispatcher(options).tick();
    await new Dispatcher(options).tick();
    expect(
      f.state().events.filter((e) => e.type === PM_MERGE_STALL_KIND),
    ).toHaveLength(2);
  } finally {
    f.close();
  }
});
