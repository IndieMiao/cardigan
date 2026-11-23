// @vitest-environment jsdom
/**
 * C-615: `attachment-123` in a body renders as a chip that opens the file;
 * an unknown or unreadable number stays text.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  attachmentQuery,
  attachmentTarget,
  entryAttachmentRefs,
  insertAttachmentRef,
  numberPendingRefs,
  uploadMime,
  uploadProblem,
} from "../attachment-refs.js";
import { renderMarkdown } from "../markdown.js";
import { attachment, cardDetail, timelineEntry } from "../testing/fixtures.js";
import { Timeline } from "./Timeline.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pdf = attachment({
  id: "attachment-1",
  original_filename: "评审.pdf",
  mime: "application/pdf",
  inline: false,
  size: 2048,
  thumbnail_path: null,
  attach_to: { kind: "timeline_entry", id: "C-1#1" },
  download_path: "/api/projects/p-1/attachments/attachment-1",
});
const shot = attachment({
  id: "attachment-5",
  original_filename: "shot.png",
  attach_to: { kind: "timeline_entry", id: "C-1#2" },
  uploaded_by: "human",
  download_path: "/api/projects/p-1/attachments/attachment-5",
  thumbnail_path: "/api/projects/p-1/attachments/attachment-5/thumbnail",
});
const foreign = {
  ...attachment({
    id: "attachment-2",
    original_filename: "log.txt",
    mime: "text/plain",
    inline: false,
    thumbnail_path: null,
    attach_to: { kind: "timeline_entry", id: "C-9#4" },
    download_path: "/api/projects/p-1/attachments/attachment-2",
  }),
  card_id: "C-9",
};

function timeline(body: string, author = "human") {
  const entry = timelineEntry({ id: "C-1#2", author, body });
  const detail = cardDetail({
    timeline: [entry],
    attachments: [pdf, shot],
    referenced_attachments: [foreign],
  });
  render(
    <Timeline
      projectId="p-1"
      cardId="C-1"
      entries={[entry]}
      attachments={detail.attachments}
      detail={detail}
    />,
  );
  const node = document.querySelector(".timeline-body");
  if (!node) throw new Error("no body");
  return node as HTMLElement;
}

test("own, other-card and pending references render as chips; unknown numbers stay text", () => {
  const body = timeline(
    "见 attachment-1、attachment-2 和 attachment-404；截图 attachment-new-1",
  );
  const own = within(body).getByRole("link", { name: /评审\.pdf/u });
  expect(own.getAttribute("href")).toBe(pdf.download_path);
  expect(own.getAttribute("target")).toBe("_blank");
  expect(own.getAttribute("rel")).toBe("noopener noreferrer");
  expect(own.dataset.kind).toBe("pdf");
  expect(own.title).toContain("attachment-1");
  const other = within(body).getByRole("link", { name: /log\.txt/u });
  expect(other.dataset.kind).toBe("text");
  expect(other.title).toContain("C-9");
  // A number the server did not return (missing or not visible) is plain text.
  expect(body.textContent).toContain("attachment-404");
  expect(
    body.querySelector('[data-attachment-ref="attachment-404"]'),
  ).toBeNull();
  // The comment's first own upload stands for `attachment-new-1`.
  const pending = within(body).getByRole("link", { name: /shot\.png/u });
  expect(pending.dataset.attachmentRef).toBe("attachment-5");
  expect(pending.querySelector("img")?.getAttribute("src")).toBe(
    shot.thumbnail_path,
  );
  expect(body.textContent).not.toContain("attachment-new-1");
});

test("an Agent's post_comment body renders the same way", () => {
  const body = timeline("证据在 attachment-1", "assignment:A-1");
  expect(
    within(body).getByRole("link", { name: /评审\.pdf/u }).dataset
      .attachmentRef,
  ).toBe("attachment-1");
  // Only the author's own uploads count as the comment's new files.
  expect(
    entryAttachmentRefs(
      new Map([[shot.id, attachmentTarget(shot)]]),
      { id: "C-1#2", author: "assignment:A-1" },
      [shot],
    ).has("attachment-new-1"),
  ).toBe(false);
});

test("an image chip opens the preview", async () => {
  const body = timeline("看 attachment-5");
  fireEvent.click(within(body).getByRole("link", { name: /shot\.png/u }));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog)
      .getByRole("img", { name: "附件 shot.png" })
      .getAttribute("src"),
  ).toBe(shot.download_path);
});

test("a PDF chip opens a local copy in a new tab", async () => {
  const tab = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
  const fetcher = vi.fn(async () => new Response("%PDF-1.4"));
  vi.stubGlobal("fetch", fetcher);
  const created: Blob[] = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return "blob:local/1";
  });
  URL.revokeObjectURL = vi.fn();
  const body = timeline("见 attachment-1");
  fireEvent.click(within(body).getByRole("link", { name: /评审\.pdf/u }));
  expect(open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  await waitFor(() => expect(tab.location.href).toBe("blob:local/1"));
  expect(fetcher).toHaveBeenCalledWith(pdf.download_path, {
    credentials: "same-origin",
  });
  expect(created[0]?.type).toBe("application/pdf");
});

test("a failed open closes the tab and says so", async () => {
  const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
  const body = timeline("见 attachment-2");
  fireEvent.click(within(body).getByRole("link", { name: /log\.txt/u }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "未能打开 log.txt",
  );
  expect(tab.close).toHaveBeenCalled();
});

test("links, code and longer words keep their text", () => {
  const refs = new Map([[pdf.id, attachmentTarget(pdf)]]);
  const html = renderMarkdown(
    "[attachment-1](https://example.com) `attachment-1` xattachment-1 attachment-10 **attachment-1**",
    { attachments: refs },
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  expect(root.querySelectorAll("[data-attachment-ref]")).toHaveLength(1);
  expect(root.querySelector("strong [data-attachment-ref]")).not.toBeNull();
  expect(root.querySelector("code")?.textContent).toBe("attachment-1");
  expect(root.textContent).toContain("attachment-10");
});

test("file names are escaped and SVG or HTML only download", () => {
  const svg = attachment({
    id: "attachment-7",
    original_filename: '<img src=x onerror="alert(1)">.svg',
    mime: "image/svg+xml",
    inline: false,
    thumbnail_path: null,
  });
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown("attachment-7", {
    attachments: new Map([[svg.id, attachmentTarget(svg)]]),
  });
  expect(root.querySelector("img")).toBeNull();
  const chip = root.querySelector("a");
  expect(chip?.dataset.kind).toBe("file");
  expect(chip?.hasAttribute("download")).toBe(true);
  expect(chip?.hasAttribute("target")).toBe(false);
});

test("upload rules follow the server's types and 10 MiB limit", () => {
  const file = (name: string, type: string, size = 10) => ({
    name,
    type,
    size,
  });
  expect(uploadMime(file("run.log", ""))).toBe("text/plain");
  expect(uploadMime(file("notes.md", "text/x-markdown"))).toBe("text/markdown");
  expect(uploadMime(file("a.JSON", ""))).toBe("application/json");
  expect(uploadMime(file("page.htm", ""))).toBe("text/html");
  expect(uploadMime(file("x.pdf", "application/pdf"))).toBe("application/pdf");
  expect(uploadProblem(file("tool.exe", "application/x-msdownload"))).toMatch(
    /不支持这种类型/u,
  );
  expect(
    uploadProblem(file("big.pdf", "application/pdf", 10 * 1024 * 1024 + 1)),
  ).toBe("超过 10 MiB");
  expect(
    uploadProblem(file("max.pdf", "application/pdf", 10 * 1024 * 1024)),
  ).toBeUndefined();
});

test("`#` opens at a word start only, and pending numbers follow the files sent", () => {
  expect(attachmentQuery("见 #评审", 5)).toEqual({
    start: 2,
    query: "评审",
    end: 5,
  });
  expect(attachmentQuery("见#pdf", 5)?.query).toBe("pdf");
  expect(attachmentQuery("# 标题", 2)).toBeUndefined();
  expect(attachmentQuery("[x](#/p/1)", 6)).toBeUndefined();
  expect(attachmentQuery("C#", 2)).toBeUndefined();
  expect(
    insertAttachmentRef(
      "见 #pd 后",
      { start: 2, query: "pd", end: 5 },
      "attachment-3",
    ),
  ).toEqual({ body: "见 attachment-3 后", caret: 15 });
  expect(
    numberPendingRefs(
      "attachment-new-3 和 attachment-new-5 与 attachment-2",
      [3, 5],
    ),
  ).toEqual({
    body: "attachment-new-1 和 attachment-new-2 与 attachment-2",
    missing: [],
  });
  expect(numberPendingRefs("attachment-new-4", [3]).missing).toEqual([
    "attachment-new-4",
  ]);
});
