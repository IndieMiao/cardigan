/** C-751: comments that need someone to act must name them. */
import { COMMENT_HANDOFF_RULE, toolNames } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  composeRolePrompt,
  corePromptFor,
  DEFAULT_ROLE_KINDS,
  type DefaultRoleId,
  PM_UNNAMED_REQUEST_RULE,
  SHARED_BOUNDARIES,
} from "./index.js";

const roles = Object.keys(DEFAULT_ROLE_KINDS) as DefaultRoleId[];

test("the naming rule says who to name, how, and what an unnamed comment is", () => {
  for (const phrase of [
    "需要别人行动、决定或回复的内容，必须点名具体对象",
    "`mentions` 字段填 Assignment 编号（A-n）或员工名",
    "被阻塞用 `report_blocker`",
    "不点名的评论只是记录，不保证有人看到",
    "代码块、行内代码或引用块里的点名不生效",
  ])
    expect(COMMENT_HANDOFF_RULE).toContain(phrase);
  // Rule text never writes the at sign (C-269).
  expect(COMMENT_HANDOFF_RULE).not.toContain("@");
  const referenced = [...COMMENT_HANDOFF_RULE.matchAll(/`([a-z_]+)`/g)].map(
    (m) => m[1],
  );
  expect(referenced).toEqual([
    "post_comment",
    "mentions",
    "report_blocker",
    "request_human_action",
  ]);
  // Existing tools only.
  const known = new Set<string>(toolNames);
  for (const tool of ["post_comment", "report_blocker", "request_human_action"])
    expect(known.has(tool)).toBe(true);
});

test.each(roles)("%s core prompt carries the naming rule once", (role) => {
  expect(SHARED_BOUNDARIES).toContain(COMMENT_HANDOFF_RULE);
  expect(corePromptFor(role).split(`- ${COMMENT_HANDOFF_RULE}`)).toHaveLength(
    2,
  );
});

test("a project-registered role gets the rule without re-registering", () => {
  // Stored instructions hold only the role's own text; the shared rules are
  // composed in at every launch.
  const prompt = composeRolePrompt("# 角色：PM\n\n- 项目附加规则。");
  expect(prompt.split(`- ${COMMENT_HANDOFF_RULE}`)).toHaveLength(2);
});

test("pm names the target of an unnamed request on the author's behalf", () => {
  for (const phrase of [
    "请别人行动、决定或回复却没有点名",
    "替作者补上点名",
    "`reply_to` 回复原评论一句",
    "`mentions` 字段填这个具体对象（A-n 或员工名）",
  ])
    expect(PM_UNNAMED_REQUEST_RULE).toContain(phrase);
  expect(PM_UNNAMED_REQUEST_RULE).not.toContain("@");
  expect(
    corePromptFor("pm").split(`- ${PM_UNNAMED_REQUEST_RULE}`),
  ).toHaveLength(2);
  for (const role of roles.filter((role) => role !== "pm"))
    expect(corePromptFor(role)).not.toContain(PM_UNNAMED_REQUEST_RULE);
});

test("no keyword detection or self-declared field is introduced", () => {
  for (const text of [COMMENT_HANDOFF_RULE, PM_UNNAMED_REQUEST_RULE])
    expect(text).not.toContain("no_handoff");
});
