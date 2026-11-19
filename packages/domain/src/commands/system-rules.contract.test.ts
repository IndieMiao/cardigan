import { expect, test } from "vitest";
import {
  assign,
  autoAssignVerifier,
  builtinCardTemplates,
  type CommandPorts,
  type CommandState,
  type Delivery,
  type Employee,
  prepareDelivery,
  remindSystemWaits,
  type SubmitDeliveryParams,
  type SystemReminderPolicy,
  setProjectPreferences,
  submitDelivery,
  updateCard,
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
  placement,
  ports,
  role,
  run,
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

test("C-300 automatic assignment uses assignment load, audit, token issuance and persistent ownership", () => {
  let s = base();
  s = {
    ...s,
    employee_activity: [
      {
        employee_id: id("employee", 1),
        unfinished_runs: 0,
        active_assignments: 3,
        last_assigned_at: now,
      },
      {
        employee_id: id("employee", 2),
        unfinished_runs: 2,
        active_assignments: 1,
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
    { type: "machine_selected", actor: system },
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

test.each(
  [1, 5].flatMap((flow_version) =>
    [
      "current_author",
      "released_author",
      "other_verifier",
      "released_verifier",
      "reverse_independent",
      "inactive",
      "external",
      "no_employees",
      "inactive_role",
    ].map((scenario) => ({ flow_version, scenario })),
  ),
)(
  "C1 flow $flow_version isolation and eligibility: $scenario falls back once without creating anonymous assignments",
  ({ flow_version, scenario }) => {
    let s = base();
    s = {
      ...s,
      cards: s.cards.map((c) => ({ ...c, flow_version })),
      project_preferences: [
        {
          ...required(s.project_preferences?.[0]),
          system_auto_assign_verifiers: flow_version < 5,
        },
      ],
    };
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
    if (
      ["other_verifier", "released_verifier", "reverse_independent"].includes(
        scenario,
      )
    ) {
      expect(effect.data?.employee_id).toBe(id("employee", 1));
      return;
    }
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
    expect(effect.token_requests).toHaveLength(enabled ? 0 : 1);
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

function beforeDelivery(): CommandState {
  const s = base();
  return {
    ...s,
    deliveries: [],
    runs: [run()],
    work_items: s.work_items.map((w) =>
      w.kind === "produce"
        ? { ...w, assignment_id: id("assignment", 1) }
        : { ...w, status: "todo" },
    ),
  };
}
async function deliverReady(
  s: CommandState,
  io: CommandPorts,
  patch: Partial<SubmitDeliveryParams> = {},
) {
  const params: SubmitDeliveryParams = {
    work_item_id: id("work_item", 1),
    kind: "code",
    summary: "Ready",
    subject,
    requested_verifiers: s.work_items
      .filter(
        (w) =>
          w.kind === "verify" && w.target_work_item_id === id("work_item", 1),
      )
      .map((w) => w.id),
    ...patch,
  };
  const prepared = value(
    await prepareDelivery(s, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return value(submitDelivery(s, actor(), params, prepared, io));
}

test.each([
  "unregistered",
  "missing_tags",
  "offline",
  "draining",
  "unauthorized_remote",
])(
  "C-300 ready transaction preserves baseline machine admission when %s",
  async (scenario) => {
    const initial = beforeDelivery();
    const local = required(initial.machines?.[0]);
    const s: CommandState = {
      ...initial,
      machines:
        scenario === "unregistered"
          ? []
          : scenario === "unauthorized_remote"
            ? [{ ...local, id: "worker-a", herdr_machine: "worker-a" }]
            : [
                {
                  ...local,
                  status:
                    scenario === "offline" || scenario === "draining"
                      ? scenario
                      : local.status,
                },
              ],
      roles: initial.roles.map((r) =>
        r.role_id === "reviewer" && scenario === "missing_tags"
          ? { ...r, required_machine_tags: ["gpu"] }
          : r,
      ),
    };
    const effect = await deliverReady(s, ports());
    const next = apply(s, effect);
    const reason =
      scenario === "unregistered"
        ? "没有登记"
        : scenario === "missing_tags"
          ? "tag=gpu"
          : scenario === "unauthorized_remote"
            ? "allow_remote_launch"
            : scenario;
    expect(effect.token_requests).toEqual([]);
    expect(next.assignments).toEqual(s.assignments);
    expect(
      next.work_items.find((w) => w.id === id("work_item", 2)),
    ).toMatchObject({ status: "ready" });
    expect(effect.events).toMatchObject([
      { type: "delivery_submitted" },
      {
        type: "system_assignment_deferred",
        actor: system,
        payload: {
          reason: expect.stringContaining(reason),
          candidates: [1, 2].map((n) => ({
            employee_id: id("employee", n),
            reason: expect.stringContaining(reason),
          })),
        },
      },
    ]);
    expect(auto(next).events).toEqual([]);
  },
);

test("C-300 ready assignment pins the unique tagged machine and audits it without starting a Run", async () => {
  const initial = beforeDelivery();
  const local = required(initial.machines?.[0]);
  const s: CommandState = {
    ...initial,
    read_machine_placement: () =>
      placement([
        [
          "worker-a",
          {
            remote_binding: "allowed",
            health: { status: "passed", available: true },
            capabilities: [
              { key: "harness.codex", version: "1.2.3", available: true },
            ],
            limit: 4,
            occupied: 0,
          },
        ],
      ]),
    machines: [
      local,
      { ...local, id: "worker-a", herdr_machine: "worker-a", tags: ["gpu"] },
    ],
    roles: initial.roles.map((r) =>
      r.role_id === "reviewer"
        ? { ...r, worktree: "none", required_machine_tags: ["gpu"] }
        : r,
    ),
  };
  const effect = await deliverReady(s, ports());
  const next = apply(s, effect);
  const assigned = required(
    next.assignments.find((a) => a.role_id === "reviewer"),
  );
  expect(assigned.machine_id).toBe("worker-a");
  expect(
    effect.events.find((e) => e.type === "work_item_assigned"),
  ).toMatchObject({
    actor: system,
    payload: {
      assigned_by: "system",
      machine_id: "worker-a",
      selection: { active_assignments: 0 },
    },
  });
  expect(next.runs).toEqual(s.runs);
  expect(
    value(
      assign(
        { ...next, machines: [] },
        human,
        { work_item_id: id("work_item", 2), role_id: "reviewer" },
        ports(),
      ),
    ).data.id,
  ).toBe(assigned.id);
  expect(
    assign(
      next,
      human,
      {
        work_item_id: id("work_item", 2),
        role_id: "reviewer",
        machine_id: "local",
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
});

test("C-300 delivery and ready assignment share one effect, preserving actor, review target and token scope", async () => {
  const s = beforeDelivery();
  const effect = await deliverReady(s, ports());
  const next = apply(s, effect);
  expect(effect.events.map((e) => e.type)).toEqual([
    "delivery_submitted",
    "work_item_assigned",
    "machine_selected",
  ]);
  expect(effect.events[0]?.actor).toEqual(actor());
  expect(effect.events[1]).toMatchObject({
    actor: system,
    payload: {
      assigned_by: "system",
      delivery_id: effect.data.id,
      selection_order: [
        "active_assignments_ascending",
        "employee_number_ascending",
      ],
      selection: { active_assignments: 0, employee_number: 1 },
    },
  });
  expect(
    next.work_items.find((w) => w.id === id("work_item", 2)),
  ).toMatchObject({
    status: "ready",
    assignment_id: effect.token_requests[0]?.assignment_id,
  });
  expect(effect.token_requests).toHaveLength(1);
  expect(effect.token_requests[0]?.allowed_tools).toEqual(
    role("reviewer").allowed_tools,
  );
  expect(next.assignments).toHaveLength(2);
  expect(next.runs).toEqual(s.runs); // Scheduling and capacity admission remain separate.
  expect(
    next.work_items.find((w) => w.role_id === "pm")?.assignment_id,
  ).toBeUndefined();
});

test.each(["missing", "off", "manual"])(
  "C-300 ready transaction honors %s automation gate",
  async (gate) => {
    let s = beforeDelivery();
    if (gate === "missing") s = { ...s, project_preferences: [] };
    if (gate === "off")
      s = {
        ...s,
        project_preferences: [
          {
            ...required(s.project_preferences?.[0]),
            system_auto_assign_verifiers: false,
          },
        ],
      };
    if (gate === "manual")
      s = {
        ...s,
        work_items: s.work_items.map((w) =>
          w.kind === "verify" ? { ...w, manual_assign: true } : w,
        ),
      };
    const effect = await deliverReady(s, ports());
    expect(effect.events.map((e) => e.type)).toEqual(["delivery_submitted"]);
    expect(effect.token_requests).toEqual([]);
  },
);

test("C-300 multiple ready verifiers see earlier assignments in the same transaction and stable numeric order", async () => {
  let s = beforeDelivery();
  s = {
    ...s,
    employees: [employee(2), employee(1)],
    employee_activity: [1, 2].map((n) => ({
      employee_id: id("employee", n),
      active_assignments: 0,
      unfinished_runs: 0,
      last_assigned_at: null,
    })),
    work_items: [
      { ...required(s.work_items[1]), id: id("work_item", 10) },
      ...s.work_items,
    ].reverse(),
  };
  const effect = await deliverReady(s, ports());
  const assignments = apply(s, effect).assignments.filter(
    (a) => a.role_id === "reviewer",
  );
  expect(assignments).toMatchObject([
    { work_item_id: id("work_item", 2), employee_id: id("employee", 1) },
    { work_item_id: id("work_item", 10), employee_id: id("employee", 2) },
  ]);
});

test("C-300 redelivery reuses the persistent reviewer identity and refreshes its target", async () => {
  const io = ports();
  let s = beforeDelivery();
  const first = await deliverReady(s, io);
  s = apply(s, first);
  const assigned = s.work_items.find(
    (w) => w.id === id("work_item", 2),
  )?.assignment_id;
  s = {
    ...s,
    work_items: s.work_items.map((w) =>
      w.kind === "verify" && w.id === id("work_item", 2)
        ? { ...w, status: "failed" }
        : w,
    ),
  };
  const second = await deliverReady(s, io);
  const next = apply(s, second);
  expect(
    next.work_items.find((w) => w.id === id("work_item", 2)),
  ).toMatchObject({ assignment_id: assigned, status: "ready" });
  expect(next.deliveries.find((v) => v.id === first.data.id)?.status).toBe(
    "superseded",
  );
  expect(second.token_requests).toEqual([]);
  expect(next.assignments).toEqual(s.assignments);
});

test("C-300 failure reports every same-role candidate with shared validator reasons and deduplicates scans", async () => {
  let s = beforeDelivery();
  s = {
    ...s,
    employees: [employee(1), { ...employee(2), status: "inactive" }],
    assignments: [{ ...assignment(), employee_id: id("employee", 1) }],
  };
  const effect = await deliverReady(s, ports());
  const deferred = effect.events.find(
    (e) => e.type === "system_assignment_deferred",
  );
  expect(deferred).toMatchObject({
    actor: system,
    payload: {
      candidates: [
        {
          employee_id: id("employee", 1),
          reason: expect.stringContaining("当前或曾经的作者"),
        },
        {
          employee_id: id("employee", 2),
          reason: expect.stringContaining("已停用"),
        },
      ],
    },
  });
  expect(effect.token_requests).toEqual([]);
  const next = apply(s, effect);
  expect(auto(next).events).toEqual([]);
  const recovered = auto({
    ...next,
    employees: [...required(next.employees), employee(3)],
  });
  expect(recovered.data?.employee_id).toBe(id("employee", 3));
});

test("C-300 PM becomes assigned only for a completion request, and new product withdraws that target without rebinding", async () => {
  const io = ports();
  let s = beforeDelivery();
  s = { ...s, employees: [...required(s.employees), employee(3, "pm")] };
  const product = await deliverReady(s, io);
  s = apply(s, product);
  expect(
    s.work_items.find((w) => w.role_id === "pm")?.assignment_id,
  ).toBeUndefined();
  s = {
    ...s,
    work_items: s.work_items.map((w) =>
      w.kind === "produce"
        ? { ...w, status: "accepted" }
        : w.role_id === "reviewer"
          ? { ...w, status: "passed" }
          : w,
    ),
    deliveries: s.deliveries.map((v) => ({ ...v, status: "accepted" })),
  };
  const completion = await deliverReady(s, io, {
    kind: "card_completion",
    requested_verifiers: [id("work_item", 3)],
    plain_summary: { changed: "测试改动", impact: "验证完成验收", risk: "无" },
  });
  s = apply(s, completion);
  const acceptance = required(s.work_items.find((w) => w.role_id === "pm"));
  expect(acceptance).toMatchObject({
    status: "ready",
    assignment_id: completion.token_requests[0]?.assignment_id,
  });
  expect(
    completion.events.find((e) => e.type === "work_item_assigned"),
  ).toMatchObject({
    payload: {
      delivery_id: completion.data.id,
      employee_id: id("employee", 3),
    },
  });
  const nextProduct = await deliverReady(s, io);
  const next = apply(s, nextProduct);
  expect(next.work_items.find((w) => w.role_id === "pm")).toMatchObject({
    status: "todo",
    assignment_id: acceptance.assignment_id,
  });
  expect(nextProduct.token_requests).toEqual([]);
});

test.each(
  [1, 4, 5].flatMap((flow_version) =>
    [undefined, false, true].map((enabled) => ({ flow_version, enabled })),
  ),
)(
  "C1 flow $flow_version with switch $enabled applies the same rule at readiness and recovery",
  async ({ flow_version, enabled }) => {
    const configure = (s: CommandState): CommandState => ({
      ...s,
      cards: s.cards.map((c) => ({ ...c, flow_version })),
      project_preferences: [
        {
          id: s.project_id,
          auto_merge_after_minutes: null,
          ...(enabled === undefined
            ? {}
            : { system_auto_assign_verifiers: enabled }),
        },
      ],
    });
    const expected = flow_version >= 5 || enabled === true;
    const recovery = auto(configure(base()));
    expect(recovery.token_requests).toHaveLength(expected ? 1 : 0);
    const before = configure(beforeDelivery());
    const effect = await deliverReady(before, ports());
    expect(effect.token_requests).toHaveLength(expected ? 1 : 0);
    expect(auto(apply(before, effect)).events).toEqual([]);
  },
);

test.each([
  "manual",
  "blocked",
  "waiting_decision",
  "historical",
  "unrequested",
  "stale",
  "no_target",
])(
  "C1 future scheduling preserves the %s hold with the legacy switch off",
  (hold) => {
    const initial = base();
    const s: CommandState = {
      ...initial,
      cards: initial.cards.map((c) => ({ ...c, flow_version: 5 })),
      project_preferences: [],
      work_items: initial.work_items.map((w) =>
        w.kind !== "verify"
          ? w
          : {
              ...w,
              ...(hold === "manual" ? { manual_assign: true } : {}),
              ...(hold === "blocked" || hold === "waiting_decision"
                ? { status: hold }
                : {}),
            },
      ),
      assignments:
        hold === "historical"
          ? [
              ...initial.assignments,
              { ...assignment(2, "reviewer"), status: "released" },
            ]
          : initial.assignments,
      deliveries:
        hold === "no_target"
          ? []
          : initial.deliveries.map((v) => ({
              ...v,
              ...(hold === "unrequested" ? { requested_verifiers: [] } : {}),
              ...(hold === "stale" ? { status: "superseded" as const } : {}),
            })),
    };
    expect(auto(s).events).toEqual([]);
    expect(auto(s).token_requests).toEqual([]);
  },
);

test("card hold suppresses verifier assignment and reminders; release rechecks manual assignment", () => {
  const io = ports();
  const state = base();
  const held = apply(
    state,
    value(
      updateCard(
        state,
        human,
        {
          card_id: id("card", 1),
          hold: { reason: "wait", resume_condition: "ready" },
        },
        io,
      ),
    ),
  );
  expect(auto(held).data).toBeNull();
  expect(
    tick(held, 100).events.some((e) => e.type === "system_wait_reminded"),
  ).toBe(false);
  const manual = {
    ...held,
    work_items: held.work_items.map((w) => ({ ...w, manual_assign: true })),
  };
  const release = value(
    updateCard(manual, human, { card_id: id("card", 1), hold: null }, io),
  );
  expect(release.events.some((e) => e.type === "work_item_assigned")).toBe(
    false,
  );
  expect(auto(apply(manual, release)).data).toBeNull();
  const resumed = value(
    updateCard(held, human, { card_id: id("card", 1), hold: null }, io),
  );
  expect(auto(apply(held, resumed)).data).not.toBeNull();
});
