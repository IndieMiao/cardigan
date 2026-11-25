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
  followChosen,
  followTyped,
  inputEdit,
  insertMention,
  matchMentionCandidates,
  mentionQuery,
  NO_MEMORY,
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
  const setValue = (value: string) =>
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, value);
  /** Change the text with the caret left at `caret`, without `beforeinput`. */
  const typeAt = (value: string, caret: number) => {
    setValue(value);
    input.setSelectionRange(caret, caret);
    fireEvent.input(input);
  };
  /**
   * Insert `text` over the selection as a browser does: the native
   * `beforeinput` first, then the new text and the `input` event.
   */
  const insert = (text: string, inputType = "insertText") => {
    const { selectionStart: start, selectionEnd: end, value } = input;
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType,
        data: text,
        bubbles: true,
        cancelable: true,
      }),
    );
    setValue(value.slice(0, start) + text + value.slice(end));
    input.setSelectionRange(start + text.length, start + text.length);
    fireEvent.input(input);
  };
  /** Type `text` key by key. */
  const typeKeys = (text: string) => {
    for (const key of text) insert(key);
  };
  /** Backspace with a collapsed caret, as a browser does. */
  const backspace = () => {
    const { selectionStart: caret, value } = input;
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        cancelable: true,
      }),
    );
    setValue(value.slice(0, caret - 1) + value.slice(caret));
    input.setSelectionRange(caret - 1, caret - 1);
    fireEvent.input(input);
  };
  const moveTo = (start: number, end = start) => {
    act(() => input.setSelectionRange(start, end));
    fireEvent.select(input);
  };
  const click = (name: string) => {
    const option = screen
      .getAllByRole("option")
      .find(
        (o) => o.querySelector(".ui-suggestion-label")?.textContent === name,
      );
    if (!option) throw new Error(`no option ${name}`);
    fireEvent.mouseDown(option);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
  };
  const names = () =>
    screen
      .queryAllByRole("option")
      .map((o) => o.querySelector(".ui-suggestion-label")?.textContent);
  return {
    input,
    type,
    typeAt,
    insert,
    typeKeys,
    backspace,
    moveTo,
    click,
    names,
    reads,
    posted,
  };
}

test("the placeholder names employees instead of roles or Assignments", () => {
  const { input } = setup();
  expect(input.placeholder).toBe(
    "支持 Markdown；@ 提及员工；# 引用附件；可以粘贴图片或拖入文件",
  );
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
  let roster: Promise<{ employees: MentionCandidate[] }> = Promise.resolve({
    employees: EMPLOYEES,
  });
  const { input, type, names, reads, posted } = setup(() => roster);
  type("@");
  await waitFor(() => expect(names()).toHaveLength(5));
  fireEvent.keyDown(input, { key: "Escape" });
  type("@ 现在");
  let answer: (value: { employees: MentionCandidate[] }) => void = () => {};
  roster = new Promise((resolve) => {
    answer = resolve;
  });
  type("@ 现在 @B");
  expect(reads).toEqual(["C-1", "C-1"]);
  // Until the new read answers, the old names cannot be chosen.
  expect(screen.getByRole("listbox").textContent).toBe("正在加载员工…");
  expect(names()).toEqual([]);
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  expect(input.value).toBe("@ 现在 @B");
  await act(async () =>
    answer({
      employees: [person("E-6", "王姐", "运营"), person("E-7", "Ann", "测试")],
    }),
  );
  // Bob has left: nothing matches, and he can no longer be posted.
  expect(screen.queryByRole("listbox")).toBeNull();
  type("@ 现在 @B @");
  await waitFor(() => expect(names()).toEqual(["王姐", "Ann"]));
  expect(reads).toEqual(["C-1", "C-1", "C-1"]);
  expect(posted).toEqual([]);
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
  await waitFor(() => expect(names()).toHaveLength(5));
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
  await waitFor(() => expect(names()).toEqual(["Bob Smith"]));
});

const MINGMING = [person("E-8", "明明", "运营"), ...EMPLOYEES];

/** Q-1047: names a following file name could complete. */
const SMITH = [
  person("E-2", "薛宝钗", "前端工程师", true),
  person("E-3", "Bob", "测试"),
  person("E-9", "Bobby", "设计"),
  person("E-10", "Bob Smith", "运维"),
  person("E-11", "Bo Smith", "运营"),
];

/** Q-1043: Bob and Bobby to complete and then swap, by whole sequences. */
const SWAP = [
  person("E-1", "森·刘邦", "游戏程序", true),
  person("E-2", "薛宝钗", "前端工程师", true),
  person("E-8", "明明", "运营"),
  person("E-3", "Bob", "测试"),
  person("E-9", "Bobby", "设计"),
];

for (const how of ["keyboard", "click"] as const) {
  const sequence = (roster = SWAP) => {
    const box = setup(async () => ({ employees: roster }));
    /** Choose `name` from the open list, by arrow keys and Enter or a click. */
    const pick = async (name: string) => {
      await waitFor(() => expect(box.names()).toContain(name));
      if (how === "click") return box.click(name);
      for (let i = 0; i < box.names().indexOf(name); i++)
        fireEvent.keyDown(box.input, { key: "ArrowDown" });
      fireEvent.keyDown(box.input, { key: "Enter" });
    };
    /** Arrow left `count` times: one caret move per key, as a browser does. */
    const left = (count: number) => {
      for (let i = 0; i < count; i++) box.moveTo(box.input.selectionStart - 1);
    };
    return { ...box, pick, left };
  };

  test(`Q-1043 S1: @, choose Bob, move back into it, swap to Bobby (${how})`, async () => {
    const { input, typeKeys, left, pick, names } = sequence();
    typeKeys("@");
    await pick("Bob");
    expect(input.value).toBe("@Bob ");
    // Three left arrows: `@B|ob `.
    left(3);
    await waitFor(() => expect(names()).toEqual(["Bob", "Bobby"]));
    await pick("Bobby");
    expect(input.value).toBe("@Bobby ");
    expect(input.selectionStart).toBe("@Bobby ".length);
  });

  test(`Q-1043 S2: @B, choose Bob, move back into it, swap to Bobby (${how})`, async () => {
    const { input, typeKeys, left, pick, names } = sequence();
    typeKeys("@B");
    await pick("Bob");
    expect(input.value).toBe("@Bob ");
    left(3);
    await waitFor(() => expect(names()).toEqual(["Bob", "Bobby"]));
    await pick("Bobby");
    expect(input.value).toBe("@Bobby ");
  });

  test(`Q-1043 S3: a swap after completing before README.md keeps it (${how})`, async () => {
    const { input, type, typeKeys, moveTo, left, pick, names } = sequence();
    type("附件 README.md");
    moveTo(3);
    typeKeys("@B");
    await pick("Bob");
    expect(input.value).toBe("附件 @Bob README.md");
    // From after `@Bob `, three left arrows: `附件 @B|ob README.md`.
    left(3);
    await waitFor(() => expect(names()).toEqual(["Bob", "Bobby"]));
    await pick("Bobby");
    expect(input.value).toBe("附件 @Bobby README.md");
  });

  for (const file of ["Smith.txt", "README.md"])
    test(`Q-1047 a swap only replaces the chosen Bob, keeping ${file} (${how})`, async () => {
      const { input, type, typeKeys, moveTo, left, pick, names } =
        sequence(SMITH);
      type(`附件 ${file}`);
      moveTo(3);
      typeKeys("@B");
      await pick("Bob");
      expect(input.value).toBe(`附件 @Bob ${file}`);
      left(3);
      await waitFor(() => expect(names()).toContain("Bobby"));
      await pick("Bobby");
      expect(input.value).toBe(`附件 @Bobby ${file}`);
    });

  test(`Q-1049 deleting only the space after a chosen name keeps it whole (${how})`, async () => {
    const { input, typeKeys, backspace, left, pick, names } = sequence(SMITH);
    typeKeys("@B");
    await pick("Bob");
    expect(input.value).toBe("@Bob ");
    backspace();
    expect(input.value).toBe("@Bob");
    left(2);
    await waitFor(() => expect(names()).toContain("Bobby"));
    await pick("Bobby");
    expect(input.value).toBe("@Bobby ");
  });

  test(`Q-1049 a separator typed back after the name keeps it whole (${how})`, async () => {
    const { input, typeKeys, backspace, left, pick, names } = sequence(SMITH);
    typeKeys("@B");
    await pick("Bob");
    backspace();
    typeKeys(" ");
    expect(input.value).toBe("@Bob ");
    left(3);
    await waitFor(() => expect(names()).toContain("Bobby"));
    await pick("Bobby");
    expect(input.value).toBe("@Bobby ");
  });

  test(`Q-1049 a letter typed onto the name's end only gives way up to the caret (${how})`, async () => {
    const { input, typeKeys, backspace, left, pick, names } = sequence(SMITH);
    typeKeys("@B");
    await pick("Bob");
    backspace();
    typeKeys("x");
    expect(input.value).toBe("@Bobx");
    left(3);
    await waitFor(() => expect(names()).toContain("Bobby"));
    await pick("Bobby");
    expect(input.value).toBe("@Bobby obx");
  });

  test(`Q-1047 an edited chosen name only gives way up to the caret (${how})`, async () => {
    const { input, type, typeKeys, backspace, moveTo, left, pick } =
      sequence(SMITH);
    type("附件 Smith.txt");
    moveTo(3);
    typeKeys("@B");
    await pick("Bob");
    expect(input.value).toBe("附件 @Bob Smith.txt");
    left(1);
    backspace();
    expect(input.value).toBe("附件 @Bo Smith.txt");
    // `Bo Smith` is a name, but the edited Bob proves no end past the caret.
    await pick("Bobby");
    expect(input.value).toBe("附件 @Bobby Smith.txt");
  });

  test(`Q-1047 two chosen names: swapping the first leaves the second (${how})`, async () => {
    const { input, typeKeys, moveTo, pick } = sequence(SMITH);
    typeKeys("@B");
    await pick("Bob");
    typeKeys("和 @薛");
    await pick("薛宝钗");
    expect(input.value).toBe("@Bob 和 @薛宝钗 ");
    moveTo(4);
    moveTo(3);
    moveTo(2);
    await pick("Bobby");
    expect(input.value).toBe("@Bobby 和 @薛宝钗 ");
  });

  test(`Q-1047 a pasted @Bob Smith.txt swaps only Bob (${how})`, async () => {
    const { input, insert, moveTo, pick } = sequence(SMITH);
    insert("@Bob Smith.txt", "insertFromPaste");
    moveTo(3);
    moveTo(2);
    await pick("Bobby");
    expect(input.value).toBe("@Bobby Smith.txt");
  });
}

test("Q-1043 the old selection React reports with the Enter that chooses does not undo the choice", async () => {
  const { input, typeKeys, moveTo, click, names } = setup(async () => ({
    employees: SWAP,
  }));
  typeKeys("@B");
  await waitFor(() => expect(names()).toEqual(["Bob", "Bobby"]));
  // Chrome reports a selection of the old text in the same batch as the
  // Enter that chooses; here a moved caret makes React report one.
  act(() => {
    fireEvent.keyDown(input, { key: "Enter" });
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
  });
  expect(input.value).toBe("@Bob ");
  for (const caret of [4, 3, 2]) moveTo(caret);
  await waitFor(() => expect(names()).toEqual(["Bob", "Bobby"]));
  click("Bobby");
  expect(input.value).toBe("@Bobby ");
});

for (const how of ["keyboard", "click"] as const) {
  test(`V-2490 a typed @明 before 明早开会 keeps the text (${how})`, async () => {
    const { input, type, typeKeys, moveTo, click, names } = setup(async () => ({
      employees: MINGMING,
    }));
    type("明早开会");
    moveTo(0);
    typeKeys("@明");
    await waitFor(() => expect(names()).toEqual(["明明"]));
    if (how === "keyboard") fireEvent.keyDown(input, { key: "Enter" });
    else click("明明");
    expect(input.value).toBe("@明明 明早开会");
    expect(input.selectionStart).toBe("@明明 ".length);
  });

  test(`V-2490 an @ typed over the selected colon keeps Bob.txt (${how})`, async () => {
    const { input, type, typeKeys, moveTo, click, names } = setup();
    type("附件：Bob.txt");
    moveTo(2, 3);
    typeKeys("@");
    await waitFor(() => expect(names()).toHaveLength(5));
    if (how === "keyboard") {
      // 森·刘邦, then 薛宝钗.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
    } else click("薛宝钗");
    expect(input.value).toBe("附件 @薛宝钗 Bob.txt");
    expect(input.selectionStart).toBe("附件 @薛宝钗 ".length);
  });
}

test("a new @ typed or pasted before existing text inserts the name and keeps that text", async () => {
  const { input, type, typeKeys, insert, moveTo, names } = setup();
  type("附件 README.md");
  moveTo(3);
  typeKeys("@B");
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("附件 @Bob README.md");
  expect(input.selectionStart).toBe("附件 @Bob ".length);
  // Pasted in one go over a selection.
  type("附件 xx README.md");
  moveTo(3, 5);
  insert("@B", "insertFromPaste");
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("附件 @Bob README.md");
});

test("without beforeinput the range is not known: a name only replaces up to the caret", async () => {
  const { input, type, typeAt, moveTo, names } = setup();
  type("附件 README.md");
  moveTo(3);
  typeAt("附件 @BREADME.md", 5);
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("附件 @Bob README.md");
});

test("choosing with the caret inside a typed or an existing mention replaces the whole name", async () => {
  const { input, type, typeKeys, moveTo, names } = setup();
  // Typed just now, then the caret moved back: `@B|ob 请看`.
  typeKeys("@Bob 请看");
  moveTo(2);
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("@bobby 请看");
  expect(input.selectionStart).toBe("@bobby ".length);
  // Already in a fresh draft (cleared first, so nothing chosen is recorded):
  // the caret leaves the line, then moves into it.
  type("");
  type("x\n@Bob 请看");
  moveTo(1);
  moveTo(4);
  await waitFor(() => expect(names()).toEqual(["Bob", "bobby"]));
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("x\n@Bob 请看");
  // Inside an old word that spells no name, nothing is offered.
  type("");
  type("x\n@Bobx 请看");
  moveTo(1);
  moveTo(4);
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
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

test("mentionQuery replaces a spelled name inside an existing mention, and nothing after a new @", () => {
  const roster = [
    person("E-2", "薛宝钗", "前端工程师"),
    person("E-3", "Bob", "测试"),
  ];
  // The caret moved into an existing mention: a name the text spells up to a
  // space, punctuation or the end.
  expect(mentionQuery("@Bob，你好", 2, roster)?.end).toBe(4);
  expect(mentionQuery("@薛宝钗 请看", 3, roster)?.end).toBe(4);
  // Inside any other word nothing is offered (`@Bobx` does not spell Bob).
  expect(mentionQuery("@薛宝钗请看", 3, roster)).toBeUndefined();
  expect(mentionQuery("@Bobx ok", 2, roster)).toBeUndefined();
  expect(mentionQuery("@Bobx ok", 1, roster)).toBeUndefined();
  expect(mentionQuery("请@看", 2, roster)).toBeUndefined();
  // An `@` typed before existing text never replaces it, name or word.
  const typedAt = (start: number, keep: number | undefined) => ({
    start,
    keep,
  });
  expect(mentionQuery("@BREADME.md", 2, roster, typedAt(0, 2))?.end).toBe(2);
  expect(mentionQuery("@Bob 请看", 1, roster, typedAt(0, 1))?.end).toBe(1);
  expect(mentionQuery("请@看", 2, roster, typedAt(1, 2))?.end).toBe(2);
  // What was typed after that `@` is still replaced in full.
  expect(mentionQuery("@Bob 请看", 2, roster, typedAt(0, 7))?.end).toBe(4);
  expect(mentionQuery("@Bobx ok", 2, roster, typedAt(0, 8))?.end).toBe(5);
  expect(mentionQuery("@BobREADME", 2, roster, typedAt(0, 4))?.end).toBe(4);
  expect(mentionQuery("@薛宝钗请看", 3, roster, typedAt(0, 6))?.end).toBe(4);
  // The caret inside the kept text: nothing is offered.
  expect(mentionQuery("@BREADME", 4, roster, typedAt(0, 2))).toBeUndefined();
  // Range not known: only up to the caret.
  expect(mentionQuery("@Bob 请看", 2, roster, typedAt(0, undefined))?.end).toBe(
    2,
  );
});

test("inputEdit takes the range from the selection an input began with", () => {
  const intent = (
    before: string,
    selectionStart: number,
    selectionEnd = selectionStart,
    inputType = "insertText",
    compositionStart?: number,
  ) => ({
    before,
    selectionStart,
    selectionEnd,
    inputType,
    ...(compositionStart === undefined ? {} : { compositionStart }),
  });
  // A same character to the right does not move the range.
  expect(inputEdit(intent("@明早开会", 1), "@明明早开会")).toEqual({
    start: 1,
    end: 1,
    inserted: 1,
  });
  // A selection replaced by as many characters.
  expect(inputEdit(intent("附件：Bob.txt", 2, 3), "附件@Bob.txt")).toEqual({
    start: 2,
    end: 3,
    inserted: 1,
  });
  // Collapsed deletes take the characters before or after the caret.
  expect(
    inputEdit(intent("@Bob", 4, 4, "deleteContentBackward"), "@Bo"),
  ).toEqual({ start: 3, end: 4, inserted: 0 });
  expect(inputEdit(intent("@Bob", 1, 1, "deleteWordForward"), "@")).toEqual({
    start: 1,
    end: 4,
    inserted: 0,
  });
  // An IME composition replaces what it composed so far.
  expect(
    inputEdit(intent("@mi", 3, 3, "insertCompositionText", 1), "@米"),
  ).toEqual({ start: 1, end: 3, inserted: 1 });
  // A text that does not agree with the range: unknown.
  expect(inputEdit(intent("abc", 1), "xbcd")).toBeUndefined();
});

test("followTyped starts a typed @ only when the edit inserted it and moves the kept text exactly", () => {
  const edit = (start: number, end: number, inserted: number) => ({
    start,
    end,
    inserted,
  });
  // `@` typed at 3 before `README.md`: kept from 4.
  expect(followTyped(undefined, 3, edit(3, 3, 1))).toEqual({
    start: 3,
    keep: 4,
  });
  // An `@` the edit did not insert (a delete reached an old one): not typed.
  expect(followTyped(undefined, 0, edit(5, 6, 0))).toBeUndefined();
  // A change of unknown range: the boundary is not known.
  expect(followTyped(undefined, 3, null)).toEqual({
    start: 3,
    keep: undefined,
  });
  const typed = { start: 3, keep: 5 };
  // Typing or deleting before the kept text moves it.
  expect(followTyped(typed, 3, edit(5, 5, 2))).toEqual({ start: 3, keep: 7 });
  expect(followTyped(typed, 3, edit(4, 5, 0))).toEqual({ start: 3, keep: 4 });
  // A selection across the boundary: kept after the new text.
  expect(followTyped(typed, 3, edit(4, 7, 1))).toEqual({ start: 3, keep: 5 });
  // Editing inside the kept text leaves the boundary.
  expect(followTyped(typed, 3, edit(8, 9, 1))).toEqual(typed);
  // A caret move keeps it; another `@` or none ends it.
  expect(followTyped(typed, 3, undefined)).toEqual(typed);
  expect(followTyped(typed, 9, undefined)).toBeUndefined();
  expect(followTyped(typed, undefined, edit(0, 0, 1))).toBeUndefined();
  // Unknown once, unknown for the rest of this `@`.
  expect(followTyped(typed, 3, null)).toEqual({ start: 3, keep: undefined });
});

test("followChosen moves, keeps, marks or drops chosen names by the real edit", () => {
  const bob = { start: 3, end: 7, valid: true };
  const memory = { chosen: [bob], lost: false };
  const edit = (start: number, end: number, inserted: number) => ({
    start,
    end,
    inserted,
  });
  // Typed before the `@`: moved.
  expect(followChosen(memory, edit(0, 0, 2)).chosen).toEqual([
    { start: 5, end: 9, valid: true },
  ]);
  // Typed after the space that follows the name: kept.
  expect(followChosen(memory, edit(8, 8, 1)).chosen).toEqual([bob]);
  // Text `附件 @Bob Smith.txt`: `@` at 3, Bob up to 7.
  // At the name's end, only deleting (the space): kept.
  expect(
    followChosen(memory, edit(7, 8, 0), "附件 @BobSmith.txt").chosen,
  ).toEqual([bob]);
  // At the name's end, a separator first: kept; a letter first: edited.
  expect(
    followChosen(memory, edit(7, 7, 1), "附件 @Bob, Smith.txt").chosen,
  ).toEqual([bob]);
  expect(
    followChosen(memory, edit(7, 8, 1), "附件 @Bob,Smith.txt").chosen,
  ).toEqual([bob]);
  expect(
    followChosen(memory, edit(7, 7, 1), "附件 @Bobx Smith.txt").chosen,
  ).toEqual([{ ...bob, valid: false }]);
  expect(
    followChosen(memory, edit(7, 7, 1), "附件 @Bob宝 Smith.txt").chosen,
  ).toEqual([{ ...bob, valid: false }]);
  // Inside the name: only the `@` is still known.
  expect(
    followChosen(memory, edit(6, 7, 0), "附件 @Bo Smith.txt").chosen,
  ).toEqual([{ ...bob, valid: false }]);
  expect(
    followChosen(memory, edit(5, 5, 1), "附件 @Bxob Smith.txt").chosen,
  ).toEqual([{ ...bob, valid: false }]);
  // Once edited, deleting the space later does not make it trusted again.
  expect(
    followChosen(
      { chosen: [{ ...bob, valid: false }], lost: false },
      edit(7, 8, 0),
      "附件 @BobSmith.txt",
    ).chosen,
  ).toEqual([{ ...bob, valid: false }]);
  // The `@` removed: dropped.
  expect(followChosen(memory, edit(2, 4, 0)).chosen).toEqual([]);
  // Unknown range: nothing can be followed any more.
  expect(followChosen(memory, null)).toEqual({ chosen: [], lost: true });
  expect(followChosen(NO_MEMORY, null)).toEqual(NO_MEMORY);
});

test("mentionQuery replaces a chosen name exactly, and an edited or lost one only up to the caret", () => {
  const roster = [
    person("E-3", "Bob", "测试"),
    person("E-10", "Bob Smith", "运维"),
    person("E-11", "Bo Smith", "运营"),
  ];
  const chosen = (valid: boolean) => ({
    chosen: [{ start: 0, end: 4, valid }],
    lost: false,
  });
  expect(
    mentionQuery("@Bob Smith.txt", 2, roster, undefined, chosen(true))?.end,
  ).toBe(4);
  expect(
    mentionQuery("@Bo Smith.txt", 3, roster, undefined, chosen(false))?.end,
  ).toBe(3);
  expect(
    mentionQuery("@Bob Smith.txt", 2, roster, undefined, {
      chosen: [],
      lost: true,
    })?.end,
  ).toBe(2);
  // Never chosen: the shortest name reaching the caret, not the longest.
  expect(mentionQuery("@Bob Smith.txt", 2, roster)?.end).toBe(4);
  expect(mentionQuery("@Bob Sm", 7, roster)?.end).toBe(7);
  expect(mentionQuery("@Bob Smith", 7, roster)?.end).toBe(10);
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
