import { expect, test } from "vitest";
import {
  applyAutoRiskTags,
  assign,
  type CommandState,
  createWorkItem,
  type DeliveryEvidence,
  type Employee,
  prepareDelivery,
  submitDelivery,
  updateCard,
  updateWorkItem,
  type WorkItem,
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
  run,
  value,
} from "./test-fixtures.js";

// C-790: a high-risk product gets its required independent review from the
// system instead of a PM request. Creation only; the review is unchanged.
const system = { kind: "system" as const, project_id: human.project_id };
const RISKY = ".github/workflows/ci.yml";

function evidence(paths: readonly string[], sha: string): DeliveryEvidence[] {
  const binding = { sha, base_sha: "b".repeat(40), tree_sha: "c".repeat(40) };
  return [
    {
      kind: "diff",
      details: {
        role_rule_inventory: {
          version: 1,
          complete: true,
          ...binding,
          changes: paths.map((path) => ({ path, status: "M" })),
        },
      },
    },
    { kind: "commit", details: binding },
  ];
}

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

function base(): CommandState {
  const s = fixture();
  return { ...s, roles: [...s.roles, role("independent_reviewer")] };
}

async function deliver(
  state: CommandState,
  paths: readonly string[] = [RISKY],
  { n = 1, sha = "a".repeat(40) } = {},
) {
  const io = ports();
  const producer = id("work_item", n);
  const input = {
    work_item_id: producer,
    kind: "code" as const,
    summary: "Ready",
    subject: { kind: "git_head" as const, value: sha },
    requested_verifiers: state.work_items
      .filter(
        (w) =>
          w.kind === "verify" &&
          w.target_work_item_id === producer &&
          w.required &&
          w.status !== "cancelled" &&
          !w.replaced_by_work_item_id,
      )
      .map((w) => w.id),
  };
  const proof = value(
    await prepareDelivery(state, actor(n), input, {
      verify: async () => ({ ok: true, value: evidence(paths, sha) }),
    }),
  );
  const effect = value(submitDelivery(state, actor(n), input, proof, io));
  return { state: apply(state, effect), effect, io };
}

const independent = (s: CommandState, target = id("work_item", 1)) =>
  s.work_items.filter(
    (w) =>
      w.kind === "verify" &&
      w.role_id === "independent_reviewer" &&
      w.target_work_item_id === target,
  );

function only(items: readonly WorkItem[]): WorkItem {
  expect(items).toHaveLength(1);
  return items[0] as WorkItem;
}

test("C-790: a high-risk product gets a required independent reviewer bound to the current delivery", async () => {
  const { state, effect } = await deliver(base());
  const item = only(independent(state));
  expect(item).toMatchObject({
    kind: "verify",
    role_id: "independent_reviewer",
    required: true,
    status: "ready",
    target_work_item_id: id("work_item", 1),
    card_id: id("card", 1),
    max_review_rounds: 3,
  });
  expect(effect.data.status).toBe("submitted");
  expect(
    state.deliveries.find((v) => v.id === effect.data.id)?.requested_verifiers,
  ).toContain(item.id);
  expect(
    effect.events.find((e) => e.type === "work_item_created"),
  ).toMatchObject({
    actor: system,
    payload: {
      work_item_id: item.id,
      target_work_item_id: id("work_item", 1),
      delivery_id: effect.data.id,
    },
  });
  // Nothing is left for PM: no request event and no request flag.
  expect(
    effect.events.some((e) => e.type === "high_risk_review_required"),
  ).toBe(false);
  expect(
    effect.events.find((e) => e.type === "auto_risk_tags_applied")?.payload,
  ).toMatchObject({ needs_independent_reviewer: false });
  expect(
    effect.timeline.some((e) => e.body.includes(`必需独立复核项 ${item.id}`)),
  ).toBe(true);
});

test("C-790: a human high-risk mark triggers it without a matching path; ordinary products do not", async () => {
  expect(
    independent((await deliver(base(), ["docs/readme.md"])).state),
  ).toEqual([]);
  const marked = {
    ...base(),
    cards: base().cards.map((c) =>
      c.id === id("card", 1) ? { ...c, high_risk: true } : c,
    ),
  };
  const { state, effect } = await deliver(marked, ["docs/readme.md"]);
  only(independent(state));
  expect(effect.events.some((e) => e.type === "auto_risk_tags_applied")).toBe(
    false,
  );
});

test("C-790: the same product set is covered once — replays and redeliveries add nothing", async () => {
  const first = await deliver(base());
  const created = only(independent(first.state));
  expect(
    value(
      applyAutoRiskTags(
        first.state,
        system,
        { delivery_id: first.effect.data.id },
        first.io,
      ),
    ).events,
  ).toEqual([]);
  const again = await deliver(first.state, [RISKY], { sha: "d".repeat(40) });
  expect(only(independent(again.state)).id).toBe(created.id);
  expect(again.effect.data.requested_verifiers).toContain(created.id);
  expect(
    again.effect.events.some(
      (e) =>
        e.type === "work_item_created" ||
        e.type === "high_risk_review_required",
    ),
  ).toBe(false);
});

test("C-790: without an active independent_reviewer role the PM request remains", async () => {
  const { state, effect } = await deliver(fixture());
  expect(independent(state)).toEqual([]);
  expect(
    effect.events.find((e) => e.type === "auto_risk_tags_applied")?.payload,
  ).toMatchObject({ needs_independent_reviewer: true });
});

test("C-790 anti-bypass: the system item cannot be made optional by PM or human", async () => {
  const { state, io } = await deliver(base());
  const item = only(independent(state));
  for (const caller of [human, actor(4, "pm")])
    expect(
      updateWorkItem(
        state,
        caller,
        { work_item_id: item.id, required: false },
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
});

test("C-790 anti-bypass: removing the security tag keeps the requirement and a later delivery adds no gap", async () => {
  const { state, io } = await deliver(base());
  const item = only(independent(state));
  const untagged = apply(
    state,
    value(
      updateCard(
        state,
        actor(4, "pm"),
        { card_id: id("card", 1), risk_tags: [] },
        io,
      ),
    ),
  );
  expect(untagged.work_items.find((w) => w.id === item.id)?.required).toBe(
    true,
  );
  const again = await deliver(untagged, [RISKY], { sha: "d".repeat(40) });
  expect(again.effect.data.requested_verifiers).toContain(item.id);
});

test("C-790: an existing PM-made required reviewer is recognised and nothing is added", async () => {
  const s = base();
  const io = ports();
  const created = value(
    createWorkItem(
      s,
      actor(4, "pm"),
      {
        card_id: id("card", 1),
        title: "独立复核",
        kind: "verify",
        role_id: "independent_reviewer",
        required: true,
        completion_criteria: ["passes"],
        target_work_item_id: id("work_item", 1),
      },
      io,
    ),
  );
  const { state, effect } = await deliver(apply(s, created));
  expect(only(independent(state)).id).toBe(created.data.id);
  expect(effect.data.requested_verifiers).toContain(created.data.id);
  expect(
    effect.events.some(
      (e) =>
        e.type === "work_item_created" ||
        e.type === "high_risk_review_required",
    ),
  ).toBe(false);
});

test("C-790 anti-bypass: a PM-made reviewer turned optional no longer covers; the next delivery restores a required one", async () => {
  let s = base();
  const io = ports();
  const created = value(
    createWorkItem(
      s,
      actor(4, "pm"),
      {
        card_id: id("card", 1),
        title: "独立复核",
        kind: "verify",
        role_id: "independent_reviewer",
        required: true,
        completion_criteria: ["passes"],
        target_work_item_id: id("work_item", 1),
      },
      io,
    ),
  );
  s = apply(s, created);
  s = apply(
    s,
    value(
      updateWorkItem(
        s,
        actor(4, "pm"),
        { work_item_id: created.data.id, required: false },
        io,
      ),
    ),
  );
  const { state } = await deliver(s);
  expect(independent(state)).toHaveLength(2);
  const required = independent(state).filter((w) => w.required);
  expect(only(required).id).not.toBe(created.data.id);
});

test("C-790 anti-bypass: splitting the work onto another card still requires its own reviewer", async () => {
  const first = await deliver(base());
  only(independent(first.state));
  // A split card's producer: W-6 on C-2, owned by A-6.
  const split: CommandState = {
    ...first.state,
    work_items: [
      ...first.state.work_items,
      {
        ...(first.state.work_items.find(
          (w) => w.id === id("work_item", 1),
        ) as WorkItem),
        id: id("work_item", 6),
        card_id: id("card", 2),
        assignment_id: id("assignment", 6),
        status: "in_progress",
      } as WorkItem,
    ],
    assignments: [...first.state.assignments, assignment(6)],
    runs: [...first.state.runs, run(6)],
  };
  const { state } = await deliver(split, [RISKY], { n: 6 });
  expect(only(independent(state, id("work_item", 6))).card_id).toBe(
    id("card", 2),
  );
});

test("C-790 anti-bypass: the author of the reviewed delivery cannot be the independent reviewer", async () => {
  const s = base();
  const withAuthor: CommandState = {
    ...s,
    employees: [
      employee(1, "independent_reviewer"),
      employee(2, "independent_reviewer"),
    ],
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, employee_id: id("employee", 1) }
        : a,
    ),
  };
  const { state, io } = await deliver(withAuthor);
  const item = only(independent(state));
  expect(
    assign(
      state,
      human,
      {
        work_item_id: item.id,
        role_id: "independent_reviewer",
        employee_id: "E-1",
      },
      io,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: "invariant_violation",
      message: "独立复核员工不能是本次交付的作者",
    },
  });
  expect(
    value(
      assign(
        state,
        human,
        {
          work_item_id: item.id,
          role_id: "independent_reviewer",
          employee_id: "E-2",
        },
        io,
      ),
    ).data.employee_id,
  ).toBe("E-2");
});

test("C-790: with automatic verifier assignment the system picks a non-author", async () => {
  const s = base();
  const auto: CommandState = {
    ...s,
    cards: s.cards.map((c) => ({ ...c, flow_version: 5 })),
    employees: [
      employee(1, "independent_reviewer"),
      employee(2, "independent_reviewer"),
    ],
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, employee_id: id("employee", 1) }
        : a,
    ),
  };
  const { state } = await deliver(auto);
  const item = only(independent(state));
  const owner = state.assignments.find((a) => a.id === item.assignment_id);
  expect(owner?.employee_id).toBe("E-2");
});
