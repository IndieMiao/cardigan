import { describe, expect, test } from "vitest";
import type { Actor, WorkItem } from "../entities.js";
import {
  artifactCardTemplate,
  type CardTemplateDefinition,
  developmentCardTemplate,
  generalCardTemplate,
} from "../templates.js";
import { recordDecision } from "./coordination.js";
import type { CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { assign, createCard } from "./pm.js";
import { manageCardTemplate, markCardDone } from "./templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const definition: CardTemplateDefinition = {
  ...artifactCardTemplate,
  id: "custom",
};
const initial = (): CommandState => ({
  ...fixture(),
  roles: [...fixture().roles, role("ui_ux_designer")],
  cards: [],
  work_items: [],
  assignments: [],
  runs: [],
});
const params = {
  title: "Task",
  goal: "A result",
  acceptance_criteria: ["Result reviewed"],
  source: { kind: "quote" as const, text: "Please do this" },
};
const create = (state: CommandState, template_id = "general") =>
  createCard(state, human, { ...params, template_id }, ports());

test("legacy roles with empty capabilities can create dev cards and be assigned without gaining tools", () => {
  const clock = ports();
  let state: CommandState = {
    ...initial(),
    roles: ["coder", "reviewer", "pm"].map((role_id) => ({
      ...role(role_id),
      capabilities: [],
      // Old roles may only have the tools needed by their original workflow.
      allowed_tools: ["whoami"],
    })),
  };
  const created = value(
    createCard(
      state,
      human,
      { ...params, repo: "fixture/repo", base_branch: "main" },
      clock,
    ),
  );
  state = apply(state, created);
  expect(state.work_items.map((w) => [w.role_id, w.kind])).toEqual([
    ["coder", "produce"],
    ["reviewer", "verify"],
    ["pm", "verify"],
  ]);
  for (const item of state.work_items) {
    const assigned = value(
      assign(
        state,
        human,
        { work_item_id: item.id, role_id: item.role_id },
        clock,
      ),
    );
    expect(assigned.data).toMatchObject({
      role_id: item.role_id,
      role_version: 1,
    });
    expect(assigned.token_requests[0]?.allowed_tools).toEqual(["whoami"]);
    state = apply(state, assigned);
  }
  expect(state.assignments).toHaveLength(3);
  const copied = value(
    manageCardTemplate(
      state,
      human,
      { action: "copy", template_id: "dev", new_id: "legacy-dev" },
      clock,
    ),
  );
  state = apply(state, copied);
  state = apply(
    state,
    value(
      manageCardTemplate(
        state,
        human,
        { action: "deactivate", template_id: "legacy-dev" },
        clock,
      ),
    ),
  );
  expect(
    manageCardTemplate(
      state,
      human,
      { action: "activate", template_id: "legacy-dev" },
      clock,
    ).ok,
  ).toBe(true);
});

test.each(["coder", "reviewer", "pm"])(
  "dev creation still rejects missing, inactive or explicitly restricted %s roles atomically",
  (role_id) => {
    const base = initial();
    for (const roles of [
      base.roles.filter((r) => r.role_id !== role_id),
      [
        ...base.roles,
        {
          ...role(role_id),
          role_version: 2,
          capabilities: [],
          status: "inactive" as const,
        },
      ],
      [...base.roles, { ...role(role_id), role_version: 2, allowed_tools: [] }],
    ]) {
      const state = { ...base, roles },
        before = JSON.parse(JSON.stringify(state));
      expect(
        createCard(
          state,
          human,
          { ...params, repo: "fixture/repo", base_branch: "main" },
          ports(),
        ),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
      expect(state).toEqual(before);
    }
  },
);

describe("template validation contracts", () => {
  test.each<[string, Partial<CardTemplateDefinition>]>([
    ["uppercase ID", { id: "Upper" }],
    ["empty title", { title: " " }],
    [
      "duplicate keys",
      {
        work_items: [
          artifactCardTemplate.work_items[0],
          artifactCardTemplate.work_items[0],
        ],
      },
    ],
    [
      "missing verification target",
      {
        work_items: [
          ...definition.work_items,
          {
            key: "check",
            title: "Check",
            role_id: "reviewer",
            required: true,
            kind: "verify",
            target_work_item_key: "missing",
          },
        ],
      },
    ],
    [
      "verification targeting verification",
      {
        work_items: [
          ...definition.work_items,
          {
            key: "check",
            title: "Check",
            role_id: "reviewer",
            required: true,
            kind: "verify",
            target_work_item_key: "pm_acceptance",
          },
        ],
      },
    ],
    ["verification as primary", { primary_work_item_key: "pm_acceptance" }],
    ["missing primary", { primary_work_item_key: "missing" }],
    ["review without primary", { primary_work_item_key: null }],
    ["merge without repository", { merge: "auto" }],
    [
      "unknown role",
      {
        work_items: [
          { ...artifactCardTemplate.work_items[0], role_id: "absent" },
          artifactCardTemplate.work_items[1],
        ],
      },
    ],
    [
      "unknown completion reviewer",
      { completion: { mode: "review", reviewer: "role:absent" } },
    ],
  ])("rejects %s atomically", (_label, patch) => {
    const state = initial(),
      before = JSON.parse(JSON.stringify(state));
    expect(
      manageCardTemplate(
        state,
        human,
        { action: "add", definition: { ...definition, ...patch } },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(state).toEqual(before);
  });
  test.each(["produce", "verify"] as const)(
    "rejects a role that cannot %s and rejects its inactive latest version",
    (kind) => {
      const roleId = kind === "produce" ? "ui_ux_designer" : "pm";
      for (const patch of [
        { allowed_tools: [] },
        { status: "inactive" as const },
      ]) {
        const state = initial();
        expect(
          manageCardTemplate(
            {
              ...state,
              roles: [
                ...state.roles,
                { ...role(roleId), role_version: 2, ...patch },
              ],
            },
            human,
            { action: "add", definition },
            ports(),
          ).ok,
        ).toBe(false);
      }
    },
  );
  test("requires human authority even if an Agent claims a management tool", () => {
    expect(
      manageCardTemplate(
        fixture(),
        actor(),
        { action: "add", definition },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  });
  test.each(["update", "deactivate", "activate", "rollback"] as const)(
    "builtins cannot %s",
    (action) => {
      const p =
        action === "update"
          ? { action, definition: developmentCardTemplate }
          : action === "rollback"
            ? { action, template_id: "dev", version: 1 }
            : { action, template_id: "dev" };
      expect(manageCardTemplate(initial(), human, p, ports()).ok).toBe(false);
    },
  );
});

test("copy, update, deactivate, activate and rollback append versions and preserve existing cards", () => {
  const clock = ports();
  let state = initial();
  const copy = value(
    manageCardTemplate(
      state,
      human,
      { action: "copy", template_id: "general", new_id: "notes" },
      clock,
    ),
  );
  state = apply(state, copy);
  const created = value(create(state, "notes"));
  state = apply(state, created);
  expect(created.data).toMatchObject({
    template: "notes",
    template_version: 1,
    merge_policy: "none",
  });
  expect(created.data).not.toHaveProperty("repo");
  const changed = value(
    manageCardTemplate(
      state,
      human,
      {
        action: "update",
        definition: {
          ...copy.data,
          title: "Updated",
          require_acceptance_criteria: true,
        },
      },
      clock,
    ),
  );
  state = apply(state, changed);
  expect(changed.data.version).toBe(2);
  const inactive = value(
    manageCardTemplate(
      state,
      human,
      { action: "deactivate", template_id: "notes" },
      clock,
    ),
  );
  state = apply(state, inactive);
  expect(create(state, "notes").ok).toBe(false);
  // Current template status does not revoke the v1 card's human completion flow.
  expect(
    markCardDone(
      state,
      human,
      { card_id: created.data.id, result: "Notes ready" },
      clock,
    ).ok,
  ).toBe(true);
  const active = value(
    manageCardTemplate(
      state,
      human,
      { action: "activate", template_id: "notes" },
      clock,
    ),
  );
  state = apply(state, active);
  const rollback = value(
    manageCardTemplate(
      state,
      human,
      { action: "rollback", template_id: "notes", version: 1 },
      clock,
    ),
  );
  state = apply(state, rollback);
  expect(rollback.data).toMatchObject({
    version: 5,
    title: generalCardTemplate.title,
    status: "active",
  });
  expect(state.card_templates).toHaveLength(5);
  expect(value(create(state, "notes")).data.template_version).toBe(5);
  expect(state.cards[0]?.template_version).toBe(1);
});

test("create uses the selected version, validates roles, repo and acceptance, and defaults to dev", () => {
  const state = initial();
  expect(create(state, "dev").ok).toBe(false);
  expect(create(state, "unknown").ok).toBe(false);
  expect(
    createCard(
      state,
      human,
      { ...params, template_id: "general", acceptance_criteria: [] },
      ports(),
    ).ok,
  ).toBe(true);
  expect(
    createCard(
      state,
      human,
      { ...params, template_id: "artifact", acceptance_criteria: [] },
      ports(),
    ).ok,
  ).toBe(false);
  const dev = value(
    createCard(
      state,
      human,
      { ...params, repo: "example/repo", base_branch: "main" },
      ports(),
    ),
  );
  expect(dev.data).toMatchObject({
    template: "dev",
    template_version: 1,
    merge_policy: "confirm",
  });
  expect(dev.changes.filter((c) => c.collection === "work_items")).toHaveLength(
    3,
  );
  const artifact = value(create(state, "artifact"));
  expect(
    artifact.changes
      .filter((c) => c.collection === "work_items")
      .map((c) => c.entity),
  ).toMatchObject([
    { kind: "produce", role_id: "ui_ux_designer", template_key: "production" },
    { kind: "verify", role_id: "pm", template_key: "pm_acceptance" },
  ]);
  expect(
    create(
      {
        ...state,
        roles: state.roles.filter((r) => r.role_id !== "ui_ux_designer"),
      },
      "artifact",
    ).ok,
  ).toBe(false);
});

test("markCardDone requires human, the pinned completion mode, a result and successful required items", () => {
  const created = value(create(initial()));
  let state = apply(initial(), created);
  const p = { card_id: created.data.id, result: "Reviewed notes" };
  for (const author of [
    actor(),
    { kind: "system", project_id: human.project_id } as Actor,
  ])
    expect(markCardDone(state, author, p, ports()).ok).toBe(false);
  expect(markCardDone(state, human, { ...p, result: " " }, ports()).ok).toBe(
    false,
  );
  const unfinished: WorkItem = {
    id: id("work_item", 8),
    card_id: p.card_id,
    kind: "produce",
    role_id: "designer",
    title: "Required",
    status: "in_progress",
    required: true,
    depends_on: [],
    completion_criteria: [],
  };
  expect(
    markCardDone({ ...state, work_items: [unfinished] }, human, p, ports()).ok,
  ).toBe(false);
  for (const item of [
    { ...unfinished, status: "accepted" },
    { ...unfinished, required: false },
  ] as WorkItem[])
    expect(
      markCardDone({ ...state, work_items: [item] }, human, p, ports()).ok,
    ).toBe(true);
  const done = value(markCardDone(state, human, p, ports()));
  expect(done.data).toMatchObject({ status: "done", resolution: "done" });
  expect(done.events[0]).toMatchObject({
    type: "card_marked_done",
    actor: human,
    payload: { result: p.result },
  });
  expect(done.timeline[0]?.body).toBe(p.result);
  state = apply(state, done);
  expect(markCardDone(state, human, p, ports()).ok).toBe(false);
  expect(
    markCardDone(
      { ...state, cards: [{ ...created.data, status: "cancelled" }] },
      human,
      p,
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    markCardDone(fixture(), human, { ...p, card_id: id("card", 1) }, ports())
      .ok,
  ).toBe(false);
});

test("completion and employee separation use the card's pinned custom primary and reviewer keys", async () => {
  const template = {
    ...developmentCardTemplate,
    id: "quality-flow",
    builtin: false,
    primary_work_item_key: "build",
    completion: { mode: "review" as const, reviewer: "role:quality" as const },
    work_items: [
      { ...developmentCardTemplate.work_items[0], key: "build" },
      {
        ...developmentCardTemplate.work_items[1],
        target_work_item_key: "build",
      },
      {
        ...developmentCardTemplate.work_items[2],
        key: "final",
        role_id: "quality",
      },
    ],
  };
  let state: CommandState = {
    ...fixture(),
    roles: [...fixture().roles, role("quality")],
    card_templates: [
      template,
      { ...template, version: 2, primary_work_item_key: "new-build" },
    ],
    cards: fixture().cards.map((c) => ({
      ...c,
      template: template.id,
      template_version: 1,
    })),
    work_items: fixture().work_items.map((w) =>
      w.kind === "produce"
        ? { ...w, template_key: "build" }
        : w.template_key === "pm_acceptance"
          ? { ...w, template_key: "final", role_id: "quality" }
          : w,
    ),
    assignments: fixture().assignments.map((a) =>
      a.id === id("assignment", 3) ? { ...a, role_id: "quality" } : a,
    ),
  };
  const p = ports(),
    subject = { kind: "doc_version" as const, value: "doc-v1" };
  const product = {
    work_item_id: id("work_item", 1),
    kind: "doc" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [id("work_item", 2)],
  };
  const deliver = async (params: Parameters<typeof prepareDelivery>[2]) => {
    const checked = value(
      await prepareDelivery(state, actor(), params, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    const effect = value(submitDelivery(state, actor(), params, checked, p));
    state = apply(state, effect);
    return effect.data;
  };
  const selfReview = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 1) || a.id === id("assignment", 3)
        ? { ...a, employee_id: id("employee", 1) }
        : a,
    ),
  };
  expect(
    (
      await prepareDelivery(selfReview, actor(), product, {
        verify: async () => ({ ok: true, value: [] }),
      })
    ).ok,
  ).toBe(false);
  const delivered = await deliver(product);
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          delivery_id: delivered.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        p,
      ),
    ),
  );
  const completion = await deliver({
    ...product,
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
    requested_verifiers: [id("work_item", 3)],
  });
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(3, "quality"),
        {
          delivery_id: completion.id,
          target_sha: subject.value,
          kind: "product",
          issues: [],
        },
        p,
      ),
    ),
  );
  expect(state.cards.find((c) => c.id === id("card", 1))?.status).toBe("done");
});

test("human completion review binds a decision to the current non-Git delivery and rejects stale approval", async () => {
  const template = {
    ...developmentCardTemplate,
    id: "human-review",
    builtin: false,
    merge: "none" as const,
    requires_repo: false,
    completion: { mode: "review" as const, reviewer: "human" as const },
    work_items: [developmentCardTemplate.work_items[0]],
  };
  let state: CommandState = {
    ...fixture(),
    card_templates: [template],
    cards: fixture().cards.map((c) => ({
      ...c,
      template: template.id,
      template_version: 1,
    })),
    work_items: fixture().work_items.filter((w) => w.kind === "produce"),
  };
  const p = ports(),
    product = {
      work_item_id: id("work_item", 1),
      kind: "doc" as const,
      summary: "Ready",
      subject: { kind: "doc_version" as const, value: "v1" },
      requested_verifiers: [],
    };
  const deliver = async (params: Parameters<typeof prepareDelivery>[2]) => {
    const verified = value(
      await prepareDelivery(state, actor(), params, {
        verify: async () => ({ ok: true, value: [] }),
      }),
    );
    const effect = value(submitDelivery(state, actor(), params, verified, p));
    state = apply(state, effect);
    return effect.data;
  };
  await deliver(product);
  await deliver({
    ...product,
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  const first = state.decisions[0];
  if (!first) throw new Error("Missing human acceptance");
  await deliver({ ...product, subject: { ...product.subject, value: "v2" } });
  expect(state.decisions.find((d) => d.id === first.id)?.status).toBe(
    "superseded",
  );
  const decisionParams = {
    decision_id: first.id,
    option: "approve",
    rationale: "Verified",
    raw_quote: "Approved",
  };
  expect(recordDecision(state, human, decisionParams, p).ok).toBe(false);
  await deliver({
    ...product,
    subject: { ...product.subject, value: "v2" },
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  const current = state.decisions.find((d) => d.status === "open");
  if (!current) throw new Error("Missing current review");
  const rejected = value(
    recordDecision(
      state,
      human,
      { ...decisionParams, decision_id: current.id, option: "reject" },
      p,
    ),
  );
  state = apply(state, rejected);
  expect(rejected.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "completion_reviewed",
        payload: expect.objectContaining({
          verdict: "reject",
          rework_allowed: true,
        }),
      }),
    ]),
  );
  expect(state.cards.find((c) => c.id === id("card", 1))?.status).toBe(
    "in_progress",
  );
  await deliver({
    ...product,
    subject: { ...product.subject, value: "v2" },
    kind: "card_completion",
    plain_summary: TEST_PLAIN_SUMMARY,
  });
  const retry = state.decisions.find((d) => d.status === "open");
  if (!retry) throw new Error("Missing retry review");
  state = apply(
    state,
    value(
      recordDecision(
        state,
        human,
        { ...decisionParams, decision_id: retry.id },
        p,
      ),
    ),
  );
  expect(state.cards.find((c) => c.id === id("card", 1))).toMatchObject({
    status: "done",
    resolution: "done",
  });
});

test("human completion accepts passed verification and binds only same-card evidence", () => {
  const created = value(create(initial())),
    state = apply(initial(), created),
    clock = ports();
  const verification: WorkItem = {
    id: id("work_item", 8),
    card_id: created.data.id,
    kind: "verify",
    role_id: "pm",
    title: "Check",
    required: true,
    status: "passed",
    depends_on: [],
    completion_criteria: [],
    max_review_rounds: 3,
  };
  const attachment = {
    id: clock.ids.nextAttachmentId(state.project_id),
    kind: "evidence" as const,
    sha256: "a".repeat(64),
    mime: "text/plain",
    size: 1,
    card_id: created.data.id,
    uploaded_by: "human" as const,
    storage_path: "attachments/proof",
    attach_to: { kind: "delivery" as const, id: id("delivery", 1) },
  };
  const p = {
    card_id: created.data.id,
    result: "Confirmed",
    attachments: [attachment.id],
  };
  const input = {
    ...state,
    work_items: [verification],
    attachments: [attachment],
  };
  expect(markCardDone(input, human, p, clock).ok).toBe(true);
  expect(
    markCardDone(
      { ...input, work_items: [{ ...verification, status: "failed" }] },
      human,
      p,
      clock,
    ).ok,
  ).toBe(false);
  expect(
    markCardDone(
      { ...input, attachments: [{ ...attachment, card_id: id("card", 999) }] },
      human,
      p,
      clock,
    ).ok,
  ).toBe(false);
  expect(
    markCardDone(input, { ...human, project_id: "other-project" }, p, clock).ok,
  ).toBe(false);
});

test("a none template refuses Git subjects before external verification", async () => {
  const state = fixture();
  const input = {
    ...state,
    cards: state.cards.map((c) => ({
      ...c,
      template: "artifact",
      template_version: 1,
    })),
    work_items: state.work_items.map((w) =>
      w.kind === "produce" ? { ...w, template_key: "production" } : w,
    ),
  };
  let checked = false;
  const result = await prepareDelivery(
    input,
    actor(),
    {
      work_item_id: id("work_item", 1),
      kind: "code",
      summary: "Cannot bypass",
      subject: { kind: "git_head", value: "a".repeat(40) },
      requested_verifiers: [id("work_item", 2)],
    },
    {
      verify: async () => {
        checked = true;
        return { ok: true, value: [] };
      },
    },
  );
  expect(result.ok).toBe(false);
  expect(checked).toBe(false);
});
