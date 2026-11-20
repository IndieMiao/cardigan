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
  HttpCardiganClient,
  type LaunchChange,
  type LaunchProfileCheck,
  type LaunchSettingsView,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { launchSettingsFixture } from "../testing/launch-settings-fixture.js";
import { SettingsPage } from "./SettingsPage.js";

/**
 * C-516: launch settings writes go preview → confirm against a mocked C-515
 * API (synthetic fixture, no host, endpoint or secret value); checks run only
 * when the person clicks.
 */
afterEach(() => {
  cleanup();
  window.location.hash = "";
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const V1 = "a".repeat(64);
const V2 = "b".repeat(64);
const PREVIEW = "11111111-1111-4111-8111-111111111111";

function harness(overrides: Partial<CardiganClient> = {}) {
  const launchSettings = vi.fn(async () => launchSettingsFixture);
  const previewLaunchChange = vi.fn(
    async (version: string, change: LaunchChange) => ({
      version,
      preview_id: PREVIEW,
      diff:
        change.op === "delete_profile"
          ? [
              {
                field: `profiles.${change.name}`,
                before: change.name,
                after: null,
              },
            ]
          : [
              {
                field: `profiles.${change.name}.effort`,
                before: "high",
                after: "medium",
              },
            ],
    }),
  );
  const confirmLaunchChange = vi.fn(async () => {});
  const startLaunchCheck = vi.fn(
    async (version: string, profile: string, mode: "metadata" | "online") => ({
      id: "c",
      profile,
      mode,
      version,
      status: "running" as const,
    }),
  );
  const client = fakeClient({
    launchSettings,
    previewLaunchChange,
    confirmLaunchChange,
    startLaunchCheck,
    ...overrides,
  });
  return {
    client,
    launchSettings,
    previewLaunchChange,
    confirmLaunchChange,
    startLaunchCheck,
  };
}

async function openModels(client: CardiganClient) {
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  await screen.findByRole("table", { name: "启动配置" });
}
async function openProfile(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.findByRole("dialog", { name });
}
const field = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("textbox", { name });

test("a new profile is previewed first and written only after confirming", async () => {
  const api = harness();
  await openModels(api.client);
  fireEvent.click(screen.getByRole("button", { name: "新建启动配置" }));
  const dialog = await screen.findByRole("dialog", { name: "新建启动配置" });
  const preview = within(dialog).getByRole("button", { name: "预览修改" });
  expect(preview.hasAttribute("disabled")).toBe(true);

  // Invalid and taken names are marked in place; nothing is sent.
  const name = field(dialog, "名称");
  fireEvent.change(name, { target: { value: "Bad Name" } });
  expect(name.getAttribute("aria-invalid")).toBe("true");
  const note = document.getElementById(
    name.getAttribute("aria-describedby") ?? "",
  );
  expect(note?.textContent).toContain("小写字母");
  fireEvent.change(name, { target: { value: "claude-opus" } });
  expect(
    document.getElementById(name.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("已有同名配置");
  expect(preview.hasAttribute("disabled")).toBe(true);

  fireEvent.change(name, { target: { value: "opus-review" } });
  expect(name.hasAttribute("aria-invalid")).toBe(false);
  changeControl(within(dialog).getByRole("combobox", { name: /模型/ }), {
    target: { value: "opus" },
  });
  changeControl(within(dialog).getByRole("combobox", { name: /Provider/ }), {
    target: { value: "anthropic" },
  });
  fireEvent.click(preview);
  await within(dialog).findByRole("form", { name: "确认新建启动配置" });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "create_profile",
    name: "opus-review",
    fields: { harness: "claude-code", provider: "anthropic", model: "opus" },
  });
  expect(api.confirmLaunchChange).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("推理强度");
  expect(dialog.textContent).toContain("high → medium");

  const reads = api.launchSettings.mock.calls.length;
  fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.confirmLaunchChange).toHaveBeenCalledWith(
    V1,
    PREVIEW,
    expect.any(String),
  );
  // The list and “who uses it” are read again.
  await waitFor(() =>
    expect(api.launchSettings.mock.calls.length).toBeGreaterThan(reads),
  );
  expect(
    await screen.findByText("已新建启动配置 opus-review，新运行将使用它"),
  ).toBeTruthy();
});

test("an edit sends only the changed fields and clears emptied ones", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  const form = within(dialog).getByRole("form", { name: "编辑启动配置" });
  expect(within(form).queryByRole("textbox", { name: "名称" })).toBeNull();
  expect(
    within(form)
      .getByRole("button", { name: "预览修改" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(field(form, "推理强度"), { target: { value: "medium" } });
  fireEvent.change(field(form, "权限模式"), { target: { value: "" } });
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await within(dialog).findByRole("form", { name: "确认编辑启动配置" });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "edit_profile",
    name: "claude-opus",
    fields: { effort: "medium", permission_mode: null },
  });
  // Back to the form keeps the draft.
  fireEvent.click(within(dialog).getByRole("button", { name: "返回修改" }));
  expect((field(dialog, "推理强度") as HTMLInputElement).value).toBe("medium");
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "确认保存" }),
  );
  // Saved: back to the profile's detail, refreshed.
  expect(
    await within(dialog).findByRole("button", { name: "编辑" }),
  ).toBeTruthy();
  expect(api.confirmLaunchChange).toHaveBeenCalledTimes(1);
});

test("a field the server rejects is marked in place and nothing is written", async () => {
  const api = harness({
    previewLaunchChange: vi.fn(async () => {
      throw new ApiError(
        400,
        "validation_failed",
        "启动配置或密钥引用未通过校验",
        false,
        { field: "name" },
      );
    }),
  });
  await openModels(api.client);
  fireEvent.click(screen.getByRole("button", { name: "新建启动配置" }));
  const dialog = await screen.findByRole("dialog", { name: "新建启动配置" });
  const name = field(dialog, "名称");
  fireEvent.change(name, { target: { value: "added-elsewhere" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
  expect(
    document.getElementById(name.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("已有同名配置，换一个名称。");
  expect(api.confirmLaunchChange).not.toHaveBeenCalled();
  // Editing the name clears the server's note.
  fireEvent.change(name, { target: { value: "another" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
});

test("a file the host rejects on confirm returns to the form with the reason", async () => {
  const api = harness({
    confirmLaunchChange: vi.fn(async () => {
      throw new ApiError(400, "validation_failed", "未通过校验");
    }),
  });
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  fireEvent.change(field(dialog, "推理强度"), { target: { value: "max" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "确认保存" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("未通过校验");
  expect(alert.textContent).toContain("没有写入");
  // Still the confirmation step: the person goes back to correct the form.
  expect(within(dialog).getByRole("button", { name: "返回修改" })).toBeTruthy();
});

test("a stale snapshot is refused; refreshing previews again on the new version", async () => {
  let version = V1;
  const confirmLaunchChange = vi
    .fn<CardiganClient["confirmLaunchChange"]>()
    .mockRejectedValueOnce(
      new ApiError(409, "stale_snapshot", "启动配置已变化，请刷新后重新预览"),
    )
    .mockResolvedValue(undefined);
  const api = harness({
    launchSettings: vi.fn(async () => ({ ...launchSettingsFixture, version })),
    confirmLaunchChange,
  });
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  fireEvent.change(field(dialog, "推理强度"), { target: { value: "low" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "确认保存" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("这次预览已作废，没有写入");
  // Confirming the old preview is no longer offered.
  expect(within(dialog).queryByRole("button", { name: "确认保存" })).toBeNull();
  version = V2;
  fireEvent.click(
    within(dialog).getByRole("button", { name: "刷新并重新预览" }),
  );
  await waitFor(() =>
    expect(api.previewLaunchChange).toHaveBeenLastCalledWith(V2, {
      op: "edit_profile",
      name: "claude-opus",
      fields: { effort: "low" },
    }),
  );
  await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
  fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));
  await waitFor(() =>
    expect(confirmLaunchChange).toHaveBeenLastCalledWith(
      V2,
      PREVIEW,
      expect.any(String),
    ),
  );
});

test("an unanswered confirmation is retried with the same idempotency key", async () => {
  const confirmLaunchChange = vi
    .fn<CardiganClient["confirmLaunchChange"]>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue(undefined);
  const api = harness({ confirmLaunchChange });
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  fireEvent.change(field(dialog, "推理强度"), { target: { value: "low" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "确认保存" }),
  );
  await within(dialog).findByRole("alert");
  fireEvent.click(within(dialog).getByRole("button", { name: "确认保存" }));
  await waitFor(() => expect(confirmLaunchChange).toHaveBeenCalledTimes(2));
  const [first, second] = confirmLaunchChange.mock.calls;
  expect(second?.[2]).toBe(first?.[2]);
});

test("leaving a form with unapplied edits asks first", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  // Unchanged: cancel goes straight back.
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(within(dialog).getByRole("button", { name: "编辑" })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  fireEvent.change(field(dialog, "推理强度"), { target: { value: "low" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  let ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未应用的修改？" }),
    ).toBeNull(),
  );
  expect((field(dialog, "推理强度") as HTMLInputElement).value).toBe("low");

  // The drawer's close button asks too; discarding closes the drawer.
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭抽屉" }));
  ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  // Still open behind the question (hidden from the accessibility tree).
  expect(dialog.isConnected).toBe(true);
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "claude-opus" })).toBeNull(),
  );
  expect(api.previewLaunchChange).not.toHaveBeenCalled();
});

test("a referenced profile cannot be deleted and shows who uses it", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  const alert = within(dialog).getByRole("alert");
  expect(alert.textContent).toContain("不能删除");
  expect(
    within(alert)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    "角色 文档写手（p-1 / writer v2）",
    "角色 代码审核（p-2 / reviewer v3）",
    "员工 悟空（E-3）",
  ]);
  expect(
    within(dialog)
      .getByRole("button", { name: "预览删除" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(api.previewLaunchChange).not.toHaveBeenCalled();
});

test("deleting an unused profile previews, confirms and closes; a late reference is refused", async () => {
  const api = harness();
  await openModels(api.client);
  let dialog = await openProfile("pi-deepseek");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "预览删除" }));
  await within(dialog).findByRole("form", { name: "确认删除启动配置" });
  expect(dialog.textContent).toContain("启动配置 pi-deepseek删除");
  fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.confirmLaunchChange).toHaveBeenCalledTimes(1);
  cleanup();

  // Someone started using it between the read and the preview.
  const late = harness({
    previewLaunchChange: vi.fn(async () => {
      throw new ApiError(
        409,
        "profile_in_use",
        "仍有角色版本或员工使用该配置",
        false,
        { references: [{ employee_id: "E-9", name: "沙僧" }] },
      );
    }),
  });
  await openModels(late.client);
  dialog = await openProfile("pi-deepseek");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "预览删除" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toContain("员工 沙僧（E-9）");
  expect(late.confirmLaunchChange).not.toHaveBeenCalled();
});

test("copying sends the source and the new name", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("codex-sol");
  fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
  fireEvent.change(field(dialog, "新配置名称"), {
    target: { value: "codex-sol-2" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  await within(dialog).findByRole("form", { name: "确认复制启动配置" });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "copy_profile",
    name: "codex-sol-2",
    source: "codex-sol",
  });
});

test("a provider's endpoint and secret key reference use existing key names only", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "编辑 Provider" }),
  );
  const form = within(dialog).getByRole("form", { name: "编辑 Provider" });
  expect(form.textContent).toContain("claude-opus");
  // No password or free text for secrets: a choice among key names.
  expect(form.querySelector('input[type="password"]')).toBeNull();
  const endpoint = field(form, "端点");
  fireEvent.change(endpoint, { target: { value: "not a url" } });
  expect(endpoint.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(endpoint, {
    target: { value: "https://gateway.example.test" },
  });
  const secret = within(form).getByRole("combobox", {
    name: /密钥引用 ANTHROPIC_API_KEY/,
  });
  fireEvent.keyDown(secret, { key: "ArrowDown" });
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
    launchSettingsFixture.secret_keys,
  );
  fireEvent.keyDown(
    screen.getByRole("option", { name: "ANTHROPIC_API_KEY_SPARE" }),
    {
      key: "Enter",
    },
  );
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await within(dialog).findByRole("form", { name: "确认编辑 Provider" });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "edit_provider",
    name: "anthropic",
    fields: {
      base_url: "https://gateway.example.test",
      secret_env: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY_SPARE" },
    },
  });
});

test("a model alias points at another concrete id", async () => {
  const api = harness();
  await openModels(api.client);
  const dialog = await openProfile("claude-opus");
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑模型别名" }));
  const id = field(dialog, "模型标识");
  expect((id as HTMLInputElement).value).toBe("claude-opus-fixture-1");
  fireEvent.change(id, { target: { value: "claude-opus-fixture-2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览修改" }));
  await within(dialog).findByRole("form", { name: "确认编辑模型别名" });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "set_model",
    name: "opus",
    id: "claude-opus-fixture-2",
  });
});

const check = (
  mode: LaunchProfileCheck["mode"],
  status: LaunchProfileCheck["status"],
  problems: string[] = [],
): LaunchProfileCheck => ({
  id: "c",
  version: V1,
  mode,
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: status === "running" ? null : "2026-01-01T00:00:03.000Z",
  status,
  problems,
  cli_version: "9.9.1",
});
const withCheck = (
  name: string,
  last: LaunchProfileCheck | null,
): LaunchSettingsView => ({
  ...launchSettingsFixture,
  // Only `name` may be checking, so nothing else keeps the page polling.
  profiles: launchSettingsFixture.profiles.map((p) =>
    p.name === name
      ? { ...p, last_check: last }
      : p.last_check?.status === "running"
        ? { ...p, last_check: null }
        : p,
  ),
});

test("checks start only on a click and report exactly what ran", async () => {
  let current = withCheck("pi-deepseek", null);
  const api = harness({ launchSettings: vi.fn(async () => current) });
  await openModels(api.client);
  const dialog = await openProfile("pi-deepseek");
  expect(api.startLaunchCheck).not.toHaveBeenCalled();
  current = withCheck("pi-deepseek", check("online", "running"));
  fireEvent.click(within(dialog).getByRole("button", { name: "在线探测" }));
  expect(api.startLaunchCheck).toHaveBeenCalledWith(
    V1,
    "pi-deepseek",
    "online",
  );
  expect(await within(dialog).findByText("在线探测中")).toBeTruthy();
  // While running, neither check can be started again.
  expect(
    within(dialog)
      .getByRole("button", { name: "本地检查" })
      .getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    within(dialog)
      .getByRole("button", { name: "在线探测" })
      .getAttribute("aria-disabled") === "true",
  ).toBe(true);
  // The page reads again while the check runs (GET only), then shows the result.
  current = withCheck("pi-deepseek", check("online", "passed"));
  expect(
    await within(dialog).findByText("已列出模型", undefined, { timeout: 4000 }),
  ).toBeTruthy();
  expect(dialog.textContent).toContain("在线探测（只列出模型，不调用推理）");
  expect(dialog.textContent).not.toContain("推理通过");
  expect(api.startLaunchCheck).toHaveBeenCalledTimes(1);

  // Each started check has its own id.
  current = withCheck("pi-deepseek", {
    ...check("metadata", "failed", ["cli_missing"]),
    id: "c-metadata",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "本地检查" }));
  expect(await within(dialog).findByText("本地检查未通过")).toBeTruthy();
  expect(dialog.textContent).toContain("找不到 CLI");
  expect(api.startLaunchCheck).toHaveBeenLastCalledWith(
    V1,
    "pi-deepseek",
    "metadata",
  );
});

test("a refused check says why and does not count as a result", async () => {
  const api = harness({
    launchSettings: vi.fn(async () => withCheck("codex-sol", null)),
    startLaunchCheck: vi.fn(async () => {
      throw new ApiError(
        400,
        "validation_failed",
        "启动配置或密钥引用未通过校验",
        false,
        { field: "base_url" },
      );
    }),
  });
  await openModels(api.client);
  const dialog = await openProfile("codex-sol");
  fireEvent.click(within(dialog).getByRole("button", { name: "在线探测" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toBe("没有能明确显示的端点，不能在线探测。");
  expect(dialog.textContent).toContain("未检查");
});

test("the HTTP client posts previews, keyed confirmations and checks to the global API", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [
    { version: V1, preview_id: PREVIEW, diff: [] },
    { ok: true, preview_id: PREVIEW },
    { id: "c", profile: "p", mode: "metadata", version: V1, status: "running" },
  ];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(replies[calls.length - 1]), {
      status: calls.length === 3 ? 202 : 200,
    });
  });
  const client = new HttpCardiganClient(
    fetch as unknown as typeof globalThis.fetch,
  );
  await client.previewLaunchChange(V1, { op: "delete_profile", name: "p" });
  await client.confirmLaunchChange(V1, PREVIEW, "key-1");
  await client.startLaunchCheck(V1, "p", "metadata");
  expect(calls.map((c) => c.url)).toEqual([
    "/api/launch-settings/preview",
    "/api/launch-settings/confirm",
    "/api/launch-settings/checks",
  ]);
  expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
    { version: V1, change: { op: "delete_profile", name: "p" } },
    { version: V1, preview_id: PREVIEW },
    { version: V1, profile: "p", mode: "metadata" },
  ]);
  const headers = calls.map(
    (c) => (c.init.headers as Record<string, string>)["Idempotency-Key"],
  );
  expect(headers).toEqual([undefined, "key-1", undefined]);
});

test("error details reach the page", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "profile_in_use",
            message: "仍有角色版本或员工使用该配置",
            details: { references: [{ employee_id: "E-1", name: "甲" }] },
          },
        }),
        { status: 409 },
      ),
  );
  const client = new HttpCardiganClient(
    fetch as unknown as typeof globalThis.fetch,
  );
  const error = await client
    .previewLaunchChange(V1, { op: "delete_profile", name: "p" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).details).toEqual({
    references: [{ employee_id: "E-1", name: "甲" }],
  });
});

// D-2012 review cases (林黛玉, V-2562), kept as regression tests.
test("a stale re-preview keeps someone else's change to a field this person did not edit", async () => {
  let current = launchSettingsFixture;
  const api = harness({
    launchSettings: vi.fn(async () => current),
    confirmLaunchChange: vi
      .fn()
      .mockRejectedValue(new ApiError(409, "stale_snapshot", "stale")),
  });
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  const click = (name: string) =>
    fireEvent.click(within(d).getByRole("button", { name }));
  click("编辑");
  fireEvent.change(field(d, "推理强度"), { target: { value: "medium" } });
  click("预览修改");
  await within(d).findByRole("button", { name: "确认保存" });
  click("确认保存");
  await within(d).findByRole("button", { name: "刷新并重新预览" });
  current = {
    ...current,
    version: V2,
    profiles: current.profiles.map((p) =>
      p.name === "claude-opus"
        ? { ...p, parameters: { ...p.parameters, auto_update: true } }
        : p,
    ),
  };
  click("刷新并重新预览");
  await waitFor(() =>
    expect(
      within(d).queryByRole("button", { name: "刷新并重新预览" }),
    ).toBeNull(),
  );
  await within(d).findByRole("button", { name: "返回修改" });
  click("返回修改");
  click("预览修改");
  expect(api.previewLaunchChange.mock.lastCall).toEqual([
    V2,
    { op: "edit_profile", name: "claude-opus", fields: { effort: "medium" } },
  ]);
});

test("an accepted check keeps both actions unavailable until a read shows it", async () => {
  const api = harness({
    launchSettings: vi
      .fn()
      .mockResolvedValueOnce(launchSettingsFixture)
      .mockImplementation(() => new Promise(() => {})),
  });
  await openModels(api.client);
  const d = await openProfile("pi-deepseek");
  fireEvent.click(within(d).getByRole("button", { name: "在线探测" }));
  await waitFor(() =>
    expect(api.client.launchSettings).toHaveBeenCalledTimes(2),
  );
  expect(
    within(d)
      .getByRole("button", { name: "本地检查" })
      .getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    within(d)
      .getByRole("button", { name: "在线探测" })
      .getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(await within(d).findByText("在线探测中")).toBeTruthy();
  expect(api.startLaunchCheck).toHaveBeenCalledTimes(1);
});

test("an endpoint with a query or fragment is marked in place and cannot be previewed", async () => {
  const api = harness();
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  fireEvent.click(within(d).getByRole("button", { name: "编辑 Provider" }));
  const endpoint = field(d, "端点");
  for (const value of [
    "https://fixture.example.test/v1?region=demo",
    "https://fixture.example.test/v1#part",
  ]) {
    fireEvent.change(endpoint, { target: { value } });
    expect(endpoint.getAttribute("aria-invalid")).toBe("true");
    expect(
      within(d)
        .getByRole("button", { name: "预览修改" })
        .hasAttribute("disabled"),
    ).toBe(true);
  }
  expect(api.previewLaunchChange).not.toHaveBeenCalled();
});

test("a reference found at confirmation makes the delete unavailable", async () => {
  const confirmLaunchChange = vi.fn().mockRejectedValue(
    new ApiError(409, "profile_in_use", "使用中", false, {
      references: [{ employee_id: "E-9", name: "样例" }],
    }),
  );
  const api = harness({ confirmLaunchChange });
  await openModels(api.client);
  const d = await openProfile("pi-deepseek");
  fireEvent.click(within(d).getByRole("button", { name: "删除" }));
  fireEvent.click(within(d).getByRole("button", { name: "预览删除" }));
  fireEvent.click(await within(d).findByRole("button", { name: "确认删除" }));
  expect((await within(d).findByRole("alert")).textContent).toContain("样例");
  const confirm = within(d).queryByRole("button", { name: "确认删除" });
  expect(!confirm || confirm.hasAttribute("disabled")).toBe(true);
  await waitFor(() =>
    expect(
      within(d)
        .getByRole("button", { name: "预览删除" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  // The settings are read again so the list and users catch up.
  await waitFor(() => expect(api.launchSettings).toHaveBeenCalledTimes(2));
  expect(confirmLaunchChange).toHaveBeenCalledTimes(1);
});

test("a secret key secrets.env no longer has is shown but not choosable", async () => {
  const api = harness();
  await openModels(api.client);
  const d = await openProfile("codex-sol");
  fireEvent.click(within(d).getByRole("button", { name: "编辑 Provider" }));
  const choice = within(d).getByRole("combobox", {
    name: /密钥引用 OPENAI_API_KEY/,
  });
  expect(choice.textContent).toContain("（已失效）");
  fireEvent.keyDown(choice, { key: "ArrowDown" });
  const enabled = screen
    .getAllByRole("option")
    .filter((x) => x.getAttribute("aria-disabled") !== "true")
    .map((x) => x.textContent);
  expect(enabled).toEqual(launchSettingsFixture.secret_keys);
});

test("the Provider form also keeps someone else's endpoint after a stale re-preview", async () => {
  let current = launchSettingsFixture;
  const api = harness({
    launchSettings: vi.fn(async () => current),
    confirmLaunchChange: vi
      .fn()
      .mockRejectedValue(new ApiError(409, "stale_snapshot", "stale")),
  });
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  const click = (name: string) =>
    fireEvent.click(within(d).getByRole("button", { name }));
  click("编辑 Provider");
  fireEvent.change(field(d, "名称"), { target: { value: "Anthropic 网关" } });
  click("预览修改");
  await within(d).findByRole("button", { name: "确认保存" });
  click("确认保存");
  await within(d).findByRole("button", { name: "刷新并重新预览" });
  current = {
    ...current,
    version: V2,
    providers: current.providers.map((p) =>
      p.id === "anthropic"
        ? { ...p, base_url: "https://other.example.test" }
        : p,
    ),
  };
  click("刷新并重新预览");
  await within(d).findByRole("button", { name: "返回修改" });
  click("返回修改");
  expect((field(d, "端点") as HTMLInputElement).value).toBe(
    "https://other.example.test",
  );
  click("预览修改");
  expect(api.previewLaunchChange.mock.lastCall).toEqual([
    V2,
    {
      op: "edit_provider",
      name: "anthropic",
      fields: { name: "Anthropic 网关" },
    },
  ]);
});

// D-2016 review cases (林黛玉, V-2563), kept as regression tests.
test("a status read slower than the poll interval still finishes and shows the result", async () => {
  const { act } = await import("@testing-library/react");
  const profile = "pi-deepseek";
  let completed = 0;
  const reads = vi
    .fn()
    .mockResolvedValueOnce(withCheck(profile, null))
    .mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      completed++;
      return withCheck(profile, check("online", "passed"));
    });
  const api = harness({ launchSettings: reads });
  await openModels(api.client);
  const d = await openProfile(profile);
  vi.useFakeTimers();
  try {
    await act(async () => {
      fireEvent.click(within(d).getByRole("button", { name: "在线探测" }));
    });
    for (let i = 0; i < 9; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    expect(completed).toBeGreaterThan(0);
    expect(api.startLaunchCheck).toHaveBeenCalledTimes(1);
    expect(within(d).queryByText("已列出模型")).not.toBeNull();
    expect(
      within(d)
        .getByRole("button", { name: "在线探测" })
        .getAttribute("aria-disabled") === "true",
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a newer finished check replaces this person's check once it was seen", async () => {
  const { act } = await import("@testing-library/react");
  const profile = "pi-deepseek";
  let state = withCheck(profile, null);
  const reads = vi.fn(async () => state);
  const api = harness({ launchSettings: reads });
  await openModels(api.client);
  const d = await openProfile(profile);
  vi.useFakeTimers();
  try {
    state = withCheck(profile, check("online", "running"));
    await act(async () => {
      fireEvent.click(within(d).getByRole("button", { name: "在线探测" }));
    });
    expect(within(d).queryByText("在线探测中")).not.toBeNull();
    expect(reads).toHaveBeenCalledTimes(2);
    state = withCheck(profile, {
      ...check("metadata", "passed"),
      id: "c2",
      started_at: "2026-01-01T00:00:05Z",
      finished_at: "2026-01-01T00:00:06Z",
    });
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    expect(within(d).queryByText("本地检查通过")).not.toBeNull();
    expect(
      within(d)
        .getByRole("button", { name: "在线探测" })
        .getAttribute("aria-disabled") === "true",
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a newer check shown by the first read after starting ends the wait", async () => {
  const profile = "pi-deepseek";
  let state = withCheck(profile, null);
  const api = harness({ launchSettings: vi.fn(async () => state) });
  await openModels(api.client);
  const d = await openProfile(profile);
  // Ours (id c) finished and someone else's c2 is now the latest.
  state = withCheck(profile, {
    ...check("metadata", "passed"),
    id: "c2",
  });
  fireEvent.click(within(d).getByRole("button", { name: "在线探测" }));
  expect(await within(d).findByText("本地检查通过")).toBeTruthy();
  expect(
    within(d)
      .getByRole("button", { name: "本地检查" })
      .getAttribute("aria-disabled") === "true",
  ).toBe(false);
});

test("a field changed and put back before preview is not sent after a refresh", async () => {
  let current = launchSettingsFixture;
  const api = harness({
    launchSettings: vi.fn(async () => current),
    confirmLaunchChange: vi
      .fn()
      .mockRejectedValue(new ApiError(409, "stale_snapshot", "stale")),
  });
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  const click = (name: string) =>
    fireEvent.click(within(d).getByRole("button", { name }));
  click("编辑 Provider");
  const endpoint = field(d, "端点");
  const orig = (endpoint as HTMLInputElement).value;
  fireEvent.change(endpoint, {
    target: { value: "https://temporary.example.test" },
  });
  fireEvent.change(endpoint, { target: { value: orig } });
  fireEvent.change(field(d, "名称"), { target: { value: "Demo" } });
  click("预览修改");
  await within(d).findByRole("button", { name: "确认保存" });
  const expected = {
    op: "edit_provider",
    name: "anthropic",
    fields: { name: "Demo" },
  };
  expect(api.previewLaunchChange.mock.lastCall).toEqual([V1, expected]);
  click("确认保存");
  await within(d).findByRole("button", { name: "刷新并重新预览" });
  current = {
    ...current,
    version: V2,
    providers: current.providers.map((p) =>
      p.id === "anthropic" ? { ...p, base_url: "https://new.example.test" } : p,
    ),
  };
  click("刷新并重新预览");
  await within(d).findByRole("button", { name: "确认保存" });
  click("返回修改");
  click("预览修改");
  expect(api.previewLaunchChange.mock.lastCall).toEqual([V2, expected]);
});

test("a profile field changed and put back is not sent after a refresh", async () => {
  let current = launchSettingsFixture;
  const api = harness({
    launchSettings: vi.fn(async () => current),
    confirmLaunchChange: vi
      .fn()
      .mockRejectedValue(new ApiError(409, "stale_snapshot", "stale")),
  });
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  const click = (name: string) =>
    fireEvent.click(within(d).getByRole("button", { name }));
  click("编辑");
  const permission = field(d, "权限模式");
  const orig = (permission as HTMLInputElement).value;
  fireEvent.change(permission, { target: { value: "plan" } });
  fireEvent.change(permission, { target: { value: orig } });
  fireEvent.change(field(d, "推理强度"), { target: { value: "medium" } });
  click("预览修改");
  await within(d).findByRole("button", { name: "确认保存" });
  click("确认保存");
  await within(d).findByRole("button", { name: "刷新并重新预览" });
  current = {
    ...current,
    version: V2,
    profiles: current.profiles.map((p) =>
      p.name === "claude-opus"
        ? { ...p, parameters: { ...p.parameters, permission_mode: "auto" } }
        : p,
    ),
  };
  click("刷新并重新预览");
  await within(d).findByRole("button", { name: "确认保存" });
  click("返回修改");
  click("预览修改");
  expect(api.previewLaunchChange.mock.lastCall).toEqual([
    V2,
    { op: "edit_profile", name: "claude-opus", fields: { effort: "medium" } },
  ]);
});

// D-2016 design review suggestions (妙玉, V-2564).
test("a busy check button keeps focus and ignores another click", async () => {
  let current = withCheck("pi-deepseek", null);
  const api = harness({ launchSettings: vi.fn(async () => current) });
  await openModels(api.client);
  const d = await openProfile("pi-deepseek");
  current = withCheck("pi-deepseek", check("online", "running"));
  const online = within(d).getByRole("button", { name: "在线探测" });
  online.focus();
  fireEvent.click(online);
  expect(await within(d).findByText("在线探测中")).toBeTruthy();
  const busy = within(d).getByRole("button", { name: "在线探测" });
  expect(busy.getAttribute("aria-disabled")).toBe("true");
  expect(busy.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(busy);
  fireEvent.click(busy);
  fireEvent.click(within(d).getByRole("button", { name: "本地检查" }));
  expect(api.startLaunchCheck).toHaveBeenCalledTimes(1);
});

test("the alias confirmation names the alias and the profiles following it", async () => {
  const api = harness();
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  fireEvent.click(within(d).getByRole("button", { name: "编辑模型别名" }));
  fireEvent.change(field(d, "模型标识"), {
    target: { value: "claude-opus-fixture-2" },
  });
  fireEvent.click(within(d).getByRole("button", { name: "预览修改" }));
  const alias = await within(d).findByRole("form", {
    name: "确认编辑模型别名",
  });
  expect(alias.textContent).toContain("别名opus");
  expect(alias.textContent).toContain("使用它的配置claude-opus");
});

test("the Provider confirmation names the Provider and the profiles using it", async () => {
  const api = harness();
  await openModels(api.client);
  const d = await openProfile("claude-opus");
  fireEvent.click(within(d).getByRole("button", { name: "编辑 Provider" }));
  fireEvent.change(field(d, "名称"), { target: { value: "Anthropic 网关" } });
  fireEvent.click(within(d).getByRole("button", { name: "预览修改" }));
  const provider = await within(d).findByRole("form", {
    name: "确认编辑 Provider",
  });
  expect(provider.textContent).toContain("Provideranthropic");
  expect(provider.textContent).toContain("使用它的配置");
});
