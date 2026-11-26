import {
  type Assignment,
  createCard,
  markCardDone,
  type ProjectId,
  STORY_SUMMARY_ESCALATED,
  STORY_SUMMARY_HANDED_OFF,
} from "@cardigan/domain";
import { defaultRoleDefinition } from "@cardigan/roles";
import { writeRole } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { standingResolver } from "./assembly.js";
import { notificationOwner, routeProjectEvents } from "./dispatch-inbox.js";
import { runSystemRules } from "./system-rules.js";

const HANDOFF_MS = 60_000;
let f: ReturnType<typeof dispatchFixture>;
const other = "story-other-project" as ProjectId;

function standing(
  project: ProjectId,
  standing_mode: "office" | "ops",
  external: boolean,
) {
  return f.store.uow.run((tx) => {
    const a: Assignment = {
      id: tx.ids.next(project, "assignment"),
      scope: "standing",
      standing_mode,
      role_id: "pm",
      role_version: 1,
      status: "active",
      runtime_state: "not_provisioned",
      runtime_ref: null,
      machine_id: "local",
      mcp_token_id: `${project}-${standing_mode}`,
      created_at: f.clock.now(),
      ...(external ? { external: true } : {}),
    };
    tx.assignments.put(project, a);
    return a;
  });
}

const role = {
  ...defaultRoleDefinition("pm", {
    harness: "pi",
    launch_profile_ref: "fixture",
  }),
  version: 1,
  core_prompt: "Fixture",
  worktree: "none" as const,
};

beforeEach(() => {
  f = dispatchFixture();
  f.store.createProject({ id: other, name: "Other" });
  f.store.uow.run((tx) => {
    for (const project of [f.project, other])
      writeRole(tx, project, role, { mode: "add" });
  });
});
afterEach(() => f.close());

function settledStory() {
  const request = (template_id: string, parent_card_id?: string) =>
    f.apply((s, a, p) =>
      createCard(
        s,
        a,
        {
          template_id,
          title: template_id,
          goal: "Need",
          source: { kind: "quote", text: "Need" },
          ...(parent_card_id
            ? { parent_card_id: parent_card_id as never }
            : {}),
        },
        p,
      ),
    );
  const story = request("story");
  const child = request("general", story.id);
  f.apply((s, a, p) =>
    markCardDone(s, a, { card_id: child.id, result: "Shipped" }, p),
  );
  return story;
}

const tick = () => {
  runSystemRules(f.store, f.project, f.clock, undefined, undefined, {
    storySummaryHandoffMs: HANDOFF_MS,
  });
  runSystemRules(f.store, other, f.clock, undefined, undefined, {
    storySummaryHandoffMs: HANDOFF_MS,
  });
  routeProjectEvents(f.store, f.project);
  routeProjectEvents(f.store, other);
};
/** Stored notifications of this project produced by events of `type`. */
const notes = (project: ProjectId, type: string) => {
  const ids = new Set(
    f
      .state()
      .events.filter((e) => e.type === type)
      .map((e) => e.id as string),
  );
  return f.store
    .listNotifications({ project_id: project })
    .filter((n) => ids.has(n.event_id));
};
const events = (type: string) =>
  f.state().events.filter((e) => e.type === type);

test("C-762: an external Office's settled story reaches Needs You, then PM Ops after the configured wait; the other project hears nothing", () => {
  const office = standing(f.project, "office", true);
  const ops = standing(f.project, "ops", false);
  standing(other, "office", true);
  standing(other, "ops", false);
  const story = settledStory();
  tick();
  expect(events(STORY_SUMMARY_ESCALATED)).toHaveLength(1);
  expect(notes(f.project, "story_children_settled")).toMatchObject([
    { recipient: { kind: "pm_office" }, card_id: story.id },
  ]);
  expect(notes(f.project, STORY_SUMMARY_ESCALATED)).toMatchObject([
    { recipient: { kind: "needs_you" }, card_id: story.id },
  ]);
  const resolver = standingResolver(f.store);
  const [settled] = notes(f.project, "story_children_settled");
  if (!settled) throw new Error("missing Office note");
  expect(notificationOwner(settled, f.state(), resolver)).toBe(office.id);

  f.advance(HANDOFF_MS - 1);
  tick();
  expect(events(STORY_SUMMARY_HANDED_OFF)).toEqual([]);
  f.advance(1);
  tick();
  tick();
  expect(events(STORY_SUMMARY_HANDED_OFF)).toHaveLength(1);
  const handoff = notes(f.project, STORY_SUMMARY_HANDED_OFF);
  expect(handoff).toMatchObject([
    { recipient: { kind: "pm_ops" }, card_id: story.id },
  ]);
  if (!handoff[0]) throw new Error("missing handoff note");
  expect(notificationOwner(handoff[0], f.state(), resolver)).toBe(ops.id);

  // No cross-project delivery: the other project's external Office has no
  // notification at all (Assignment ids are per project, so compare inboxes).
  expect(f.store.listNotifications({ project_id: other })).toEqual([]);
  expect(f.state().cards.find((c) => c.id === story.id)?.status).not.toBe(
    "done",
  );
});

test("C-762: a resident (non-external) Office keeps today's single Office note", () => {
  standing(f.project, "office", false);
  standing(f.project, "ops", false);
  settledStory();
  tick();
  f.advance(10 * HANDOFF_MS);
  tick();
  expect(events(STORY_SUMMARY_ESCALATED)).toEqual([]);
  expect(events(STORY_SUMMARY_HANDED_OFF)).toEqual([]);
  expect(notes(f.project, "story_children_settled")).toMatchObject([
    { recipient: { kind: "pm_office" } },
  ]);
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.recipient.kind === "needs_you"),
  ).toEqual([]);
});
