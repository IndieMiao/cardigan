import { describe, expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  acknowledgeRun,
  artifactCardTemplate,
  assign,
  type CardTemplate,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  createWorkItem,
  type Delivery,
  developmentCardTemplate,
  dispatchRun,
  finishRun,
  prepareDelivery,
  queueRun,
  type Result,
  releaseAssignment,
  replacePrimaryWorkItem,
  submitDelivery,
  submitReview,
  updateWorkItem,
  type WorkItem,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  machine,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const PLAIN = { changed: "测试改动", impact: "测试影响", risk: "无" };
const ops = actor(4, "pm");

/** Real create/assign/run transitions on a fresh card built from `template`. */
function harness(template: CardTemplate, roles: readonly string[]) {
  const io: CommandPorts = { ...ports(), templates: [template] };
  let state: CommandState = {
    project_id: human.project_id,
    machines: [machine()],
    roles: roles.map(role),
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const commit = <T>(r: Result<CommandEffect<T>>): T => {
    const e = value(r);
    state = apply(state, e);
    return e.data;
  };
  const card = commit(
    createCard(
      state,
      human,
      {
        template: template.id,
        title: "Replace",
        goal: "Ship",
        acceptance_criteria: ["Works"],
        source: { kind: "quote", text: "Build" },
        ...(template.requires_repo
          ? { repo: "fixture", base_branch: "main" }
          : {}),
      },
      io,
    ),
  );
  const items = () => state.work_items.filter((w) => w.card_id === card.id);
  const slot = (key: string) => {
    const item = items().find((w) => w.template_key === key);
    if (!item) throw new Error(`missing ${key}`);
    return item;
  };
  const owner = (item: WorkItem) =>
    commit(
      assign(
        state,
        human,
        { work_item_id: item.id, role_id: item.role_id },
        io,
      ),
    );
  const as = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: state.project_id,
    assignment_id: a.id,
    ...role(a.role_id),
  });
  const finish = (a: Assignment) => {
    for (const r of state.runs.filter(
      (r) => r.assignment_id === a.id && r.status === "running",
    ))
      commit(
        finishRun(
          state,
          as(a),
          { run_id: r.id, outcome: "completed", summary: "Finished" },
          io,
        ),
      );
  };
  const start = (a: Assignment) => {
    finish(a);
    const queued =
      state.runs.find(
        (r) => r.assignment_id === a.id && r.status === "queued",
      ) ??
      commit(
        queueRun(
          state,
          human,
          { assignment_id: a.id, model: "m", agent_cli_version: "1" },
          io,
        ),
      );
    commit(
      dispatchRun(
        state,
        human,
        {
          run_id: queued.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: `terminal-${a.id}`,
            agent_name: a.role_id,
          },
        },
        io,
      ),
    );
    commit(acknowledgeRun(state, as(a), { run_id: queued.id }, io));
  };
  const deliveryParams = (
    a: Assignment,
    kind: Delivery["kind"],
    requested_verifiers: readonly WorkItem["id"][],
    sha: string,
  ) => ({
    work_item_id: (a as Extract<Assignment, { scope: "work_item" }>)
      .work_item_id,
    kind,
    ...(kind === "card_completion" ? { plain_summary: PLAIN } : {}),
    summary: "Ready",
    subject: template.requires_repo
      ? { kind: "git_head" as const, value: sha }
      : { kind: "doc_version" as const, value: sha },
    requested_verifiers,
  });
  const attempt = async (
    a: Assignment,
    kind: Delivery["kind"],
    requested_verifiers: readonly WorkItem["id"][],
    sha = "a".repeat(40),
  ) => {
    start(a);
    const p = deliveryParams(a, kind, requested_verifiers, sha);
    const proof = await prepareDelivery(state, as(a), p, {
      verify: async () => ({ ok: true, value: [] }),
    });
    if (!proof.ok) return proof;
    return submitDelivery(state, as(a), p, proof.value, io);
  };
  const deliver = async (
    a: Assignment,
    kind: Delivery["kind"],
    requested_verifiers: readonly WorkItem["id"][],
    sha?: string,
  ) => commit(await attempt(a, kind, requested_verifiers, sha));
  const review = (a: Assignment, v: Delivery) => {
    start(a);
    return commit(
      submitReview(
        state,
        as(a),
        {
          delivery_id: v.id,
          target_sha: v.subject.value,
          kind: v.kind === "card_completion" ? "product" : "code",
          issues: [],
        },
        io,
      ),
    );
  };
  const extra = (
    p: Omit<Parameters<typeof createWorkItem>[2], "card_id">,
  ): WorkItem =>
    commit(createWorkItem(state, human, { ...p, card_id: card.id }, io));
  return {
    get state() {
      return state;
    },
    io,
    card,
    items,
    slot,
    owner,
    finish,
    attempt,
    deliver,
    review,
    extra,
    commit,
    release: (a: Assignment) => {
      finish(a);
      commit(releaseAssignment(state, human, { assignment_id: a.id }, io));
    },
  };
}

const work = (s: CommandState, workItemId: string) =>
  s.work_items.find((w) => w.id === workItemId);

describe("C-778: replace a mis-assigned primary producer", () => {
  test("artifact card: the replacement keeps its accepted delivery and review, requests completion and closes the card", async () => {
    const h = harness(artifactCardTemplate, [
      "ui_ux_designer",
      "artist_3d",
      "design_director",
      "pm",
    ]);
    const old = h.slot("production");
    const acceptance = h.slot("pm_acceptance");
    const wrong = h.owner(old);
    const pm = h.owner(acceptance);
    // PM rebuilt the work on a correctly-roled producer with its own review.
    const redo = h.extra({
      title: "产出（3D）",
      role_id: "artist_3d",
      kind: "produce",
      required: true,
      completion_criteria: ["Works"],
    });
    const director = h.extra({
      title: "设计总监审核",
      role_id: "design_director",
      kind: "verify",
      required: true,
      completion_criteria: ["Works"],
      target_work_item_id: redo.id,
    });
    const artist = h.owner(redo);
    const reviewer = h.owner(director);
    const product = await h.deliver(artist, "doc", [director.id], "v1");
    h.review(reviewer, product);
    expect(work(h.state, redo.id)?.status).toBe("accepted");
    // The live defect: only the template primary may request completion.
    expect(
      await h.attempt(artist, "card_completion", [acceptance.id], "v1"),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });

    const params = {
      work_item_id: old.id,
      replacement_work_item_id: redo.id,
      card_id: h.card.id,
      template_key: "production",
      reason: "派错角色，改由 3D 美术产出",
    };
    // An unreleased Assignment on the old producer refuses the transfer.
    const before = JSON.stringify(h.state);
    expect(replacePrimaryWorkItem(h.state, human, params, h.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(JSON.stringify(h.state)).toBe(before);
    h.release(wrong);

    const holder = h.commit(
      replacePrimaryWorkItem(h.state, human, params, h.io),
    );
    expect(holder).toMatchObject({
      id: redo.id,
      template_key: "production",
      required: true,
      status: "accepted",
      assignment_id: artist.id,
    });
    const retired = work(h.state, old.id);
    expect(retired).toMatchObject({
      status: "cancelled",
      required: false,
      replaced_by_work_item_id: redo.id,
      assignment_id: wrong.id,
    });
    expect(retired?.template_key).toBeUndefined();
    // The slot moved, it was never emptied.
    expect(
      h.items().filter((w) => w.template_key === "production"),
    ).toMatchObject([{ id: redo.id }]);
    // Existing accepted delivery and the review aimed at it stay valid.
    expect(h.state.deliveries.find((v) => v.id === product.id)?.status).toBe(
      "accepted",
    );
    expect(work(h.state, director.id)?.status).toBe("passed");
    expect(h.state.events.at(-1)).toMatchObject({
      type: "primary_work_item_replaced",
      actor: human,
      payload: {
        work_item_id: old.id,
        replacement_work_item_id: redo.id,
        template_key: "production",
        reason: params.reason,
      },
    });
    const entry = h.state.timeline.at(-1);
    expect(entry).toMatchObject({ type: "status_change", author: "human" });
    for (const fact of ["人", "production", old.id, redo.id, params.reason])
      expect(entry?.body).toContain(fact);

    // No redelivery: completion from the new primary, PM accepts, card closes.
    const completion = await h.deliver(
      artist,
      "card_completion",
      [acceptance.id],
      "v1",
    );
    h.review(pm, completion);
    expect(h.state.cards.find((c) => c.id === h.card.id)?.status).toBe("done");
    // The retired item is history only.
    expect(replacePrimaryWorkItem(h.state, human, params, h.io).ok).toBe(false);
  });

  test("development card: template verifiers follow the slot and must review the replacement", async () => {
    const h = harness(developmentCardTemplate, ["coder", "reviewer", "pm"]);
    const old = h.slot("development");
    const codeReview = h.slot("code_review");
    const acceptance = h.slot("pm_acceptance");
    const wrong = h.owner(old);
    const reviewer = h.owner(codeReview);
    const pm = h.owner(acceptance);
    // The old producer's version was reviewed before the mistake was found.
    const stale = await h.deliver(wrong, "code", [codeReview.id]);
    h.review(reviewer, stale);
    const redo = h.extra({
      title: "开发（重做）",
      role_id: "coder",
      kind: "produce",
      required: false,
      completion_criteria: ["Works"],
      depends_on: [old.id],
    });
    const follower = h.extra({
      title: "依赖开发",
      role_id: "coder",
      kind: "produce",
      required: false,
      completion_criteria: ["Works"],
      depends_on: [old.id],
    });
    h.release(wrong);
    h.commit(
      replacePrimaryWorkItem(
        h.state,
        human,
        {
          work_item_id: old.id,
          replacement_work_item_id: redo.id,
          card_id: h.card.id,
          template_key: "development",
          reason: "原开发项派错",
        },
        h.io,
      ),
    );
    expect(h.state.deliveries.find((v) => v.id === stale.id)?.status).toBe(
      "superseded",
    );
    expect(work(h.state, codeReview.id)).toMatchObject({
      target_work_item_id: redo.id,
      status: "todo",
      template_key: "code_review",
    });
    expect(work(h.state, redo.id)).toMatchObject({
      required: true,
      depends_on: [],
    });
    expect(work(h.state, follower.id)?.depends_on).toEqual([redo.id]);
    // The template's required code review cannot be bypassed by the move.
    const coder = h.owner(work(h.state, redo.id) as WorkItem);
    expect(await h.attempt(coder, "code", [])).toMatchObject({ ok: false });
    const product = await h.deliver(
      coder,
      "code",
      [codeReview.id],
      "b".repeat(40),
    );
    h.review(reviewer, product);
    const completion = await h.deliver(
      coder,
      "card_completion",
      [acceptance.id],
      "b".repeat(40),
    );
    h.review(pm, completion);
    expect(h.state.cards.find((c) => c.id === h.card.id)?.status).toBe(
      "awaiting_merge",
    );
    expect(h.state.decisions).toMatchObject([
      {
        trigger: "merge_confirmation",
        status: "open",
        target: { delivery_id: completion.id },
      },
    ]);
  });
});

/** fixture(): W-1 primary (A-1), W-2 code review, W-3 acceptance, A-4 standing PM. */
function released(): CommandState {
  const s = fixture();
  const redo: WorkItem = {
    id: id("work_item", 5),
    card_id: id("card", 1),
    title: "Redo",
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: ["passes"],
    status: "todo",
  };
  return {
    ...s,
    assignments: s.assignments.map((a) =>
      a.scope === "standing"
        ? { ...a, standing_mode: "ops" }
        : a.id === id("assignment", 1)
          ? { ...a, status: "released" }
          : a,
    ),
    runs: s.runs.map((r) =>
      r.assignment_id === id("assignment", 1)
        ? { ...r, status: "completed", outcome: "completed" }
        : r,
    ),
    work_items: [...s.work_items, redo],
  };
}
const params = {
  work_item_id: id("work_item", 1),
  replacement_work_item_id: id("work_item", 5),
  card_id: id("card", 1),
  template_key: "development",
  reason: "派错角色",
};
const patch = (
  s: CommandState,
  workItemId: string,
  fields: Partial<WorkItem>,
): CommandState => ({
  ...s,
  work_items: s.work_items.map((w) =>
    w.id === workItemId ? ({ ...w, ...fields } as WorkItem) : w,
  ),
});

test("PM Ops transfers the slot; it can never be emptied or re-taken afterwards", () => {
  const s = released();
  const before = JSON.stringify(s);
  const effect = value(replacePrimaryWorkItem(s, ops, params, ports()));
  expect(JSON.stringify(s)).toBe(before);
  const next = apply(s, effect);
  expect(effect.events).toMatchObject([
    { type: "primary_work_item_replaced", actor: ops },
  ]);
  expect(effect.timeline[0]?.body).toContain(id("assignment", 4));
  expect(work(next, id("work_item", 2))).toMatchObject({
    target_work_item_id: id("work_item", 5),
    status: "todo",
  });
  // §4.5: a required template item cannot be switched off once it holds the slot.
  expect(
    updateWorkItem(
      next,
      ops,
      { work_item_id: id("work_item", 5), required: false },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  for (const r of [
    updateWorkItem(
      next,
      ops,
      { work_item_id: id("work_item", 1), required: true },
      ports(),
    ),
    assign(
      next,
      human,
      { work_item_id: id("work_item", 1), role_id: "coder" },
      ports(),
    ),
    // Handing the slot back would need the retired item as the new holder.
    replacePrimaryWorkItem(
      next,
      ops,
      {
        ...params,
        work_item_id: id("work_item", 5),
        replacement_work_item_id: id("work_item", 1),
      },
      ports(),
    ),
  ])
    expect(r.ok).toBe(false);
});

const REASONS: Record<string, RegExp> = {
  "active old assignment": /未释放的 Assignment/u,
  "suspended old assignment": /未释放的 Assignment/u,
  ...Object.fromEntries(
    ["queued", "dispatched", "acked", "running", "unknown"].map((s) => [
      `old ${s} run`,
      /未结束的 Run/u,
    ]),
  ),
  ...Object.fromEntries(
    ["done", "cancelled", "awaiting_merge"].map((s) => [
      `card ${s}`,
      /卡片已关闭或待合并/u,
    ]),
  ),
  "verifier as replacement": /新项必须是同卡的产出项/u,
  "producer on another card": /同一卡片/u,
  "cancelled replacement": /新产出项已取消/u,
  "replacement holding another slot": /已占用模板槽位/u,
  "same item": /不能相同/u,
  "old item is not the primary": /主产出项/u,
  "wrong template key": /template_key/u,
  "cross card": /同一卡片/u,
  "empty reason": /原因不能为空/u,
  "missing replacement": /新产出项不存在/u,
  "blocked follower verifier": /W-2 正在阻塞或等待拍板/u,
  "follower reviewer is the replacement's author": /审核员工不能是目标产出项/u,
};

test.each<[string, (s: CommandState) => CommandState, typeof params]>([
  [
    "active old assignment",
    (s) => ({
      ...s,
      assignments: s.assignments.map((a) =>
        a.id === id("assignment", 1) ? { ...a, status: "active" } : a,
      ),
    }),
    params,
  ],
  [
    "suspended old assignment",
    (s) => ({
      ...s,
      assignments: s.assignments.map((a) =>
        a.id === id("assignment", 1) ? { ...a, status: "suspended" } : a,
      ),
    }),
    params,
  ],
  ...(["queued", "dispatched", "acked", "running", "unknown"] as const).map(
    (status): [string, (s: CommandState) => CommandState, typeof params] => [
      `old ${status} run`,
      (s) => ({
        ...s,
        runs: s.runs.map((r) =>
          r.assignment_id === id("assignment", 1)
            ? { ...r, status, outcome: null }
            : r,
        ),
      }),
      params,
    ],
  ),
  ...(["done", "cancelled", "awaiting_merge"] as const).map(
    (status): [string, (s: CommandState) => CommandState, typeof params] => [
      `card ${status}`,
      (s) => ({
        ...s,
        cards: s.cards.map((c) => ({ ...c, status })),
      }),
      params,
    ],
  ),
  [
    "verifier as replacement",
    (s) => s,
    { ...params, replacement_work_item_id: id("work_item", 2) },
  ],
  [
    "producer on another card",
    (s) => patch(s, id("work_item", 5), { card_id: id("card", 2) }),
    params,
  ],
  [
    "cancelled replacement",
    (s) => patch(s, id("work_item", 5), { status: "cancelled" }),
    params,
  ],
  [
    "replacement holding another slot",
    (s) => patch(s, id("work_item", 5), { template_key: "integration" }),
    params,
  ],
  [
    "same item",
    (s) => s,
    { ...params, replacement_work_item_id: id("work_item", 1) },
  ],
  [
    "old item is not the primary",
    (s) => s,
    { ...params, work_item_id: id("work_item", 2) },
  ],
  ["wrong template key", (s) => s, { ...params, template_key: "production" }],
  ["cross card", (s) => s, { ...params, card_id: id("card", 2) }],
  ["empty reason", (s) => s, { ...params, reason: "  " }],
  [
    "missing replacement",
    (s) => s,
    { ...params, replacement_work_item_id: id("work_item", 99) },
  ],
  [
    "blocked follower verifier",
    (s) => patch(s, id("work_item", 2), { status: "blocked" }),
    params,
  ],
  [
    "follower reviewer is the replacement's author",
    (s) => ({
      ...s,
      work_items: s.work_items.map((w) =>
        w.id === id("work_item", 5)
          ? { ...w, assignment_id: id("assignment", 5) }
          : w,
      ),
      assignments: [
        ...s.assignments.map((a) =>
          a.id === id("assignment", 2)
            ? { ...a, employee_id: id("employee", 1) }
            : a,
        ),
        {
          ...(s.assignments.find(
            (a) => a.id === id("assignment", 1),
          ) as Assignment),
          id: id("assignment", 5),
          work_item_id: id("work_item", 5),
          status: "active",
          employee_id: id("employee", 1),
        } as Assignment,
      ],
    }),
    params,
  ],
])(
  "rejects %s with a Chinese reason and no partial effect",
  (_n, mutate, p) => {
    const s = mutate(released());
    const before = JSON.stringify(s);
    const r = replacePrimaryWorkItem(s, ops, p, ports());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(REASONS[_n] ?? /^$/u);
    expect(JSON.stringify(s)).toBe(before);
  },
);

test.each([
  "office",
  "legacy",
  "work item pm",
  "coder",
  "reviewer",
  "host_ops",
])("rejects %s even with an overbroad tool grant", (kind) => {
  let s = released();
  let caller: Actor = ops;
  if (kind === "office" || kind === "legacy")
    s = {
      ...s,
      assignments: s.assignments.map((a) => {
        if (a.scope !== "standing") return a;
        const { standing_mode: _mode, ...rest } = a;
        return kind === "office" ? { ...rest, standing_mode: "office" } : rest;
      }),
    };
  else if (kind === "work item pm") caller = actor(3, "pm");
  else {
    caller = actor(kind === "coder" ? 5 : 4, kind);
    s = {
      ...s,
      work_items: s.work_items.map((w) =>
        w.id === id("work_item", 5)
          ? { ...w, assignment_id: id("assignment", 5) }
          : w,
      ),
      assignments: [
        ...s.assignments.map((a) =>
          a.id === id("assignment", 4) ? { ...a, role_id: kind } : a,
        ),
        {
          ...(s.assignments.find(
            (a) => a.id === id("assignment", 1),
          ) as Assignment),
          id: id("assignment", 5),
          work_item_id: id("work_item", 5),
          status: "active",
        } as Assignment,
      ],
      roles: [
        ...s.roles,
        {
          role_id: kind,
          role_version: 1,
          allowed_tools: ["replace_primary_work_item"],
          capabilities: [],
        },
      ],
    };
  }
  expect(replacePrimaryWorkItem(s, caller, params, ports())).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
});
