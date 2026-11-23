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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ApiError,
  type CommentInput,
  HttpCardiganClient,
  type UploadAttachmentInput,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { writeFailures } from "../testing/write-errors.js";
import {
  CommentBox,
  insertMention,
  matchMentionCandidates,
  mentionQuery,
  mentionsIn,
  orderMentionCandidates,
} from "./CommentBox.js";

afterEach(cleanup);

const box = (overrides: Parameters<typeof fakeClient>[0] = {}) =>
  render(
    <CommentBox client={fakeClient(overrides)} projectId="p-1" cardId="C-1" />,
  );

test("empty comments stay compact until focused, keep drafts expanded, and shrink after clearing and leaving", () => {
  box();
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  expect(input.rows).toBe(2);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("button", { name: "发表评论" })).toBeNull();
  act(() => input.focus());
  expect(input.rows).toBe(6);
  expect(screen.getByRole("tab", { name: "预览" })).toBeTruthy();
  // Moving focus inside the editor must not collapse its controls.
  act(() => screen.getByRole("tab", { name: "预览" }).focus());
  expect(input.rows).toBe(6);
  act(() => input.focus());
  fireEvent.change(input, { target: { value: "Draft" } });
  act(() => input.blur());
  expect(input.rows).toBe(6);
  fireEvent.change(input, { target: { value: "" } });
  expect(input.rows).toBe(2);
  act(() => input.focus());
  expect(input.rows).toBe(6);
  act(() => input.blur());
  expect(input.rows).toBe(2);
  expect(screen.queryByRole("tablist")).toBeNull();
});

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
      onPosted={() => {
        reloaded += 1;
      }}
    />,
  );
  fireEvent.focus(screen.getByLabelText("评论正文"));
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
  expect(input.rows).toBe(2);
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("button", { name: "发表评论" })).toBeNull();
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
  expect(
    screen.getByRole("list", { name: "待上传的附件" }).textContent,
  ).toContain("screenshot.png");
  expect((input as HTMLTextAreaElement).rows).toBe(6);
  fireEvent.change(screen.getByLabelText("screenshot.png 的说明"), {
    target: { value: "修复后的界面" },
  });

  fireEvent.change(input, { target: { value: "贴一张图" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));

  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]).toMatchObject({
    original_filename: "screenshot.png",
    note: "修复后的界面",
    mime: "image/png",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: "C-1#43" },
  });
  expect(uploads[0]?.file).toBe(btoa("png-bytes"));
  expect(screen.queryByRole("list", { name: "待上传的附件" })).toBeNull();
});

test("invalid attachment notes are rejected before posting and a 200-character Unicode note can be sent", async () => {
  const addComment = vi.fn(async () => ({
    id: "C-1#43",
    body: "Evidence",
    created_at: "2026-01-01",
  }));
  const uploadAttachment = vi.fn(async () => ({ id: "attachment-1" }));
  render(
    <CommentBox
      client={fakeClient({ addComment, uploadAttachment })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文");
  fireEvent.paste(input, {
    clipboardData: {
      files: [new File(["png"], "image.png", { type: "image/png" })],
    },
  });
  fireEvent.change(input, { target: { value: "Evidence" } });
  const note = screen.getByLabelText("image.png 的说明");
  for (const value of ["😀".repeat(201), "bad\u202e"]) {
    fireEvent.change(note, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    expect(screen.getByRole("alert").textContent).toContain("最多 200 字符");
    expect(addComment).not.toHaveBeenCalled();
  }
  fireEvent.change(note, { target: { value: "😀".repeat(200) } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploadAttachment).toHaveBeenCalledOnce());
});

test("a file over the host limit is refused when pasted and the comment still goes out", async () => {
  const addComment = vi.fn(async () => ({
    id: "C-1#44",
    body: "Evidence",
    created_at: "2026-01-01",
  }));
  const uploadAttachment = vi.fn(async () => ({ id: "attachment-1" }));
  render(
    <CommentBox
      client={{
        ...fakeClient({ addComment, uploadAttachment }),
        attachmentMaxBytes: () => 30 * 1024 * 1024,
      }}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文");
  // The current limit is part of the existing placeholder.
  expect(input.getAttribute("placeholder")).toBe(
    "支持 Markdown；@ 提及员工；# 引用附件；可以粘贴图片或拖入文件，单个不超过 30 MiB",
  );
  fireEvent.change(input, { target: { value: "Evidence" } });
  const large = new File(["png"], "large.png", { type: "image/png" });
  Object.defineProperty(large, "size", { value: 30 * 1024 * 1024 + 1 });
  const exact = new File(["png"], "exact.png", { type: "image/png" });
  Object.defineProperty(exact, "size", { value: 30 * 1024 * 1024 });
  // Refused on paste: never listed, the text stays, the limit is named.
  fireEvent.paste(input, { clipboardData: { files: [large] } });
  expect(screen.getByRole("alert").textContent).toContain(
    "large.png：超过 30 MiB",
  );
  expect(screen.queryByLabelText("large.png 的说明")).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe("Evidence");
  expect(addComment).not.toHaveBeenCalled();
  // A file at the limit pasted next is listed, and the comment goes out with it.
  fireEvent.paste(input, { clipboardData: { files: [large, exact] } });
  expect(screen.queryByLabelText("large.png 的说明")).toBeNull();
  expect(screen.getByLabelText("exact.png 的说明")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploadAttachment).toHaveBeenCalledOnce());
  expect(addComment).toHaveBeenCalledOnce();
});

test("without a published limit the placeholder and paste behave as before", () => {
  render(
    <CommentBox
      client={{ ...fakeClient({}), attachmentMaxBytes: () => undefined }}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文");
  expect(input.getAttribute("placeholder")).toBe(
    "支持 Markdown；@ 提及员工；# 引用附件；可以粘贴图片或拖入文件",
  );
  const large = new File(["png"], "large.png", { type: "image/png" });
  Object.defineProperty(large, "size", { value: 64 * 1024 * 1024 });
  fireEvent.paste(input, { clipboardData: { files: [large] } });
  expect(screen.getByLabelText("large.png 的说明")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a rejected comment keeps the text and explains itself", async () => {
  render(
    <CommentBox
      client={fakeClient({
        addComment: async () => {
          throw new ApiError(409, "illegal_transition", "卡片已关闭");
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
  expect(alert.textContent).toBe("请求失败：卡片已关闭");
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

test("an uncertain comment retries with the draft's key and the next draft gets a new key", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("connection dropped after commit"))
    .mockImplementation(async () =>
      Response.json({ id: "C-1#7", body: "原文" }),
    );
  // Automatic retries off: this exercises the person's manual retry.
  const client = new HttpCardiganClient(fetcher, undefined, { delaysMs: [] });
  render(<CommentBox client={client} projectId="p-1" cardId="C-1" />);
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "原文" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "发表可能已经成功，重试不会重复发表",
  );
  expect(input.value).toBe("原文");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(input.value).toBe(""));
  fireEvent.change(input, { target: { value: "下一条" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(input.value).toBe(""));
  const keys = fetcher.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("Idempotency-Key"),
  );
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
    fetcher.mock.calls[0]?.[1]?.body,
  );
});

test("partial upload failure retains comment and individual image keys on retry", async () => {
  let uploads = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).endsWith("/comments"))
      return Response.json({ id: "C-1#8" });
    uploads++;
    if (uploads === 2) throw new DOMException("Timed out", "TimeoutError");
    return Response.json({ id: "F-1" });
  });
  render(
    <CommentBox
      client={new HttpCardiganClient(fetcher)}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "两张图片" } });
  fireEvent.paste(input, {
    clipboardData: {
      files: [
        new File(["first"], "one.png", { type: "image/png" }),
        new File(["second"], "two.png", { type: "image/png" }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "上传可能已经成功，保留原内容重试不会重复上传",
  );
  expect(input.value).toBe("两张图片");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(input.value).toBe(""));
  // The retry replays the comment and the failed image only (C-615): the
  // accepted first image is not sent again.
  expect(fetcher.mock.calls).toHaveLength(5);
  const keys = fetcher.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("Idempotency-Key"),
  );
  expect(new Set(keys.slice(0, 3)).size).toBe(3);
  expect(keys.slice(3)).toEqual([keys[0], keys[2]]);
  expect(fetcher.mock.calls.slice(3).map(([, init]) => init?.body)).toEqual(
    [0, 2].map((i) => fetcher.mock.calls[i]?.[1]?.body),
  );
});

test.each(["", "   "])(
  "clearing a failed draft to %j starts a new comment and attachment operation",
  async (empty) => {
    const addComment = vi.fn().mockResolvedValue({ id: "C-1#8" });
    const uploadAttachment = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockResolvedValue({ id: "F-1" });
    box({ addComment, uploadAttachment });
    const input = screen.getByLabelText("评论正文");
    fireEvent.change(input, { target: { value: "原评论" } });
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(["png"], "one.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    await screen.findByRole("alert");
    fireEvent.change(input, { target: { value: empty } });
    fireEvent.change(input, { target: { value: "重新开始" } });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
    expect(addComment.mock.calls[1]?.[3]).not.toBe(
      addComment.mock.calls[0]?.[3],
    );
    expect(uploadAttachment.mock.calls[1]?.[3]).not.toBe(
      uploadAttachment.mock.calls[0]?.[3],
    );
  },
);

test.each(
  writeFailures.flatMap((failure) =>
    [false, true].map((upload) => ({ ...failure, upload })),
  ),
)(
  "$label only warns of uncertain writes when appropriate (upload=$upload)",
  async ({ error, uncertain, reason, upload }) => {
    const conflict = vi.fn();
    render(
      <CommentBox
        client={fakeClient(
          upload
            ? {
                uploadAttachment: async () => {
                  throw error;
                },
              }
            : {
                addComment: async () => {
                  throw error;
                },
              },
        )}
        projectId="p-1"
        cardId="C-1"
        onConflict={conflict}
      />,
    );
    const input = screen.getByLabelText("评论正文");
    fireEvent.change(input, { target: { value: "保留正文" } });
    if (upload)
      fireEvent.paste(input, {
        clipboardData: {
          files: [new File(["png"], "one.png", { type: "image/png" })],
        },
      });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.includes("可能已经成功")).toBe(uncertain);
    const commentConflict =
      !upload &&
      error instanceof ApiError &&
      error.code === "idempotency_conflict";
    expect(alert.textContent).toContain(
      commentConflict ? "上一次的评论已经发表" : reason,
    );
    expect(conflict).toHaveBeenCalledTimes(commentConflict ? 1 : 0);
    expect((input as HTMLTextAreaElement).value).toBe("保留正文");
  },
);
