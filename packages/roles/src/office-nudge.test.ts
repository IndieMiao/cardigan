/** C-740: PM Office checks live status before telling the owner something waits. */
import { toolNames } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  PM_OFFICE_NUDGE_RULES,
} from "./index.js";

const OFFICE = "## PM Office（前台）";
const OPS = "## PM Ops（后台）";
const pm = corePromptFor("pm");
const officeSection = pm.slice(pm.indexOf(OFFICE), pm.indexOf(OPS));

test("the check-before-nudging rule sits in the PM Office section once", () => {
  expect(PM_OFFICE_NUDGE_RULES).toHaveLength(1);
  for (const rule of PM_OFFICE_NUDGE_RULES) {
    expect(pm.split(rule)).toHaveLength(2);
    expect(officeSection).toContain(`- ${rule}`);
    expect(pm.slice(pm.indexOf(OPS))).not.toContain(rule);
  }
});

test("the rule asks for a live check and drops settled questions", () => {
  const text = PM_OFFICE_NUDGE_RULES.join("\n");
  for (const phrase of ["“某事在等你”之前", "先实时查", "已结案的不再催"])
    expect(text).toContain(phrase);
  const known = new Set<string>(toolNames);
  const referenced = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  // Existing read tools only; no new tool or permission.
  expect(referenced).toEqual(["list_needs_you", "get_card"]);
  for (const name of referenced) expect(known.has(name as string)).toBe(true);
});

test.each(
  (Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]).filter(
    (role) => role !== "pm",
  ),
)("%s core prompt does not carry the Office nudge rule", (role) => {
  const prompt = corePromptFor(role);
  for (const rule of PM_OFFICE_NUDGE_RULES) expect(prompt).not.toContain(rule);
});
