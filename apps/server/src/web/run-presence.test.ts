import type { CommandState, Event, Run, WorkItem } from "@cardigan/domain";
import { describe, expect, test } from "vitest";
import {
  assignment,
  fixture,
  id,
  run,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardDetail, cardListViews, executionView } from "./read.js";
import {
  assignmentPresence,
  precheckIndex,
  strongestPresence,
} from "./run-presence.js";

// C-531: what each person is doing for a card, as the avatar ring shows it.

const employee = (n: number) => ({
  id: id("employee", n),
  name: `员工${n}`,
  title: "工程师",
  avatar: null,
  role_id: "coder",
  launch_profile_ref: "private-profile",
  status: "active" as const,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
});

function precheckEvent(
  seq: number,
  assignmentNumber: number,
  status: "queued" | "running" | "passed",
  card = id("card", 1),
): Event {
  return {
    id: `precheck-${seq}`,
    project_id: fixture().project_id,
    card_id: card,
    seq,
    type: status === "queued" ? "precheck_queued" : "precheck_finished",
    actor: { kind: "system", project_id: fixture().project_id },
    created_at: "2026-01-01T00:00:00.000Z",
    payload: {
      attempt_id: `attempt-${seq}`,
      assignment_id: id("assignment", assignmentNumber),
      work_item_id: id("work_item", assignmentNumber),
      card_id: card,
      head_sha: "a".repeat(40),
      status,
      branch: "feature",
      machine_id: "local",
    },
  } as unknown as Event;
}

/** One produce item owned by assignment 1, with the given Runs and item status. */
function single(
  runs: readonly Run[],
  options: { item?: Partial<WorkItem>; events?: readonly Event[] } = {},
): CommandState {
  const base = fixture();
  return {
    ...base,
    work_items: base.work_items.map((w) =>
      w.id === id("work_item", 1) ? { ...w, ...options.item } : w,
    ),
    runs: [...runs],
    events: [...(options.events ?? [])],
  };
}

function presenceOf(state: CommandState, assignmentNumber = 1) {
  const a = state.assignments.find(
    (x) => x.id === id("assignment", assignmentNumber),
  );
  if (!a) throw new Error("missing assignment");
  return assignmentPresence(state, a, precheckIndex(state)(id("card", 1)));
}

describe("assignment presence", () => {
  test.each([
    ["running", { state: "running" }],
    ["queued", { state: "queued" }],
    ["dispatched", { state: "queued" }],
    ["acked", { state: "queued" }],
    ["unknown", { state: "unknown" }],
    ["completed", { state: "idle" }],
    ["failed", { state: "idle" }],
    ["cancelled", { state: "idle" }],
  ] as const)("a %s Run maps to %o", (status, expected) => {
    expect(presenceOf(single([{ ...run(1), status } as Run]))).toStrictEqual(
      expected,
    );
  });

  test("waiting for a precheck is never running, even while the precheck runs", () => {
    for (const status of ["queued", "running"] as const)
      expect(
        presenceOf(single([], { events: [precheckEvent(1, 1, status)] })),
      ).toStrictEqual({ state: "waiting", waiting: "precheck" });
    // A finished precheck no longer waits.
    expect(
      presenceOf(single([], { events: [precheckEvent(1, 1, "passed")] })),
    ).toStrictEqual({ state: "idle" });
    // Another assignment's precheck does not make this one wait.
    expect(
      presenceOf(single([], { events: [precheckEvent(1, 2, "queued")] })),
    ).toStrictEqual({ state: "idle" });
  });

  test("decisions and blockers wait with their own reason; a live Run outranks them", () => {
    expect(
      presenceOf(single([], { item: { status: "waiting_decision" } })),
    ).toStrictEqual({ state: "waiting", waiting: "decision" });
    expect(
      presenceOf(single([], { item: { status: "blocked" } })),
    ).toStrictEqual({ state: "waiting", waiting: "blocked" });
    expect(
      presenceOf(single([run(1)], { item: { status: "blocked" } })),
    ).toStrictEqual({ state: "running" });
  });

  test("merging prefers running > queued > unknown > waiting > idle", () => {
    expect(
      strongestPresence([
        { state: "idle" },
        { state: "waiting", waiting: "blocked" },
        { state: "queued" },
        { state: "running" },
      ]),
    ).toStrictEqual({ state: "running" });
    expect(
      strongestPresence([
        { state: "waiting", waiting: "blocked" },
        { state: "unknown" },
        { state: "queued" },
      ]),
    ).toStrictEqual({ state: "queued" });
    expect(
      strongestPresence([{ state: "idle" }, { state: "unknown" }]),
    ).toStrictEqual({ state: "unknown" });
    expect(
      strongestPresence([
        { state: "waiting", waiting: "blocked" },
        { state: "waiting", waiting: "precheck" },
      ]),
    ).toStrictEqual({ state: "waiting", waiting: "precheck" });
    expect(strongestPresence([])).toStrictEqual({ state: "idle" });
  });
});

describe("board participants", () => {
  /** Employee 1 owns items 1 and 2 on card 1; employee 2 owns item 3. */
  function board(runs: readonly Run[], extra: Partial<CommandState> = {}) {
    const base = fixture();
    return {
      ...base,
      employees: [employee(1), employee(2)],
      assignments: base.assignments.map((a) =>
        a.id === id("assignment", 3)
          ? { ...a, employee_id: id("employee", 2) }
          : a.scope === "work_item"
            ? { ...a, employee_id: id("employee", 1) }
            : a,
      ),
      runs: [...runs],
      ...extra,
    } as CommandState;
  }
  const presences = (state: CommandState) =>
    cardListViews(state)
      .find((c) => c.id === id("card", 1))
      ?.participants.map((p) => [p.employee?.name, p.run_presence]);

  test("one person merges their assignments on this card; others keep their own state", () => {
    expect(
      presences(board([{ ...run(1), status: "completed" }, run(2, 2)])),
    ).toStrictEqual([
      ["员工1", { state: "running" }],
      ["员工2", { state: "idle" }],
    ]);
    expect(
      presences(board([{ ...run(2, 2), status: "queued" }, run(3, 3)])),
    ).toStrictEqual([
      ["员工1", { state: "queued" }],
      ["员工2", { state: "running" }],
    ]);
  });

  test("a released assignment or work on another card never rings this card", () => {
    const base = board([]);
    const other = {
      ...assignment(9),
      work_item_id: id("work_item", 9),
      employee_id: id("employee", 2),
    };
    const state = board([run(3, 3), run(9, 9)], {
      assignments: [
        ...base.assignments.map((a) =>
          a.id === id("assignment", 3)
            ? { ...a, status: "released" as const }
            : a,
        ),
        other,
      ],
      work_items: [
        ...base.work_items,
        {
          ...(base.work_items[0] as WorkItem),
          id: id("work_item", 9),
          card_id: id("card", 2),
          assignment_id: other.id,
        },
      ],
    });
    // Employee 2's only card-1 assignment is released, so they are not shown;
    // their Run on card 2 rings only card 2.
    expect(presences(state)).toStrictEqual([["员工1", { state: "idle" }]]);
    expect(
      cardListViews(state)
        .find((c) => c.id === id("card", 2))
        ?.participants.map((p) => [p.employee?.name, p.run_presence]),
    ).toStrictEqual([["员工2", { state: "running" }]]);
  });

  test("a card-level waiting precheck is not running", () => {
    expect(
      presences(board([], { events: [precheckEvent(1, 1, "running")] })),
    ).toStrictEqual([
      ["员工1", { state: "waiting", waiting: "precheck" }],
      ["员工2", { state: "idle" }],
    ]);
  });
});

test("execution rows and detail work items carry only their own state", () => {
  const state = {
    ...fixture(),
    runs: [run(1), { ...run(2), status: "queued" }],
  };
  const rows = executionView(state as CommandState, "2026-01-01").assignments;
  expect(
    rows.map((row) => [
      row.id,
      "run_presence" in row ? row.run_presence : null,
    ]),
  ).toStrictEqual([
    [id("assignment", 1), { state: "running" }],
    [id("assignment", 2), { state: "queued" }],
    [id("assignment", 3), { state: "idle" }],
    // Standing rows are not bound to a card.
    [id("assignment", 4), null],
  ]);
  const detail = cardDetail(state as CommandState, id("card", 1));
  expect(
    detail?.work_items.map((item) => [
      item.id,
      "run_presence" in item ? item.run_presence : null,
      "assignee" in item ? item.assignee?.author_role : null,
    ]),
  ).toStrictEqual([
    [id("work_item", 1), { state: "running" }, "coder"],
    [id("work_item", 2), { state: "queued" }, "reviewer"],
    [id("work_item", 3), { state: "idle" }, "pm"],
  ]);
});
