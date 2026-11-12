import { describe, expect, test } from "vitest";
import type { RoleReference } from "../entities.js";
import { ROLE_TOOL_ALLOWLISTS, type RoleKind } from "../role.js";
import {
  artifactCardTemplate,
  builtinCardTemplates,
  type CardTemplate,
  designCardTemplate,
} from "../templates.js";
import type { CommandState } from "./core.js";
import { createCard } from "./pm.js";
import { manageCardTemplate } from "./templates.js";
import { fixture, human, ports, value } from "./test-fixtures.js";

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
const state = (
  roles: readonly RoleReference[] = designRoles,
  card_templates: readonly CardTemplate[] = [],
): CommandState => ({
  ...fixture(),
  roles,
  card_templates,
  cards: [],
  work_items: [],
  assignments: [],
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
      {
        key: "pm_acceptance",
        kind: "verify",
        role_id: "pm",
        required: true,
        target: null,
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
      { kind: "verify", role_id: "pm", template_key: "pm_acceptance" },
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
