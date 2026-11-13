import { expect, test } from "vitest";
import {
  assign,
  type CommandState,
  type Employee,
  submitReview,
  type WorkItem,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

// W-1 development (coder), W-2 code_review (reviewer), W-3 PM acceptance,
// W-4 independent_reviewer, W-5 tester; all targeting W-1 where applicable.
const DEV = 1,
  CODE_REVIEW = 2,
  ACCEPT = 3,
  INDEPENDENT = 4,
  TESTER = 5;

function employee(n: number, role_id: string): Employee {
  return {
    id: id("employee", n),
    name: `Person ${n}`,
    title: "Engineer",
    bio: "",
    avatar: null,
    role_id,
    launch_profile_ref: null,
    status: "active",
    created_at: now,
    updated_at: now,
  };
}

function state(): CommandState {
  const base = fixture();
  const verify = base.work_items[1] as WorkItem;
  const extra = (n: number, role_id: string, template_key: string) =>
    ({
      ...verify,
      id: id("work_item", n),
      title: role_id,
      role_id,
      template_key,
    }) as WorkItem;
  return {
    ...base,
    roles: [...base.roles, role("independent_reviewer"), role("tester")],
    employees: [],
    assignments: [],
    runs: [],
    work_items: [
      ...base.work_items,
      extra(INDEPENDENT, "independent_reviewer", "independent_review"),
      extra(TESTER, "tester", "test"),
    ].map(({ assignment_id: _unused, ...item }) => item as WorkItem),
  };
}

// One shared ID source so successive assignments in a test get distinct IDs.
const io = ports();

const roleOf = (s: CommandState, n: number) => {
  const item = s.work_items.find((w) => w.id === id("work_item", n));
  if (!item) throw new Error("Missing work item");
  return item.role_id;
};

/** Assign W-n to employee E-e, giving E-e the item's role first (role history is what makes cross-role reuse possible). */
function assignTo(s: CommandState, n: number, e: number) {
  const role_id = roleOf(s, n);
  const others = (s.employees ?? []).filter((x) => x.id !== id("employee", e));
  const next = { ...s, employees: [...others, employee(e, role_id)] };
  return {
    next,
    result: assign(
      next,
      human,
      { work_item_id: id("work_item", n), role_id, employee_id: `E-${e}` },
      io,
    ),
  };
}

function assigned(s: CommandState, n: number, e: number): CommandState {
  const { next, result } = assignTo(s, n, e);
  return apply(next, value(result));
}

const rejectedWith = (result: unknown, message: string) =>
  expect(result).toMatchObject({
    ok: false,
    error: { code: "invariant_violation", message },
  });
const VERIFIER_CONFLICT =
  "独立复核员工不能同时是同一张卡上其它验证项当前或曾经的负责人";
const AUTHOR_CONFLICT =
  "审核员工不能是目标产出项当前或曾经的作者（完成申请同理）";

test.each([
  ["code_review first, then independent_reviewer", CODE_REVIEW, INDEPENDENT],
  ["independent_reviewer first, then code_review", INDEPENDENT, CODE_REVIEW],
  ["independent_reviewer first, then PM acceptance", INDEPENDENT, ACCEPT],
  ["tester first, then independent_reviewer", TESTER, INDEPENDENT],
])(
  "invariant 15/16 (P2a-14 ②): same employee rejected — %s",
  (_name, first, second) => {
    for (const status of ["active", "released"] as const) {
      const s = assigned(state(), first, 1);
      const history = {
        ...s,
        assignments: s.assignments.map((a) => ({ ...a, status })),
      };
      rejectedWith(assignTo(history, second, 1).result, VERIFIER_CONFLICT);
      // A different employee is fine.
      expect(value(assignTo(history, second, 2).result).data.employee_id).toBe(
        "E-2",
      );
    }
  },
);

test("auto selection skips an independent reviewer who already verifies the card", () => {
  const s = assigned(state(), CODE_REVIEW, 1);
  const pool = {
    ...s,
    employees: [
      employee(1, "independent_reviewer"),
      employee(2, "independent_reviewer"),
    ],
  };
  const auto = assign(
    pool,
    human,
    {
      work_item_id: id("work_item", INDEPENDENT),
      role_id: "independent_reviewer",
    },
    ports(),
  );
  expect(value(auto).data.employee_id).toBe("E-2");
  expect(
    assign(
      { ...pool, employees: [employee(1, "independent_reviewer")] },
      human,
      {
        work_item_id: id("work_item", INDEPENDENT),
        role_id: "independent_reviewer",
      },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: "该角色的在职员工均违反审核隔离要求，请指派其他员工" },
  });
});

test("regression: independent_reviewer vs its target producer is still rejected both ways", () => {
  rejectedWith(
    assignTo(assigned(state(), DEV, 1), INDEPENDENT, 1).result,
    AUTHOR_CONFLICT,
  );
  rejectedWith(
    assignTo(assigned(state(), INDEPENDENT, 1), DEV, 1).result,
    AUTHOR_CONFLICT,
  );
});

test("three distinct employees for development, code_review and independent_reviewer are allowed", () => {
  let s = assigned(state(), DEV, 1);
  s = assigned(s, CODE_REVIEW, 2);
  s = assigned(s, INDEPENDENT, 3);
  s = assigned(s, ACCEPT, 4);
  expect(
    s.assignments
      .map((a) => [
        a.scope === "work_item" ? a.work_item_id : null,
        a.employee_id,
      ])
      .sort(),
  ).toEqual([
    ["W-1", "E-1"],
    ["W-2", "E-2"],
    ["W-3", "E-4"],
    ["W-4", "E-3"],
  ]);
  expect(new Set(s.assignments.map((a) => a.id)).size).toBe(4);
});

test("regression: other verify roles stay unseparated from each other", () => {
  for (const [first, second] of [
    [CODE_REVIEW, TESTER],
    [TESTER, CODE_REVIEW],
    [CODE_REVIEW, ACCEPT],
    [ACCEPT, TESTER],
  ]) {
    const s = assigned(state(), first as number, 1);
    expect(
      value(assignTo(s, second as number, 1).result).data.employee_id,
    ).toBe("E-1");
  }
});

test("independent review on another card does not conflict", () => {
  const s = assigned(state(), CODE_REVIEW, 1);
  const moved = {
    ...s,
    work_items: s.work_items.map((w) =>
      w.id === id("work_item", INDEPENDENT)
        ? { ...w, card_id: id("card", 2) }
        : w,
    ),
  };
  expect(value(assignTo(moved, INDEPENDENT, 1).result).data.employee_id).toBe(
    "E-1",
  );
});

test("submit_review rejects a stored independent reviewer who also holds code_review", () => {
  let s = assigned(state(), DEV, 9);
  s = assigned(s, CODE_REVIEW, 1);
  // Bypass assign: a legacy/stored independent review assignment for the same employee.
  const review = s.assignments.find(
    (a) =>
      a.scope === "work_item" &&
      a.work_item_id === id("work_item", CODE_REVIEW),
  );
  if (!review) throw new Error("Missing code review assignment");
  const stored = {
    ...review,
    id: id("assignment", 40),
    work_item_id: id("work_item", INDEPENDENT),
    role_id: "independent_reviewer",
  } as (typeof s.assignments)[number];
  const delivery = {
    id: id("delivery", 1),
    work_item_id: id("work_item", DEV),
    run_id: id("run", 1),
    kind: "code" as const,
    summary: "Ready",
    subject,
    status: "submitted" as const,
    requested_verifiers: [id("work_item", INDEPENDENT)],
    evidence: [],
    attachments: [],
    known_gaps: [],
  };
  const next: CommandState = {
    ...s,
    assignments: [...s.assignments, stored],
    deliveries: [delivery],
    work_items: s.work_items.map((w) =>
      w.id === id("work_item", INDEPENDENT)
        ? { ...w, assignment_id: stored.id }
        : w,
    ),
  };
  rejectedWith(
    submitReview(
      next,
      actor(40, "independent_reviewer"),
      {
        delivery_id: delivery.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      ports(),
    ),
    VERIFIER_CONFLICT,
  );
});
