// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ApiError,
  type CardiganClient,
  type PreferencesView,
  type TemplateView,
} from "../api.js";
import { httpSharedFiles } from "../shared-files-api.js";
import { fakeClient } from "../testing/fixtures.js";
import { CreateCardButton } from "./CreateCardButton.js";

vi.mock("../video-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../video-probe.js")>()),
  measureVideo: vi.fn(async () => ({
    video: { duration_seconds: 12, width: 1280, height: 720 },
    poster: "/9j/4AAQ",
  })),
}));

beforeEach(() => {
  // jsdom has no layout or pointer capture for the Radix select.
  HTMLElement.prototype.scrollIntoView ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const template = (
  id: string,
  title: string,
  extra: Partial<TemplateView> = {},
): TemplateView => ({
  id,
  title,
  description: "",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  work_items: [],
  completion: { mode: "human_mark_done" },
  ...extra,
});
const templates = [
  template("story", "需求卡", { story: true }),
  template("dev", "开发卡", { require_acceptance_criteria: true }),
  template("general", "通用卡"),
];
const preferences = (human_card_templates?: string[]): PreferencesView => ({
  auto_merge_after_minutes: null,
  merge_gate_enabled: false,
  ...(human_card_templates ? { human_card_templates } : {}),
});

function setup(overrides: Partial<CardiganClient> = {}, allowed?: string[]) {
  const onCreated = vi.fn();
  const client = fakeClient({
    templates: async () => ({ templates }),
    preferences: async () => preferences(allowed),
    ...overrides,
  });
  render(
    <CreateCardButton client={client} projectId="p-1" onCreated={onCreated} />,
  );
  return { onCreated };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "新建需求" }));
  const dialog = within(await screen.findByRole("dialog"));
  await waitFor(() =>
    expect(
      (dialog.getByRole("button", { name: "创建" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  return dialog;
}
const fill = (
  dialog: ReturnType<typeof within>,
  label: string,
  value: string,
) => fireEvent.change(dialog.getByLabelText(label), { target: { value } });
const png = () => new File(["png"], "sketch.png", { type: "image/png" });

test("by default a person opens a story: no template choice, title, description and files", async () => {
  const createCard = vi.fn<CardiganClient["createCard"]>(async () => ({
    id: "C-7",
    entry_id: "C-7#1",
  }));
  const uploadAttachment = vi.fn<CardiganClient["uploadAttachment"]>(
    async () => ({ id: "attachment-1" }),
  );
  const { onCreated } = setup({ createCard, uploadAttachment });
  const dialog = await open();
  expect(dialog.getByRole("heading", { name: "新建需求" })).toBeTruthy();
  expect(dialog.queryByText("模板")).toBeNull();
  expect(dialog.queryByLabelText("验收标准")).toBeNull();
  expect(dialog.queryByLabelText("父需求卡（可选）")).toBeNull();
  fill(dialog, "标题", "导出报表");
  fill(dialog, "描述", "希望每周能导出一次");
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: { files: [png()] },
  });
  expect(
    dialog.getByRole("list", { name: "待上传的附件" }).textContent,
  ).toContain("sketch.png");
  fireEvent.click(dialog.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("C-7"));
  expect(createCard).toHaveBeenCalledWith(
    "p-1",
    {
      title: "导出报表",
      goal: "希望每周能导出一次",
      template_id: "story",
      acceptance_criteria: [],
    },
    expect.any(String),
  );
  expect(uploadAttachment).toHaveBeenCalledWith(
    "p-1",
    "C-7",
    expect.objectContaining({
      original_filename: "sketch.png",
      mime: "image/png",
      kind: "evidence",
      attach_to: { kind: "timeline_entry", id: "C-7#1" },
    }),
    expect.any(String),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("once the owner opens other templates the dialog offers a template choice", async () => {
  const createCard = vi.fn<CardiganClient["createCard"]>(async () => ({
    id: "C-8",
    entry_id: "C-8#1",
  }));
  setup({ createCard }, ["story", "dev"]);
  const dialog = await open();
  const choice = dialog.getByRole("combobox", { name: /模板/ });
  expect(choice.textContent).toContain("需求卡");
  fireEvent.keyDown(choice, { key: "ArrowDown" });
  // Only the opened templates are offered.
  const options = await screen.findAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["需求卡", "开发卡"]);
  fireEvent.keyDown(options[1] as HTMLElement, { key: "Enter" });
  expect(dialog.getByRole("heading", { name: "新建卡片" })).toBeTruthy();
  fill(dialog, "标题", "Build");
  fill(dialog, "目标", "Outcome");
  fill(dialog, "验收标准", "Reviewed");
  fireEvent.click(dialog.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(createCard).toHaveBeenCalled());
  expect(createCard.mock.calls[0]?.[1]).toMatchObject({
    template_id: "dev",
    acceptance_criteria: ["Reviewed"],
  });
});

test("a server refusal stays in the dialog with everything typed", async () => {
  const createCard = vi.fn<CardiganClient["createCard"]>(async () => {
    throw new ApiError(
      400,
      "validation_failed",
      "人只能开需求卡；“开发卡”需由所有者在设置 → 偏好 → 人可开的卡片模板中放开",
    );
  });
  setup({ createCard });
  const dialog = await open();
  fill(dialog, "标题", "Keep me");
  fill(dialog, "描述", "Still here");
  fireEvent.click(dialog.getByRole("button", { name: "创建" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "人只能开需求卡",
  );
  expect((dialog.getByLabelText("标题") as HTMLInputElement).value).toBe(
    "Keep me",
  );
  expect((dialog.getByLabelText("描述") as HTMLTextAreaElement).value).toBe(
    "Still here",
  );
});

test("closing with typed content asks first; an empty dialog closes at once", async () => {
  setup();
  let dialog = await open();
  fireEvent.click(dialog.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  dialog = await open();
  fill(dialog, "标题", "Draft");
  fireEvent.keyDown(dialog.getByLabelText("标题"), { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect(
    (
      within(screen.getByRole("dialog", { name: "新建需求" })).getByLabelText(
        "标题",
      ) as HTMLInputElement
    ).value,
  ).toBe("Draft");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a failed upload keeps the created card and retries only the files", async () => {
  const createCard = vi.fn<CardiganClient["createCard"]>(async () => ({
    id: "C-9",
    entry_id: "C-9#1",
  }));
  const uploadAttachment = vi
    .fn<CardiganClient["uploadAttachment"]>()
    .mockRejectedValueOnce(new ApiError(413, "payload_too_large", "附件超限"))
    .mockResolvedValue({ id: "attachment-2" });
  const { onCreated } = setup({ createCard, uploadAttachment });
  const dialog = await open();
  fill(dialog, "标题", "With file");
  fill(dialog, "描述", "See the sketch");
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: { files: [png()] },
  });
  fireEvent.click(dialog.getByRole("button", { name: "创建" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "卡片 C-9 已创建，附件上传失败",
  );
  expect(onCreated).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "重试上传" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("C-9"));
  expect(createCard).toHaveBeenCalledTimes(1);
  expect(uploadAttachment).toHaveBeenCalledTimes(2);
  expect(uploadAttachment.mock.calls[1]?.[3]).toBe(
    uploadAttachment.mock.calls[0]?.[3],
  );
});

test("files the server would refuse are listed with the reason and not added", async () => {
  setup({ attachmentMaxBytes: () => 2 });
  const dialog = await open();
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: { files: [png()] },
  });
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "sketch.png：超过",
  );
  expect(dialog.queryByRole("list", { name: "待上传的附件" })).toBeNull();
});

test("C-717: the attachment button adds an empty-type .txt or .log and names every refusal", async () => {
  setup();
  const dialog = await open();
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: {
      files: [
        new File(["a"], "notes.txt", { type: "" }),
        new File(["b"], "run.log", { type: "" }),
        new File(["c"], "README", { type: "" }),
      ],
    },
  });
  expect(
    within(dialog.getByRole("list", { name: "待上传的附件" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    expect.stringContaining("notes.txt"),
    expect.stringContaining("run.log"),
  ]);
  expect(dialog.getByRole("alert").textContent).toMatch(
    /README：不支持这种类型/u,
  );
});

test("C-717: the dialog takes a zip and points an oversize file to the shared library", async () => {
  vi.spyOn(httpSharedFiles, "list").mockResolvedValue({
    availability: "ready",
    notice: "",
    path: "",
    dirs: [],
    files: [],
  });
  setup({ attachmentMaxBytes: () => 4 });
  const dialog = await open();
  const big = new File(["12345"], "big.txt", { type: "text/plain" });
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: {
      files: [new File(["PK"], "logs.zip", { type: "application/zip" }), big],
    },
  });
  expect(
    within(dialog.getByRole("list", { name: "待上传的附件" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([expect.stringContaining("logs.zip")]);
  const link = await dialog.findByRole("link", { name: "共享文件库" });
  expect(link.closest("li")?.textContent).toMatch(
    /^big\.txt：超过 .+ MiB，可以改传到共享文件库$/u,
  );
});

test("C-683: a video goes through the resumable upload, and a retry resumes it", async () => {
  const createCard = vi.fn<CardiganClient["createCard"]>(async () => ({
    id: "C-10",
    entry_id: "C-10#1",
  }));
  const uploadVideo = vi
    .fn<NonNullable<CardiganClient["uploadVideo"]>>()
    .mockImplementationOnce(async (_p, file, _m, options) => {
      options?.onStarted?.("up-1");
      options?.onProgress?.(file.size / 2, file.size);
      throw new ApiError(503, "unavailable", "断开");
    })
    .mockImplementation(async () => "up-1");
  const uploadAttachment = vi.fn<CardiganClient["uploadAttachment"]>(
    async () => ({ id: "attachment-3" }),
  );
  const { onCreated } = setup({
    createCard,
    uploadAttachment,
    uploadVideo,
    videoMaxBytes: () => 1024 * 1024 * 1024,
  });
  const dialog = await open();
  fill(dialog, "标题", "Recording");
  fill(dialog, "描述", "See the clip");
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: { files: [new File(["0123"], "clip.mp4", { type: "video/mp4" })] },
  });
  fireEvent.click(dialog.getByRole("button", { name: "创建" }));
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "卡片 C-10 已创建，附件上传失败",
  );
  expect(
    dialog.getByRole("list", { name: "待上传的附件" }).textContent,
  ).toContain("50%");
  expect(uploadAttachment).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "重试上传" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("C-10"));
  expect(createCard).toHaveBeenCalledTimes(1);
  expect(uploadVideo.mock.calls[1]?.[3]?.uploadId).toBe("up-1");
  const input = uploadAttachment.mock.calls[0]?.[2];
  expect(input).toMatchObject({
    upload_id: "up-1",
    mime: "video/mp4",
    original_filename: "clip.mp4",
    video: { duration_seconds: 12, width: 1280, height: 720 },
    poster: "/9j/4AAQ",
    attach_to: { kind: "timeline_entry", id: "C-10#1" },
  });
  expect(input).not.toHaveProperty("file");
});

test("C-683: a server without video uploads refuses a video", async () => {
  setup();
  const dialog = await open();
  fireEvent.change(dialog.getByLabelText("添加附件"), {
    target: { files: [new File(["0"], "clip.mp4", { type: "video/mp4" })] },
  });
  expect((await dialog.findByRole("alert")).textContent).toContain(
    "clip.mp4：不支持上传视频",
  );
});
