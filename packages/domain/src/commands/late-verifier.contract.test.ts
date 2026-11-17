import { expect, test } from "vitest";
import type {
  Assignment,
  CommandEffect,
  CommandState,
  CreateWorkItemParams,
  Delivery,
  Result,
} from "../index.js";
import {
  acknowledgeRun,
  assign,
  createWorkItem,
  dispatchRun,
  prepareDelivery,
  queueRun,
  refreshRequiredVerifiers,
  submitDelivery,
  submitReview,
  systemCompleteCard,
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

const system = { kind: "system" as const, project_id: human.project_id };
const productId = id("work_item", 1);
const cardId = id("card", 1);
const params: CreateWorkItemParams = {
  card_id: cardId,
  title: "Late independent review",
  kind: "verify",
  role_id: "independent_reviewer",
  required: true,
  target_work_item_id: productId,
  completion_criteria: ["Check the current product"],
};

function setup(flow = 5) {
  let state: CommandState = {
    ...fixture(),
    roles: [...fixture().roles, role("independent_reviewer")],
    cards: fixture().cards.map((c) => ({ ...c, flow_version: flow })),
  };
  const io = ports();
  const commit = <T>(result: Result<CommandEffect<T>>) => {
    const effect = value(result);
    state = apply(state, effect);
    return effect.data;
  };
  async function deliver(completion = false) {
    const p = {
      work_item_id: productId,
      kind: completion ? ("card_completion" as const) : ("code" as const),
      summary: "Ready",
      subject,
      requested_verifiers: [id("work_item", completion ? 3 : 2)],
      ...(completion || flow >= 5
        ? {
            plain_summary: {
              changed: "修正流程",
              impact: "审核可继续",
              risk: "无",
            },
          }
        : {}),
    };
    const proof = value(
      await prepareDelivery(state, actor(), p, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    return commit(submitDelivery(state, actor(), p, proof, io));
  }
  function review(delivery: Delivery, n = 2, roleId = "reviewer") {
    return commit(
      submitReview(
        state,
        actor(n, roleId),
        {
          delivery_id: delivery.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    );
  }
  function start(a: Assignment) {
    const run = commit(
      queueRun(
        state,
        human,
        { assignment_id: a.id, model: "fixture", agent_cli_version: "1" },
        io,
      ),
    );
    commit(
      dispatchRun(
        state,
        system,
        {
          run_id: run.id,
          base_sha: subject.value,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "late-review",
            agent_name: "reviewer",
            worktree_path: "/fixture/late-review",
            branch: "agent/late-review",
          },
        },
        io,
      ),
    );
    commit(
      acknowledgeRun(
        state,
        actor(Number(a.id.slice(2)), a.role_id),
        { run_id: run.id },
        io,
      ),
    );
  }
  return {
    get state() {
      return state;
    },
    set state(v: CommandState) {
      state = v;
    },
    io,
    commit,
    deliver,
    review,
    start,
    add: (patch: Partial<CreateWorkItemParams> = {}) =>
      commit(
        createWorkItem(state, actor(4, "pm"), { ...params, ...patch }, io),
      ),
    current: (delivery: Delivery) =>
      state.deliveries.find((v) => v.id === delivery.id),
  };
}

test.each([1, 5])(
  "flow %s: a late required verifier reviews the same delivery and full SHA",
  async (flow) => {
    const f = setup(flow);
    const delivery = await f.deliver();
    const item = f.add();
    expect(item.status).toBe("ready");
    expect(f.current(delivery)).toMatchObject({
      id: delivery.id,
      subject,
      status: "submitted",
      requested_verifiers: [id("work_item", 2), item.id],
    });
    expect(
      f.state.events.filter((e) => e.type === "delivery_verifier_added"),
    ).toMatchObject([
      {
        payload: {
          delivery_id: delivery.id,
          target_work_item_id: productId,
          work_item_id: item.id,
          target_sha: subject.value,
        },
      },
    ]);
    expect(f.state.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delivery_id: delivery.id,
          work_item_id: item.id,
        }),
      ]),
    );
    expect(f.state.reviews).toEqual([]);
    const a = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: item.id, role_id: item.role_id },
        f.io,
      ),
    );
    f.start(a);
    const before = f.state;
    expect(
      submitReview(
        f.state,
        actor(Number(a.id.slice(2)), a.role_id),
        {
          delivery_id: delivery.id,
          target_sha: subject.value.slice(0, 7),
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_target" } });
    expect(
      submitReview(
        f.state,
        actor(),
        {
          delivery_id: delivery.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(f.state).toEqual(before);
    const review = f.review(delivery, Number(a.id.slice(2)), a.role_id);
    expect(review).toMatchObject({
      delivery_id: delivery.id,
      target_sha: subject.value,
      work_item_id: item.id,
      verdict: "pass",
    });
    expect(f.current(delivery)?.status).toBe("submitted");
    f.review(delivery);
    expect(f.current(delivery)?.status).toBe("accepted");
  },
);

test("an accepted product reopens without changing its identity or existing reviews", async () => {
  const f = setup();
  const delivery = await f.deliver();
  const priorReview = f.review(delivery);
  const item = f.add();
  expect(f.current(delivery)).toEqual({
    ...delivery,
    requested_verifiers: [...delivery.requested_verifiers, item.id],
  });
  expect(f.state.work_items.find((w) => w.id === productId)?.status).toBe(
    "delivered",
  );
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 2))?.status,
  ).toBe("passed");
  expect(f.state.reviews.find((r) => r.id === priorReview.id)).toMatchObject({
    ...priorReview,
  });
  const a = f.commit(
    assign(
      f.state,
      human,
      { work_item_id: item.id, role_id: item.role_id },
      f.io,
    ),
  );
  f.start(a);
  f.review(delivery, Number(a.id.slice(2)), a.role_id);
  expect(f.current(delivery)?.status).toBe("accepted");
  expect(f.state.deliveries).toHaveLength(1);
});

test.each(["superseded", "rejected"] as const)(
  "a %s latest product is not bound and no older product is revived",
  async (status) => {
    const f = setup();
    const delivery = await f.deliver();
    f.state = {
      ...f.state,
      deliveries: [
        { ...delivery, id: id("delivery", 1), status: "accepted" },
        { ...delivery, status },
      ],
    };
    const before = f.state.deliveries;
    const item = f.add();
    expect(item.status).toBe("todo");
    expect(f.state.deliveries).toEqual(before);
    expect(
      f.state.events.some((e) => e.type === "delivery_verifier_added"),
    ).toBe(false);
  },
);

test.each(["optional", "completion", "produce"] as const)(
  "unrelated work item retains its existing behavior: %s",
  async (kind) => {
    const f = setup();
    const delivery = await f.deliver();
    f.review(delivery);
    const before = f.state.deliveries;
    const { target_work_item_id: _target, ...withoutTarget } = params;
    const p =
      kind === "optional"
        ? { ...params, required: false }
        : {
            ...withoutTarget,
            kind:
              kind === "produce" ? ("produce" as const) : ("verify" as const),
          };
    expect(f.commit(createWorkItem(f.state, human, p, f.io)).status).toBe(
      "todo",
    );
    expect(f.state.deliveries).toEqual(before);
    expect(
      f.state.events.some((e) => e.type === "delivery_verifier_added"),
    ).toBe(false);
  },
);

test("no product, a cancelled producer, or a recorded merge cannot gain a review target", async () => {
  const f = setup();
  expect(f.add().status).toBe("todo");
  const g = setup();
  const delivery = await g.deliver();
  const original = g.state;
  g.state = {
    ...original,
    work_items: original.work_items.map((w) =>
      w.id === productId ? { ...w, status: "cancelled" } : w,
    ),
  };
  expect(g.add().status).toBe("todo");
  expect(g.current(delivery)).toEqual(delivery);
  g.state = {
    ...original,
    events: [
      ...original.events,
      {
        id: g.io.ids.nextEventId(),
        seq: 999,
        card_id: cardId,
        type: "card_merged",
        actor: system,
        payload: {},
        created_at: now,
      },
    ],
  };
  expect(g.add().status).toBe("todo");
  expect(g.current(delivery)).toEqual(delivery);
  g.state = {
    ...original,
    cards: original.cards.map((c) => ({ ...c, status: "done" })),
  };
  expect(createWorkItem(g.state, human, params, g.io)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test.each([1, 5])(
  "flow %s: late verification revokes completion and merge authority",
  async (flow) => {
    const f = setup(flow);
    const delivery = await f.deliver();
    f.review(delivery);
    const completion =
      flow >= 5
        ? f.commit(
            systemCompleteCard(f.state, system, { card_id: cardId }, f.io),
          )
        : await f.deliver(true);
    if (!completion) throw new Error("Missing completion");
    f.review(completion, 3, "pm");
    expect(f.state.cards.find((c) => c.id === cardId)?.status).toBe(
      "awaiting_merge",
    );
    const item = f.add();
    expect(item.status).toBe("ready");
    expect(f.current(delivery)?.status).toBe("submitted");
    expect(f.current(completion)?.status).toBe("superseded");
    expect(
      f.state.work_items.find((w) => w.id === id("work_item", 3))?.status,
    ).toBe("todo");
    expect(
      f.state.decisions.filter((q) => q.trigger === "merge_confirmation"),
    ).toMatchObject([{ status: "superseded" }]);
    expect(f.state.cards.find((c) => c.id === cardId)?.status).toBe("review");
    const a = f.commit(
      assign(
        f.state,
        human,
        { work_item_id: item.id, role_id: item.role_id },
        f.io,
      ),
    );
    f.start(a);
    f.review(delivery, Number(a.id.slice(2)), a.role_id);
    expect(f.current(delivery)?.status).toBe("accepted");
  },
);

test.each([1, 5])(
  "flow %s: scoped PM binds its own verifier without accessing another card's completion",
  async (flow) => {
    const f = setup(flow);
    const delivery = await f.deliver();
    f.review(delivery);
    const completion =
      flow >= 5
        ? f.commit(
            systemCompleteCard(f.state, system, { card_id: cardId }, f.io),
          )
        : await f.deliver(true);
    if (!completion) throw new Error("Missing completion");
    f.review(completion, 3, "pm");
    const producer = f.state.work_items.find((w) => w.id === productId);
    if (!producer) throw new Error("Missing producer");
    const { assignment_id: _owner, ...unassigned } = producer;
    const otherProducer = {
      ...unassigned,
      id: id("work_item", 900),
      card_id: id("card", 2),
    };
    const otherCompletion: Delivery = {
      ...delivery,
      id: id("delivery", 900),
      work_item_id: otherProducer.id,
      kind: "card_completion",
      status: "accepted",
      requested_verifiers: [],
    };
    f.state = {
      ...f.state,
      work_items: [...f.state.work_items, otherProducer],
      deliveries: [...f.state.deliveries, otherCompletion],
    };
    const scopedPm = actor(3, "pm");
    // The fix must not grant the same actor access to the other card.
    expect(
      createWorkItem(
        f.state,
        scopedPm,
        {
          ...params,
          card_id: otherProducer.card_id,
          target_work_item_id: otherProducer.id,
        },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    const item = f.commit(createWorkItem(f.state, scopedPm, params, f.io));
    expect(item.status).toBe("ready");
    expect(f.current(delivery)).toMatchObject({
      status: "submitted",
      subject: delivery.subject,
      requested_verifiers: [...delivery.requested_verifiers, item.id],
    });
    expect(f.current(completion)?.status).toBe("superseded");
    expect(
      f.state.decisions.filter((q) => q.trigger === "merge_confirmation"),
    ).toMatchObject([{ status: "superseded" }]);
    expect(f.current(otherCompletion)).toEqual(otherCompletion);
    expect(f.state.work_items.find((w) => w.id === otherProducer.id)).toEqual(
      otherProducer,
    );
    expect(
      f.state.events.some((e) => e.card_id === otherProducer.card_id),
    ).toBe(false);
  },
);

test("automatic assignment excludes the delivery author and review submission rechecks isolation", async () => {
  const f = setup();
  const delivery = await f.deliver();
  f.state = {
    ...f.state,
    employees: [1, 2].map((n) => ({
      id: id("employee", n),
      name: `Reviewer ${n}`,
      title: "Reviewer",
      bio: "",
      avatar: null,
      role_id: "independent_reviewer",
      launch_profile_ref: null,
      status: "active",
      created_at: now,
      updated_at: now,
    })),
    assignments: f.state.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, employee_id: id("employee", 1) }
        : a,
    ),
  };
  const item = f.add();
  const a = f.state.assignments.find((a) => a.work_item_id === item.id);
  if (!a) throw new Error("Missing automatic assignment");
  expect(a.employee_id).toBe(id("employee", 2));
  expect(f.state.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "work_item_assigned",
        actor: system,
        payload: expect.objectContaining({
          work_item_id: item.id,
          delivery_id: delivery.id,
        }),
      }),
    ]),
  );
  f.start(a);
  const invalid = {
    ...f.state,
    assignments: f.state.assignments.map((entry) =>
      entry.id === a.id ? { ...entry, employee_id: id("employee", 1) } : entry,
    ),
  };
  expect(
    submitReview(
      invalid,
      actor(Number(a.id.slice(2)), a.role_id),
      {
        delivery_id: delivery.id,
        target_sha: subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  f.review(delivery, Number(a.id.slice(2)), a.role_id);
});

test("the system repairs an existing owned todo verifier once and preserves prior reviews", async () => {
  const f = setup();
  const delivery = await f.deliver();
  f.review(delivery);
  const accepted = f.state;
  const added = f.add();
  // Reconstruct the pre-upgrade omission, without invoking a migration or IO.
  f.state = {
    ...accepted,
    work_items: [...accepted.work_items, { ...added, status: "todo" }],
  };
  const owner = f.commit(
    assign(
      f.state,
      human,
      { work_item_id: added.id, role_id: added.role_id },
      f.io,
    ),
  );
  const reviews = f.state.reviews;
  expect(refreshRequiredVerifiers(f.state, human, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(refreshRequiredVerifiers(f.state, actor(4, "pm"), f.io)).toMatchObject(
    { ok: false, error: { code: "unauthorized" } },
  );
  f.commit(refreshRequiredVerifiers(f.state, system, f.io));
  expect(f.current(delivery)).toMatchObject({
    status: "submitted",
    requested_verifiers: [...delivery.requested_verifiers, added.id],
  });
  expect(f.state.work_items.find((w) => w.id === added.id)).toMatchObject({
    status: "ready",
    assignment_id: owner.id,
  });
  expect(f.state.reviews).toEqual(reviews);
  expect(value(refreshRequiredVerifiers(f.state, system, f.io))).toMatchObject({
    changes: [],
    events: [],
    token_requests: [],
  });
  f.start(owner);
  f.review(delivery, Number(owner.id.slice(2)), owner.role_id);
  expect(f.current(delivery)?.status).toBe("accepted");
});

test.each([
  "closed",
  "held",
  "optional",
  "cancelled",
  "replaced",
  "superseded",
])("legacy repair respects %s state", async (condition) => {
  const f = setup();
  const delivery = await f.deliver();
  const original = f.state;
  const added = f.add();
  f.state = {
    ...original,
    cards: original.cards.map((c) => ({
      ...c,
      ...(condition === "closed" ? { status: "done" as const } : {}),
      ...(condition === "held"
        ? {
            hold: {
              reason: "Paused",
              resume_condition: "Resume explicitly",
              set_at: now,
              set_by: "human" as const,
            },
          }
        : {}),
    })),
    deliveries: original.deliveries.map((v) =>
      condition === "superseded" ? { ...v, status: "superseded" } : v,
    ),
    work_items: [
      ...original.work_items,
      {
        ...added,
        status: condition === "cancelled" ? "cancelled" : "todo",
        required: condition !== "optional",
        ...(condition === "replaced"
          ? { replaced_by_work_item_id: id("work_item", 999) }
          : {}),
      },
    ],
  };
  expect(value(refreshRequiredVerifiers(f.state, system, f.io))).toMatchObject({
    changes: [],
    events: [],
  });
  expect(f.current(delivery)?.requested_verifiers).toEqual(
    delivery.requested_verifiers,
  );
});

test.each(["card", "project", "kind"])(
  "legacy repair rejects an invalid target %s without partial effects",
  async (boundary) => {
    const f = setup();
    await f.deliver();
    const original = f.state;
    const added = f.add();
    if (added.kind !== "verify") throw new Error("Missing verifier");
    f.state = {
      ...original,
      cards: original.cards.map((c) =>
        boundary === "project" && c.id === id("card", 2)
          ? { ...c, project_id: "other-project" }
          : c,
      ),
      work_items: [
        ...original.work_items,
        {
          ...added,
          status: "todo",
          card_id: boundary === "kind" ? cardId : id("card", 2),
          target_work_item_id:
            boundary === "kind" ? id("work_item", 2) : productId,
        },
      ],
    };
    const before = JSON.stringify(f.state);
    expect(refreshRequiredVerifiers(f.state, system, f.io)).toMatchObject({
      ok: false,
      error: {
        code: boundary === "project" ? "unauthorized" : "invariant_violation",
      },
    });
    expect(JSON.stringify(f.state)).toBe(before);
  },
);
