// @vitest-environment jsdom
/**
 * C-615: the comment box uploads chosen, dropped and pasted files with the
 * comment, and `#` inserts references to the card's attachments or to the
 * files waiting in the box.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  AttachmentView,
  CommentInput,
  UploadAttachmentInput,
} from "../api.js";
import { attachment, fakeClient } from "../testing/fixtures.js";
import { CommentBox } from "./CommentBox.js";

afterEach(cleanup);

const review = attachment({
  id: "attachment-3",
  original_filename: "评审.pdf",
  mime: "application/pdf",
  inline: false,
  thumbnail_path: null,
  download_path: "/api/projects/p-1/attachments/attachment-3",
});

function setup(attachments: readonly AttachmentView[] = [review]) {
  const posted: CommentInput[] = [];
  const uploads: UploadAttachmentInput[] = [];
  const client = fakeClient({
    addComment: async (_p, _c, input) => {
      posted.push(input);
      return { id: "C-1#9", body: input.body, created_at: "2026-01-01" };
    },
    uploadAttachment: async (_p, _c, input) => {
      uploads.push(input);
      return { id: `attachment-${10 + uploads.length}` };
    },
  });
  render(
    <CommentBox
      client={client}
      projectId="p-1"
      cardId="C-1"
      attachments={attachments}
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  return { input, posted, uploads };
}

const choose = (...files: File[]) =>
  fireEvent.change(
    document.querySelector('input[type="file"]') as HTMLInputElement,
    { target: { files } },
  );
const chips = () =>
  within(screen.getByRole("list", { name: "待上传的附件" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
const type = (input: HTMLTextAreaElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
  fireEvent.select(input);
};

test("the button adds several files as removable chips and uploads them in order after the comment", async () => {
  const { input, posted, uploads } = setup();
  expect(screen.getByRole("button", { name: "上传附件" })).toBeTruthy();
  const accept =
    document.querySelector('input[type="file"]')?.getAttribute("accept") ?? "";
  expect(accept).toContain("application/pdf");
  expect(accept).toContain(".log");
  choose(
    new File(["%PDF"], "guide.pdf", { type: "application/pdf" }),
    new File(["# hi"], "notes.md", { type: "" }),
    new File(["line"], "run.log", { type: "" }),
  );
  expect(chips()).toEqual([
    expect.stringContaining("guide.pdf4 B"),
    expect.stringContaining("notes.md4 B"),
    expect.stringContaining("run.log4 B"),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "移除 notes.md" }));
  expect(chips()).toHaveLength(2);
  type(input, "附上文件");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploads).toHaveLength(2));
  expect(posted).toEqual([{ body: "附上文件" }]);
  expect(
    uploads.map((u) => [u.original_filename, u.mime, u.attach_to, u.ref_slot]),
  ).toEqual([
    [
      "guide.pdf",
      "application/pdf",
      { kind: "timeline_entry", id: "C-1#9" },
      1,
    ],
    ["run.log", "text/plain", { kind: "timeline_entry", id: "C-1#9" }, 2],
  ]);
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: "待上传的附件" })).toBeNull(),
  );
});

test("dropping files adds them and outlines the box while dragging", () => {
  setup();
  const box = screen.getByRole("region", { name: "写评论" });
  const files = [new File(["{}"], "data.json", { type: "application/json" })];
  fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"], files } });
  expect(box.hasAttribute("data-dragging")).toBe(true);
  fireEvent.drop(box, { dataTransfer: { types: ["Files"], files } });
  expect(box.hasAttribute("data-dragging")).toBe(false);
  expect(chips()).toEqual([expect.stringContaining("data.json")]);
  // Dragged text is not a file: the box ignores it.
  fireEvent.dragEnter(box, { dataTransfer: { types: ["text/plain"] } });
  expect(box.hasAttribute("data-dragging")).toBe(false);
});

test("files over 10 MiB or of other types are refused in place with the reason", () => {
  setup();
  const big = new File(["x"], "huge.pdf", { type: "application/pdf" });
  Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
  choose(
    big,
    new File(["MZ"], "tool.exe", { type: "application/x-msdownload" }),
    new File(["ok"], "ok.txt", { type: "text/plain" }),
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("huge.pdf：超过 10 MiB");
  expect(alert.textContent).toContain("tool.exe：不支持这种类型");
  expect(chips()).toEqual([expect.stringContaining("ok.txt")]);
  // The next choice replaces the report.
  choose(new File(["ok"], "two.txt", { type: "text/plain" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("pasting an image still adds it", () => {
  const { input } = setup();
  fireEvent.paste(input, {
    clipboardData: {
      files: [new File(["png"], "paste.png", { type: "image/png" })],
    },
  });
  expect(chips()).toEqual([expect.stringContaining("paste.png")]);
});

test("`#` offers the box's files and the card's attachments and inserts the chosen reference", () => {
  const { input } = setup();
  choose(new File(["png"], "shot.png", { type: "image/png" }));
  type(input, "见 #");
  const list = screen.getByRole("listbox", { name: "引用附件" });
  expect(
    within(list)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual([
    expect.stringContaining("shot.png"),
    expect.stringContaining("评审.pdf"),
  ]);
  type(input, "见 #评");
  expect(within(list).getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("见 attachment-3 ");
  type(input, "见 attachment-3 和 #shot");
  fireEvent.click(screen.getByRole("option", { name: /shot\.png/u }));
  expect(input.value).toBe("见 attachment-3 和 attachment-new-1 ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Escape closes the `#` list until the next `#`; a heading `# ` offers nothing", () => {
  const { input } = setup();
  type(input, "#");
  expect(screen.getByRole("listbox", { name: "引用附件" })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  type(input, "# 标题");
  expect(screen.queryByRole("listbox")).toBeNull();
  type(input, "# 标题 #");
  expect(screen.getByRole("listbox", { name: "引用附件" })).toBeTruthy();
});

test("references to waiting files are numbered by the files sent; a removed file's reference stops the send", async () => {
  const { input, posted, uploads } = setup();
  choose(
    new File(["a"], "a.txt", { type: "text/plain" }),
    new File(["b"], "b.txt", { type: "text/plain" }),
  );
  type(input, "看 #b");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("看 attachment-new-2 ");
  type(input, `${input.value}和 #a`);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "移除 a.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  expect(screen.getByRole("alert").textContent).toBe(
    "正文引用的文件已移除：attachment-new-1",
  );
  expect(posted).toEqual([]);
  type(input, "看 attachment-new-2 ");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploads).toHaveLength(1));
  // b.txt is the only file sent, so the body names it as the comment's first.
  expect(posted).toEqual([{ body: "看 attachment-new-1 " }]);
  expect(uploads[0]?.original_filename).toBe("b.txt");
});

test("the preview shows referenced attachments and waiting files as chips", () => {
  const { input } = setup();
  choose(new File(["png"], "shot.png", { type: "image/png" }));
  type(input, "见 attachment-3 和 attachment-new-1，attachment-99");
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview") as HTMLElement;
  expect(
    within(preview)
      .getByRole("link", { name: /评审\.pdf/u })
      .getAttribute("href"),
  ).toBe(review.download_path);
  const waiting = preview.querySelector("[data-pending]");
  expect(waiting?.textContent).toBe("shot.png");
  expect(preview.textContent).toContain("attachment-99");
});

test("a comment accepted with files still uploading keeps the files in place", async () => {
  const uploadAttachment = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockResolvedValue({ id: "attachment-12" });
  render(
    <CommentBox
      client={fakeClient({
        addComment: async () => ({ id: "C-1#9", body: "x", created_at: "" }),
        uploadAttachment,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  choose(new File(["a"], "a.txt", { type: "text/plain" }));
  fireEvent.change(input, { target: { value: "文件 attachment-new-1" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "移除 a.txt" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(input.value).toBe(""));
  expect(uploadAttachment).toHaveBeenCalledTimes(2);
  expect(uploadAttachment.mock.calls[1]?.[3]).toBe(
    uploadAttachment.mock.calls[0]?.[3],
  );
});

test("a retry after a partial failure skips the accepted file and locks its note, so attachment-new-2 stays the second file", async () => {
  const sent: { name?: string; key?: string }[] = [];
  let fail = true;
  const uploadAttachment = vi.fn(
    async (
      _p: string,
      _c: string,
      input: UploadAttachmentInput,
      key?: string,
    ) => {
      if (input.original_filename === "b.txt" && fail) {
        fail = false;
        throw new TypeError("lost");
      }
      sent.push({
        ...(input.original_filename ? { name: input.original_filename } : {}),
        ...(key ? { key } : {}),
      });
      return { id: `attachment-${20 + sent.length}` };
    },
  );
  const posted: CommentInput[] = [];
  render(
    <CommentBox
      client={fakeClient({
        addComment: async (_p, _c, input) => {
          posted.push(input);
          return { id: "C-1#9", body: input.body, created_at: "" };
        },
        uploadAttachment,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  choose(
    new File(["a"], "a.txt", { type: "text/plain" }),
    new File(["b"], "b.txt", { type: "text/plain" }),
  );
  type(input, "读第二份 #b");
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await screen.findByRole("alert");
  // The accepted file's note can no longer change (it would need a new key).
  expect(
    (screen.getByLabelText("a.txt 的说明") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(input.value).toBe(""));
  expect(sent.map((s) => s.name)).toEqual(["a.txt", "b.txt"]);
  expect(posted.map((p) => p.body)).toEqual([
    "读第二份 attachment-new-2 ",
    "读第二份 attachment-new-2 ",
  ]);
});

test("`#` right after Chinese text inserts a reference the renderer and the send both recognise", async () => {
  const { input, posted, uploads } = setup();
  choose(new File(["b"], "b.txt", { type: "text/plain" }));
  type(input, "见#");
  fireEvent.click(screen.getByRole("option", { name: /评审\.pdf/u }));
  expect(input.value).toBe("见attachment-3 ");
  type(input, "见attachment-3 和#b");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("见attachment-3 和attachment-new-1 ");
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview") as HTMLElement;
  expect(
    within(preview).getByRole("link", { name: /评审\.pdf/u }),
  ).toBeTruthy();
  expect(preview.querySelector("[data-pending]")?.textContent).toBe("b.txt");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(posted).toEqual([{ body: "见attachment-3 和attachment-new-1 " }]);
});

test("choosing a reference mid-sentence replaces only the `#` and its query", () => {
  const { input } = setup();
  const value = "请看 #后续说明。";
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(4, 4);
  fireEvent.select(input);
  fireEvent.click(screen.getByRole("option", { name: /评审\.pdf/u }));
  // Chinese text after the reference ends the number: no space is added.
  expect(input.value).toBe("请看 attachment-3后续说明。");
  const typed = "请看 #评，后续";
  fireEvent.change(input, { target: { value: typed } });
  input.setSelectionRange(5, 5);
  fireEvent.select(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("请看 attachment-3，后续");
});

test("the preview reads another card's attachment named for the first time; unreadable numbers stay text", async () => {
  const other = {
    ...attachment({
      id: "attachment-77",
      original_filename: "数值表.json",
      mime: "application/json",
      inline: false,
      thumbnail_path: null,
      download_path: "/api/projects/p-1/attachments/attachment-77",
    }),
    card_id: "C-9",
  };
  const attachmentRefs = vi.fn(
    async (_p: string, _c: string, ids: readonly string[]) => ({
      attachments: [other].filter((a) => ids.includes(a.id)),
    }),
  );
  render(
    <CommentBox
      client={fakeClient({ attachmentRefs })}
      projectId="p-1"
      cardId="C-1"
      attachments={[review]}
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  type(input, "attachment-3、attachment-77 与 attachment-88");
  // Nothing is read while writing.
  expect(attachmentRefs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "预览" }));
  const preview = document.querySelector(".comment-preview") as HTMLElement;
  const chip = await within(preview).findByRole("link", {
    name: /数值表\.json/u,
  });
  expect(chip.title).toContain("C-9");
  // Only the numbers the page did not know are asked for.
  expect(attachmentRefs).toHaveBeenCalledWith("p-1", "C-1", [
    "attachment-77",
    "attachment-88",
  ]);
  expect(preview.textContent).toContain("attachment-88");
  expect(
    preview.querySelector('[data-attachment-ref="attachment-88"]'),
  ).toBeNull();
});

test("an empty file is accepted and a file name over 200 characters is refused before sending", () => {
  setup();
  const long = `${"长".repeat(197)}.txt`;
  choose(
    new File([], "empty.log", { type: "" }),
    new File(["x"], long, { type: "text/plain" }),
  );
  expect(chips()).toEqual([expect.stringContaining("empty.log0 B")]);
  expect(screen.getByRole("alert").textContent).toContain(
    "文件名超过 200 字符",
  );
});

test("a placeholder inside code is literal: no file needed, sent as written", async () => {
  const { input, posted } = setup();
  type(input, "占位符示例：`attachment-new-1`");
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]?.body).toBe("占位符示例：`attachment-new-1`");
});
