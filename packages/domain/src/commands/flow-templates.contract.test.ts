import { expect, test, vi } from "vitest";
import * as flow from "../flow.js";
import {
  builtinCardTemplates,
  builtinCardTemplateVersions,
  type CardTemplate,
  cardTemplate,
  developmentCardTemplate,
  developmentCardTemplateV2,
  productCardTemplate,
} from "../templates.js";
import type { CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { upgradeCardFlow } from "./flow.js";
import { mergePlan } from "./merge.js";
import { createCard } from "./pm.js";
import { listTemplates } from "./queries.js";
import { systemCompleteCard } from "./system-completion.js";
import {
  futurePreferences,
  pathEvidence,
  system,
} from "./system-merge/test-fixtures.js";
import { manageCardTemplate } from "./templates.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  ports,
  run,
  subject,
  value,
} from "./test-fixtures.js";

const params = {
  title: "Template contract",
  goal: "Ship the agreed change",
  repo: "example/repo",
  base_branch: "main",
  acceptance_criteria: ["The result meets the requirement"],
  source: { kind: "quote" as const, text: "Build it" },
};
const initial = (): CommandState => ({
  ...fixture(),
  cards: [],
  work_items: [],
  assignments: [],
  runs: [],
});

test("B3b source versions are exact and do not activate or rewrite registered defaults", () => {
  expect(builtinCardTemplateVersions).toEqual(
    expect.arrayContaining([developmentCardTemplateV2, productCardTemplate]),
  );
  expect(builtinCardTemplates).not.toContain(developmentCardTemplateV2);
  expect(builtinCardTemplates).not.toContain(productCardTemplate);
  expect(cardTemplate({ template: "dev" })).toBe(developmentCardTemplate);
  expect(cardTemplate({ template: "dev", template_version: 1 })).toBe(
    developmentCardTemplate,
  );
  expect(cardTemplate({ template: "dev", template_version: 2 })).toBe(
    developmentCardTemplateV2,
  );
  expect(cardTemplate({ template: "product", template_version: 1 })).toBe(
    productCardTemplate,
  );
  for (const template of ["dev", "product", "unknown"])
    expect(cardTemplate({ template, template_version: 99 })).toBeUndefined();
  const created = value(createCard(initial(), human, params, ports()));
  expect(created.data).toMatchObject({ template_version: 1, flow_version: 1 });
  expect(
    created.changes.filter((c) => c.collection === "work_items"),
  ).toHaveLength(3);
  expect(flow.validFlowVersion(5)).toBe(false);
});

test.each([developmentCardTemplateV2, productCardTemplate])(
  "$id@$version cannot be replaced through editable template operations",
  (template) => {
    for (const state of [
      initial(),
      { ...initial(), card_templates: [template] },
    ]) {
      const before = JSON.parse(JSON.stringify(state));
      for (const action of ["add", "update"] as const)
        expect(
          manageCardTemplate(
            state,
            human,
            { action, definition: { ...template, title: "Overwrite" } },
            ports(),
          ).ok,
        ).toBe(false);
      for (const action of ["activate", "deactivate", "rollback"] as const)
        expect(
          manageCardTemplate(
            state,
            human,
            { action, template_id: template.id, version: 1 },
            ports(),
          ).ok,
        ).toBe(false);
      expect(
        manageCardTemplate(
          state,
          human,
          { action: "copy", template_id: "general", new_id: template.id },
          ports(),
        ).ok,
      ).toBe(false);
      expect(state).toEqual(before);
    }
  },
);

test("system completion templates validate without a PM role but cannot strand old-flow cards", () => {
  const base = initial();
  const state = {
    ...base,
    roles: base.roles.filter((r) => r.role_id !== "pm"),
  };
  const copied = value(
    manageCardTemplate(
      state,
      human,
      { action: "copy", template_id: "dev", version: 2, new_id: "engineering" },
      ports(),
    ),
  );
  const registered = apply(state, copied);
  expect(
    createCard(
      registered,
      human,
      { ...params, template_id: "engineering" },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("第五级"),
    },
  });
  for (const work_items of [
    [
      ...developmentCardTemplateV2.work_items,
      developmentCardTemplate.work_items[2],
    ],
    [
      {
        ...developmentCardTemplateV2.work_items[0],
        completion_criteria: [" "],
      },
    ],
  ])
    expect(
      manageCardTemplate(
        base,
        human,
        {
          action: "add",
          definition: {
            ...developmentCardTemplateV2,
            id: "invalid",
            work_items,
          },
        },
        ports(),
      ).ok,
    ).toBe(false);
});

async function registeredCard(template: CardTemplate, risk = false) {
  const io = ports();
  const future = futurePreferences(initial());
  let state: CommandState = {
    ...initial(),
    events: future.events.map((event) =>
      event.type === "project_preferences_updated" &&
      (event.payload as { preference: string }).preference === "flow_version"
        ? {
            ...event,
            payload: { preference: "flow_version", old_value: 2, new_value: 5 },
          }
        : event,
    ),
    card_templates: [...builtinCardTemplates, template],
    project_preferences: (future.project_preferences ?? []).map((p) => ({
      ...p,
      flow_version: 5,
    })),
  };
  // Simulate the later release/registration in this isolated contract only.
  // Production still rejects flow 5; no migration or preference write is added.
  const released = vi.spyOn(flow, "validFlowVersion").mockReturnValue(true);
  try {
    state = apply(
      state,
      value(
        createCard(state, human, { ...params, template_id: template.id }, io),
      ),
    );
  } finally {
    released.mockRestore();
  }
  const card = state.cards[0];
  const producer = state.work_items[0];
  if (!card || !producer) throw new Error("Missing generated card");
  state = {
    ...state,
    cards: [
      {
        ...card,
        status: "in_progress",
        ...(risk ? { risk_tags: ["permission"] as const } : {}),
      },
    ],
    work_items: state.work_items.map((w, i) => ({
      ...w,
      assignment_id: assignment(i + 1).id,
      status: w.kind === "produce" ? "in_progress" : "ready",
    })),
    assignments: state.work_items.map((w, i) => ({
      ...assignment(i + 1, w.role_id),
      work_item_id: w.id,
    })),
    runs: state.work_items.map((_w, i) => run(i + 1)),
  };
  const deliveryParams = {
    work_item_id: producer.id,
    kind: "code" as const,
    summary: "Ready",
    plain_summary: {
      changed: "完成约定改动",
      impact: "按验收标准运行",
      risk: "无",
    },
    subject,
    requested_verifiers: state.work_items
      .filter(
        (w) => w.kind === "verify" && w.target_work_item_id === producer.id,
      )
      .map((w) => w.id),
  };
  const proof = value(
    await prepareDelivery(state, actor(), deliveryParams, {
      verify: async () => ({ ok: true, value: pathEvidence() }),
    }),
  );
  const delivered = value(
    submitDelivery(state, actor(), deliveryParams, proof, io),
  );
  state = apply(state, delivered);
  const complete = () => {
    const result = value(
      systemCompleteCard(state, system, { card_id: card.id }, io),
    );
    state = apply(state, result);
    return result.data;
  };
  const review = (
    delivery_id = delivered.data.id,
    n = 2,
    role = "reviewer",
  ) => {
    state = apply(
      state,
      value(
        submitReview(
          state,
          actor(n, role),
          { delivery_id, target_sha: subject.value, kind: "code", issues: [] },
          io,
        ),
      ),
    );
  };
  return {
    get state() {
      return state;
    },
    card,
    delivered: delivered.data,
    complete,
    review,
  };
}

test.each([developmentCardTemplateV2, productCardTemplate])(
  "$id@$version creates the intended work and follows B3a with real product reviews",
  async (template) => {
    const f = await registeredCard(template);
    const pm = template.id === "product";
    expect(f.state.work_items.map((w) => w.role_id).sort()).toEqual(
      pm ? ["coder", "pm", "reviewer"] : ["coder", "reviewer"],
    );
    expect(
      f.state.work_items.find((w) => w.template_key === "code_review")
        ?.completion_criteria,
    ).toEqual([
      ...params.acceptance_criteria,
      "逐条对照验收标准；测试范围为本地相关测试 + 远程预检通过",
    ]);
    expect(f.complete()).toBeNull();
    f.review();
    const completion = f.complete();
    if (!completion) throw new Error("Missing completion");
    expect(completion.status).toBe(pm ? "submitted" : "accepted");
    expect(completion.requested_verifiers).toEqual(
      pm
        ? [
            f.state.work_items.find((w) => w.template_key === "pm_acceptance")
              ?.id,
          ]
        : [],
    );
    expect(completion.system_completion?.products[0]?.delivery_id).toBe(
      f.delivered.id,
    );
    if (pm) f.review(completion.id, 3, "pm");
    expect(f.state.cards[0]?.status).toBe("awaiting_merge");
    expect(f.state.reviews).toHaveLength(pm ? 2 : 1);
    expect(
      f.state.decisions.find((q) => q.trigger === "merge_confirmation"),
    ).toMatchObject({ decider: "system", status: "open" });
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    expect(f.complete()).toBeNull();
  },
);

test("dev@2 still requires risk review before system completion", async () => {
  const f = await registeredCard(developmentCardTemplateV2, true);
  f.review();
  expect(f.complete()).toBeNull();
  expect(
    f.state.events.some((e) => e.type === "system_completion_deferred"),
  ).toBe(true);
  expect(f.state.cards[0]?.status).not.toBe("done");
});

test("a pinned system-completion card cannot be downgraded into the old manual flow", () => {
  const base = fixture();
  const original = base.cards[0];
  if (!original) throw new Error("Missing fixture card");
  const card = {
    ...original,
    status: "todo",
    template: "dev",
    template_version: 2,
    flow_version: 5,
  } as const;
  const state: CommandState = { ...base, cards: [card] };
  const before = JSON.parse(JSON.stringify(state));
  expect(
    upgradeCardFlow(state, human, { card_id: card.id, to: 2 }, ports()),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("第五级"),
    },
  });
  expect(state).toEqual(before);
});

test("registered versions appear in the project catalog with their review criteria", () => {
  const state = {
    ...fixture(),
    card_templates: [
      ...builtinCardTemplates,
      developmentCardTemplateV2,
      productCardTemplate,
    ],
  };
  const listed = value(listTemplates(state, actor(4, "pm"))).data.templates;
  expect(listed.find((t) => t.id === "dev")).toMatchObject({
    version: 2,
    work_items: [
      { kind: "produce" },
      {
        completion_criteria:
          developmentCardTemplateV2.work_items[1].completion_criteria,
      },
    ],
  });
  expect(listed.find((t) => t.id === "product")?.work_items).toHaveLength(3);
});
