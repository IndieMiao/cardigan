// @vitest-environment jsdom
/**
 * C-514: `@` in the comment box suggests the project's employees (avatar, name,
 * title), the card's own people first; typing filters, the keyboard chooses,
 * and `@<name>` is inserted for the server's employee routing. Roles and
 * Assignments are no longer offered (typing them by hand still works).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { CommentInput, MentionCandidate } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import {
  CommentBox,
  insertMention,
  matchMentionCandidates,
  mentionQuery,
  orderMentionCandidates,
} from "./CommentBox.js";

afterEach(cleanup);

const person = (
  id: string,
  name: string,
  title: string,
  related = false,
): MentionCandidate => ({
  id,
  name,
  title,
  avatar: id === "E-1" ? "/avatars/v1/liu-bang/head-64.webp" : null,
  related,
});
const EMPLOYEES = [
  person("E-4", "张良", "平台负责人"),
  person("E-1", "森·刘邦", "游戏程序", true),
  person("E-3", "Bob", "测试"),
  person("E-2", "薛宝钗", "前端工程师", true),
  person("E-5", "bobby", "设计"),
];

function setup(
  read: (cardId: string) => Promise<{ employees: MentionCandidate[] }> = () =>
    Promise.resolve({ employees: EMPLOYEES }),
) {
  const reads: string[] = [];
  const posted: CommentInput[] = [];
  render(
    <CommentBox
      client={fakeClient({
        mentionCandidates: async (_projectId, cardId) => {
          reads.push(cardId);
          return read(cardId);
        },
        addComment: async (_projectId, _cardId, input) => {
          posted.push(input);
          return { id: "C-1#9", body: input.body, created_at: "2026-01-01" };
        },
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  const type = (value: string) =>
    fireEvent.change(input, { target: { value } });
  const names = () =>
    screen
      .queryAllByRole("option")
      .map((o) => o.querySelector(".ui-suggestion-label")?.textContent);
  return { input, type, names, reads, posted };
}

test("the placeholder names employees instead of roles or Assignments", () => {
  const { input } = setup();
  expect(input.placeholder).toBe("支持 Markdown；@ 提及员工；可以直接粘贴图片");
});

test("typing @ reads the card's candidates and lists avatar, name and title, card people first", async () => {
  const { input, type, names, reads } = setup();
  expect(reads).toEqual([]);
  type("请 @");
  expect(screen.getByRole("listbox").textContent).toBe("正在加载员工…");
  await waitFor(() => expect(names()).toHaveLength(5));
  expect(reads).toEqual(["C-1"]);
  // Related first (by name), then everyone else by name.
  expect(names()).toEqual(["森·刘邦", "薛宝钗", "张良", "Bob", "bobby"]);
  const list = screen.getByRole("listbox", { name: "提及员工" });
  expect(list.id).toBe(input.getAttribute("aria-controls"));
  const first = screen.getAllByRole("option")[0];
  expect(first?.textContent).toContain("游戏程序");
  expect(first?.querySelector("img")?.getAttribute("src")).toBe(
    "/avatars/v1/liu-bang/head-64.webp",
  );
  // No avatar: the initial instead.
  expect(screen.getAllByRole("option")[3]?.textContent).toBe("BBob测试");
  expect(screen.queryByText(/角色|Assignment/)).toBeNull();
  // Typing within the same `@` reads nothing more.
  type("请 @森");
  expect(names()).toEqual(["森·刘邦"]);
  expect(reads).toEqual(["C-1"]);
});

test("every new @ re-reads, so employees who joined, left or were renamed show up on the same card", async () => {
  let roster = EMPLOYEES;
  const { input, type, names, reads } = setup(async () => ({
    employees: roster,
  }));
  type("@");
  await waitFor(() => expect(names()).toHaveLength(5));
  fireEvent.keyDown(input, { key: "Escape" });
  roster = [person("E-6", "王姐", "运营"), person("E-7", "Ann", "测试")];
  type("@ @");
  // The previous list stays up while the new read is under way.
  expect(names()).toHaveLength(5);
  await waitFor(() => expect(names()).toEqual(["王姐", "Ann"]));
  expect(reads).toEqual(["C-1", "C-1"]);
});

test("typed characters filter by name, ignoring case; no match closes the list", async () => {
  const { type, names } = setup();
  type("@");
  await waitFor(() => expect(names()).toHaveLength(5));
  type("@BO");
  expect(names()).toEqual(["Bob", "bobby"]);
  type("@宝");
  expect(names()).toEqual(["薛宝钗"]);
  type("@A-12");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("arrow keys move the active option (wrapping), Enter inserts @name and the post routes it", async () => {
  const { input, type, names, posted } = setup();
  type("看过了 @b");
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  const active = () =>
    document.getElementById(input.getAttribute("aria-activedescendant") ?? "")
      ?.textContent;
  expect(active()).toBe("BBob测试");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active()).toBe("Bbobby设计");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(active()).toBe("BBob测试");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(active()).toBe("Bbobby设计");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("看过了 @bobby ");
  expect(input.selectionStart).toBe(input.value.length);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({
    body: "看过了 @bobby ",
    mentions: ["bobby"],
  });
});

test("clicking an option inserts it at the caret and keeps the text after it", async () => {
  const { input, type, names } = setup();
  type("你好@薛 请看");
  // The caret sits right after the query, before the rest of the sentence.
  act(() => input.setSelectionRange(4, 4));
  fireEvent.select(input);
  await waitFor(() => expect(names()).toEqual(["薛宝钗"]));
  const option = screen.getByRole("option");
  fireEvent.mouseDown(option);
  fireEvent.mouseUp(option);
  fireEvent.click(option);
  // A space keeps the `@` readable by the server after a Chinese character.
  expect(input.value).toBe("你好 @薛宝钗 请看");
  expect(input.selectionStart).toBe("你好 @薛宝钗 ".length);
  expect(document.activeElement).toBe(input);
});

test("Escape closes the list until a new @, and hand-typed @role / @A-n are left alone", async () => {
  const { input, type, names } = setup();
  type("@");
  await waitFor(() => expect(names()).toHaveLength(5));
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  type("@s");
  expect(screen.queryByRole("listbox")).toBeNull();
  type("@s @");
  expect(names()).toHaveLength(5);
  // Without matching employees, Enter is a plain newline for the text.
  type("x @reviewer");
  const enter = fireEvent.keyDown(input, { key: "Enter" });
  expect(enter).toBe(true);
  expect(input.value).toBe("x @reviewer");
});

test("Escape on one comment does not hold back the list for the next comment", async () => {
  const { input, type, names, posted } = setup();
  type("@Bob");
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  await waitFor(() => expect(input.value).toBe(""));
  act(() => input.focus());
  type("@");
  await waitFor(() => expect(names()).toHaveLength(5));
});

test("a name with spaces keeps filtering; a finished mention lets the text go on", async () => {
  const { input, type, names } = setup(async () => ({
    employees: [
      person("E-8", "Mary Jane", "设计"),
      person("E-9", "Mary Jo", "测试"),
      person("E-3", "Bob", "测试"),
      person("E-10", "Bob Smith", "运维"),
    ],
  }));
  type("@Mary");
  await waitFor(() => expect(names()).toEqual(["Mary Jane", "Mary Jo"]));
  type("@Mary J");
  expect(names()).toEqual(["Mary Jane", "Mary Jo"]);
  type("@Mary Ja");
  expect(names()).toEqual(["Mary Jane"]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("@Mary Jane ");
  // Text after a finished mention is plain text again.
  type("@Mary Jane 你好");
  expect(screen.queryByRole("listbox")).toBeNull();
  // A full name and a space finish the mention even if a longer name starts
  // with it, so Enter stays a newline.
  type("@Mary Jane 你好 @Bob ");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  type("@Mary Jane 你好 @Bob S");
  expect(names()).toEqual(["Bob Smith"]);
});

test("choosing with the caret inside an existing mention replaces the whole name", async () => {
  const { input, type, names } = setup();
  type("@Bob 请看");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  act(() => input.setSelectionRange(2, 2));
  fireEvent.select(input);
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("@bobby 请看");
  expect(input.selectionStart).toBe("@bobby ".length);
});

test("a failed read is shown in the list and retried at the next @", async () => {
  let fail = true;
  const { type, names, reads } = setup(async () => {
    if (fail) throw new Error("网络中断");
    return { employees: EMPLOYEES };
  });
  type("@");
  await waitFor(() =>
    expect(screen.getByRole("listbox").textContent).toBe(
      "未能加载员工：网络中断",
    ),
  );
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  fail = false;
  type("@ @");
  await waitFor(() => expect(names()).toHaveLength(5));
  expect(reads).toEqual(["C-1", "C-1"]);
});

test("mentionQuery finds the @query before the caret, never inside an e-mail", () => {
  expect(mentionQuery("请 @薛", 4)).toEqual({ start: 2, query: "薛", end: 4 });
  expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "", end: 1 });
  expect(mentionQuery("你好@", 3)).toEqual({ start: 2, query: "", end: 3 });
  expect(mentionQuery("@薛宝钗 ", 5)).toBeUndefined();
  expect(mentionQuery("@ 你好", 4)).toBeUndefined();
  expect(mentionQuery("@a\nb", 4)).toBeUndefined();
  expect(mentionQuery("foo@bar", 7)).toBeUndefined();
  expect(mentionQuery("text", 4)).toBeUndefined();
});

test("mentionQuery lets a query hold spaces only while it matches a name", () => {
  const roster = [
    person("E-8", "Mary Jane", "设计"),
    person("E-3", "Bob", "测试"),
  ];
  expect(mentionQuery("@Mary J", 7, roster)).toEqual({
    start: 0,
    query: "Mary J",
    end: 7,
  });
  expect(mentionQuery("@Mary J", 7)).toBeUndefined();
  expect(mentionQuery("@Mary X", 7, roster)).toBeUndefined();
  expect(mentionQuery("@Mary Jane ", 11, roster)).toBeUndefined();
  expect(mentionQuery("@bob ", 5, roster)).toBeUndefined();
});

test("mentionQuery ends the replaced text after a name or Latin word under the caret", () => {
  const roster = [
    person("E-2", "薛宝钗", "前端工程师"),
    person("E-3", "Bob", "测试"),
  ];
  // A name the text already spells, Han or Latin.
  expect(mentionQuery("@薛宝钗请看", 3, roster)?.end).toBe(4);
  expect(mentionQuery("@Bob，你好", 2, roster)?.end).toBe(4);
  // An unknown Latin word: up to its end.
  expect(mentionQuery("@Bobx ok", 2, roster)?.end).toBe(5);
  // A known name must end the Latin word to count.
  expect(mentionQuery("@Bobx ok", 1, roster)?.end).toBe(1);
  // Running Han text without a known name: only up to the caret.
  expect(mentionQuery("请@看", 2, roster)?.end).toBe(2);
});

test("candidates order card people first, then by name; filtering keeps that order", () => {
  const ordered = orderMentionCandidates(EMPLOYEES);
  // Chinese collation: names by pinyin, Latin names after Han ones.
  expect(ordered.map((c) => c.id)).toEqual(["E-1", "E-2", "E-4", "E-3", "E-5"]);
  expect(EMPLOYEES[0]?.id).toBe("E-4");
  expect(matchMentionCandidates(ordered, "B").map((c) => c.id)).toEqual([
    "E-3",
    "E-5",
  ]);
  expect(matchMentionCandidates(ordered, "")).toHaveLength(5);
});

test("insertMention replaces the query, adds a needed leading space and one trailing space", () => {
  expect(
    insertMention("请 @薛", { start: 2, query: "薛", end: 4 }, "薛宝钗"),
  ).toEqual({ body: "请 @薛宝钗 ", caret: 7 });
  expect(
    insertMention("你好@", { start: 2, query: "", end: 3 }, "张良"),
  ).toEqual({ body: "你好 @张良 ", caret: 7 });
  // Text already followed by a space: no second space, caret after it.
  expect(
    insertMention("@B 请看", { start: 0, query: "B", end: 2 }, "Bob"),
  ).toEqual({ body: "@Bob 请看", caret: 5 });
  // The rest of an existing mention, up to `end`, is replaced as well.
  expect(
    insertMention("@Bob 请看", { start: 0, query: "B", end: 4 }, "Bob"),
  ).toEqual({ body: "@Bob 请看", caret: 5 });
  expect(
    insertMention("请@看", { start: 1, query: "", end: 2 }, "张良"),
  ).toEqual({ body: "请 @张良 看", caret: 6 });
});
