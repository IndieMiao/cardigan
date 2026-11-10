import { expect, test } from "vitest";
import {
  assign,
  type CommandState,
  dispatchRun,
  type Employee,
  queueRun,
  submitReview,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  run,
  subject,
  value,
} from "./test-fixtures.js";

function employee(n: number, patch: Partial<Employee> = {}): Employee {
  return {
    id: id("employee", n),
    name: `Person ${n}`,
    title: "Developer",
    bio: "",
    avatar: null,
    role_id: "pm",
    launch_profile_ref: null,
    status: "active",
    created_at: now,
    updated_at: now,
    ...patch,
  };
}
function state(): CommandState {
  const base = fixture();
  return {
    ...base,
    employees: [employee(1), employee(2)],
    assignments: [],
    runs: [],
    work_items: base.work_items.map(({ assignment_id: _unused, ...item }) => ({
      ...item,
      role_id: "pm",
    })),
  };
}
const assignItem = (s: CommandState, n = 1, reference?: string, io = ports()) =>
  assign(
    s,
    human,
    {
      work_item_id: id("work_item", n),
      role_id: "pm",
      ...(reference === undefined ? {} : { employee_id: reference }),
    },
    io,
  );
const rejected = (result: unknown, code = "invariant_violation") =>
  expect(result).toMatchObject({ ok: false, error: { code } });

test("explicit employee ID and normalized name bind identity; replay cannot change it", () => {
  const s = state();
  const assigned = value(assignItem(s, 1, "　PERSON 2 "));
  expect(assigned.data.employee_id).toBe("E-2");
  const next = apply(s, assigned);
  for (const reference of [undefined, "E-2", "Person 2"]) {
    const replay = value(assignItem(next, 1, reference));
    expect(replay.data).toEqual(assigned.data);
    expect(replay.changes).toEqual([]);
  }
  rejected(assignItem(next, 1, "E-1"));
  const unnamed = value(assignItem({ ...s, employees: [] }));
  rejected(
    assignItem({ ...apply(s, unnamed), employees: s.employees }, 1, "E-1"),
  );
});

test("new assignments reject inactive employees, role mismatch and unregistered project roles", () => {
  rejected(
    assignItem(
      { ...state(), employees: [employee(1, { status: "inactive" })] },
      1,
      "E-1",
    ),
  );
  rejected(
    assignItem(
      { ...state(), employees: [employee(1, { role_id: "coder" })] },
      1,
      "E-1",
    ),
    "validation_failed",
  );
  rejected(assignItem({ ...state(), roles: [] }, 1, "E-1"), "not_found");
  rejected(assignItem(state(), 1, "E-999"), "not_found");
});

test.each([2, 3])(
  "employee separation applies both ways for W-%i, including released historical identities",
  (verifier) => {
    for (const [first, second] of [
      [1, verifier],
      [verifier, 1],
    ]) {
      for (const status of ["active", "released"] as const) {
        const s = apply(state(), value(assignItem(state(), first, "E-1")));
        const history = {
          ...s,
          assignments: s.assignments.map((a) => ({ ...a, status })),
        };
        rejected(assignItem(history, second, "E-1"));
        expect(value(assignItem(history, second, "E-2")).data.employee_id).toBe(
          "E-2",
        );
        // Selection filters the author before considering load/age.
        expect(value(assignItem(history, second)).data.employee_id).toBe("E-2");
        rejected(assignItem({ ...history, employees: [employee(1)] }, second));
      }
    }
  },
);

test("all previous author assignments count, unrelated cards and unnamed counterparts do not conflict", () => {
  const base = state();
  const historical = {
    ...assignment(10, "pm"),
    work_item_id: id("work_item", 1),
    employee_id: id("employee", 1),
    status: "released" as const,
  };
  const current = { ...assignment(1, "pm"), employee_id: id("employee", 2) };
  const s = { ...base, assignments: [historical, current] };
  rejected(assignItem(s, 2, "E-1"));
  rejected(assignItem(s, 2, "E-2"));
  for (const assignments of [
    [{ ...historical, work_item_id: id("work_item", 99) }],
    [assignment(1, "pm")],
  ])
    expect(
      value(assignItem({ ...base, assignments }, 2, "E-1")).data.employee_id,
    ).toBe("E-1");
});

test("auto selection prefers no unfinished Run, then oldest last assignment, then numeric ID", () => {
  const s = {
    ...state(),
    employees: [employee(10), employee(2), employee(1)],
    employee_activity: [
      {
        employee_id: id("employee", 1),
        unfinished_runs: 1,
        last_assigned_at: null,
      },
      {
        employee_id: id("employee", 2),
        unfinished_runs: 0,
        last_assigned_at: now,
      },
      {
        employee_id: id("employee", 10),
        unfinished_runs: 0,
        last_assigned_at: "2025-01-01",
      },
    ],
  };
  expect(value(assignItem(s)).data.employee_id).toBe("E-10");
  expect(
    value(
      assignItem({
        ...s,
        employee_activity: s.employee_activity.map((a) => ({
          ...a,
          unfinished_runs: 0,
        })),
      }),
    ).data.employee_id,
  ).toBe("E-1");
  expect(
    value(assignItem({ ...s, employee_activity: [] })).data.employee_id,
  ).toBe("E-1");
  // Queued and unknown Runs are busy too; completed/failed/cancelled Runs are not.
  for (const status of [
    "queued",
    "unknown",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    const local = {
      ...state(),
      assignments: [
        { ...assignment(99, "pm"), employee_id: id("employee", 1) },
      ],
      runs: [{ ...run(99), status }],
    };
    expect(value(assignItem(local)).data.employee_id).toBe("E-2"); // E-2 is idle and never assigned.
  }
});

test("legacy fallback only applies when no active employee has the role; deactivation leaves ongoing responsibility intact", () => {
  const s = {
    ...state(),
    employees: [
      employee(1, { status: "inactive" }),
      employee(2, { role_id: "coder" }),
    ],
  };
  expect(value(assignItem(s)).data).not.toHaveProperty("employee_id");
  const assigned = value(assignItem(state(), 1, "E-1"));
  const ongoing = {
    ...apply(state(), assigned),
    employees: [employee(1, { status: "inactive" })],
  };
  expect(value(assignItem(ongoing)).data.employee_id).toBe("E-1");
  const queued = value(
    queueRun(
      ongoing,
      human,
      {
        assignment_id: assigned.data.id,
        model: "chosen",
        agent_cli_version: "1",
        launch_profile_ref: "employee-profile",
      },
      ports(),
    ),
  );
  expect(queued.data).toMatchObject({
    employee_id: "E-1",
    launch_profile_ref: "employee-profile",
  });
  const dispatched = value(
    dispatchRun(
      apply(ongoing, queued),
      human,
      {
        run_id: queued.data.id,
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "fixture",
          agent_name: "fixture",
          worktree_path: "/fixture",
          branch: "agent/fixture",
        },
        base_sha: "a".repeat(40),
      },
      ports(),
    ),
  );
  expect(dispatched.data).toMatchObject({
    employee_id: "E-1",
    launch_profile_ref: "employee-profile",
    model: "chosen",
  });
});

test.each(["code", "card_completion"] as const)(
  "review command rejects a stored same-employee %s verifier",
  (kind) => {
    const s = fixture();
    const verifier = kind === "code" ? 2 : 3;
    const delivery = {
      id: id("delivery", 1),
      work_item_id: id("work_item", 1),
      run_id: id("run", 1),
      kind,
      summary: "Ready",
      subject,
      status: "submitted" as const,
      requested_verifiers: [id("work_item", verifier)],
      evidence: [],
      attachments: [],
      known_gaps: [],
    };
    const next = {
      ...s,
      deliveries: [delivery],
      assignments: s.assignments.map((a) => ({
        ...a,
        employee_id: id("employee", 1),
      })),
    };
    rejected(
      submitReview(
        next,
        actor(verifier, verifier === 2 ? "reviewer" : "pm"),
        {
          delivery_id: delivery.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        ports(),
      ),
    );
  },
);
