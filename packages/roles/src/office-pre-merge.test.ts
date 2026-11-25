/** C-744: PM Office records its pre-merge checks in the turn acceptance passes. */
import { toolNames } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  PM_OFFICE_PRE_MERGE_RULES,
} from "./index.js";

const OFFICE = "## PM Office（前台）";
const OPS = "## PM Ops（后台）";
const pm = corePromptFor("pm");
const officeSection = pm.slice(pm.indexOf(OFFICE), pm.indexOf(OPS));

test("the same-turn pre-merge rule sits in the PM Office section once", () => {
  expect(PM_OFFICE_PRE_MERGE_RULES).toHaveLength(1);
  for (const rule of PM_OFFICE_PRE_MERGE_RULES) {
    expect(pm.split(rule)).toHaveLength(2);
    expect(officeSection).toContain(`- ${rule}`);
    expect(pm.slice(pm.indexOf(OPS))).not.toContain(rule);
  }
});

test("the rule asks for the checks in the same turn, not after the merge check", () => {
  const text = PM_OFFICE_PRE_MERGE_RULES.join("\n");
  for (const phrase of ["审核和验收都通过", "同一轮", "不要等合并检查结果"])
    expect(text).toContain(phrase);
  const known = new Set<string>(toolNames);
  const referenced = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  // An existing PM tool and its existing field; no new tool or permission.
  expect(referenced).toEqual(["update_card", "pre_merge_check"]);
  expect(known.has("update_card")).toBe(true);
});

test.each(
  (Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]).filter(
    (role) => role !== "pm",
  ),
)("%s core prompt does not carry the Office pre-merge rule", (role) => {
  const prompt = corePromptFor(role);
  for (const rule of PM_OFFICE_PRE_MERGE_RULES)
    expect(prompt).not.toContain(rule);
});
