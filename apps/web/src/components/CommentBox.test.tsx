// @vitest-environment jsdom
/**
 * M5.3/M5.2 comment box: writing, previewing and posting (plan §3.7, §4 M5.3;
 * the write endpoints landed with M5.2).
 *
 * Markdown with a preview, `@` mention completion, pasted images uploaded as
 * evidence attached to the comment's timeline entry, and a send button that
 * only fires when there is something to send.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  ApiError,
  type CommentInput,
  type UploadAttachmentInput,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { CommentBox, type MentionOption, mentionsIn } from "./CommentBox.js";

afterEach(cleanup);

const MENTIONS: readonly MentionOption[] = [
  { value: "coder", label: "角色 coder" },
  { value: "A-1", label: "Assignment A-1" },
];

const box = (overrides: Parameters<typeof fakeClient>[0] = {}) =>
  render(
    <CommentBox
      client={fakeClient(overrides)}
      projectId="p-1"
      cardId="C-1"
      mentions={MENTIONS}
    />,
  );

test("writes Markdown and previews it", () => {
  box();
  fireEvent.change(screen.getByLabelText("评论正文"), {
    target: { value: "**粗** 文本" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview");
  expect(preview?.innerHTML).toContain("<strong>粗</strong>");
  expect(preview?.textContent).toContain("文本");
});

test("the preview never executes HTML from the body", () => {
  box();
  fireEvent.change(screen.getByLabelText("评论正文"), {
    target: {
      value: '<img src=x onerror="alert(1)"> [x](javascript:alert(1))',
    },
  });
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview");
  expect(preview?.querySelector("img")).toBeNull();
  expect(
    [...(preview?.querySelectorAll("a") ?? [])].every(
      (anchor) => !/javascript:/iu.test(anchor.getAttribute("href") ?? ""),
    ),
  ).toBe(true);
});

test("typing @ offers mentions and inserts the chosen one", () => {
  box();
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "请 @co" } });
  fireEvent.click(screen.getByRole("button", { name: "角色 coder" }));
  expect(input.value).toBe("请 @coder ");
  expect(screen.queryByRole("list", { name: "提及建议" })).toBeNull();
});

test("sending a comment posts it and clears the box", async () => {
  const posted: CommentInput[] = [];
  let reloaded = 0;
  render(
    <CommentBox
      client={fakeClient({
        addComment: async (_projectId, _cardId, input) => {
          posted.push(input);
          return { id: "C-1#42", body: input.body, created_at: "2026-01-01" };
        },
      })}
      projectId="p-1"
      cardId="C-1"
      mentions={MENTIONS}
      onPosted={() => {
        reloaded += 1;
      }}
    />,
  );
  const send = screen.getByRole("button", {
    name: "发表评论",
  }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);

  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "看过了 @coder" } });
  expect(send.disabled).toBe(false);
  fireEvent.click(send);

  await waitFor(() => expect(reloaded).toBe(1));
  expect(posted).toEqual([{ body: "看过了 @coder", mentions: ["coder"] }]);
  expect(input.value).toBe("");
});

test("pasted images are uploaded as evidence on the new comment", async () => {
  const uploads: UploadAttachmentInput[] = [];
  render(
    <CommentBox
      client={fakeClient({
        addComment: async () => ({
          id: "C-1#43",
          body: "with image",
          created_at: "2026-01-01",
        }),
        uploadAttachment: async (_projectId, _cardId, input) => {
          uploads.push(input);
          return { id: "F-9" };
        },
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文");
  const file = new File(["png-bytes"], "screenshot.png", { type: "image/png" });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  expect(screen.getByText(/已捕获 1 张图片/u)).toBeTruthy();

  fireEvent.change(input, { target: { value: "贴一张图" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]).toMatchObject({
    mime: "image/png",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: "C-1#43" },
  });
  expect(uploads[0]?.file).toBe(btoa("png-bytes"));
  expect(screen.queryByText(/已捕获/u)).toBeNull();
});

test("a rejected comment keeps the text and explains itself", async () => {
  render(
    <CommentBox
      client={fakeClient({
        addComment: async () => {
          throw new ApiError(409, "illegal_transition", "card is closed");
        },
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  fireEvent.change(screen.getByLabelText("评论正文"), {
    target: { value: "这张卡已经关了" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("card is closed");
  expect((screen.getByLabelText("评论正文") as HTMLTextAreaElement).value).toBe(
    "这张卡已经关了",
  );
});

test("mentions are parsed without duplicates or trailing punctuation", () => {
  expect(mentionsIn("@coder 和 @coder，还有 @A-1")).toEqual(["coder", "A-1"]);
  expect(mentionsIn("邮箱 foo@bar.com 不是提及")).toEqual([]);
  // Two mentions written without a separating space: the first token wins.
  expect(mentionsIn("@coder@A-1")).toEqual(["coder"]);
});
