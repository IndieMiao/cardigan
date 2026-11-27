// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { attachment } from "../testing/fixtures.js";
import { AttachmentGrid } from "./AttachmentGrid.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { DecisionAttachments } from "./DecisionAttachments.js";

afterEach(cleanup);

const image = attachment({
  id: "F-1",
  original_filename: "390-dark.png",
  download_path: "/api/projects/p-1/attachments/F-1",
  thumbnail_path: "/api/projects/p-1/attachments/F-1/thumbnail",
});

test("C-540: thumbnails load the small rendition; preview and download keep the original", async () => {
  render(<AttachmentGrid attachments={[image]} />);
  const trigger = screen.getByRole("button", { name: "预览 390-dark.png" });
  const thumb = within(trigger).getByRole("img");
  expect(thumb.getAttribute("src")).toBe(image.thumbnail_path);
  expect(thumb.getAttribute("loading")).toBe("lazy");
  expect(
    screen
      .getByRole("link", { name: "下载 390-dark.png" })
      .getAttribute("href"),
  ).toBe(image.download_path);
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog)
      .getByRole("img", { name: "附件 390-dark.png" })
      .getAttribute("src"),
  ).toBe(image.download_path);
});

test("C-540: a thumbnail that fails to load becomes the shared placeholder, still openable", async () => {
  render(<DecisionAttachments attachments={[image]} />);
  const trigger = screen.getByRole("button", { name: "预览 390-dark.png" });
  // C-614: the first failure retries the locally rendered thumbnail.
  fireEvent.error(within(trigger).getByRole("img"));
  expect(within(trigger).getByRole("img").getAttribute("src")).toBe(
    `${image.thumbnail_path}?local=1`,
  );
  fireEvent.error(within(trigger).getByRole("img"));
  expect(within(trigger).queryByRole("img")).toBeNull();
  const icon = trigger.querySelector("svg.lucide-image-off");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.getAttribute("width")).toBe("16");
  fireEvent.click(trigger);
  expect(
    (await screen.findByRole("dialog"))
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe(image.download_path);
});

test("C-540: a bitmap without a thumbnail never falls back to the original", () => {
  render(
    <AttachmentPreview
      attachment={{ ...image, thumbnail_path: null }}
      images={[image]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "预览 390-dark.png" });
  expect(trigger.querySelector("img")).toBeNull();
  expect(trigger.querySelector("svg.lucide-image-off")).not.toBeNull();
});

test("C-614: the lightbox shows the preview route and falls back to the local original", async () => {
  const preview = { ...image, preview_path: `${image.download_path}/preview` };
  render(<AttachmentGrid attachments={[preview]} />);
  fireEvent.click(screen.getByRole("button", { name: "预览 390-dark.png" }));
  const dialog = await screen.findByRole("dialog");
  const img = within(dialog).getByRole("img", { name: "附件 390-dark.png" });
  expect(img.getAttribute("src")).toBe(preview.preview_path);
  fireEvent.error(img);
  expect(
    within(dialog)
      .getByRole("img", { name: "附件 390-dark.png" })
      .getAttribute("src"),
  ).toBe(`${preview.preview_path}?local=1`);
});

test("C-820: the shared tile puts previews first, keeps one line of facts and opens the full note", async () => {
  const note =
    "截图 A 模拟器 Sensen_P0 原型 3f26e951d19a145628d81c4885f44b961c8754fd：默认 60° 倾斜，Streets 立体楼 + 光照（无阴影）+ 占位模型";
  render(
    <AttachmentGrid
      attachments={[
        attachment({
          id: "F-7",
          original_filename: "fix.patch",
          mime: "text/x-patch",
          inline: false,
          thumbnail_path: null,
          download_path: "/api/projects/p-1/attachments/F-7",
        }),
        { ...image, note, size: 1258291 },
        attachment({
          id: "F-8",
          original_filename: "notes.txt",
          mime: "text/plain",
          inline: false,
          thumbnail_path: null,
          download_path: "/api/projects/p-1/attachments/F-8",
        }),
      ]}
    />,
  );
  const tiles = document.querySelectorAll<HTMLElement>(
    "[data-ui=attachment-tile]",
  );
  // The attachments tab: each tile is its attachment's anchor.
  expect([...tiles].map((tile) => [tile.id, tile.dataset.kind])).toEqual([
    ["attachment-F-1", "media"],
    ["attachment-F-7", "file"],
    ["attachment-F-8", "file"],
  ]);
  const [first, patch, text] = [...tiles] as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ];
  // Other files: a type strip instead of a preview, and no preview button.
  expect(within(patch).queryByRole("button", { name: /^预览/ })).toBeNull();
  expect(patch.querySelector("[data-attachment-media]")?.textContent).toBe(
    "补丁",
  );
  expect(text.querySelector("[data-attachment-media]")?.textContent).toBe(
    "文本",
  );
  // The download is an icon button named after the file, not a second name.
  const download = within(first).getByRole("link", {
    name: "下载 390-dark.png",
  });
  expect(download.getAttribute("href")).toBe(image.download_path);
  expect(download.hasAttribute("download")).toBe(true);
  expect(first.querySelector("[data-attachment-name]")?.textContent).toBe(
    "390-dark.png",
  );
  // V-3568: avatar, then one shrinkable span with time and size.
  const meta = first.querySelector("[data-attachment-meta]");
  expect(meta?.children).toHaveLength(2);
  expect(meta?.lastElementChild?.textContent).toContain("时间未知");
  expect(meta?.lastElementChild?.textContent).toContain("1.2 MiB");
  // The note is clamped in the tile; pressing it shows the whole note.
  const noteButton = within(first).getByRole("button", { name: note });
  fireEvent.click(noteButton);
  const panel = await screen.findByRole("dialog", {
    name: "390-dark.png 的说明",
  });
  expect(within(panel).getByText(note)).toBeTruthy();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  // Tiles without a note keep the same two-line slot, but nothing to press.
  expect(within(patch).queryByRole("button", { name: /./ })).toBeNull();
});

test("C-820: decisions use the same attachment tile as the attachments tab", () => {
  render(<DecisionAttachments attachments={[image]} />);
  const list = screen.getByRole("list", { name: "拍板附件" });
  const tile = within(list).getByRole("listitem");
  expect(tile.dataset.ui).toBe("attachment-tile");
  // Only the attachments tab carries the `attachment-<id>` anchor.
  expect(tile.id).toBe("");
  expect(
    within(tile).getByRole("link", { name: "下载 390-dark.png" }),
  ).toBeTruthy();
});
