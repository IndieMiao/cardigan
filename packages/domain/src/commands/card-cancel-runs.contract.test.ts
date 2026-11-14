import { expect, test } from "vitest";
import { occupiedRunSlots } from "../run-capacity.js";
import type { CommandState } from "./core.js";
import { dispatchRun, queueRun } from "./launch.js";
import { updateCard } from "./pm.js";
import {
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const ref = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "fixture-terminal",
  agent_name: "fixture",
};
const cancel = (s: CommandState) =>
  value(
    updateCard(
      s,
      human,
      { card_id: id("card", 1), status: "cancelled" },
      ports(),
    ),
  );

test.each([undefined, "concurrency_limit", "runtime_unavailable"] as const)(
  "C-217: card cancellation atomically cancels queued Runs (%s), preserving terminals and other cards",
  (queue_reason) => {
    const initial = fixture();
    const first = initial.work_items[0];
    if (!first) throw new Error("Missing fixture work item");
    const other = {
      ...first,
      id: id("work_item", 5),
      card_id: id("card", 2),
      assignment_id: id("assignment", 5),
    };
    const s: CommandState = {
      ...initial,
      work_items: [...initial.work_items, other],
      assignments: [
        ...initial.assignments.map((a) => ({ ...a, runtime_ref: ref })),
        assignment(5),
      ],
      runs: [
        {
          ...run(1),
          status: "queued",
          ...(queue_reason ? { queue_reason } : {}),
        },
        run(2),
        { ...run(3), status: "queued" },
        { ...run(4), status: "queued" }, // Standing PM: not owned by the card.
        { ...run(5), status: "queued" }, // Another card.
      ],
    };
    const before = JSON.stringify(s);
    const effect = cancel(s);
    const next = apply(s, effect);
    expect(JSON.stringify(s)).toBe(before);
    expect(next.cards.find((c) => c.id === id("card", 1))?.status).toBe(
      "cancelled",
    );
    expect(
      next.work_items
        .filter((w) => w.card_id === id("card", 1))
        .every((w) => w.status === "cancelled"),
    ).toBe(true);
    for (const n of [1, 3])
      expect(next.runs.find((r) => r.id === id("run", n))).toMatchObject({
        status: "cancelled",
        outcome: "failed",
        summary: "卡片已取消，排队执行已取消",
        finished_at: now,
      });
    for (const n of [2, 4, 5])
      expect(next.runs.find((r) => r.id === id("run", n))).toEqual(
        s.runs.find((r) => r.id === id("run", n)),
      );
    expect(next.assignments).toEqual(s.assignments);
    expect(occupiedRunSlots(next.assignments, next.runs, "local")).toBe(
      occupiedRunSlots(s.assignments, s.runs, "local"),
    );
    expect(effect.events).toEqual([
      expect.objectContaining({
        type: "card_updated",
        actor: human,
        card_id: id("card", 1),
        payload: {
          card_id: id("card", 1),
          status: "cancelled",
          cancelled_run_ids: [id("run", 1), id("run", 3)],
        },
      }),
    ]);
    expect(cancel(next).changes.filter((c) => c.collection === "runs")).toEqual(
      [],
    );
    expect(
      queueRun(
        next,
        human,
        {
          assignment_id: id("assignment", 1),
          model: "test",
          agent_cli_version: "test",
        },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    for (const runtime_ref of [undefined, ref])
      expect(
        dispatchRun(
          next,
          human,
          { run_id: id("run", 1), ...(runtime_ref ? { runtime_ref } : {}) },
          ports(),
        ),
      ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  },
);

test.each([
  "dispatched",
  "acked",
  "running",
  "unknown",
  "completed",
  "failed",
] as const)(
  "C-217: a %s Run survives card cancellation until explicit cleanup",
  (status) => {
    const s: CommandState = { ...fixture(), runs: [{ ...run(1), status }] };
    const next = apply(s, cancel(s));
    expect(next.runs).toEqual(s.runs);
    expect(next.assignments).toEqual(s.assignments);
  },
);
