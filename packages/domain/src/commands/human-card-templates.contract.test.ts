import { expect, test } from "vitest";
import type { Actor } from "../entities.js";
import type { Result } from "../errors.js";
import {
  DEFAULT_HUMAN_CARD_TEMPLATES,
  humanCardTemplates,
} from "../preferences.js";
import { postComment } from "./coordination.js";
import type { CommandEffect, CommandState } from "./core.js";
import { type CreateCardParams, createCard, createHumanCard } from "./pm.js";
import { projectPreferences, setProjectPreferences } from "./preferences.js";
import { confirmStoryProposal } from "./story-proposal.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

// C-684: people open story cards by default; the human widens it per template.
const office = actor(4, "pm");
const params = (template_id: string): CreateCardParams => ({
  template_id,
  title: "Request",
  goal: "Rough need",
  acceptance_criteria: ["Works"],
  source: { kind: "quote", text: "Rough need" },
  repo: "example/repo",
  base_branch: "main",
});

function setup() {
  let state: CommandState = fixture();
  state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.scope === "standing" ? { ...a, standing_mode: "office" } : a,
    ),
  };
  const p = ports();
  const commit = <T>(result: Result<CommandEffect<T>>) => {
    const effect = value(result);
    state = apply(state, effect);
    return effect;
  };
  const open = (template_id: string, by: Actor = human) =>
    createHumanCard(state, by, params(template_id), p);
  const allow = (patch: Record<string, boolean>, by: Actor = human) =>
    setProjectPreferences(state, by, { human_card_templates: patch }, p);
  return {
    p,
    commit,
    open,
    allow,
    get state() {
      return state;
    },
  };
}

test("a person may open only the story template until the human opens others", () => {
  const f = setup();
  expect(humanCardTemplates()).toEqual(["story"]);
  expect(DEFAULT_HUMAN_CARD_TEMPLATES).toEqual(["story"]);
  const story = f.commit(f.open("story")).data;
  expect(story).toMatchObject({ template: "story", story: {} });
  // The Office decomposition item exists, so the existing story flow starts.
  expect(
    f.state.work_items.find(
      (w) => w.card_id === story.id && w.template_key === "decomposition",
    ),
  ).toMatchObject({ role_id: "pm" });
  for (const template of ["general", "dev", "design"]) {
    const rejected = f.open(template);
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    if (!rejected.ok) {
      expect(rejected.error.message).toContain("人只能开需求卡");
      expect(rejected.error.message).toContain("人可开的卡片模板");
    }
  }
  // Rejection leaves no card behind.
  expect(f.state.cards.filter((c) => c.template !== "dev")).toHaveLength(1);
});

test("opening a template lets people use it; closing it again restores the limit", () => {
  const f = setup();
  const opened = f.commit(f.allow({ general: true }));
  expect(humanCardTemplates(projectPreferences(f.state))).toEqual([
    "story",
    "general",
  ]);
  expect(opened.events).toEqual([
    expect.objectContaining({
      type: "project_preferences_updated",
      payload: {
        old_value: ["story"],
        new_value: ["story", "general"],
        preference: "human_card_templates",
      },
    }),
  ]);
  expect(f.commit(f.open("general")).data.template).toBe("general");
  expect(f.open("dev").ok).toBe(false);
  // Only the listed template changes; others opened meanwhile stay open.
  f.commit(f.allow({ dev: true }));
  f.commit(f.allow({ general: false }));
  expect(humanCardTemplates(projectPreferences(f.state))).toEqual([
    "story",
    "dev",
  ]);
  expect(f.open("general").ok).toBe(false);
  expect(f.commit(f.open("dev")).data.template).toBe("dev");
  // Repeating the current value changes nothing and records nothing.
  expect(f.commit(f.allow({ dev: true })).events).toEqual([]);
});

test("the story template cannot be closed, and only the human may change the list", () => {
  const f = setup();
  expect(f.allow({ story: false })).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(f.allow({ "Not An Id": true })).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  expect(f.allow({ general: true }, office)).toMatchObject({
    ok: false,
    error: { code: "forbidden_tool" },
  });
  expect(projectPreferences(f.state).human_card_templates).toBeUndefined();
});

test("Agents, PM and story children opened from a proposal are not limited", () => {
  const f = setup();
  // The PM opens any template, through either entry point.
  expect(f.commit(f.open("general", office)).data.template).toBe("general");
  expect(
    f.commit(createCard(f.state, office, params("dev"), f.p)).data.template,
  ).toBe("dev");
  // Plain createCard (fixtures, internal callers) keeps its old behaviour.
  expect(
    f.commit(createCard(f.state, human, params("general"), f.p)).data.template,
  ).toBe("general");
  const story = f.commit(f.open("story")).data;
  f.commit(
    postComment(
      f.state,
      office,
      {
        card_id: story.id,
        body: "拆解",
        story_discussion: {
          action: "propose",
          children: [
            {
              title: "Child",
              template_id: "general",
              goal: "Child goal",
              acceptance_criteria: ["Child works"],
              owner_role: "coder",
            },
          ],
        },
      },
      f.p,
    ),
  );
  // The person confirms; the child uses a template people may not open.
  const confirmed = f.commit(
    confirmStoryProposal(
      f.state,
      human,
      { card_id: story.id, version: 1 },
      f.p,
    ),
  );
  expect(confirmed.data.card_ids).toHaveLength(1);
  expect(
    f.state.cards.find((c) => c.id === confirmed.data.card_ids[0]),
  ).toMatchObject({ template: "general", parent_card_id: story.id });
});
