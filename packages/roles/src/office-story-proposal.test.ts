/** C-748: PM Office reads the story card before saying a proposal still waits. */
import { toolNames } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  PM_OFFICE_STORY_PROPOSAL_RULES,
} from "./index.js";

const OFFICE = "## PM Office（前台）";
const OPS = "## PM Ops（后台）";
const pm = corePromptFor("pm");
const officeSection = pm.slice(pm.indexOf(OFFICE), pm.indexOf(OPS));

test("the proposal check rule sits in the PM Office section once", () => {
  expect(PM_OFFICE_STORY_PROPOSAL_RULES).toHaveLength(1);
  for (const rule of PM_OFFICE_STORY_PROPOSAL_RULES) {
    expect(pm.split(rule)).toHaveLength(2);
    expect(officeSection).toContain(`- ${rule}`);
    expect(pm.slice(pm.indexOf(OPS))).not.toContain(rule);
  }
});

test("the rule reads the story card first and drops confirmed proposals", () => {
  const text = PM_OFFICE_STORY_PROPOSAL_RULES.join("\n");
  for (const phrase of [
    "“某拆解方案在等你确认”之前",
    "读需求卡最新状态",
    "已确认拆解方案第 N 版",
    "不再催",
  ])
    expect(text).toContain(phrase);
  const known = new Set<string>(toolNames);
  const referenced = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  // An existing read tool and the event it shows; no new tool or permission.
  expect(referenced).toEqual(["get_card", "story_proposal_confirmed"]);
  expect(known.has("get_card")).toBe(true);
});

test.each(
  (Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]).filter(
    (role) => role !== "pm",
  ),
)("%s core prompt does not carry the Office proposal rule", (role) => {
  const prompt = corePromptFor(role);
  for (const rule of PM_OFFICE_STORY_PROPOSAL_RULES)
    expect(prompt).not.toContain(rule);
});
