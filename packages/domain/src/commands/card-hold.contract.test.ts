import { expect, test } from "vitest";
import { deriveCardFields } from "../card-derived.js";
import { assignmentCardHeld } from "../card-hold.js";
import {
  abortDispatch,
  acknowledgeRun,
  dispatchRun,
  queueRun,
} from "./launch.js";
import { markNoticesRead, notices } from "./notices.js";
import { assign, createCard, updateCard } from "./pm.js";
import { recoverPreparation } from "./preparation-recovery.js";
import { refreshRunTargetWait } from "./run-target-wait.js";
import { markCardDone } from "./templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
};
const hold = { reason: "等待现场证据", resume_condition: "现场结果已核对" };
const card_id = id("card", 1);

test.each(["office", "ops"] as const)(
  "standing PM %s and human can set and release an audited hold without changing evidence",
  (mode) => {
    const io = ports();
    const original = fixture();
    const state = {
      ...original,
      assignments: original.assignments.map((a) =>
        a.scope === "standing" ? { ...a, standing_mode: mode } : a,
      ),
    };
    const effect = value(
      updateCard(state, actor(4, "pm"), { card_id, hold }, io),
    );
    const held = apply(state, effect);
    expect(held.cards.find((c) => c.id === card_id)?.hold).toEqual({
      ...hold,
      set_by: "assignment:A-4",
      set_at: now,
    });
    expect(held.cards.find((c) => c.id === card_id)?.status).toBe(
      state.cards[0]?.status,
    );
    for (const key of [
      "work_items",
      "runs",
      "assignments",
      "deliveries",
      "reviews",
      "decisions",
    ] as const)
      expect(held[key]).toEqual(state[key]);
    expect(effect.events.map((e) => e.type)).toEqual(["card_hold_set"]);
    expect(
      value(updateCard(held, human, { card_id, hold }, io)).events,
    ).toEqual([]);
    const release = value(updateCard(held, human, { card_id, hold: null }, io));
    expect(release.data.hold).toBeUndefined();
    expect(release.events[0]).toMatchObject({
      type: "card_hold_released",
      actor: human,
      payload: {
        previous_hold: held.cards.find((c) => c.id === card_id)?.hold,
        hold: null,
      },
    });
  },
);

test("hold rejects ordinary agents, work-item PMs, empty fields, forged metadata and mixed edits atomically", () => {
  const state = fixture();
  for (const caller of [
    actor(),
    actor(2, "reviewer"),
    actor(3, "pm"),
    { kind: "system" as const, project_id: state.project_id },
  ])
    expect(updateCard(state, caller, { card_id, hold }, ports()).ok).toBe(
      false,
    );
  for (const input of [
    { hold: { ...hold, reason: " " } },
    { hold: { ...hold, resume_condition: "" } },
    { hold: { ...hold, set_by: "human" } },
    { hold, title: "Mixed edit" },
  ])
    expect(updateCard(state, human, { card_id, ...input }, ports()).ok).toBe(
      false,
    );
  expect(state.cards[0]?.hold).toBeUndefined();
  expect(state.events).toEqual([]);
});

test("hold preserves queued ownership, blocks queue/dispatch/assign, and lets already-dispatched work acknowledge", () => {
  const io = ports();
  const base = fixture();
  const state = {
    ...base,
    runs: base.runs.map((r) => ({ ...r, status: "queued" as const })),
  };
  const held = apply(
    state,
    value(updateCard(state, human, { card_id, hold }, io)),
  );
  expect(assignmentCardHeld(required(held.assignments[0]), held)).toBe(true);
  expect(
    queueRun(
      held,
      human,
      {
        assignment_id: id("assignment", 1),
        model: "fixture",
        agent_cli_version: "fixture",
      },
      io,
    ).ok,
  ).toBe(false);
  expect(dispatchRun(held, human, { run_id: id("run", 1) }, io).ok).toBe(false);
  expect(
    assign(
      held,
      human,
      { work_item_id: id("work_item", 1), role_id: "coder" },
      io,
    ).ok,
  ).toBe(false);
  const waiting = value(
    refreshRunTargetWait(
      held,
      { kind: "system", project_id: held.project_id },
      { run_id: id("run", 1) },
      io,
    ),
  );
  expect(waiting.data).toBe(true);
  expect(
    apply(held, waiting).runs.find((r) => r.id === id("run", 1)),
  ).toMatchObject({ id: "R-1", assignment_id: "A-1", status: "queued" });
  const inFlight = {
    ...held,
    runs: held.runs.map((r) => ({ ...r, status: "dispatched" as const })),
  };
  expect(
    acknowledgeRun(inFlight, actor(), { run_id: id("run", 1) }, io).ok,
  ).toBe(true);
});

test("release keeps manual assignment, blockers and cancelled work; old title prefixes do not become holds", () => {
  const io = ports();
  const base = fixture();
  const state = {
    ...base,
    cards: base.cards.map((c) => ({ ...c, title: "【暂停】旧卡" })),
    work_items: base.work_items.map((w) => ({
      ...w,
      manual_assign: true,
      status: "cancelled" as const,
    })),
  };
  expect(assignmentCardHeld(required(state.assignments[0]), state)).toBe(false);
  const held = apply(
    state,
    value(updateCard(state, human, { card_id, hold }, io)),
  );
  const released = apply(
    held,
    value(updateCard(held, human, { card_id, hold: null }, io)),
  );
  expect(released.work_items).toEqual(state.work_items);
  expect(released.runs).toEqual(state.runs);
  expect(released.cards.find((c) => c.id === card_id)?.title).toBe(
    "【暂停】旧卡",
  );
});

test("hold has display priority without changing the lifecycle; review without pending reviews waits for completion", () => {
  const base = fixture();
  const input = {
    card: {
      ...required(base.cards[0]),
      hold: { ...hold, set_by: "human" as const, set_at: now },
    },
    work_items: base.work_items,
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    status: "review" as const,
  };
  expect(deriveCardFields(input)).toMatchObject({
    why: "已暂停：等待现场证据",
    next_owners: [{ kind: "role", ref: "pm" }],
  });
  expect(
    deriveCardFields({
      ...input,
      card: required(base.cards[0]),
      work_items: [],
    }).why,
  ).toBe("等待完成申请");
});

test("hold and release create readable non-blocking Needs You notices", () => {
  const io = ports();
  let state = apply(
    fixture(),
    value(updateCard(fixture(), human, { card_id, hold }, io)),
  );
  state = apply(
    state,
    value(updateCard(state, human, { card_id, hold: null }, io)),
  );
  expect(notices(state)).toHaveLength(2);
  expect(notices(state).map((n) => n.option)).toEqual(["已解除暂停", "已暂停"]);
  expect(notices(state)[1]?.body).toContain(hold.resume_condition);
  state = apply(
    state,
    value(
      markNoticesRead(
        state,
        human,
        { notice_ids: notices(state).map((n) => n.id) },
        io,
      ),
    ),
  );
  expect(notices(state).every((n) => n.read)).toBe(true);
  expect(state.decisions).toEqual([]);
  expect(state.human_actions).toEqual([]);
});

test("hold follows the owned card, not another card's dependency event; standing work follows its trigger", () => {
  const base = fixture(),
    io = ports();
  const held = apply(
    base,
    value(updateCard(base, human, { card_id, hold }, io)),
  );
  const event = held.events.find((e) => e.type === "card_hold_set");
  const other = {
    ...held,
    work_items: held.work_items.map((w) => ({ ...w, card_id: id("card", 2) })),
  };
  expect(
    assignmentCardHeld(required(other.assignments[0]), other, event?.id),
  ).toBe(false);
  const standing = required(
    other.assignments.find((a) => a.scope === "standing"),
  );
  expect(assignmentCardHeld(standing, other, event?.id)).toBe(true);
  expect(assignmentCardHeld(standing, other)).toBe(false);
});

test("human completion of a general card waits for explicit hold release", () => {
  const io = ports();
  let state = fixture();
  const created = value(
    createCard(
      state,
      human,
      {
        template_id: "general",
        title: "General",
        goal: "Observe",
        source: { kind: "quote", text: "Observe" },
      },
      io,
    ),
  );
  state = apply(state, created);
  const card_id = created.data.id;
  state = apply(state, value(updateCard(state, human, { card_id, hold }, io)));
  const before = JSON.stringify(state);
  expect(
    markCardDone(state, human, { card_id, result: "Completed" }, io),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(JSON.stringify(state)).toBe(before);
  state = apply(
    state,
    value(updateCard(state, human, { card_id, hold: null }, io)),
  );
  const done = value(
    markCardDone(state, human, { card_id, result: "Completed" }, io),
  );
  expect(done.data).toMatchObject({ status: "done" });
  expect(done.data.hold).toBeUndefined();
});

test("a standing patrol may queue beside held card work but never beside an executing Run", () => {
  const io = ports();
  let state = fixture();
  const changed = value(
    updateCard(state, human, { card_id, title: "Card task" }, io),
  );
  state = apply(state, changed);
  const original = value(
    queueRun(
      state,
      human,
      {
        assignment_id: id("assignment", 4),
        trigger_event_id: required(changed.events[0]).id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      io,
    ),
  );
  state = apply(state, original);
  state = apply(state, value(updateCard(state, human, { card_id, hold }, io)));
  const system = { kind: "system" as const, project_id: state.project_id };
  const params = {
    assignment_id: id("assignment", 4),
    model: "fixture",
    agent_cli_version: "fixture",
  };
  const patrol = value(queueRun(state, system, params, io));
  state = apply(state, patrol);
  state = apply(
    state,
    value(
      dispatchRun(
        state,
        system,
        {
          run_id: patrol.data.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "standing-patrol",
            agent_name: "fixture",
          },
        },
        io,
      ),
    ),
  );
  state = apply(
    state,
    value(
      acknowledgeRun(state, actor(4, "pm"), { run_id: patrol.data.id }, io),
    ),
  );
  expect(state.runs.find((r) => r.id === original.data.id)).toEqual(
    original.data,
  );
  expect(state.runs.find((r) => r.id === patrol.data.id)?.status).toBe(
    "running",
  );
  expect(queueRun(state, system, params, io).ok).toBe(false);
});

test.each([false, true])(
  "preparation successor keeps standing source hold (already held=%s)",
  (heldBefore) => {
    const io = ports();
    let state = fixture();
    const system = { kind: "system" as const, project_id: state.project_id };
    const change = value(
      updateCard(state, human, { card_id, title: "Preparation source" }, io),
    );
    state = apply(state, change);
    const original = value(
      queueRun(
        state,
        system,
        {
          assignment_id: id("assignment", 4),
          trigger_event_id: required(change.events[0]).id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        io,
      ),
    );
    state = apply(state, original);
    state = apply(
      state,
      value(
        abortDispatch(
          state,
          system,
          { run_id: original.data.id, reason: "directory preparation failed" },
          io,
        ),
      ),
    );
    if (heldBefore)
      state = apply(
        state,
        value(updateCard(state, human, { card_id, hold }, io)),
      );
    const effect = value(
      recoverPreparation(
        state,
        system,
        {
          run_id: original.data.id,
          category: "repository_lock_timeout",
          execution_exited: true,
          cleanup_complete: true,
          expected_runtime_ref:
            state.assignments.find((a) => a.id === original.data.assignment_id)
              ?.runtime_ref ?? null,
          backoff_ms: 1000,
        },
        io,
      ),
    );
    if (heldBefore) {
      expect(effect.data).toBeUndefined();
      return;
    }
    state = apply(state, effect);
    const next = required(effect.data);
    expect(
      effect.events.find((e) => e.id === next.trigger_event_id)?.card_id,
    ).toBe(card_id);
    // Historical recovery events stayed in the project stream.
    state = {
      ...state,
      events: state.events.map((event) => {
        if (event.id !== next.trigger_event_id) return event;
        const { card_id: _card, ...legacy } = event;
        return legacy;
      }),
    };
    state = apply(
      state,
      value(updateCard(state, human, { card_id, hold }, io)),
    );
    // Isolate the hold from the preparation backoff: both are independent gates.
    const later = {
      ...io,
      clock: { now: () => new Date(Date.parse(now) + 2000).toISOString() },
    };
    expect(
      dispatchRun(
        state,
        system,
        {
          run_id: next.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "prepared-session",
            agent_name: "fixture",
          },
        },
        later,
      ).ok,
    ).toBe(false);
    state = apply(
      state,
      value(updateCard(state, human, { card_id, hold: null }, later)),
    );
    expect(
      dispatchRun(
        state,
        system,
        {
          run_id: next.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "prepared-session",
            agent_name: "fixture",
          },
        },
        later,
      ).ok,
    ).toBe(true);
  },
);
