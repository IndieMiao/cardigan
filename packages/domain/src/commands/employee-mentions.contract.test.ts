import { expect, test } from "vitest";
import { type Employee, postComment } from "../index.js";
import { commentMentions } from "../mentions.js";
import {
  actor,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const employee = (name: string, n = 1): Employee => ({
  id: id("employee", n),
  name,
  title: "开发",
  bio: "",
  avatar: null,
  role_id: "coder",
  launch_profile_ref: null,
  status: "active",
  created_at: now,
  updated_at: now,
});
const employees = [
  employee("Mary Jane"),
  employee("诸葛亮", 2),
  employee("Mary", 3),
];
const comment = (body: string, mentions: string[] = []) =>
  value(
    postComment(
      { ...fixture(), employees },
      human,
      { card_id: id("card", 1), body, mentions },
      ports(),
    ),
  );

test("invariant 3: body targets share parsing with names and roles, preserving explicit mentions", () => {
  expect(
    comment("请 (@A-2)、@W-3 与 @reviewer、@Mary Jane 看一下 @A-2", [
      "A-2",
      "reviewer",
    ]).data?.mentions,
  ).toEqual(["A-2", "reviewer", "@W-3", "@Mary Jane"]);
  expect(
    comment("mail@A-2 x@W-3 @@A-2 @A-2suffix @W-3_abc @A-4-5").data?.mentions,
  ).toEqual([]);
  expect(comment("@a-2 @w-3").data?.mentions).toEqual(["@A-2", "@W-3"]);
});

test.each([human, actor()])(
  "employee parsing uses stored identities and preserves the authenticated author ($kind)",
  (who) => {
    const body = "请 @MARY　JANE、@诸葛亮 与 @reviewer 看一下";
    const result = value(
      postComment(
        { ...fixture(), employees },
        who,
        {
          card_id: id("card", 1),
          body,
          mentions: ["MARY", "reviewer", "@A-2", "@W-3"],
        },
        ports(),
      ),
    );
    expect(result.data?.mentions).toEqual([
      "reviewer",
      "@A-2",
      "@W-3",
      "@Mary Jane",
      "@诸葛亮",
    ]);
    expect(result.data?.body).toBe(body);
    expect(result.data?.author).toBe(
      who.kind === "human" ? "human" : "assignment:A-1",
    );
    expect(result.changes).toEqual([]);
    expect(result.events).toHaveLength(1);
  },
);

test("unknown, inactive and partial names are ordinary text; email addresses do not mention employees", () => {
  const result = value(
    postComment(
      {
        ...fixture(),
        employees: [
          employee("Mary"),
          { ...employee("退役", 2), status: "inactive" },
        ],
      },
      human,
      {
        card_id: id("card", 1),
        body: "@Nobody @退役 mail@Mary @Maryland",
        mentions: ["Nobody", "退役"],
      },
      ports(),
    ),
  );
  expect(result.data?.mentions).toEqual([]);
});

test("longest complete name wins over an old client's truncated ASCII token", () => {
  expect(comment("@Mary Jane，检查", ["Mary"]).data?.mentions).toEqual([
    "@Mary Jane",
  ]);
  expect(comment("@Mary Jane 和 @Mary", ["Mary"]).data?.mentions).toEqual([
    "Mary",
    "@Mary Jane",
  ]);
  expect(comment("@　mArY　jAnE　", ["@  mary jane "]).data?.mentions).toEqual([
    "@  mary jane ",
  ]);
});

test("names containing punctuation are matched literally; role and explicit targets remain supported", () => {
  const result = value(
    postComment(
      { ...fixture(), employees: [employee("A.* (开发)")] },
      human,
      {
        card_id: id("card", 1),
        body: "@A.* (开发)，请看 @coder",
        mentions: ["A", "@W-1", "@A-2", "@coder"],
      },
      ports(),
    ),
  );
  expect(result.data?.mentions).toEqual([
    "@W-1",
    "@A-2",
    "@coder",
    "@A.* (开发)",
  ]);
});

test("C-751: names in code blocks, inline code and quote lines are not mentions", () => {
  const body = [
    "> @A-7 请处理（引用原评论）",
    "  > > @诸葛亮 嵌套引用",
    "```",
    "@A-8 @reviewer",
    "```",
    "",
    "    @A-9 缩进代码",
    "",
    "行内 `@Mary Jane` 和 [链接](mailto:x@A-10) 不算；",
    "请 @A-2 和 @诸葛亮 处理",
  ].join("\n");
  expect(comment(body).data?.mentions).toEqual(["@A-2", "@诸葛亮"]);
  // The text itself is kept as written.
  expect(comment(body).data?.body).toBe(body);
});

test("C-751: the explicit mentions field still works for anything quoted in the body", () => {
  expect(
    comment("> @A-7 请处理\n`@reviewer`", ["A-7", "reviewer"]).data?.mentions,
  ).toEqual(["A-7", "reviewer"]);
});

test("C-751: a comment and its story answers are read part by part", () => {
  // An unclosed fence in one part never hides a name in the next.
  expect(
    commentMentions(
      ["```\n@A-8 还没闭合", "请 @A-2 看", "> @A-9"],
      [],
      employees,
      ["reviewer"],
    ),
  ).toEqual(["@A-2"]);
  expect(commentMentions("```\n@A-8\n请 @A-2", [], employees, [])).toEqual([]);
});
