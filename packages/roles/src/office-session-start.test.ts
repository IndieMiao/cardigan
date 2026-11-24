/** C-723: PM Office reads the project changes when a session starts. */
import { toolNames } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  AGENT_PROTOCOL,
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  PM_OFFICE_SESSION_START_RULES,
} from "./index.js";

const OFFICE = "## PM Office（前台）";
const OPS = "## PM Ops（后台）";
const pm = corePromptFor("pm");
const officeSection = pm.slice(pm.indexOf(OFFICE), pm.indexOf(OPS));
const outsideOffice = pm.replace(officeSection, "");

test("the session-start rules open the PM Office section", () => {
  expect(PM_OFFICE_SESSION_START_RULES).toHaveLength(3);
  expect(officeSection.startsWith(OFFICE)).toBe(true);
  expect(
    officeSection.startsWith(
      [
        OFFICE,
        "",
        ...PM_OFFICE_SESSION_START_RULES.map((line) => `- ${line}`),
      ].join("\n"),
    ),
  ).toBe(true);
});

test.each(PM_OFFICE_SESSION_START_RULES.map((rule, i) => ({ rule, n: i + 1 })))(
  "rule $n appears once, inside the Office section only",
  ({ rule }) => {
    expect(pm.split(rule)).toHaveLength(2);
    expect(officeSection).toContain(`- ${rule}`);
    expect(outsideOffice).not.toContain(rule);
    expect(pm.slice(pm.indexOf(OPS))).not.toContain(rule);
  },
);

test.each(
  (Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[]).filter(
    (role) => role !== "pm",
  ),
)("%s core prompt carries none of the Office session-start rules", (role) => {
  const prompt = corePromptFor(role);
  for (const rule of PM_OFFICE_SESSION_START_RULES)
    expect(prompt).not.toContain(rule);
  expect(prompt).not.toContain("office_digest");
});

test("the rules only time existing tools and stay a hint, scoped to this project", () => {
  const text = PM_OFFICE_SESSION_START_RULES.join("\n");
  const known = new Set<string>(toolNames);
  const referenced = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  const tools = referenced.filter((name) => known.has(name as string));
  expect(tools).toEqual(["get_updates", "project_snapshot", "ack_events"]);
  // Every other backticked name is a field of the C-722 read, not a tool.
  expect(referenced.filter((name) => !known.has(name as string))).toEqual([
    "card_id",
    "events",
    "office_digest",
    "office_digest",
    "omitted",
  ]);
  for (const phrase of [
    "回应人之前先调用不带 `card_id` 的 `get_updates`",
    "不是门禁",
    "人有急事时先回应，再补读",
    "变动摘要只含本项目",
    "找对应项目的 PM Office，或用跨卡读取",
    "不主动订阅其它项目",
  ])
    expect(text).toContain(phrase);
});

test("the shared §6.3 protocol is unchanged and still closes every prompt", () => {
  for (const role of Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[])
    for (const line of AGENT_PROTOCOL)
      expect(corePromptFor(role), role).toContain(line);
  const protocol = AGENT_PROTOCOL.join("\n");
  for (const rule of PM_OFFICE_SESSION_START_RULES)
    expect(protocol).not.toContain(rule);
});
