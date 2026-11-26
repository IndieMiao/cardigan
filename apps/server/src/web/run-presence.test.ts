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
  runningFirst,
  runningSince,
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
    ["dispatched", { state: "starting" }],
    ["acked", { state: "starting" }],
    ["unknown", { state: "unknown" }],
    ["completed", { state: "idle" }],
    ["failed", { state: "idle" }],
    ["cancelled", { state: "idle" }],
  ] as const)("a %s Run maps to %o", (status, expected) => {
    expect(presenceOf(single([{ ...run(1), status } as Run]))).toStrictEqual(
      expected,
    );
  });

  test("queued → dispatched → running: only queued waits for a machine, only running rings", () => {
    const states = (["queued", "dispatched", "acked", "running"] as const).map(
      (status) => presenceOf(single([{ ...run(1), status } as Run])).state,
    );
    expect(states).toStrictEqual(["queued", "starting", "starting", "running"]);
    // A starting Run outranks a queued one of the same person, below running.
    expect(
      strongestPresence([
        { state: "queued" },
        { state: "starting" },
        { state: "waiting", waiting: "precheck" },
      ]),
    ).toStrictEqual({ state: "starting" });
    expect(
      strongestPresence([{ state: "starting" }, { state: "running" }]),
    ).toStrictEqual({ state: "running" });
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
    // C-765: the running person comes first.
    expect(
      presences(board([{ ...run(2, 2), status: "queued" }, run(3, 3)])),
    ).toStrictEqual([
      ["员工2", { state: "running" }],
      ["员工1", { state: "queued" }],
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

// C-765: board avatars show three people, so running people go first.
describe("running people first", () => {
  type P = { name: string; state: "running" | "idle" | "queued"; at?: number };
  const order = (people: readonly P[]) =>
    runningFirst(people, (p) => ({
      presence: { state: p.state },
      ...(p.at === undefined ? {} : { since: p.at }),
    })).map((p) => p.name);

  test("nobody running keeps the given order", () => {
    const people: P[] = [
      { name: "a", state: "idle" },
      { name: "b", state: "queued" },
      { name: "c", state: "idle" },
      { name: "d", state: "queued" },
    ];
    expect(order(people)).toStrictEqual(["a", "b", "c", "d"]);
  });

  test("one runner moves to the front; the rest keep their order", () => {
    expect(
      order([
        { name: "a", state: "idle" },
        { name: "b", state: "queued" },
        { name: "c", state: "idle" },
        { name: "d", state: "running", at: 5 },
        { name: "e", state: "idle" },
      ]),
    ).toStrictEqual(["d", "a", "b", "c", "e"]);
  });

  test("runners sort by start time; unknown start last; ties keep order", () => {
    expect(
      order([
        { name: "a", state: "running", at: 30 },
        { name: "b", state: "idle" },
        { name: "c", state: "running" },
        { name: "d", state: "running", at: 10 },
        { name: "e", state: "running", at: 30 },
        { name: "f", state: "running", at: 20 },
      ]),
    ).toStrictEqual(["d", "f", "a", "e", "c", "b"]);
  });

  test("more than three runners fill the first three; idle people follow", () => {
    const names = order([
      { name: "a", state: "idle" },
      { name: "b", state: "running", at: 4 },
      { name: "c", state: "idle" },
      { name: "d", state: "running", at: 3 },
      { name: "e", state: "running", at: 2 },
      { name: "f", state: "running", at: 1 },
    ]);
    expect(names.slice(0, 3)).toStrictEqual(["f", "e", "d"]);
    expect(names.slice(3)).toStrictEqual(["b", "a", "c"]);
  });

  test("start time is the earliest running Run of the assignment", () => {
    const state = {
      runs: [
        { ...run(1), started_at: "2026-01-01T00:00:09.000Z" },
        { ...run(2, 1), started_at: "2026-01-01T00:00:03.000Z" },
        // Finished Runs do not count, however early.
        {
          ...run(3, 1),
          status: "completed",
          started_at: "2026-01-01T00:00:01.000Z",
        },
        // Another assignment's Run does not count.
        { ...run(4, 2), started_at: "2026-01-01T00:00:00.000Z" },
      ] as Run[],
    };
    expect(runningSince(state, { id: id("assignment", 1) })).toBe(
      Date.parse("2026-01-01T00:00:03.000Z"),
    );
    expect(
      runningSince({ runs: [run(1)] }, { id: id("assignment", 1) }),
    ).toBeUndefined();
    expect(
      runningSince(
        { runs: [{ ...run(1), started_at: "not a time" }] },
        { id: id("assignment", 1) },
      ),
    ).toBeUndefined();
  });

  /** Card 1 with `count` work items, one person each, in creation order. */
  function crowd(count: number, runs: readonly Run[]) {
    const base = fixture();
    const template = base.work_items[0] as WorkItem;
    const items = Array.from({ length: count }, (_, i) => ({
      ...template,
      id: id("work_item", i + 1),
      assignment_id: id("assignment", i + 1),
    }));
    return {
      ...base,
      employees: items.map((_, i) => employee(i + 1)),
      work_items: items,
      assignments: items.map((_, i) => ({
        ...assignment(i + 1),
        employee_id: id("employee", i + 1),
      })),
      runs: [...runs],
    } as CommandState;
  }
  const names = (state: CommandState) =>
    cardListViews(state)
      .find((c) => c.id === id("card", 1))
      ?.participants.map((p) => [p.employee?.name, p.run_presence.state]);
  const at = (n: number, assignmentNumber: number, second: number) => ({
    ...run(n, assignmentNumber),
    started_at: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
  });

  test("board: without runners the creation order stays", () => {
    expect(names(crowd(5, [{ ...run(1, 5), status: "queued" }]))).toStrictEqual(
      [
        ["员工1", "idle"],
        ["员工2", "idle"],
        ["员工3", "idle"],
        ["员工4", "idle"],
        ["员工5", "queued"],
      ],
    );
  });

  test("board: the fifth person running is no longer folded into +N", () => {
    expect(names(crowd(5, [at(1, 5, 1)]))).toStrictEqual([
      ["员工5", "running"],
      ["员工1", "idle"],
      ["员工2", "idle"],
      ["员工3", "idle"],
      ["员工4", "idle"],
    ]);
  });

  test("board: four runners by start time, then the idle person", () => {
    expect(
      names(crowd(5, [at(1, 2, 40), at(2, 3, 10), at(3, 4, 30), at(4, 5, 20)])),
    ).toStrictEqual([
      ["员工3", "running"],
      ["员工5", "running"],
      ["员工4", "running"],
      ["员工2", "running"],
      ["员工1", "idle"],
    ]);
  });

  test("board: order follows a Run finishing on the next read", () => {
    const runs = [at(1, 4, 10), at(2, 5, 20)];
    expect(names(crowd(5, runs))?.slice(0, 2)).toStrictEqual([
      ["员工4", "running"],
      ["员工5", "running"],
    ]);
    const after = crowd(5, [
      { ...runs[0], status: "completed" } as Run,
      runs[1] as Run,
    ]);
    expect(names(after)?.map(([name]) => name)).toStrictEqual([
      "员工5",
      "员工1",
      "员工2",
      "员工3",
      "员工4",
    ]);
  });
});
