// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import {
  ApiError,
  type ReleaseNoteEntryView,
  type ReleaseNotesData,
  type WriteReleaseNoteInput,
} from "../api.js";
import { fakeClient, NOW } from "../testing/fixtures.js";
import { ReleaseNotesPage } from "./ReleaseNotesPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const owner = {
  author: "human",
  author_display: "邵杰",
  member: { id: "M-1", name: "邵杰", title: "所有者", avatar: null },
};
const note = (version: string, body: string, revision = 1) => ({
  version,
  version_code: null,
  decision_id: "Q-1",
  body,
  author: "human",
  author_view: owner,
  created_at: NOW,
  updated_at: NOW,
  revision,
});
const entries = (): ReleaseNoteEntryView[] => [
  {
    version: "0.5.0",
    version_code: 3,
    decision_id: "Q-2",
    published_at: "2026-01-03T00:00:00.000Z",
    note: null,
  },
  {
    version: "0.4.2",
    version_code: 2,
    decision_id: "Q-1",
    published_at: "2026-01-02T00:00:00.000Z",
    note: note("0.4.2", "- 新增设置页\n- 修复闪退"),
  },
];

// Works while a modal dialog hides the page from the accessibility tree.
const rows = () => [
  ...document.querySelectorAll<HTMLElement>("[data-release-note]"),
];

test("C-713 lists versions newest first with time, author and body; an unwritten version shows 未填写", async () => {
  render(
    <ReleaseNotesPage
      client={fakeClient({
        releaseNotes: async () => ({ entries: entries() }),
      })}
      projectId="p-1"
    />,
  );
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "发版说明",
  );
  await screen.findByRole("region", { name: "发版说明列表" });
  const [first, second] = rows();
  expect(first?.textContent).toContain("0.5.0");
  expect(first?.textContent).toContain("未填写");
  expect(first?.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-01-03T00:00:00.000Z",
  );
  // Nothing to copy until a note exists; writing one is offered instead.
  expect(
    within(first as HTMLElement).queryByRole("button", { name: /复制/u }),
  ).toBeNull();
  within(first as HTMLElement).getByRole("button", {
    name: "填写 0.5.0 的发版说明",
  });
  expect(second?.textContent).toContain("0.4.2");
  expect(second?.textContent).toContain("邵杰");
  expect(
    within(second as HTMLElement)
      .getAllByRole("listitem")
      .map((li) => li.textContent?.trim()),
  ).toEqual(["新增设置页", "修复闪退"]);
  within(second as HTMLElement).getByRole("button", {
    name: "编辑 0.4.2 的发版说明",
  });
});

test("C-713 no publication shows the empty state only", async () => {
  const { container } = render(
    <ReleaseNotesPage client={fakeClient()} projectId="p-1" />,
  );
  await screen.findByText("没有发布的版本");
  expect(screen.queryByRole("table")).toBeNull();
  expect(container.querySelectorAll(".empty").length).toBe(1);
});

test("C-713 copy puts the plain-text body on the clipboard and reports a failure truthfully", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <ReleaseNotesPage
      client={fakeClient({
        releaseNotes: async () => ({ entries: entries() }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "复制 0.4.2 的发版说明" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("- 新增设置页\n- 修复闪退"),
  );
  await screen.findByText("已复制 0.4.2 的发版说明");
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(
    screen.getByRole("button", { name: "复制 0.4.2 的发版说明" }),
  );
  await screen.findByText("复制失败，请选中正文手动复制");
});

test("C-713 saving submits the whole body once and the list shows the server's record, not the draft", async () => {
  let list: ReleaseNotesData = { entries: entries() };
  const writes: { input: WriteReleaseNoteInput; key: string }[] = [];
  let release: (() => void) | undefined;
  const client = fakeClient({
    releaseNotes: vi.fn(async () => list),
    writeReleaseNote: async (_project, input, key) => {
      writes.push({ input, key });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      // The server normalises nothing here, but the page must show what it
      // returns rather than what was typed.
      const saved = note(input.version, "服务端记录", 1);
      list = {
        entries: list.entries.map((e) =>
          e.version === input.version ? { ...e, note: saved } : e,
        ),
      };
      return { note: { ...saved, author_view: undefined }, changed: true };
    },
  });
  render(<ReleaseNotesPage client={client} projectId="p-1" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "填写 0.5.0 的发版说明" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "填写 0.5.0 的发版说明",
  });
  const save = within(dialog).getByRole("button", { name: "保存" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const field = within(dialog).getByRole("textbox", { name: "正文" });
  // Typing does not write anything.
  fireEvent.change(field, { target: { value: "新" } });
  fireEvent.change(field, { target: { value: "新增关卡" } });
  expect(writes).toEqual([]);
  fireEvent.click(save);
  await waitFor(() => expect(writes.length).toBe(1));
  expect(writes[0]?.input).toEqual({
    version: "0.5.0",
    body: "新增关卡",
    base_revision: 0,
  });
  // While saving, the dialog cannot be dismissed and the list is unchanged.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "填写 0.5.0 的发版说明" }));
  expect(rows()[0]?.textContent).toContain("未填写");
  release?.();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "填写 0.5.0 的发版说明" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(rows()[0]?.textContent).toContain("服务端记录"));
  expect(rows()[0]?.textContent).not.toContain("新增关卡");
  await waitFor(() => expect(rows()[0]?.textContent).toContain("邵杰"));
  expect(writes.length).toBe(1);
});

test("C-713 a failed save stays in the dialog with the draft; retry reuses the key for the same body", async () => {
  const keys: string[] = [];
  let fail = true;
  const client = fakeClient({
    releaseNotes: async () => ({ entries: entries() }),
    writeReleaseNote: async (_project, input, key) => {
      keys.push(key);
      if (fail)
        throw new ApiError(
          409,
          "stale_target",
          "发版说明已被改为第 2 版，请刷新后再改",
        );
      return { note: note(input.version, input.body, 2), changed: true };
    },
  });
  render(<ReleaseNotesPage client={client} projectId="p-1" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 0.4.2 的发版说明" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "编辑 0.4.2 的发版说明",
  });
  const field = within(dialog).getByRole("textbox", {
    name: "正文",
  }) as HTMLTextAreaElement;
  expect(field.value).toBe("- 新增设置页\n- 修复闪退");
  fireEvent.change(field, { target: { value: "- 新增设置页" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("发版说明已被改为第 2 版");
  expect(field.value).toBe("- 新增设置页");
  fail = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "编辑 0.4.2 的发版说明" }),
    ).toBeNull(),
  );
  expect(keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});

test("C-713 leaving the editor with unsaved edits asks first; without edits it closes directly", async () => {
  const write = vi.fn();
  render(
    <ReleaseNotesPage
      client={fakeClient({
        releaseNotes: async () => ({ entries: entries() }),
        writeReleaseNote: write,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 0.4.2 的发版说明" }),
  );
  let dialog = await screen.findByRole("dialog", {
    name: "编辑 0.4.2 的发版说明",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(
    screen.getByRole("button", { name: "编辑 0.4.2 的发版说明" }),
  );
  dialog = await screen.findByRole("dialog", {
    name: "编辑 0.4.2 的发版说明",
  });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "正文" }), {
    target: { value: "改过" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  const confirm = await screen.findByRole("dialog", {
    name: "放弃未应用的修改？",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未应用的修改？" }),
    ).toBeNull(),
  );
  expect(
    (
      within(
        screen.getByRole("dialog", { name: "编辑 0.4.2 的发版说明" }),
      ).getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement
    ).value,
  ).toBe("改过");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
    ).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(write).not.toHaveBeenCalled();
  expect(rows()[1]?.textContent).toContain("修复闪退");
});

test("C-713 the page opens from the 观察 navigation and its link survives a reload", async () => {
  window.location.hash = "#/p/p-1/cards";
  const client = fakeClient({
    releaseNotes: async () => ({ entries: entries() }),
  });
  const { unmount } = render(<App client={client} />);
  const views = await screen.findByRole("navigation", { name: "视图" });
  fireEvent.click(await within(views).findByRole("link", { name: "发版说明" }));
  await screen.findByRole("region", { name: "发版说明列表" });
  expect(window.location.hash).toBe("#/p/p-1/release-notes");
  expect(
    within(views)
      .getByRole("link", { name: "发版说明" })
      .getAttribute("aria-current"),
  ).toBe("page");
  // A fresh load of the same URL opens the same page.
  unmount();
  render(<App client={client} />);
  await screen.findByRole("region", { name: "发版说明列表" });
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "发版说明",
  );
});
