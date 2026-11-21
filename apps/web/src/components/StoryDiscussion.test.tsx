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
      ],
    },
  ],
};

test("one-question replies and accept-all target the displayed group; retry keeps the draft and idempotency key", async () => {
  const addComment = vi
      .fn()
      .mockRejectedValueOnce(new TypeError())
      .mockResolvedValue({ id: "C-1#3" }),
    reload = vi.fn();
  const props = {
    client: fakeClient({ addComment }),
    projectId: "p",
    cardId: "C-1",
    story,
    closed: false,
    reload,
  };
  const view = render(<StoryDiscussion {...props} />);
  const input = screen.getByRole("textbox", { name: "第 1 题回答" });
  fireEvent.change(input, { target: { value: "两列" } });
  fireEvent.click(screen.getByRole("button", { name: "回答" }));
  await screen.findByRole("alert");
  expect((input as HTMLInputElement).value).toBe("两列");
  fireEvent.click(screen.getByRole("button", { name: "回答" }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(addComment.mock.calls[1]).toEqual(addComment.mock.calls[0]);
  expect(addComment).toHaveBeenCalledWith(
    "p",
    "C-1",
    expect.objectContaining({
      story_discussion: {
        action: "answer",
        group_id,
        number: 1,
        answer: "两列",
      },
    }),
    expect.any(String),
  );
  fireEvent.click(screen.getByRole("button", { name: "整组按默认" }));
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  expect(addComment).toHaveBeenLastCalledWith(
    "p",
    "C-1",
    expect.objectContaining({
      story_discussion: { action: "accept_defaults", group_id },
    }),
    expect.any(String),
  );
  view.rerender(<StoryDiscussion {...props} closed />);
  expect(screen.queryByRole("button")).toBeNull();
});
