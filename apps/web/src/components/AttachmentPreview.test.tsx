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
