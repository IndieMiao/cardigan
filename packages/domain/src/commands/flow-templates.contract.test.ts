import { expect, test } from "vitest";
import * as flow from "../flow.js";
import {
  builtinCardTemplates,
  builtinCardTemplatesForFlow,
  builtinCardTemplateVersions,
  type CardTemplate,
  cardTemplate,
  developmentCardTemplate,
  developmentCardTemplateV2,
  fastPatchCardTemplate,
  productCardTemplate,
  uiCardTemplate,
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
  role,
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
  roles: [
    ...fixture().roles,
    role("frontend_engineer"),
    role("design_director"),
  ],
  cards: [],
  work_items: [],
  assignments: [],
  runs: [],
});

test("flow 5 registers new defaults while historical templates remain exact", () => {
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
  expect(flow.validFlowVersion(5)).toBe(true);
  expect(builtinCardTemplatesForFlow(4)).not.toContain(
    developmentCardTemplateV2,
  );
  expect(builtinCardTemplatesForFlow(5)).toEqual(
    expect.arrayContaining([developmentCardTemplateV2, productCardTemplate]),
  );
});

test.each([
  developmentCardTemplateV2,
  productCardTemplate,
  fastPatchCardTemplate,
  uiCardTemplate,
])(
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

async function registeredCard(
  template: CardTemplate,
  risk = false,
  evidence = pathEvidence(),
  paths?: readonly string[],
) {
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
      ...(paths ? { high_risk_paths: paths } : {}),
    })),
  };
  state = apply(
    state,
    value(
      createCard(
        state,
        human,
        {
          ...params,
          template_id: template.id,
          ...(template.id === "ui"
            ? { state_and_save: "无写入" as const }
            : {}),
        },
        io,
      ),
    ),
  );
  const card = state.cards[0];
  const producer = state.work_items[0];
  if (!card || !producer) throw new Error("Missing generated card");
  state = {
    ...state,
    cards: [
      {
        ...card,
        status: "in_progress",
        ...(risk
          ? { risk_tags: ["permission"], high_risk: true as const }
          : {}),
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
    await prepareDelivery(state, actor(1, producer.role_id), deliveryParams, {
      verify: async () => ({ ok: true, value: evidence }),
    }),
  );
  const delivered = value(
    submitDelivery(
      state,
      actor(1, producer.role_id),
      deliveryParams,
      proof,
      io,
    ),
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
    setPaths(paths: readonly string[]) {
      state = {
        ...state,
        project_preferences: (state.project_preferences ?? []).map((p) => ({
          ...p,
          high_risk_paths: paths,
        })),
      };
    },
  };
}

test("new effective risk paths upgrade an accepted fast patch and revoke its pending completion exactly once", async () => {
  const f = await registeredCard(fastPatchCardTemplate);
  const completion = f.complete();
  expect(completion?.status).toBe("accepted");
  f.setPaths(["packages/domain/**"]);
  expect(f.complete()).toBeNull();
  expect(f.state.cards[0]).toMatchObject({
    template: "dev",
    template_version: 2,
  });
  expect(f.state.cards[0]?.status).not.toBe("awaiting_merge");
  expect(f.state.deliveries.find((v) => v.id === completion?.id)?.status).toBe(
    "superseded",
  );
  expect(f.state.deliveries.find((v) => v.id === f.delivered.id)).toMatchObject(
    { status: "submitted", requested_verifiers: expect.any(Array) },
  );
  expect(f.state.work_items.filter((w) => w.kind === "verify")).toHaveLength(2);
  const identities = f.state.work_items.map((w) => [w.id, w.assignment_id]);
  expect(f.complete()).toBeNull();
  expect(f.state.work_items.map((w) => [w.id, w.assignment_id])).toEqual(
    identities,
  );
  expect(
    f.state.events.filter((e) => e.type === "fast_patch_upgraded"),
  ).toHaveLength(1);
});

test("fast_patch has one producer and system completion still waits for the merge gate", async () => {
  const f = await registeredCard(fastPatchCardTemplate);
  expect(f.state.work_items.map((w) => w.kind)).toEqual(["produce"]);
  expect(f.delivered.status).toBe("accepted");
  expect(f.delivered.requested_verifiers).toEqual([]);
  expect(f.complete()?.status).toBe("accepted");
  expect(f.state.reviews).toEqual([]);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(f.complete()).toBeNull();
});

test("fast_patch keeps same-SHA precheck enforcement and uses the configured paths", async () => {
  const custom = await registeredCard(
    fastPatchCardTemplate,
    false,
    pathEvidence(["custom/secret.ts"]),
    ["custom/**"],
  );
  expect(custom.delivered.status).toBe("submitted");
  const disabled = await registeredCard(
    fastPatchCardTemplate,
    false,
    pathEvidence(["packages/host/src/deployment.ts"]),
    [],
  );
  expect(disabled.delivered.status).toBe("accepted");
  const invalid = await registeredCard(
    fastPatchCardTemplate,
    false,
    pathEvidence(),
    ["../escape"],
  );
  expect(invalid.state.cards[0]?.template).toBe("dev");
  const p = {
    work_item_id: disabled.delivered.work_item_id,
    kind: "code" as const,
    summary: "Another patch",
    subject,
    requested_verifiers: [],
  };
  const verifier = {
    verify: async () => ({ ok: true as const, value: pathEvidence() }),
  };
  expect(
    await prepareDelivery(
      { ...disabled.state, project_settings: { merge_gate_enabled: true } },
      actor(),
      p,
      verifier,
    ),
  ).toMatchObject({ ok: false, error: { message: "请先 request_check" } });
});

test.each(["manual", "path", "unknown"])(
  "fast_patch upgrades atomically for %s risk and preserves the producer identity",
  async (risk) => {
    const evidence =
      risk === "unknown"
        ? []
        : risk === "path"
          ? pathEvidence(["packages/host/src/deployment.ts"])
          : pathEvidence();
    const f = await registeredCard(
      fastPatchCardTemplate,
      risk === "manual",
      evidence,
    );
    expect(f.state.cards[0]).toMatchObject({
      template: "dev",
      template_version: 2,
      flow_version: 5,
    });
    expect(f.delivered.status).toBe("submitted");
    expect(f.state.work_items.find((w) => w.kind === "produce")).toMatchObject({
      assignment_id: "A-1",
      status: "delivered",
    });
    const reviewers = f.state.work_items.filter((w) => w.kind === "verify");
    expect(reviewers.map((w) => w.role_id)).toEqual([
      "reviewer",
      "independent_reviewer",
    ]);
    expect(
      reviewers.every(
        (w) => w.required && w.target_work_item_id === f.delivered.work_item_id,
      ),
    ).toBe(true);
    expect(f.delivered.requested_verifiers).toEqual(reviewers.map((w) => w.id));
    expect(
      f.state.events.filter((e) => e.type === "fast_patch_upgraded"),
    ).toMatchObject([{ actor: { kind: "system" } }]);
    expect(f.state.events.some((e) => e.type === "delivery_accepted")).toBe(
      false,
    );
    for (let i = 0; i < 2; i++) expect(f.complete()).toBeNull();
    expect(f.state.work_items).toHaveLength(3);
    expect(f.state.assignments).toHaveLength(1);
  },
);

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

test.each([1, 2, 3, 4, 5])(
  "flow %s selects registered builtins over legacy stored defaults",
  (version) => {
    const state: CommandState = {
      ...initial(),
      card_templates: [...builtinCardTemplates],
      project_preferences: [
        {
          id: human.project_id,
          auto_merge_after_minutes: null,
          flow_version: version,
          system_merge_shadow_policy: {
            role_rule_paths: [],
            release_paths: [],
          },
        },
      ],
    };
    const created = value(createCard(state, human, params, ports()));
    expect(created.data).toMatchObject({
      flow_version: version,
      template: "dev",
      template_version: version === 5 ? 2 : 1,
    });
    expect(
      created.changes.filter((c) => c.collection === "work_items"),
    ).toHaveLength(version === 5 ? 2 : 3);
    const listed = value(listTemplates(state, human)).data.templates;
    expect(listed.find((t) => t.id === "dev")?.version).toBe(
      version === 5 ? 2 : 1,
    );
    expect(listed.some((t) => t.id === "product")).toBe(version === 5);
    expect(listed.some((t) => t.id === "ui")).toBe(version === 5);
    expect(state.card_templates).toEqual(builtinCardTemplates);
  },
);

test("UI creation requires an explicit state and save contract without adding a review", () => {
  const state: CommandState = {
    ...initial(),
    project_preferences: [
      {
        id: initial().project_id,
        flow_version: 5,
        auto_merge_after_minutes: null,
      },
    ],
  };
  const input = { ...params, template: "ui" };
  expect(
    value(listTemplates(state, human)).data.templates.find(
      (t) => t.id === "ui",
    ),
  ).toMatchObject({ requires_state_and_save: true });
  expect(createCard(state, human, input, ports())).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("纯展示填“无写入”") },
  });
  const plan = {
    save_timing: "按组保存",
    leave_behavior: "允许离开",
    failure_feedback: "全站提示一次",
    consistency: "写后补读",
  };
  for (const [key, label] of [
    ["save_timing", "保存时机"],
    ["leave_behavior", "离页行为"],
    ["failure_feedback", "失败提示"],
    ["consistency", "读写一致性"],
  ] as const) {
    expect(
      createCard(
        state,
        human,
        { ...input, state_and_save: { ...plan, [key]: " \t" } },
        ports(),
      ),
    ).toMatchObject({
      ok: false,
      error: { message: `状态与保存：请填写${label}` },
    });
  }
  const create = (state_and_save: typeof plan | "无写入") =>
    value(createCard(state, human, { ...input, state_and_save }, ports()));
  const write = create(plan);
  expect(write.data.state_and_save).toEqual(plan);
  const criteria = (e: typeof write) =>
    e.changes
      .filter((c) => c.collection === "work_items")
      .map((c) => c.entity.completion_criteria);
  const [producer, director, reviewer] = criteria(write);
  for (const criterion of [producer?.at(-1), director?.at(-1)]) {
    for (const value of Object.values(plan)) expect(criterion).toContain(value);
  }
  const display = create("无写入");
  expect(display.data.state_and_save).toBe("无写入");
  expect(criteria(display)).toEqual(
    uiCardTemplate.work_items.map((w) => [
      ...params.acceptance_criteria,
      ...w.completion_criteria,
    ]),
  );
  expect(reviewer).toEqual(criteria(display)[2]);
});

test("ui@1 binds both required reviews to the frontend delivery before system completion", async () => {
  const f = await registeredCard(uiCardTemplate);
  expect(f.card).toMatchObject({
    template: "ui",
    template_version: 1,
    flow_version: 5,
  });
  expect(f.state.work_items.map((w) => w.role_id)).toEqual([
    "frontend_engineer",
    "design_director",
    "reviewer",
  ]);
  const verifiers = f.state.work_items.filter((w) => w.kind === "verify");
  expect(
    verifiers.every(
      (w) => w.required && w.target_work_item_id === f.delivered.work_item_id,
    ),
  ).toBe(true);
  expect(f.delivered.requested_verifiers).toEqual(verifiers.map((w) => w.id));
  expect(verifiers[0]?.completion_criteria.join(" ")).toContain(
    "docs/design/ui-guidelines.md",
  );
  expect(verifiers[0]?.completion_criteria.join(" ")).toContain("基准截图");
  expect(f.complete()).toBeNull();
  f.review(f.delivered.id, 2, "design_director");
  expect(f.complete()).toBeNull();
  expect(f.state.deliveries.find((d) => d.id === f.delivered.id)?.status).toBe(
    "submitted",
  );
  f.review(f.delivered.id, 3, "reviewer");
  expect(f.complete()).toMatchObject({
    status: "accepted",
    requested_verifiers: [],
  });
  expect(f.state.reviews).toHaveLength(2);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(f.complete()).toBeNull();
});

test("ui registration cannot rewrite existing cards or enter a legacy flow", () => {
  expect(cardTemplate({ template: "ui", template_version: 1 })).toEqual(
    uiCardTemplate,
  );
  const state = { ...initial(), card_templates: [uiCardTemplate] };
  const before = structuredClone(state);
  expect(
    createCard(state, human, { ...params, template_id: "ui" }, ports()),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("第五级"),
    },
  });
  expect(state).toEqual(before);
  expect(cardTemplate({ template: "product", template_version: 1 })).toEqual(
    productCardTemplate,
  );
});
