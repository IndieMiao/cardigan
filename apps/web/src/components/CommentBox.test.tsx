// @vitest-environment jsdom
/**
 * M5.3 comment box (plan §3.7, §4 M5.3; development plan §8.7).
 *
 * Markdown with a preview, `@` mention completion and pasted images. The write
 * endpoint lands with M5.2, so the send button must stay disabled and say why —
 * a button that silently drops a comment would be worse.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { CommentBox, type MentionOption } from "./CommentBox.js";

afterEach(cleanup);

const MENTIONS: readonly MentionOption[] = [
  { value: "coder", label: "角色 coder" },
  { value: "A-1", label: "Assignment A-1" },
];

test("writes Markdown and previews it", () => {
  render(<CommentBox />);
  const input = screen.getByLabelText("评论正文");
  fireEvent.change(input, { target: { value: "**粗** 文本" } });
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview");
  expect(preview?.innerHTML).toContain("<strong>粗</strong>");
  expect(preview?.textContent).toContain("文本");
});

test("the preview shows an empty placeholder", () => {
  render(<CommentBox />);
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  expect(document.querySelector(".comment-preview")?.textContent).toContain(
    "还没有内容",
  );
});

test("the preview never executes HTML from the body", () => {
  render(<CommentBox />);
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
  render(<CommentBox mentions={MENTIONS} />);
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "请 @co" } });
  const suggestion = screen.getByRole("button", { name: "角色 coder" });
  fireEvent.click(suggestion);
  expect(input.value).toBe("请 @coder ");
  expect(screen.queryByRole("list", { name: "提及建议" })).toBeNull();
});

test("pasted images are counted and explained", () => {
  render(<CommentBox />);
  const input = screen.getByLabelText("评论正文");
  const file = new File(["png"], "screenshot.png", { type: "image/png" });
  fireEvent.paste(input, { clipboardData: { files: [file] } });
  expect(screen.getByText(/已捕获 1 张图片/u)).toBeTruthy();
  expect(screen.getByText(/screenshot\.png/u)).toBeTruthy();
});

test("sending stays disabled until M5.2 provides the endpoint", () => {
  render(<CommentBox />);
  fireEvent.change(screen.getByLabelText("评论正文"), {
    target: { value: "有内容了" },
  });
  const send = screen.getByRole("button", {
    name: "发表评论",
  }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(screen.getByText(/写接口随 M5.2 提供/u)).toBeTruthy();
});
