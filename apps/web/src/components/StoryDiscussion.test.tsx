// @vitest-environment jsdom
import type { TimelineEntryId } from "@cardigan/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeClient } from "../testing/fixtures.js";
import { StoryDiscussion } from "./StoryDiscussion.js";

afterEach(cleanup);
const group_id = "C-1#2" as TimelineEntryId;
const story = {
  discussion_rounds: 0,
  question_groups: [
    {
      id: group_id,
      questions: [
        { question: "布局？", recommended: "一列", impact: "容易阅读" },
        { question: "顺序？", recommended: "按时间", impact: "新内容在后" },
        { question: "颜色？", recommended: "灰", impact: "沿用主题" },
      ],
    },
  ],
};
const props = (addComment = vi.fn(), reload = vi.fn()) => ({
  client: fakeClient({ addComment }),
  projectId: "p",
  cardId: "C-1",
  story,
  closed: false,
  reload,
});
const field = (n: number) =>
  screen.getByRole("textbox", { name: `第 ${n} 题回答` }) as HTMLInputElement;

test("C-715: inputs only, one submit for the whole checklist; blanks are counted and left to defaults; a failed submit keeps every draft and its idempotency key", async () => {
  const addComment = vi
      .fn()
      .mockRejectedValueOnce(new TypeError())
      .mockResolvedValue({ id: "C-1#3" }),
    reload = vi.fn();
  render(<StoryDiscussion {...props(addComment, reload)} />);
  expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "提交",
    "整组按默认",
  ]);
  expect(screen.getByText("3 题按推荐")).toBeDefined();
  fireEvent.change(field(1), { target: { value: " 两列 " } });
  fireEvent.change(field(3), { target: { value: "蓝" } });
  fireEvent.change(field(2), { target: { value: "  " } });
  expect(screen.getByText("1 题按推荐")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await screen.findByRole("alert");
  expect([field(1).value, field(2).value, field(3).value]).toEqual([
    " 两列 ",
    "  ",
    "蓝",
  ]);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(addComment).toHaveBeenCalledTimes(2);
  expect(addComment.mock.calls[1]).toEqual(addComment.mock.calls[0]);
  expect(addComment).toHaveBeenCalledWith(
    "p",
    "C-1",
    {
      body: "提交回答",
      story_discussion: {
        action: "submit_answers",
        group_id,
        answers: [
          { number: 1, answer: "两列" },
          { number: 3, answer: "蓝" },
        ],
      },
    },
    expect.any(String),
  );
  // No optimistic update: locked on the old state until the reload arrives.
  expect(field(1).closest("fieldset")?.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  expect(addComment).toHaveBeenCalledTimes(2);
});

test("C-715: accept-all targets the displayed group, asks before dropping typed answers, and closed or settled checklists offer no inputs", async () => {
  const addComment = vi.fn().mockResolvedValue({ id: "C-1#3" }),
    reload = vi.fn();
  const view = render(<StoryDiscussion {...props(addComment, reload)} />);
  fireEvent.click(screen.getByRole("button", { name: "整组按默认" }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(addComment).toHaveBeenLastCalledWith(
    "p",
    "C-1",
    expect.objectContaining({
      body: "清单按默认",
      story_discussion: { action: "accept_defaults", group_id },
    }),
    expect.any(String),
  );
  view.unmount();
  render(<StoryDiscussion {...props(addComment, reload)} />);
  fireEvent.change(field(2), { target: { value: "倒序" } });
  fireEvent.click(screen.getByRole("button", { name: "整组按默认" }));
  await screen.findByRole("dialog", { name: "放弃未提交的回答？" });
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(field(2).value).toBe("倒序");
  expect(addComment).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "整组按默认" }));
  fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(addComment).toHaveBeenCalledTimes(2));
  cleanup();
  const closed = render(
    <StoryDiscussion {...props(addComment, reload)} closed />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  closed.unmount();
});

test("C-715: typed answers ask before the tab or the page is left and survive an unguarded way out", async () => {
  const view = render(<StoryDiscussion {...props()} />);
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(unload()).toBe(false);
  fireEvent.change(field(1), { target: { value: "两列" } });
  expect(unload()).toBe(true);
  const link = document.createElement("a");
  link.href = "#/p/p/cards";
  link.textContent = "卡片";
  document.body.append(link);
  fireEvent.click(link);
  await screen.findByRole("dialog", { name: "放弃未提交的回答？" });
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  link.remove();
  // Browser back/forward cannot be intercepted; the draft comes back.
  view.unmount();
  render(<StoryDiscussion {...props()} />);
  expect(field(1).value).toBe("两列");
  fireEvent.change(field(1), { target: { value: "" } });
  expect(unload()).toBe(false);
});

test("labels human answers, human-accepted defaults and unanswered proposal defaults separately", () => {
  const sources = ["answer", "accepted_default", "proposal_default"] as const;
  render(
    <StoryDiscussion
      client={fakeClient({})}
      projectId="p"
      cardId="C-1"
      reload={vi.fn()}
      closed
      story={{
        discussion_rounds: 1,
        question_groups: [
          {
            id: group_id,
            questions: sources.map((source, i) => ({
              question: `问题 ${i + 1}`,
              recommended: "一列",
              impact: "容易阅读",
              resolution: { source, value: "一列", entry_id: group_id },
            })),
          },
        ],
      }}
    />,
  );
  for (const label of ["已回答", "已接受默认", "未答，方案按默认"]) {
    expect(screen.getByText(`${label}：一列`)).toBeDefined();
  }
  expect(
    screen.getByRole("heading", { name: "需求澄清 · 1 轮" }),
  ).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();
});
