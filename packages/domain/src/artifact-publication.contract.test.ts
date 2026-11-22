import { expect, test } from "vitest";
import {
  approvesPublication,
  holdsPublicationTool,
} from "./artifact-publication.js";
import { human, id, now, ports } from "./commands/test-fixtures.js";
import type { Attachment, Decision, Event } from "./entities.js";
import { standingTools } from "./standing.js";

const project = human.project_id,
  c = id("card", 1),
  digest = "a".repeat(64),
  key = id("decision", 1);
const a: Attachment = {
  kind: "evidence",
  id: "attachment-1",
  card_id: c,
  sha256: digest,
  size: 5,
  storage_path: "",
  mime: "application/octet-stream",
  uploaded_by: "human",
  attach_to: {
    kind: "timeline_entry",
    id: ports().ids.nextTimelineEntryId(project, c),
  },
};
const resolution = {
  option: "publish",
  rationale: "yes",
  via: "needs_you",
  resolved_by: "human",
  via_chain: [],
  raw_quote: "yes",
  at: now,
} as const;
const q: Decision = {
  id: key,
  key,
  card_id: c,
  category: "publish",
  kind: "approve",
  status: "resolved",
  target: { subject: { kind: "artifact_sha256", value: digest } },
  attachment_ids: [a.id],
  options: [{ key: "publish", description: "发布", impact: "公开" }],
  recommended: "publish",
  question: "发布？",
  context: "测试站",
  affected_cards: [c],
  affected_work_items: [],
  raised_by: "human",
  decider: "human",
  blocking: false,
  doc_refs: [],
  resolution,
};
test("only a resolved per-APK publish approval is consent", () => {
  const check = (decision: Decision | undefined) =>
    approvesPublication(project, a, decision, undefined, []);
  expect(check(q)).toBe(true);
  for (const invalid of [
    undefined,
    { ...q, category: "general" },
    { ...q, status: "open" },
    { ...q, kind: "choose" },
    { ...q, card_id: id("card", 2) },
    { ...q, attachment_ids: ["other"] },
    {
      ...q,
      target: { subject: { kind: "artifact_sha256", value: "b".repeat(64) } },
    },
    { ...q, resolution: { ...resolution, option: "reject" } },
    { ...q, resolution: { ...resolution, via: "pm_office_chat" } },
  ] as const)
    expect(check(invalid)).toBe(false);
});
test("delegated consent expires with the original human authorization, including revoke and regrant", () => {
  const e: Event = {
    id: ports().ids.nextEventId(),
    seq: 1,
    actor: human,
    type: "project_preferences_updated",
    payload: {
      preference: "decision_delegation",
      old_value: { publish: false },
      new_value: { publish: true },
    },
    created_at: now,
  };
  const prefs = {
    id: project,
    auto_merge_after_minutes: null,
    decision_delegation: { publish: true },
  };
  const delegated: Decision = {
    ...q,
    decider: "role:pm",
    resolution: {
      ...resolution,
      resolved_by: `assignment:${id("assignment", 1)}`,
      via: "delegated",
      proxy_authority: `project:${project}/decision_delegation/publish/event:${e.id}`,
    },
  };
  expect(approvesPublication(project, a, delegated, prefs, [e])).toBe(true);
  expect(approvesPublication(project, a, delegated, prefs, [])).toBe(false);
  expect(
    approvesPublication(
      project,
      a,
      delegated,
      { ...prefs, decision_delegation: { publish: false } },
      [e],
    ),
  ).toBe(false);
  expect(
    approvesPublication(project, a, delegated, prefs, [
      { ...e, id: `new-${e.id}` as Event["id"] },
    ]),
  ).toBe(false);
});
test("PM work-item and Ops are not publishers", () => {
  for (const [role_id, scope, standing_mode, allowed] of [
    ["pm", "standing", "office", true],
    ["pm", "standing", "ops", false],
    ["pm", "work_item", "office", false],
    ["host_ops", "standing", "office", false],
    ["release_ops", "work_item", "", true],
  ] as const)
    expect(holdsPublicationTool({ role_id, scope, standing_mode })).toBe(
      allowed,
    );
  expect(standingTools(["publish_artifact"], "ops")).toEqual([]);
});
