import { expect, test } from "vitest";
import {
  assign,
  autoAssignVerifier,
  builtinCardTemplates,
  type CommandState,
  type Delivery,
  type Employee,
  remindSystemWaits,
  type SystemReminderPolicy,
  setProjectPreferences,
  updateWorkItem,
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
  role,
  subject,
  value,
} from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const system = { kind: "system" as const, project_id: human.project_id };
const policy: SystemReminderPolicy = {
  min_minutes: 1,
  max_minutes: 100,
  min_count: 1,
  max_count: 10,
  unassigned_ready_after_minutes: 2,
  pre_merge_check_pending_after_minutes: 3,
  repeat: false,
  repeat_interval_minutes: null,
  max_reminders: 2,
};
const employee = (n: number, role_id = "reviewer"): Employee => ({
  id: id("employee", n),
  name: `Person ${n}`,
  title: "Reviewer",
  bio: "",
  avatar: null,
  role_id,
  launch_profile_ref: null,
  status: "active",
  created_at: now,
  updated_at: now,
});
function base(): CommandState {
  const f = fixture();
  const delivery: Delivery = {
    id: id("delivery", 1),
    work_item_id: id("work_item", 1),
    run_id: id("run", 1),
    kind: "code",
    summary: "Change",
    subject,
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [id("work_item", 2)],
    status: "submitted",
  };
  return {
    ...f,
    cards: [required(f.cards[0])],
    work_items: f.work_items.map((w) => {
      const { assignment_id: _old, ...rest } = w;
      return rest;
    }),
    assignments: [assignment()],
    runs: [],
    deliveries: [delivery],
    employees: [employee(1), employee(2)],
    project_preferences: [
      {
        id: human.project_id,
        auto_merge_after_minutes: null,
        system_auto_assign_verifiers: true,
        system_reminders: true,
        system_reminder_policy: policy,
      },
    ],
  };
}
const auto = (s: CommandState, n = 2, io = ports()) =>
  value(
    autoAssignVerifier(s, system, { work_item_id: id("work_item", n) }, io),
  );
const tick = (s: CommandState, minutes: number, io = ports()) =>
  value(
    remindSystemWaits(s, system, {
      ...io,
      clock: {
        now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
      },
    }),
  );

test("C-237 automatic assignment shares employee ranking, audit, token issuance and persistent ownership", () => {
  let s = base();
  s = {
    ...s,
    employee_activity: [
      {
        employee_id: id("employee", 1),
        unfinished_runs: 1,
        last_assigned_at: now,
      },
      {
        employee_id: id("employee", 2),
        unfinished_runs: 0,
        last_assigned_at: now,
      },
    ],
  };
  const effect = auto(s);
  expect(effect.data?.employee_id).toBe(id("employee", 2));
  expect(effect.token_requests).toHaveLength(1);
  expect(effect.events).toMatchObject([
    {
      type: "work_item_assigned",
      actor: system,
      payload: { rule: "C-225/auto-assign", delivery_id: id("delivery", 1) },
    },
  ]);
  expect(effect.timeline).toMatchObject([{ author: "system" }]);
  const assigned = apply(s, effect);
  expect(auto(assigned).events).toEqual([]);
  expect(
    value(
      assign(
        assigned,
        human,
        { work_item_id: id("work_item", 2), role_id: "reviewer" },
        ports(),
      ),
    ).data.id,
  ).toBe(effect.data?.id);
  expect(
    effect.changes.every((c) =>
      ["assignments", "work_items", "cards"].includes(c.collection),
    ),
  ).toBe(true);
});

test.each([
  "missing_switch",
  "off",
  "no_delivery",
  "superseded",
  "unrequested",
  "manual",
  "cancelled",
  "replaced",
  "passed",
  "closed",
  "backlog",
  "historical_assignment",
  "blocked",
  "produce",
])(
  "C-237 ineligible %s makes no automatic assignment or fallback",
  (scenario) => {
    let s = base();
    if (scenario === "missing_switch") s = { ...s, project_preferences: [] };
    if (scenario === "off")
      s = {
        ...s,
        project_preferences: [
          {
            ...required(s.project_preferences?.[0]),
            system_auto_assign_verifiers: false,
          },
        ],
      };
    if (scenario === "no_delivery") s = { ...s, deliveries: [] };
    if (scenario === "superseded")
      s = {
        ...s,
        deliveries: s.deliveries.map((v) => ({ ...v, status: "superseded" })),
      };
    if (scenario === "unrequested")
      s = {
        ...s,
        deliveries: s.deliveries.map((v) => ({
          ...v,
          requested_verifiers: [],
        })),
      };
    if (
      ["manual", "cancelled", "passed", "blocked", "replaced"].includes(
        scenario,
      )
    )
      s = {
        ...s,
        work_items: s.work_items.map((w) =>
          w.id !== id("work_item", 2)
            ? w
            : {
                ...w,
                ...(scenario === "manual"
                  ? { manual_assign: true }
                  : scenario === "replaced"
                    ? { replaced_by_work_item_id: id("work_item", 4) }
                    : { status: scenario as "cancelled" }),
              },
        ),
      };
    if (["closed", "backlog"].includes(scenario))
      s = {
        ...s,
        cards: s.cards.map((c) => ({
          ...c,
          status: scenario === "closed" ? "done" : "backlog",
        })),
      };
    if (scenario === "historical_assignment")
      s = {
        ...s,
        assignments: [
          ...s.assignments,
          { ...assignment(2, "reviewer"), status: "released" },
        ],
      };
    const effect = auto(s, scenario === "produce" ? 1 : 2);
    expect(effect.data).toBeNull();
    expect(effect.events).toEqual([]);
    expect(effect.token_requests).toEqual([]);
  },
);

test.each([
  "current_author",
  "released_author",
  "other_verifier",
  "released_verifier",
  "reverse_independent",
  "inactive",
  "external",
  "no_employees",
  "inactive_role",
])(
  "C-237 isolation and eligibility: %s falls back once without creating anonymous assignments",
  (scenario) => {
    let s = base();
    s = { ...s, employees: [employee(1)] };
    if (scenario.includes("author"))
      s = {
        ...s,
        assignments: s.assignments.map((a) => ({
          ...a,
          employee_id: id("employee", 1),
          status: scenario === "released_author" ? "released" : "active",
        })),
      };
    if (scenario.includes("verifier") || scenario === "reverse_independent") {
      const independent = scenario !== "reverse_independent";
      s = {
        ...s,
        roles: [...s.roles, role("independent_reviewer")],
        employees: [
          employee(1, independent ? "independent_reviewer" : "reviewer"),
        ],
        work_items: [
          ...s.work_items.map((w) =>
            w.id === id("work_item", 2) && independent
              ? { ...w, role_id: "independent_reviewer" }
              : w,
          ),
          {
            ...required(s.work_items[1]),
            id: id("work_item", 4),
            role_id: independent ? "reviewer" : "independent_reviewer",
          },
        ],
        assignments: [
          ...s.assignments,
          {
            ...assignment(4, independent ? "reviewer" : "independent_reviewer"),
            employee_id: id("employee", 1),
            status: scenario === "released_verifier" ? "released" : "active",
          },
        ],
      };
    }
    if (scenario === "inactive")
      s = { ...s, employees: [{ ...employee(1), status: "inactive" }] };
    if (scenario === "external")
      s = {
        ...s,
        employee_activity: [
          {
            employee_id: id("employee", 1),
            unfinished_runs: 0,
            last_assigned_at: null,
            has_external_standing_assignment: true,
          },
        ],
      };
    if (scenario === "no_employees") s = { ...s, employees: [] };
    if (scenario === "inactive_role")
      s = {
        ...s,
        roles: s.roles.map((r) =>
          r.role_id === "reviewer" ? { ...r, status: "inactive" } : r,
        ),
      };
    const effect = auto(s);
    expect(effect.data).toBeNull();
    expect(effect.token_requests).toEqual([]);
    expect(effect.events).toMatchObject([
      { type: "system_assignment_deferred", actor: system },
    ]);
    const next = apply(s, effect);
    expect(auto(next).events).toEqual([]);
    expect(next.assignments).toEqual(s.assignments);
  },
);

test("C-237 PM acceptance is included; human completion and non-current requests are excluded", () => {
  let s = base();
  s = {
    ...s,
    employees: [employee(3, "pm")],
    deliveries: [
      {
        ...required(s.deliveries[0]),
        kind: "card_completion",
        requested_verifiers: [id("work_item", 3)],
      },
    ],
  };
  expect(auto(s, 3).data?.role_id).toBe("pm");
  const template = required(builtinCardTemplates.find((t) => t.id === "dev"));
  s = {
    ...s,
    card_templates: [
      { ...template, completion: { mode: "review", reviewer: "human" } },
    ],
  };
  expect(auto(s, 3).events).toEqual([]);
});

test("C-237 system authority is host-only and manual hold is PM/human only", () => {
  const s = base();
  for (const a of [human, actor(), { ...system, project_id: "elsewhere" }]) {
    expect(
      autoAssignVerifier(s, a, { work_item_id: id("work_item", 2) }, ports())
        .ok,
    ).toBe(false);
    expect(remindSystemWaits(s, a, ports()).ok).toBe(false);
  }
  expect(
    updateWorkItem(
      s,
      actor(),
      { work_item_id: id("work_item", 2), manual_assign: true },
      ports(),
    ).ok,
  ).toBe(false);
  for (const enabled of [true, false]) {
    const effect = value(
      updateWorkItem(
        s,
        human,
        { work_item_id: id("work_item", 2), manual_assign: enabled },
        ports(),
      ),
    );
    expect(effect.data.manual_assign).toBe(enabled);
    expect(effect.events[0]?.payload).toMatchObject({ manual_assign: enabled });
  }
  expect(
    value(
      assign(
        s,
        human,
        { work_item_id: id("work_item", 2), role_id: "reviewer" },
        ports(),
      ),
    ).data.employee_id,
  ).toBeDefined();
});

test("C-237 preferences have no defaults, reject invalid ranges/values, audit human edits atomically", () => {
  const s = fixture();
  expect(tick(s, 100).events).toEqual([]);
  for (const patch of [
    { system_auto_assign_verifiers: true },
    { system_reminders: true },
    { system_reminder_policy: policy },
  ])
    expect(setProjectPreferences(s, actor(), patch, ports()).ok).toBe(false);
  const bad = [0, -1, 1.5, NaN, Infinity, "2", 101];
  for (const n of bad)
    expect(
      setProjectPreferences(
        s,
        human,
        {
          system_reminder_policy: {
            ...policy,
            unassigned_ready_after_minutes: n,
          } as SystemReminderPolicy,
        },
        ports(),
      ).ok,
    ).toBe(false);
  for (const p of [
    {},
    { ...policy, min_minutes: 101 },
    { ...policy, min_count: 20 },
    { ...policy, max_reminders: 11 },
    { ...policy, repeat: true },
    { ...policy, repeat_interval_minutes: 2 },
    { ...policy, max_minutes: Number.MAX_SAFE_INTEGER },
    { ...policy, typo: true },
  ])
    expect(
      setProjectPreferences(
        s,
        human,
        { system_reminder_policy: p as SystemReminderPolicy },
        ports(),
      ).ok,
    ).toBe(false);
  const effect = value(
    setProjectPreferences(
      s,
      human,
      {
        system_auto_assign_verifiers: true,
        system_reminders: true,
        system_reminder_policy: policy,
      },
      ports(),
    ),
  );
  expect(effect.events).toHaveLength(3);
  expect(effect.events.every((e) => e.actor.kind === "human")).toBe(true);
  expect(
    value(
      setProjectPreferences(
        apply(s, effect),
        human,
        { system_reminder_policy: policy },
        ports(),
      ),
    ).events,
  ).toEqual([]);
});

test("C-237 ready reminder survives restarts, obeys repeat interval/cap, and skips manual or fallback-notified items", () => {
  const io = ports();
  let s = base();
  s = apply(s, tick(s, 0, io));
  expect(tick(s, 1, io).events).toEqual([]);
  const first = tick(s, 2, io);
  expect(
    first.events.filter((e) => e.type === "system_wait_reminded"),
  ).toHaveLength(1);
  s = apply(s, first);
  expect(tick(s, 10, io).events).toEqual([]);
  s = {
    ...s,
    project_preferences: [
      {
        ...required(s.project_preferences?.[0]),
        system_reminder_policy: {
          ...policy,
          repeat: true,
          repeat_interval_minutes: 4,
        },
      },
    ],
  };
  expect(tick(s, 5, io).events).toEqual([]);
  const second = tick(s, 6, io);
  expect(second.events).toHaveLength(1);
  s = apply(s, second);
  expect(tick(s, 100, io).events).toEqual([]);
  s = apply(
    s,
    value(
      updateWorkItem(
        s,
        human,
        { work_item_id: id("work_item", 2), manual_assign: true },
        io,
      ),
    ),
  );
  const held = tick(s, 101, io);
  expect(held.events.map((e) => e.type)).toEqual(["system_wait_closed"]);
  s = base();
  s = { ...s, employees: [] };
  s = apply(s, auto(s, 2, io));
  s = apply(s, tick(s, 0, io));
  expect(tick(s, 100, io).events).toEqual([]);
});

test("C-237 pending checks only remind while awaiting merge; superseding versions reset the cycle", () => {
  let s = base();
  const io = ports();
  s = {
    ...s,
    cards: s.cards.map((c) => ({
      ...c,
      status: "awaiting_merge",
      pre_merge_checks: [
        {
          label: "人工核对",
          status: "pending",
          updated_by: "human",
          updated_at: now,
        },
      ],
    })),
    assignments: [...s.assignments, assignment(2, "reviewer")],
  };
  s = apply(s, tick(s, 0, io));
  expect(tick(s, 2, io).events).toEqual([]);
  const first = tick(s, 3, io);
  expect(first.events).toMatchObject([
    {
      type: "system_wait_reminded",
      payload: { body: expect.stringContaining("人工核对") },
    },
  ]);
  s = apply(s, first);
  s = {
    ...s,
    deliveries: [{ ...required(s.deliveries[0]), id: id("delivery", 2) }],
  };
  const reset = tick(s, 4, io);
  expect(reset.events.map((e) => e.type)).toEqual([
    "system_wait_closed",
    "system_wait_started",
  ]);
  s = apply(s, reset);
  expect(tick(s, 7, io).events[0]?.type).toBe("system_wait_reminded");
  s = {
    ...s,
    project_preferences: [
      { ...required(s.project_preferences?.[0]), system_reminders: false },
    ],
  };
  expect(
    tick(s, 100, io).events.every((e) => e.type === "system_wait_closed"),
  ).toBe(true);
});

test("C-237 enabling without numeric configuration stays silent and does not affect automatic assignment", () => {
  const s = {
    ...base(),
    project_preferences: [
      {
        id: human.project_id,
        auto_merge_after_minutes: null,
        system_reminders: true,
        system_auto_assign_verifiers: true,
      },
    ],
  };
  expect(tick(s, 100).events).toEqual([]);
  expect(auto(s).data?.employee_id).toBeDefined();
  const pm = fixture();
  expect(
    value(
      updateWorkItem(
        pm,
        actor(4, "pm"),
        { work_item_id: id("work_item", 2), manual_assign: true },
        ports(),
      ),
    ).data.manual_assign,
  ).toBe(true);
});

test("C-237 selection skips historical authors even when a second eligible employee is available", () => {
  const s = base();
  const next = {
    ...s,
    assignments: s.assignments.map((a) => ({
      ...a,
      employee_id: id("employee", 1),
      status: "released" as const,
    })),
  };
  expect(auto(next).data?.employee_id).toBe(id("employee", 2));
  const newer = {
    ...s,
    deliveries: [
      ...s.deliveries,
      {
        ...required(s.deliveries[0]),
        id: id("delivery", 2),
        requested_verifiers: [],
      },
    ],
  };
  expect(auto(newer).events).toEqual([]);
});

test("C-237 off/on between timer ticks starts a fresh wait and retains prior reminder history", () => {
  let minute = 0;
  const io = {
    ...ports(),
    clock: {
      now: () => new Date(Date.parse(now) + minute * 60_000).toISOString(),
    },
  };
  let s = base();
  s = apply(s, tick(s, 0, io));
  s = apply(s, tick(s, 2, io));
  minute = 5;
  s = apply(
    s,
    value(setProjectPreferences(s, human, { system_reminders: false }, io)),
  );
  s = apply(
    s,
    value(setProjectPreferences(s, human, { system_reminders: true }, io)),
  );
  const restarted = tick(s, 5, io);
  expect(restarted.events.map((e) => e.type)).toEqual([
    "system_wait_closed",
    "system_wait_started",
  ]);
  s = apply(s, restarted);
  expect(tick(s, 6, io).events).toEqual([]);
  expect(tick(s, 7, io).events.map((e) => e.type)).toEqual([
    "system_wait_reminded",
  ]);
  expect(
    s.events.filter((e) => e.type === "system_wait_reminded"),
  ).toHaveLength(1);
});

test("C-237 first scan honors persisted readiness time after enabling, not process uptime", () => {
  const io = ports();
  let s = base();
  s = apply(
    s,
    value(
      setProjectPreferences(
        { ...s, project_preferences: [] },
        human,
        { system_reminders: true, system_reminder_policy: policy },
        io,
      ),
    ),
  );
  const effect = tick(s, 3, io);
  expect(effect.events.map((e) => e.type)).toEqual([
    "system_wait_started",
    "system_wait_reminded",
  ]);
});

test("C-237 reserved pending checks notify their reviewer and manual holds suppress them", () => {
  let s = base();
  const io = ports();
  s = {
    ...s,
    cards: s.cards.map((c) => ({
      ...c,
      status: "awaiting_merge",
      pre_merge_checks: [
        {
          label: "独立复核",
          status: "pending",
          updated_by: "system",
          updated_at: now,
        },
      ],
    })),
    roles: [...s.roles, role("independent_reviewer")],
    work_items: s.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? {
            ...w,
            role_id: "independent_reviewer",
            assignment_id: id("assignment", 2),
          }
        : w,
    ),
    assignments: [...s.assignments, assignment(2, "independent_reviewer")],
  };
  s = apply(s, tick(s, 0, io));
  expect(tick(s, 3, io).events).toMatchObject([
    {
      type: "system_wait_reminded",
      payload: { assignment_id: id("assignment", 2) },
    },
  ]);
  s = apply(
    s,
    value(
      updateWorkItem(
        s,
        human,
        { work_item_id: id("work_item", 2), manual_assign: true },
        io,
      ),
    ),
  );
  expect(tick(s, 3, io).events.map((e) => e.type)).toEqual([
    "system_wait_closed",
  ]);
});

test("C-237 equivalent reminder objects in a different key order do not create audit noise", () => {
  const s = base();
  const reordered = Object.fromEntries(
    Object.entries(policy).reverse(),
  ) as unknown as SystemReminderPolicy;
  expect(
    value(
      setProjectPreferences(
        s,
        human,
        { system_reminder_policy: reordered },
        ports(),
      ),
    ).events,
  ).toEqual([]);
});
