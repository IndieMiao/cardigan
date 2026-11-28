import { expect, test } from "vitest";
import type { Event, WorkItem } from "../entities.js";
import { WaitGraph, waitChain, waitCycles } from "../work-wait-graph.js";
import type { CommandEffect, CommandState } from "./core.js";
import { createWorkItem, updateWorkItem } from "./pm.js";
import { validateCardTemplate } from "./templates.js";
import {
  actor,
  apply as applyEffect,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";
import {
  DEFAULT_WORK_DEPENDENCY_STALL_MS,
  refreshWorkWaits,
  WORK_DEPENDENCY_STALLED,
  WORK_WAIT_CYCLE_CLEARED,
  WORK_WAIT_CYCLE_DETECTED,
} from "./work-wait-cycles.js";

const system = { kind: "system" as const, project_id: human.project_id };
const card = id("card", 1);
const w = (n: number) => id("work_item", n);
const common = {
  card_id: card,
  completion_criteria: ["passes"],
  depends_on: [] as WorkItem["depends_on"],
  required: true,
};
const produce = (n: number, extra: Partial<WorkItem> = {}): WorkItem =>
  ({
    ...common,
    id: w(n),
    title: `Produce ${n}`,
    kind: "produce",
    role_id: "coder",
    status: "todo",
    ...extra,
  }) as WorkItem;
const verify = (
  n: number,
  target: number,
  extra: Partial<WorkItem> = {},
): WorkItem =>
  ({
    ...common,
    id: w(n),
    title: `Verify ${n}`,
    kind: "verify",
    role_id: "reviewer",
    status: "todo",
    target_work_item_id: w(target),
    max_review_rounds: 3,
    ...extra,
  }) as WorkItem;

/** SEN-C-190 shape: 1 dev (delivered), 2 its required smoke test needing 3's output, 3 signing after 1. */
function deadlock(): WorkItem[] {
  return [
    produce(1, { status: "delivered", template_key: "development" }),
    verify(2, 1, { depends_on: [w(3)] }),
    produce(3, { depends_on: [w(1)], assignment_id: id("assignment", 3) }),
  ];
}
function state(items: readonly WorkItem[]): CommandState {
  const base = fixture();
  return {
    ...base,
    roles: [role("coder"), role("reviewer"), role("pm")],
    work_items: [...items],
    assignments: [
      ...base.assignments.filter((a) => a.scope === "standing"),
      {
        ...assignment(3),
        runtime_state: "not_provisioned",
        runtime_ref: null,
        created_at: "2025-12-31T20:00:00.000Z",
      },
    ],
    runs: [],
  };
}
const applyAll = (s: CommandState, effect: CommandEffect<unknown>) =>
  applyEffect(s, effect);
function apply(s: CommandState, effect: { events: readonly Event[] }) {
  return { ...s, events: [...s.events, ...effect.events] };
}

test("graph: a direct dependency cycle is found; completed or cancelled items break it", () => {
  const direct = [
    produce(1, { depends_on: [w(2)] }),
    produce(2, { depends_on: [w(1)] }),
  ];
  expect(waitCycles(direct).map((c) => c.work_items)).toEqual([[w(1), w(2)]]);
  for (const status of ["accepted", "cancelled"] as const)
    expect(
      waitCycles([produce(1, { depends_on: [w(2)] }), produce(2, { status })]),
    ).toEqual([]);
  // A verifier waits for its target's delivery, not its acceptance: no cycle.
  expect(waitCycles([produce(1), verify(2, 1)])).toEqual([]);
});

test("graph: a cycle through a verification target names every wait", () => {
  const found = waitCycles(deadlock());
  expect(found.map((c) => c.work_items)).toEqual([[w(1), w(2), w(3)]]);
  const graph = new WaitGraph(deadlock());
  const chain = waitChain(graph, { item: w(3), stage: "delivery" });
  expect(chain.cyclic).toBe(true);
  expect(chain.steps).toEqual([
    `${w(3)} 等 ${w(1)} accepted`,
    `${w(1)} 等必需验证项 ${w(2)} passed`,
    `${w(2)} 等 ${w(3)} 产出（回到 ${w(3)}，成环）`,
  ]);
  // Optional verifiers do not hold acceptance, so the cycle disappears.
  const optional = deadlock().map((x) =>
    x.id === w(2) ? { ...x, required: false } : x,
  );
  expect(waitCycles(optional)).toEqual([]);
});

test("create_work_item refuses a verifier that closes the cycle and names the items", () => {
  const s = state(deadlock().filter((x) => x.id !== w(2)));
  const refused = createWorkItem(
    s,
    human,
    {
      card_id: card,
      title: "Tablet smoke",
      kind: "verify",
      role_id: "reviewer",
      required: true,
      completion_criteria: ["passes"],
      target_work_item_id: w(1),
      depends_on: [w(3)],
    },
    ports(),
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.code).toBe("validation_failed");
  expect(refused.error.message).toContain("成环");
  for (const item of [w(1), w(3)])
    expect(refused.error.message).toContain(item);
  expect(refused.error.message).toMatch(/W-\d+ 等 W-\d+ 产出/u);
  // The same verifier as optional, or without the dependency, is accepted.
  for (const p of [
    { required: false, depends_on: [w(3)] },
    { required: true, depends_on: [] },
  ])
    expect(
      createWorkItem(
        s,
        human,
        {
          card_id: card,
          title: "Tablet smoke",
          kind: "verify",
          role_id: "reviewer",
          completion_criteria: ["passes"],
          target_work_item_id: w(1),
          ...p,
        },
        ports(),
      ).ok,
    ).toBe(true);
});

test("update_work_item: making the verifier required closes the cycle and is refused; making it optional opens it", () => {
  const optional = deadlock().map((x) =>
    x.id === w(2) ? { ...x, required: false } : x,
  );
  const refused = updateWorkItem(
    state(optional),
    human,
    { work_item_id: w(2), required: true },
    ports(),
  );
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.message).toContain(w(2));
    expect(refused.error.details).toMatchObject({
      work_items: expect.arrayContaining([w(1), w(2), w(3)]),
    });
  }
  const opened = updateWorkItem(
    state(deadlock()),
    human,
    { work_item_id: w(2), required: false },
    ports(),
  );
  expect(opened.ok).toBe(true);
  // Unrelated edits on a card with an older cycle are not blocked.
  expect(
    updateWorkItem(
      state(deadlock()),
      human,
      { work_item_id: w(3), title: "Signing" },
      ports(),
    ).ok,
  ).toBe(true);
});

test("patrol reports an existing cycle to PM Ops once, clears it, and reports again only if it returns", () => {
  let s = state(deadlock());
  const first = value(refreshWorkWaits(s, system, ports()));
  const detected = first.events.filter(
    (e) => e.type === WORK_WAIT_CYCLE_DETECTED,
  );
  expect(detected).toHaveLength(1);
  const notice = String(
    (detected[0]?.payload as Record<string, unknown> | undefined)?.notice,
  );
  for (const item of [w(1), w(2), w(3)]) expect(notice).toContain(item);
  expect(notice).toContain("建议");
  expect(notice).toContain(`把 ${w(2)} 改为非必需`);
  expect(notice).toContain(`去掉 ${w(2)} 的依赖 ${w(3)}`);
  s = apply(s, first);
  expect(
    value(refreshWorkWaits(s, system, ports())).events.filter(
      (e) => e.type === WORK_WAIT_CYCLE_DETECTED,
    ),
  ).toEqual([]);
  const fixed = {
    ...s,
    work_items: s.work_items.map((x) =>
      x.id === w(2) ? { ...x, required: false } : x,
    ),
  };
  const cleared = value(refreshWorkWaits(fixed, system, ports()));
  expect(cleared.events.map((e) => e.type)).toEqual([WORK_WAIT_CYCLE_CLEARED]);
  s = apply(s, cleared);
  expect(
    value(refreshWorkWaits(s, system, ports())).events.filter(
      (e) => e.type === WORK_WAIT_CYCLE_DETECTED,
    ),
  ).toHaveLength(1);
});

test("patrol tells PM Ops the wait chain of a long-unstarted assignment, once", () => {
  const items = [
    produce(1, { status: "in_progress", assignment_id: id("assignment", 1) }),
    produce(3, { depends_on: [w(1)], assignment_id: id("assignment", 3) }),
  ];
  const early = state(items);
  const recent = {
    ...early,
    assignments: early.assignments.map((a) =>
      a.id === id("assignment", 3) ? { ...a, created_at: now } : a,
    ),
  };
  expect(value(refreshWorkWaits(recent, system, ports())).events).toEqual([]);
  const effect = value(refreshWorkWaits(early, system, ports()));
  const stalled = effect.events.filter(
    (e) => e.type === WORK_DEPENDENCY_STALLED,
  );
  expect(stalled).toHaveLength(1);
  const p = stalled[0]?.payload as Record<string, unknown>;
  expect(p.assignment_id).toBe(id("assignment", 3));
  expect(p.chain).toEqual([
    `${w(3)} 等 ${w(1)} accepted`,
    `${w(1)} 当前 in_progress，指派 ${id("assignment", 1)}`,
  ]);
  expect(String(p.notice)).toContain("not_provisioned");
  expect(
    value(refreshWorkWaits(apply(early, effect), system, ports())).events,
  ).toEqual([]);
  // A queued Run means someone is already starting it.
  expect(
    value(
      refreshWorkWaits(
        {
          ...early,
          runs: [
            {
              ...fixture().runs[0],
              assignment_id: id("assignment", 3),
              status: "queued",
            } as CommandState["runs"][number],
          ],
        },
        system,
        ports(),
      ),
    ).events,
  ).toEqual([]);
});

test("patrol chain for the SEN-C-190 deadlock shows the cycle", () => {
  const effect = value(refreshWorkWaits(state(deadlock()), system, ports()));
  const stalled = effect.events.find((e) => e.type === WORK_DEPENDENCY_STALLED);
  const p = stalled?.payload as Record<string, unknown>;
  expect(p.cyclic).toBe(true);
  expect(p.chain).toEqual([
    `${w(3)} 等 ${w(1)} accepted`,
    `${w(1)} 等必需验证项 ${w(2)} passed`,
    `${w(2)} 等 ${w(3)} 产出（回到 ${w(3)}，成环）`,
  ]);
  expect(DEFAULT_WORK_DEPENDENCY_STALL_MS).toBe(2 * 60 * 60_000);
});

test("a template whose required verifier depends on a later producer is refused", () => {
  const roles = [role("coder"), role("reviewer"), role("pm")];
  const definition = {
    id: "cyclic",
    title: "Cyclic",
    description: "",
    requires_repo: false,
    merge: "none" as const,
    require_acceptance_criteria: false,
    primary_work_item_key: "build",
    completion: { mode: "human_mark_done" as const },
    work_items: [
      {
        key: "build",
        title: "Build",
        kind: "produce" as const,
        role_id: "coder",
        required: true,
      },
      {
        key: "sign",
        title: "Sign",
        kind: "produce" as const,
        role_id: "coder",
        required: true,
        depends_on: ["build"],
      },
      {
        key: "smoke",
        title: "Smoke",
        kind: "verify" as const,
        role_id: "reviewer",
        required: true,
        target_work_item_key: "build",
        depends_on: ["sign"],
      },
    ],
  };
  const rejection = (run: () => void) => {
    try {
      run();
    } catch (e) {
      return (e as { error: { message: string } }).error.message;
    }
    return undefined;
  };
  expect(rejection(() => validateCardTemplate(definition, roles))).toMatch(
    /成环.*smoke 等 sign 产出/u,
  );
  expect(
    rejection(() =>
      validateCardTemplate(
        {
          ...definition,
          work_items: definition.work_items.map((x) =>
            x.key === "smoke" ? { ...x, required: false } : x,
          ),
        },
        roles,
      ),
    ),
  ).toBeUndefined();
});

function withStanding(s: CommandState, mode: "ops" | "office"): CommandState {
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: mode } : a,
    ),
  };
}

test("update_work_item depends_on: PM Ops clears the dependency to break the cycle and the change is recorded", () => {
  const ops = withStanding(state(deadlock()), "ops");
  const pmOps = actor(4, "pm");
  const effect = value(
    updateWorkItem(ops, pmOps, { work_item_id: w(2), depends_on: [] }, ports()),
  );
  const updated = effect.events.find((e) => e.type === "work_item_updated");
  expect(updated?.payload).toMatchObject({
    work_item_id: w(2),
    depends_on: [],
    previous_depends_on: [w(3)],
  });
  expect(effect.timeline.at(-1)?.body).toContain(`依赖：${w(3)} → 无`);
  const after = applyAll(ops, effect);
  expect(waitCycles(after.work_items)).toEqual([]);
  // Adding it back closes the cycle again and is refused with the items named.
  const refused = updateWorkItem(
    after,
    pmOps,
    { work_item_id: w(2), depends_on: [w(3), w(3)] },
    ports(),
  );
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.message).toContain("成环");
    for (const item of [w(1), w(2), w(3)])
      expect(refused.error.message).toContain(item);
  }
  // A changed dependency closes a cycle too: 1 waiting for 3 while 3 waits for 1.
  expect(
    updateWorkItem(
      state([produce(1), produce(3, { depends_on: [w(1)] })]),
      human,
      { work_item_id: w(1), depends_on: [w(3)] },
      ports(),
    ).ok,
  ).toBe(false);
  // The human may replace dependencies; self, other-card or unknown items are refused.
  expect(
    updateWorkItem(
      state(deadlock()),
      human,
      { work_item_id: w(3), depends_on: [] },
      ports(),
    ).ok,
  ).toBe(true);
  for (const depends_on of [[w(3)], [id("work_item", 999)]])
    expect(
      updateWorkItem(
        state(deadlock()),
        human,
        { work_item_id: w(3), depends_on },
        ports(),
      ).ok,
    ).toBe(false);
});

test("update_work_item depends_on: PM Office and other Agents cannot change dependencies", () => {
  for (const [s, caller] of [
    [withStanding(state(deadlock()), "office"), actor(4, "pm")],
    [state(deadlock()), actor(3, "coder")],
  ] as const) {
    const refused = updateWorkItem(
      s,
      caller,
      { work_item_id: w(2), depends_on: [] },
      ports(),
    );
    expect(refused.ok).toBe(false);
  }
  const office = updateWorkItem(
    withStanding(state(deadlock()), "office"),
    actor(4, "pm"),
    { work_item_id: w(2), depends_on: [] },
    ports(),
  );
  expect(office.ok || office.error.code).toBe("forbidden_tool");
  // The refusal is about dependencies only: PM Office still edits other fields.
  expect(
    updateWorkItem(
      withStanding(state(deadlock()), "office"),
      actor(4, "pm"),
      { work_item_id: w(2), title: "Tablet smoke" },
      ports(),
    ).ok,
  ).toBe(true);
});
