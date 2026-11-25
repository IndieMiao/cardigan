// @vitest-environment jsdom
/**
 * C-683: videos in the comment box (resumable upload with progress and a
 * retry that resumes) and in the timeline (cover, duration, size; the
 * browser's own player, never autoplaying).
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
import type { CardiganClient, UploadAttachmentInput } from "../api.js";
import { attachmentRefKind, uploadProblem } from "../attachment-refs.js";
import { attachment, fakeClient } from "../testing/fixtures.js";
import { CommentBox, uploadPercent } from "./CommentBox.js";
import { formatDuration, VideoPreview } from "./VideoPreview.js";

vi.mock("../video-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../video-probe.js")>()),
  measureVideo: vi.fn(async () => ({
    video: {
      duration_seconds: 74.5,
      width: 1920,
      height: 1080,
      video_codec: "h264",
    },
    poster: "/9j/4AAQ",
  })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MIB = 1024 * 1024;
const choose = (...files: File[]) =>
  fireEvent.change(
    document.querySelector('input[type="file"]') as HTMLInputElement,
    { target: { files } },
  );
const chips = () =>
  within(screen.getByRole("list", { name: "待上传的附件" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

test("C-683: video types, limits and kinds in the upload rules", () => {
  const clip = (name: string, type: string, size: number) =>
    ({ name, type, size }) as File;
  expect(uploadProblem(clip("a.mp4", "video/mp4", 500 * MIB))).toBeUndefined();
  expect(uploadProblem(clip("a.MOV", "", 10))).toBeUndefined();
  expect(uploadProblem(clip("a.m4v", "", 10))).toBeUndefined();
  expect(
    uploadProblem(clip("a.webm", "video/webm", 2 * MIB), 1 * MIB, 4 * MIB),
  ).toBeUndefined();
  expect(
    uploadProblem(clip("a.webm", "video/webm", 5 * MIB), 1 * MIB, 4 * MIB),
  ).toBe("超过 4 MiB");
  expect(uploadProblem(clip("a.avi", "video/x-msvideo", 10))).toMatch(
    /不支持这种类型/u,
  );
  expect(attachmentRefKind("video/quicktime")).toBe("video");
  expect(uploadPercent(0, 100)).toBe(0);
  expect(uploadPercent(99.9, 100)).toBe(99);
  expect(uploadPercent(100, 100)).toBe(100);
  expect(formatDuration(74.5)).toBe("1:15");
  expect(formatDuration(3725)).toBe("1:02:05");
});

function setup(uploadVideo: NonNullable<CardiganClient["uploadVideo"]>) {
  const uploads: UploadAttachmentInput[] = [];
  let failAttach = 0;
  const client = fakeClient({
    addComment: async (_p, _c, input) => ({
      id: "C-1#9",
      body: input.body,
      created_at: "2026-01-01",
    }),
    uploadAttachment: async (_p, _c, input) => {
      if (failAttach-- > 0) throw new Error("offline");
      uploads.push(input);
      return { id: `attachment-${10 + uploads.length}` };
    },
  });
  render(
    <CommentBox
      client={{
        ...client,
        attachmentMaxBytes: () => 10 * MIB,
        videoMaxBytes: () => 1024 * MIB,
        uploadVideo,
      }}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
  act(() => input.focus());
  return {
    input,
    uploads,
    failNextAttach: () => {
      failAttach = 1;
    },
  };
}

test("C-683: a video goes through the resumable upload with progress, then attaches by upload id", async () => {
  let release: (() => void) | undefined;
  const calls: { uploadId?: string | undefined }[] = [];
  const uploadVideo = vi.fn<NonNullable<CardiganClient["uploadVideo"]>>(
    async (_project, file, _mime, options) => {
      calls.push({ uploadId: options?.uploadId });
      options?.onStarted?.("up-1");
      options?.onProgress?.(file.size / 4, file.size);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      options?.onProgress?.(file.size, file.size);
      return "up-1";
    },
  );
  const { input, uploads } = setup(uploadVideo);
  const video = new File(["0123456789abcdef"], "演示.mp4", {
    type: "video/mp4",
  });
  Object.defineProperty(video, "size", { value: 600 * MIB });
  choose(video);
  expect(chips()).toEqual([expect.stringContaining("演示.mp4600.0 MiB")]);
  fireEvent.change(input, { target: { value: "概念稿" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(chips()[0]).toContain("25%"));
  act(() => release?.());
  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(uploads[0]).toMatchObject({
    upload_id: "up-1",
    // Measured and drawn by the browser before sending (C-683).
    video: {
      duration_seconds: 74.5,
      width: 1920,
      height: 1080,
      video_codec: "h264",
    },
    poster: "/9j/4AAQ",
    mime: "video/mp4",
    original_filename: "演示.mp4",
    attach_to: { kind: "timeline_entry", id: "C-1#9" },
    ref_slot: 1,
  });
  expect(uploads[0]).not.toHaveProperty("file");
  expect(calls).toEqual([{ uploadId: undefined }]);
});

test("C-683: a failed attach keeps the video's upload so the retry resumes it", async () => {
  const seen: (string | undefined)[] = [];
  const uploadVideo: NonNullable<CardiganClient["uploadVideo"]> = async (
    _project,
    _file,
    _mime,
    options,
  ) => {
    seen.push(options?.uploadId);
    options?.onStarted?.("up-7");
    return "up-7";
  };
  const { input, uploads, failNextAttach } = setup(uploadVideo);
  failNextAttach();
  choose(new File(["x"], "clip.webm", { type: "video/webm" }));
  fireEvent.change(input, { target: { value: "录屏" } });
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("附件上传失败"),
  );
  fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
  await waitFor(() => expect(uploads).toHaveLength(1));
  expect(seen).toEqual([undefined, "up-7"]);
});

test("C-683: an oversized video is refused in place with the host limit", () => {
  setup(async () => "never");
  const big = new File(["x"], "long.mov", { type: "video/quicktime" });
  Object.defineProperty(big, "size", { value: 1024 * MIB + 1 });
  choose(big);
  expect(screen.getByRole("alert").textContent).toContain(
    "long.mov：超过 1024 MiB",
  );
});

test("C-683: the timeline shows the cover, duration and size and plays only on request", () => {
  const video = attachment({
    id: "attachment-8",
    original_filename: "演示.mp4",
    mime: "video/mp4",
    size: 12.4 * MIB,
    inline: false,
    thumbnail_path: null,
    download_path: "/api/projects/p-1/attachments/attachment-8",
    poster_path: "/api/projects/p-1/attachments/attachment-8/poster",
    video: { duration_seconds: 74.5, width: 1920, height: 1080 },
  });
  render(<VideoPreview attachment={video} />);
  const tile = screen.getByRole("button", { name: "播放 演示.mp4" });
  expect(tile.querySelector("img")?.getAttribute("src")).toBe(
    "/api/projects/p-1/attachments/attachment-8/poster",
  );
  expect(tile.textContent).toBe("1:15 · 12.4 MiB");
  expect(document.querySelector("video")).toBeNull();
  fireEvent.click(tile);
  const player = document.querySelector("video") as HTMLVideoElement;
  expect(player.getAttribute("src")).toBe(
    "/api/projects/p-1/attachments/attachment-8",
  );
  expect(player.hasAttribute("controls")).toBe(true);
  expect(player.hasAttribute("autoplay")).toBe(false);
  expect(screen.getByRole("link", { name: "下载" }).getAttribute("href")).toBe(
    "/api/projects/p-1/attachments/attachment-8",
  );
});

test("C-683: a video uploaded without a cover (CLI, Agent) shows the generic icon", () => {
  render(
    <VideoPreview
      attachment={attachment({
        id: "attachment-9",
        original_filename: "agent.webm",
        mime: "video/webm",
        size: 2048,
        inline: false,
        thumbnail_path: null,
        download_path: "/api/projects/p-1/attachments/attachment-9",
        video: {},
      })}
    />,
  );
  const tile = screen.getByRole("button", { name: "播放 agent.webm" });
  expect(tile.querySelector("img")).toBeNull();
  expect(tile.querySelector("svg")).not.toBeNull();
  expect(tile.textContent).toBe("2.0 KiB");
});
