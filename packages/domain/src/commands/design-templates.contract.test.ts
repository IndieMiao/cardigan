import { describe, expect, test } from "vitest";
import type {
  Actor,
  Assignment,
  RoleReference,
  WorkItem,
} from "../entities.js";
import { ROLE_TOOL_ALLOWLISTS, type RoleKind } from "../role.js";
import {
  artifactCardTemplate,
  builtinCardTemplates,
  type CardTemplate,
  designCardTemplate,
} from "../templates.js";
import { autoMergeSchedule } from "./auto-merge.js";
import { recordDecision, resolveDelegatedDecision } from "./coordination.js";
import type { CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { HUMAN_COMPLETION_REASON } from "./human-completion.js";
import { createCard, updateCard } from "./pm.js";
import { manageCardTemplate } from "./templates.js";
import {
  actor,
  apply,
  assignment,
  card,
  fixture,
  human,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

// Mirrors the default pack (packages/roles): produce roles hold
// submit_delivery, verify roles hold submit_review, never both.
const packRole = (
  role_id: string,
  kind: Exclude<RoleKind, "standing">,
): RoleReference => ({
  role_id,
  role_version: 1,
  allowed_tools: ROLE_TOOL_ALLOWLISTS[kind],
  capabilities: [kind],
});
const designRoles = [
  packRole("ui_ux_designer", "produce"),
  packRole("design_director", "verify"),
  packRole("pm", "verify"),
];
// A standing PM Ops whose role may resolve delegated decisions.
const pmOps: Assignment = {
  ...(({ work_item_id: _w, ...rest }) => rest)(assignment(9, "pm")),
  scope: "standing",
  standing_mode: "ops",
};
// A standing PM Office that may transcribe ordinary human decisions.
const pmOffice: Assignment = {
  ...pmOps,
  id: assignment(8, "pm").id,
  standing_mode: "office",
};
const state = (
  roles: readonly RoleReference[] = designRoles,
  card_templates: readonly CardTemplate[] = [],
  withOps = false,
): CommandState => ({
  ...fixture(),
  roles,
  card_templates,
  cards: [card(2)],
  work_items: [],
  assignments: withOps ? [pmOps, pmOffice] : [],
  runs: [],
});
const params = {
  title: "Settings page",
  goal: "Design the settings page",
  acceptance_criteria: ["Every state is drawn"],
  source: { kind: "quote" as const, text: "Design the settings page" },
};
const workItems = (s: CommandState, template_id: string) =>
  value(createCard(s, human, { ...params, template_id }, ports()))
    .changes.filter((c) => c.collection === "work_items")
    .map((c) => c.entity);

describe("design template (p2v-12 §2.4)", () => {
  test("is a builtin with the planned structure", () => {
    expect(builtinCardTemplates).toContain(designCardTemplate);
    expect(designCardTemplate).toMatchObject({
      id: "design",
      version: 1,
      builtin: true,
      status: "active",
      requires_repo: false,
      merge: "none",
      require_acceptance_criteria: true,
      primary_work_item_key: "design_production",
      completion: { mode: "review", reviewer: "human" },
    });
    expect(
      designCardTemplate.work_items.map((w) => ({
        key: w.key,
        kind: w.kind,
        role_id: w.role_id,
        required: w.required,
        target: "target_work_item_key" in w ? w.target_work_item_key : null,
      })),
    ).toEqual([
      {
        key: "design_production",
        kind: "produce",
        role_id: "ui_ux_designer",
        required: true,
        target: null,
      },
      {
        key: "design_review",
        kind: "verify",
        role_id: "design_director",
        required: true,
        target: "design_production",
      },
    ]);
  });

  test("creates a card wired to the design roles without a repository", () => {
    const s = state();
    const created = value(
      createCard(s, human, { ...params, template_id: "design" }, ports()),
    );
    expect(created.data).toMatchObject({
      template: "design",
      template_version: 1,
      merge_policy: "none",
    });
    const items = workItems(s, "design");
    expect(items).toMatchObject([
      {
        kind: "produce",
        role_id: "ui_ux_designer",
        template_key: "design_production",
      },
      {
        kind: "verify",
        role_id: "design_director",
        template_key: "design_review",
      },
    ]);
    const [production, review] = items as { id: string }[];
    expect(review).toMatchObject({ target_work_item_id: production?.id });
  });

  test("requires acceptance criteria", () => {
    expect(
      createCard(
        state(),
        human,
        { ...params, template_id: "design", acceptance_criteria: [] },
        ports(),
      ).ok,
    ).toBe(false);
  });

  test.each([
    ["designer registered as verify", packRole("ui_ux_designer", "verify")],
    ["director registered as produce", packRole("design_director", "produce")],
  ])("rejects the template when the %s", (_label, wrong) => {
    const roles = designRoles.map((r) =>
      r.role_id === wrong.role_id ? wrong : r,
    );
    expect(
      createCard(
        state(roles),
        human,
        { ...params, template_id: "design" },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });

  test("rejects the template when a design role is not registered", () => {
    for (const missing of ["ui_ux_designer", "design_director"])
      expect(
        createCard(
          state(designRoles.filter((r) => r.role_id !== missing)),
          human,
          { ...params, template_id: "design" },
          ports(),
        ).ok,
      ).toBe(false);
  });

  test("cannot be overwritten in place", () => {
    expect(
      manageCardTemplate(
        state(),
        human,
        { action: "update", definition: designCardTemplate },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  });
});

describe("design template flow (p2v-12 §2.4)", () => {
  // The real builtin template, default-pack-shaped roles and independent
  // designer/director Assignments: no stub items, no follow-up cards.
  const start = (withOps = false) => {
    const p = ports();
    const base = state(designRoles, [], withOps);
    const created = value(
      createCard(base, human, { ...params, template_id: "design" }, p),
    );
    let s = apply(base, created);
    const items = s.work_items.filter((w) => w.card_id === created.data.id);
    const production = items.find((w) => w.kind === "produce") as WorkItem;
    const review = items.find((w) => w.kind === "verify") as WorkItem;
    const bind = (item: WorkItem, n: number, role_id: string) => ({
      ...assignment(n, role_id),
      work_item_id: item.id,
    });
    s = {
      ...s,
      work_items: s.work_items.map((w) =>
        w.id === production.id
          ? { ...w, status: "in_progress", assignment_id: bind(w, 1, "").id }
          : w.id === review.id
            ? { ...w, status: "ready", assignment_id: bind(w, 2, "").id }
            : w,
      ) as WorkItem[],
      assignments: [
        ...s.assignments,
        bind(production, 1, "ui_ux_designer"),
        bind(review, 2, "design_director"),
      ],
      runs: [run(1), run(2)],
    };
    return { p, card_id: created.data.id, production, review, state: s };
  };
  const designer = actor(1, "ui_ux_designer");
  const director = actor(2, "design_director");

  test("director pass, completion request and human approval finish a risk-tagged card", async () => {
    let { p, card_id, production, review, state: s } = start();
    s = apply(
      s,
      value(updateCard(s, human, { card_id, risk_tags: ["security"] }, p)),
    );
    const deliver = async (params: Parameters<typeof prepareDelivery>[2]) => {
      const verified = value(
        await prepareDelivery(s, designer, params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      const effect = value(submitDelivery(s, designer, params, verified, p));
      s = apply(s, effect);
      return effect.data;
    };
    const subject = { kind: "doc_version" as const, value: "design-v1" };
    const draft = await deliver({
      work_item_id: production.id,
      kind: "design",
      summary: "Settings page draft",
      subject,
      requested_verifiers: [review.id],
    });
    s = apply(
      s,
      value(
        submitReview(
          s,
          director,
          {
            delivery_id: draft.id,
            target_sha: subject.value,
            kind: "design",
            issues: [],
          },
          p,
        ),
      ),
    );
    expect(s.work_items.find((w) => w.id === review.id)?.status).toBe("passed");
    // No verifier is requested: the human completion review is the acceptance.
    await deliver({
      work_item_id: production.id,
      kind: "card_completion",
      plain_summary: TEST_PLAIN_SUMMARY,
      summary: "Ready for approval",
      subject,
      requested_verifiers: [],
    });
    const decision = s.decisions.find(
      (d) => d.status === "open" && d.decider === "human",
    );
    if (!decision) throw new Error("Missing human completion review");
    expect(decision).toMatchObject({ trigger: "completion_review" });
    const decisionParams = {
      decision_id: decision.id,
      rationale: "Looks right",
      raw_quote: "通过",
    };
    // Human rejection sends the card back for rework.
    s = apply(
      s,
      value(
        recordDecision(s, human, { ...decisionParams, option: "reject" }, p),
      ),
    );
    expect(s.cards.find((c) => c.id === card_id)?.status).toBe("in_progress");
    await deliver({
      work_item_id: production.id,
      kind: "card_completion",
      plain_summary: TEST_PLAIN_SUMMARY,
      summary: "Ready for approval again",
      subject,
      requested_verifiers: [],
    });
    const retry = s.decisions.find(
      (d) => d.status === "open" && d.trigger === "completion_review",
    );
    if (!retry) throw new Error("Missing retry completion review");
    s = apply(
      s,
      value(
        recordDecision(
          s,
          human,
          {
            ...decisionParams,
            decision_id: retry.id,
            option: "approve",
          },
          p,
        ),
      ),
    );
    expect(s.cards.find((c) => c.id === card_id)).toMatchObject({
      status: "done",
      resolution: "done",
    });
  });

  const flow = (withOps = false) => {
    const started = start(withOps);
    let s = started.state;
    const subject = { kind: "doc_version" as const, value: "design-v1" };
    const deliver = async (params: Parameters<typeof prepareDelivery>[2]) => {
      const verified = value(
        await prepareDelivery(s, designer, params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      return submitDelivery(s, designer, params, verified, started.p);
    };
    const commit = <T>(r: ReturnType<typeof submitDelivery> | T) => r;
    return {
      ...started,
      subject,
      get state() {
        return s;
      },
      set state(next: CommandState) {
        s = next;
      },
      deliver,
      commit,
      completion: (extra: object = {}) => ({
        work_item_id: started.production.id,
        kind: "card_completion" as const,
        plain_summary: TEST_PLAIN_SUMMARY,
        summary: "Ready for approval",
        subject,
        requested_verifiers: [],
        ...extra,
      }),
      design: {
        work_item_id: started.production.id,
        kind: "design" as const,
        summary: "Settings page draft",
        subject,
        requested_verifiers: [started.review.id],
      },
    };
  };

  test("the completion request is refused until the director passes, even with a known gap", async () => {
    const f = flow();
    f.state = apply(f.state, value(await f.deliver(f.design)));
    for (const extra of [
      {},
      {
        known_gaps: [
          {
            description: "Director review later",
            precondition: `work_item:${f.review.id}`,
            followup_card_id: card(2).id,
          },
        ],
      },
    ])
      expect(await f.deliver(f.completion(extra))).toMatchObject({
        ok: false,
        error: {
          code: "invariant_violation",
          message: expect.stringContaining("必需验证项"),
        },
      });
    expect(f.state.decisions).toEqual([]);
  });

  test.each(["produce", "verify"] as const)(
    "prioritizes mandatory director review with the %s item first, even when all gaps are declared",
    async (first) => {
      const f = flow();
      f.state = apply(f.state, value(await f.deliver(f.design)));
      f.state = {
        ...f.state,
        work_items: [...f.state.work_items].sort(
          (a, b) => Number(b.kind === first) - Number(a.kind === first),
        ),
      };
      expect(f.state.work_items[0]?.kind).toBe(first);
      for (const known_gaps of [
        [],
        [f.production, f.review].map((w) => ({
          description: "Finish later",
          precondition: `work_item:${w.id}`,
          followup_card_id: card(2).id,
        })),
      ])
        expect(await f.deliver(f.completion({ known_gaps }))).toMatchObject({
          ok: false,
          error: {
            code: "invariant_violation",
            message: `人验收的完成申请须等必需验证项通过后再提交：${f.review.id}`,
          },
        });
      expect(f.state.decisions).toEqual([]);
    },
  );

  test("the human completion review stays with the human when PM Ops may take feature details", async () => {
    const f = flow(true);
    f.state = apply(f.state, value(await f.deliver(f.design)));
    f.state = apply(
      f.state,
      value(
        submitReview(
          f.state,
          director,
          {
            delivery_id: f.state.deliveries[0]?.id as never,
            target_sha: f.subject.value,
            kind: "design",
            issues: [],
          },
          f.p,
        ),
      ),
    );
    f.state = apply(f.state, value(await f.deliver(f.completion())));
    const decision = f.state.decisions.find(
      (q) => q.trigger === "completion_review",
    );
    if (!decision) throw new Error("Missing human completion review");
    // feature_detail is delegable by default and PM Ops is active, yet the
    // template's human reviewer is kept.
    expect(decision).toMatchObject({
      category: "feature_detail",
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      human_required_reason: HUMAN_COMPLETION_REASON,
    });
    expect(decision.delegation_authority).toBeUndefined();
    const ops: Actor = {
      kind: "assignment",
      project_id: human.project_id,
      assignment_id: pmOps.id,
      ...packRole("pm", "verify"),
    };
    expect(
      resolveDelegatedDecision(
        f.state,
        ops,
        { decision_id: decision.id, option: "approve", rationale: "Fine" },
        f.p,
      ).ok,
    ).toBe(false);
    // PM Office (record_decision) and PM Ops cannot record it either, and a
    // refusal leaves no partial effect.
    const recordAs = (assignment_id: Assignment["id"]): Actor => ({
      kind: "assignment",
      project_id: human.project_id,
      assignment_id,
      ...packRole("pm", "verify"),
      allowed_tools: [
        ...packRole("pm", "verify").allowed_tools,
        "record_decision",
      ],
    });
    const answer = {
      decision_id: decision.id,
      option: "approve",
      rationale: "Fine",
      raw_quote: "通过",
    };
    const before = JSON.stringify(f.state);
    for (const who of [pmOffice.id, pmOps.id])
      expect(recordDecision(f.state, recordAs(who), answer, f.p)).toMatchObject(
        {
          ok: false,
          error: { code: "forbidden_tool" },
        },
      );
    expect(JSON.stringify(f.state)).toBe(before);
    const approved = apply(
      f.state,
      value(recordDecision(f.state, human, answer, f.p)),
    );
    expect(approved.cards.find((c) => c.id === f.card_id)).toMatchObject({
      status: "done",
    });
    expect(
      approved.decisions.find((q) => q.id === decision.id)?.resolution,
    ).toMatchObject({ resolved_by: "human" });
    // Never eligible for timeout approval either.
    expect(
      autoMergeSchedule(
        {
          ...f.state,
          project_preferences: [
            { id: human.project_id, auto_merge_after_minutes: 1 } as never,
          ],
        },
        decision.id,
      ).ok,
    ).toBe(false);
  });
});

describe("artifact template default producer (p2v-12 §2.3)", () => {
  test("defaults to ui_ux_designer, which the default pack can produce with", () => {
    expect(artifactCardTemplate.work_items[0]).toMatchObject({
      kind: "produce",
      role_id: "ui_ux_designer",
    });
    expect(workItems(state(), "artifact")[0]).toMatchObject({
      kind: "produce",
      role_id: "ui_ux_designer",
      template_key: "production",
    });
  });

  test("an old project keeps creating artifact cards with its stored v1 and produce designer", () => {
    // What seedCardTemplates stored before V12a: artifact v1 producing with
    // `designer`, plus a project-registered produce `designer` role.
    const storedV1: CardTemplate = {
      ...artifactCardTemplate,
      work_items: [
        { ...artifactCardTemplate.work_items[0], role_id: "designer" },
        artifactCardTemplate.work_items[1],
      ],
    };
    const old = state(
      [packRole("designer", "produce"), packRole("pm", "verify")],
      [storedV1],
    );
    const created = value(
      createCard(old, human, { ...params, template_id: "artifact" }, ports()),
    );
    expect(created.data).toMatchObject({
      template: "artifact",
      template_version: 1,
    });
    expect(workItems(old, "artifact")).toMatchObject([
      { kind: "produce", role_id: "designer", template_key: "production" },
      { kind: "verify", role_id: "pm", template_key: "pm_acceptance" },
    ]);
  });

  test("legacy roles without capabilities still create artifact cards from the stored v1", () => {
    const legacy = (role_id: string): RoleReference => ({
      role_id,
      role_version: 1,
      allowed_tools: ["whoami"],
      capabilities: [],
    });
    const storedV1: CardTemplate = {
      ...artifactCardTemplate,
      work_items: [
        { ...artifactCardTemplate.work_items[0], role_id: "designer" },
        artifactCardTemplate.work_items[1],
      ],
    };
    expect(
      createCard(
        state([legacy("designer"), legacy("pm")], [storedV1]),
        human,
        { ...params, template_id: "artifact" },
        ports(),
      ).ok,
    ).toBe(true);
  });
});
