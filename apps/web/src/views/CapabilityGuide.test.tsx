// @vitest-environment jsdom
// C-727: capability usage notes (C-725) in the machine detail.
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
import {
  ApiError,
  type CapabilityGuidesView,
  type CardiganClient,
  type ExecutionCapacity,
  HttpCardiganClient,
  type MachineView,
} from "../api.js";
import { CapacityProvider } from "../components/Capacity.js";
import { fakeClient } from "../testing/fixtures.js";
import { fixtureMachines } from "../testing/machines-fixture.js";
import { MachinesSettings } from "./MachinesSettings.js";
import { resetMachineActions } from "./machine-actions.js";
import { resetSettingWrites } from "./useSettingWrite.js";

afterEach(() => {
  cleanup();
  resetSettingWrites();
  resetMachineActions();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.location.hash = "";
});

const local = fixtureMachines.find((m) => m.id === "local") as MachineView;
const capacity: ExecutionCapacity = {
  agents: [],
  merge_checks: [],
  merge_config_invalid: false,
};
type Notes = Record<
  string,
  { usage_note?: string | null; machine_note?: string | null }
>;
const view = (notes: Notes): CapabilityGuidesView => ({
  merged: {
    machine_id: "local",
    capabilities: Object.entries(notes).map(([key, n]) => ({
      key,
      usage_note: n.usage_note ?? null,
      machine_note: n.machine_note ?? null,
    })),
  },
});
/** A fake server: notes by key, written by the set/delete calls. */
function guideServer(initial: Notes) {
  const notes: Notes = structuredClone(initial);
  const entry = (key: string) => {
    notes[key] = notes[key] ?? {};
    return notes[key];
  };
  return {
    notes,
    capabilityGuides: vi.fn(async () => view(notes)),
    setCapabilityGuide: vi.fn(
      async (
        _p: string,
        target: { scope: string; key: string },
        text: string,
      ) => {
        if (target.scope === "capability") entry(target.key).usage_note = text;
        else entry(target.key).machine_note = text;
      },
    ),
    deleteCapabilityGuide: vi.fn(
      async (_p: string, target: { scope: string; key: string }) => {
        if (target.scope === "capability") entry(target.key).usage_note = null;
        else entry(target.key).machine_note = null;
      },
    ),
  };
}
function client(overrides: Partial<CardiganClient> = {}) {
  return fakeClient({
    executionCapacity: vi.fn(async () => capacity),
    machines: vi.fn(async () => ({ machines: [local] })),
    machine: vi.fn(async () => ({ machine: local })),
    setRunLimit: vi.fn(async () => {}),
    ...overrides,
  });
}
async function openDetail(c: CardiganClient, canEdit = true) {
  render(
    <CapacityProvider client={c} projectId="p-1" revision={0} canEdit={canEdit}>
      <MachinesSettings client={c} projectId="p-1" pollMs={5} />
    </CapacityProvider>,
  );
  const table = await screen.findByRole("table", { name: "机器列表" });
  fireEvent.click(within(table).getByRole("button", { name: "本机" }));
  const drawer = await screen.findByRole("dialog");
  await within(drawer).findByText("概况");
  return within(drawer);
}
const capabilityTable = (drawer: ReturnType<typeof within>) =>
  drawer.getByRole("table", { name: "能力" });
const noteRow = (drawer: ReturnType<typeof within>, key: string) =>
  within(capabilityTable(drawer)).queryByRole("row", {
    name: `${key} 使用说明`,
  });
const editDialog = (key: string) =>
  screen.findByRole("dialog", { name: `${key} 使用说明` });

test("notes sit under their capability rows of this project; none means no row", async () => {
  const server = guideServer({
    "browser.chromium": {
      usage_note: "用 `chromium --headless` 启动",
      machine_note: "本机装在 **~/.local/chromium**",
    },
    // A key observed only by the other project: its row stays bare.
    node: { usage_note: "node 说明" },
  });
  const drawer = await openDetail(client(server));
  const row = await waitFor(() => {
    const found = noteRow(drawer, "browser.chromium");
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(server.capabilityGuides).toHaveBeenCalledWith("p-1", "local");
  // Rendered Markdown, the main note first, then this machine's supplement.
  expect(within(row).getByText("chromium --headless").tagName).toBe("CODE");
  expect(within(row).getByText("~/.local/chromium").tagName).toBe("STRONG");
  expect([...row.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
    "使用说明",
    "本机补充",
  ]);
  // Right below its own row, spanning the table.
  const above = row.previousElementSibling as HTMLElement;
  expect(within(above).getByText("browser.chromium")).toBeTruthy();
  expect(row.querySelector("td")?.colSpan).toBe(6);
  // Only browser.chromium has a note: the other rows have no empty shell.
  expect(
    within(capabilityTable(drawer))
      .getAllByRole("row")
      .filter((r) => r.hasAttribute("data-row-detail")),
  ).toHaveLength(1);
  expect(noteRow(drawer, "node")).toBeNull();
});

test("a read-only session sees the notes without an edit entry", async () => {
  const server = guideServer({ "harness.codex": { usage_note: "只读说明" } });
  const drawer = await openDetail(client(server), false);
  await waitFor(() => expect(noteRow(drawer, "harness.codex")).not.toBeNull());
  expect(drawer.queryByRole("button", { name: /使用说明$/ })).toBeNull();
  // No install entry either: the 操作 column is not drawn.
  expect(
    within(capabilityTable(drawer))
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).not.toContain("操作");
});

test("without the notes read the capability table is unchanged", async () => {
  const drawer = await openDetail(client());
  const headers = within(capabilityTable(drawer))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual(["能力", "项目", "版本", "验证时间", "状态"]);
  expect(drawer.queryByText("编辑说明")).toBeNull();
});

test("保存 sends only the changed note, then shows the server's value", async () => {
  const server = guideServer({
    "harness.codex": { usage_note: "旧说明", machine_note: "本机旧补充" },
  });
  const drawer = await openDetail(client(server));
  await waitFor(() => expect(noteRow(drawer, "harness.codex")).not.toBeNull());
  const reads = server.capabilityGuides.mock.calls.length;
  fireEvent.click(
    drawer.getByRole("button", { name: "编辑 harness.codex 使用说明" }),
  );
  const dialog = within(await editDialog("harness.codex"));
  const main = dialog.getByLabelText("使用说明") as HTMLTextAreaElement;
  expect(main.value).toBe("旧说明");
  expect(
    (dialog.getByLabelText("本机补充（本机）") as HTMLTextAreaElement).value,
  ).toBe("本机旧补充");
  const save = dialog.getByRole("button", { name: "保存使用说明" });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(main, { target: { value: "  新说明\r\n第二行  " } });
  fireEvent.click(save);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "harness.codex 使用说明" }),
    ).toBeNull(),
  );
  expect(server.setCapabilityGuide).toHaveBeenCalledTimes(1);
  expect(server.setCapabilityGuide).toHaveBeenCalledWith(
    "p-1",
    { scope: "capability", key: "harness.codex", machine_id: null },
    "新说明\n第二行",
  );
  expect(server.deleteCapabilityGuide).not.toHaveBeenCalled();
  // Read back after the write; the row shows what the server holds.
  await waitFor(() =>
    expect(server.capabilityGuides.mock.calls.length).toBeGreaterThan(reads),
  );
  const row = await waitFor(() => {
    const found = noteRow(drawer, "harness.codex") as HTMLElement;
    expect(within(found).getByText(/新说明/)).toBeTruthy();
    return found;
  });
  expect(within(row).getByText("本机旧补充")).toBeTruthy();
  expect(await screen.findByText("已保存 harness.codex 使用说明")).toBeTruthy();
});

test("clearing a note removes it; a new machine note is written for this machine", async () => {
  const server = guideServer({ "harness.codex": { usage_note: "要删掉的" } });
  const drawer = await openDetail(client(server));
  await waitFor(() => expect(noteRow(drawer, "harness.codex")).not.toBeNull());
  fireEvent.click(
    drawer.getByRole("button", { name: "编辑 harness.codex 使用说明" }),
  );
  const dialog = within(await editDialog("harness.codex"));
  fireEvent.change(dialog.getByLabelText("使用说明"), {
    target: { value: "   " },
  });
  fireEvent.change(dialog.getByLabelText("本机补充（本机）"), {
    target: { value: "本机才有" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "保存使用说明" }));
  await waitFor(() =>
    expect(server.setCapabilityGuide).toHaveBeenCalledWith(
      "p-1",
      { scope: "machine", key: "harness.codex", machine_id: "local" },
      "本机才有",
    ),
  );
  expect(server.deleteCapabilityGuide).toHaveBeenCalledWith("p-1", {
    scope: "capability",
    key: "harness.codex",
    machine_id: null,
  });
  const row = await waitFor(() => {
    const found = noteRow(drawer, "harness.codex") as HTMLElement;
    expect(found.querySelectorAll("dt")).toHaveLength(1);
    return found;
  });
  expect(within(row).getByText("本机补充")).toBeTruthy();
});

test("a failed save keeps the draft and the reason in the dialog; retry sends what is left", async () => {
  const server = guideServer({});
  server.setCapabilityGuide.mockRejectedValueOnce(
    new ApiError(
      400,
      "validation_failed",
      "使用说明看起来包含凭据（访问令牌）；只写受管文件路径和读取方法，不写值",
    ),
  );
  const drawer = await openDetail(client(server));
  await waitFor(() => expect(server.capabilityGuides).toHaveBeenCalled());
  // No note yet: the row has no detail, the entry still offers to write one.
  expect(noteRow(drawer, "harness.pi")).toBeNull();
  await waitFor(() =>
    expect(
      drawer
        .getByRole("button", { name: "编辑 harness.pi 使用说明" })
        .getAttribute("aria-disabled"),
    ).toBeNull(),
  );
  fireEvent.click(
    drawer.getByRole("button", { name: "编辑 harness.pi 使用说明" }),
  );
  const dialog = within(await editDialog("harness.pi"));
  fireEvent.change(dialog.getByLabelText("使用说明"), {
    target: { value: "pi 的用法" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "保存使用说明" }));
  expect(
    await dialog.findByText(/使用说明未保存：.*看起来包含凭据/),
  ).toBeTruthy();
  expect((dialog.getByLabelText("使用说明") as HTMLTextAreaElement).value).toBe(
    "pi 的用法",
  );
  // Retry once the notes were read again.
  const save = dialog.getByRole("button", { name: "保存使用说明" });
  await waitFor(() => expect(save.getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(save);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "harness.pi 使用说明" }),
    ).toBeNull(),
  );
  expect(server.setCapabilityGuide).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(noteRow(drawer, "harness.pi")).not.toBeNull());
});

test("after a write nothing is edited until the notes were read again", async () => {
  const server = guideServer({ "harness.codex": { usage_note: "说明" } });
  let release: (() => void) | undefined;
  const drawer = await openDetail(client(server));
  await waitFor(() => expect(noteRow(drawer, "harness.codex")).not.toBeNull());
  const edit = () =>
    drawer.getByRole("button", { name: "编辑 harness.codex 使用说明" });
  fireEvent.click(edit());
  const dialog = within(await editDialog("harness.codex"));
  // The read after the write is held back.
  server.capabilityGuides.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(view(server.notes));
      }),
  );
  fireEvent.change(dialog.getByLabelText("使用说明"), {
    target: { value: "改过" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "保存使用说明" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "harness.codex 使用说明" }),
    ).toBeNull(),
  );
  expect(edit().getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(edit());
  expect(
    screen.queryByRole("dialog", { name: "harness.codex 使用说明" }),
  ).toBeNull();
  await act(async () => release?.());
  await waitFor(() => expect(edit().getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(edit());
  const reopened = within(await editDialog("harness.codex"));
  expect(
    (reopened.getByLabelText("使用说明") as HTMLTextAreaElement).value,
  ).toBe("改过");
});

test("leaving unsaved edits asks first; the tab asks through the browser", async () => {
  const server = guideServer({ "harness.codex": { usage_note: "说明" } });
  const drawer = await openDetail(client(server));
  await waitFor(() => expect(noteRow(drawer, "harness.codex")).not.toBeNull());
  fireEvent.click(
    drawer.getByRole("button", { name: "编辑 harness.codex 使用说明" }),
  );
  const dialog = within(await editDialog("harness.codex"));
  // Untouched: 取消 closes at once and nothing guards the tab.
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  fireEvent.change(dialog.getByLabelText("使用说明"), {
    target: { value: "没保存的" },
  });
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(dialog.getByRole("button", { name: "取消" }));
  const ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "继续编辑" }));
  expect((dialog.getByLabelText("使用说明") as HTMLTextAreaElement).value).toBe(
    "没保存的",
  );
  fireEvent.keyDown(dialog.getByLabelText("使用说明"), { key: "Escape" });
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
    ).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "harness.codex 使用说明" }),
    ).toBeNull(),
  );
  expect(server.setCapabilityGuide).not.toHaveBeenCalled();
});

test("the HTTP client reads per machine and writes with the session, never a token", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ entries: [], ...view({}) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ entry: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "not_found", message: "没有" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
  const http = new HttpCardiganClient(fetch);
  await http.capabilityGuides("p 1", "mac-mini");
  const target = {
    scope: "machine",
    key: "android.emulator",
    machine_id: "mac-mini",
  } as const;
  await http.setCapabilityGuide("p 1", target, "说明");
  // Already gone counts as removed.
  await expect(http.deleteCapabilityGuide("p 1", target)).resolves.toBe(
    undefined,
  );
  const calls = fetch.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method,
    body: init?.body,
    credentials: init?.credentials,
    authorization: new Headers(init?.headers).get("authorization"),
  }));
  expect(calls).toEqual([
    {
      url: "/api/projects/p%201/capability-guides?machine=mac-mini",
      method: "GET",
      body: undefined,
      credentials: "same-origin",
      authorization: null,
    },
    {
      url: "/api/projects/p%201/capability-guides",
      method: "PUT",
      body: JSON.stringify({ ...target, usage_note: "说明" }),
      credentials: "same-origin",
      authorization: null,
    },
    {
      url: "/api/projects/p%201/capability-guides",
      method: "DELETE",
      body: JSON.stringify(target),
      credentials: "same-origin",
      authorization: null,
    },
  ]);
});
