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
  type LaunchModelList,
  type LaunchSettingsView,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { launchSettingsFixture } from "../testing/launch-settings-fixture.js";
import { SettingsPage } from "./SettingsPage.js";

/**
 * C-564: the profile form picks a model from the chosen Provider's list
 * (catalog + its own listing, mocked here) and a permission mode from the
 * harness's options. Synthetic fixture only: no host, endpoint or credential.
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
const list = (
  provider: string,
  models: LaunchModelList["models"],
  status: Partial<{
    catalog: LaunchModelList["catalog"]["status"];
    listing: LaunchModelList["listing"]["status"];
  }> = {},
): LaunchModelList => ({
  version: V1,
  provider,
  catalog: {
    status: status.catalog ?? "ok",
    providers: [provider],
    fetched_at: "2025-12-31T00:00:00.000Z",
  },
  listing: { status: status.listing ?? "ok" },
  models,
});
const anthropicList = list("anthropic", [
  {
    id: "claude-fixture-haiku",
    sources: ["catalog"],
    context_window: 200000,
    max_output_tokens: 8000,
  },
  {
    id: "claude-opus-fixture-1",
    sources: ["catalog", "provider"],
    context_window: 200000,
    max_output_tokens: 32000,
    reasoning_efforts: ["low", "high"],
  },
  { id: "gateway-only", sources: ["provider"] },
]);

function harness(overrides: Partial<CardiganClient> = {}) {
  const launchSettings = vi.fn(
    async (): Promise<LaunchSettingsView> => launchSettingsFixture,
  );
  const previewLaunchChange = vi.fn(async (version: string) => ({
    version,
    preview_id: "11111111-1111-4111-8111-111111111111",
    diff: [{ field: "profiles.claude-opus.model", before: "a", after: "b" }],
  }));
  const launchModels = vi.fn(async (_version: string, provider: string) =>
    provider === "anthropic" ? anthropicList : list(provider, []),
  );
  const client = fakeClient({
    launchSettings,
    previewLaunchChange,
    launchModels,
    ...overrides,
  });
  return { client, previewLaunchChange, launchModels };
}

async function editProfile(client: CardiganClient, name: string) {
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  await screen.findByRole("table", { name: "启动配置" });
  fireEvent.click(screen.getByRole("button", { name }));
  const dialog = await screen.findByRole("dialog", { name });
  fireEvent.click(within(dialog).getByRole("button", { name: "编辑" }));
  return within(dialog).getByRole("form", { name: "编辑启动配置" });
}
const modelField = (form: HTMLElement) =>
  within(form).getByRole("combobox", { name: "模型" }) as HTMLInputElement;
const hintOf = (input: Element) =>
  (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
const options = () =>
  screen.queryAllByRole("option").map((o) => o.textContent ?? "");

test("the model list of the chosen Provider is searchable, shows metadata and fills the field", async () => {
  const api = harness();
  const form = await editProfile(api.client, "claude-opus");
  expect(api.launchModels).toHaveBeenCalledWith(V1, "anthropic");
  const input = modelField(form);
  await waitFor(() => expect(hintOf(input)).toContain("别名 → claude-opus"));
  // The alias the profile uses, with its metadata.
  expect(hintOf(input)).toContain("上下文 200K · 输出 32K");
  // Opening without typing shows everything; typing filters.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(options().map((o) => o.split(/别名| · |上下文/)[0])).toEqual([
    "opus",
    "claude-fixture-haiku",
    "claude-opus-fixture-1",
    "gateway-only",
  ]);
  fireEvent.change(input, { target: { value: "HAI" } });
  expect(options()).toEqual(["claude-fixture-haiku上下文 200K · 输出 8K"]);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("claude-fixture-haiku");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(hintOf(input)).toContain("上下文 200K · 输出 8K");
  expect(hintOf(input)).not.toContain("未验证");
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await waitFor(() =>
    expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
      op: "edit_profile",
      name: "claude-opus",
      fields: { model: "claude-fixture-haiku" },
    }),
  );
});

test("a typed model outside every list can still be saved, marked unverified", async () => {
  const api = harness();
  const form = await editProfile(api.client, "claude-opus");
  const input = modelField(form);
  await waitFor(() => expect(hintOf(input)).toContain("别名"));
  fireEvent.change(input, { target: { value: "my-private-model" } });
  // Nothing matches: no list is shown.
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(hintOf(input)).toContain("未验证");
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await waitFor(() =>
    expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
      op: "edit_profile",
      name: "claude-opus",
      fields: { model: "my-private-model" },
    }),
  );
});

test("a failed list says why next to the field and leaves typing open", async () => {
  const api = harness({
    launchModels: vi.fn(async () => {
      throw new ApiError(502, "bad_gateway", "网关不可用");
    }),
  });
  const form = await editProfile(api.client, "claude-opus");
  const input = modelField(form);
  await waitFor(() =>
    expect(hintOf(input)).toContain("模型列表读取失败：网关不可用"),
  );
  // The alias still resolves locally; a new ID is unverified.
  expect(hintOf(input)).not.toContain("未验证");
  fireEvent.change(input, { target: { value: "typed-by-hand" } });
  expect(hintOf(input)).toContain("未验证");
  expect(
    within(form)
      .getByRole("button", { name: "预览修改" })
      .hasAttribute("disabled"),
  ).toBe(false);
  cleanup();
  // The host answered, but the Provider's own listing failed.
  const partial = harness({
    launchModels: vi.fn(async () =>
      list("anthropic", [], { listing: "failed", catalog: "unavailable" }),
    ),
  });
  const again = await editProfile(partial.client, "claude-opus");
  await waitFor(() =>
    expect(hintOf(modelField(again))).toContain(
      "模型目录暂不可用；Provider 模型列表读取失败",
    ),
  );
});

test("another Provider reads its own list; a late reply for the old one is dropped", async () => {
  let release: (value: LaunchModelList) => void = () => {};
  const launchModels = vi.fn(
    (_version: string, provider: string) =>
      new Promise<LaunchModelList>((resolve) => {
        if (provider === "anthropic") release = resolve;
        else
          resolve(
            list(provider, [{ id: "relay-only", sources: ["provider"] }]),
          );
      }),
  );
  const api = harness({ launchModels });
  const form = await editProfile(api.client, "claude-opus");
  expect(hintOf(modelField(form))).toContain("正在读取模型列表");
  changeControl(within(form).getByRole("combobox", { name: /Provider/ }), {
    target: { value: "relay" },
  });
  expect(launchModels).toHaveBeenLastCalledWith(V1, "relay");
  const input = modelField(form);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => expect(options().join()).toContain("relay-only"));
  release(anthropicList);
  await Promise.resolve();
  expect(options().join()).not.toContain("gateway-only");
});

test("permission modes follow the harness, each with its meaning; none for a harness without the parameter", async () => {
  const api = harness();
  const form = await editProfile(api.client, "claude-opus");
  const mode = () => within(form).getByRole("combobox", { name: /权限模式/ });
  expect(hintOf(mode())).toContain("跳过全部权限确认");
  changeControl(mode(), { target: { value: "acceptEdits" } });
  expect(hintOf(mode())).toContain("自动接受文件修改");
  // Codex takes no permission mode: cleared and not selectable.
  changeControl(within(form).getByRole("combobox", { name: /Harness/ }), {
    target: { value: "codex" },
  });
  expect(mode().hasAttribute("disabled")).toBe(true);
  expect(mode().textContent).toContain("不适用");
  expect(hintOf(mode())).toContain("codex 不使用此参数");
  // Back to Claude Code: the saved value returns, nothing sent for it.
  changeControl(within(form).getByRole("combobox", { name: /Harness/ }), {
    target: { value: "claude-code" },
  });
  expect(mode().textContent).toContain("bypassPermissions");
  fireEvent.change(within(form).getByRole("textbox", { name: "推理强度" }), {
    target: { value: "low" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await waitFor(() =>
    expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
      op: "edit_profile",
      name: "claude-opus",
      fields: { effort: "low" },
    }),
  );
});

test("an old permission mode outside the list stays as it is and says so", async () => {
  const settings: LaunchSettingsView = {
    ...launchSettingsFixture,
    profiles: launchSettingsFixture.profiles.map((p) =>
      p.name === "claude-opus"
        ? { ...p, parameters: { ...p.parameters, permission_mode: "legacy" } }
        : p,
    ),
  };
  const api = harness({ launchSettings: vi.fn(async () => settings) });
  const form = await editProfile(api.client, "claude-opus");
  const mode = () => within(form).getByRole("combobox", { name: /权限模式/ });
  expect(mode().textContent).toContain("legacy（当前值）");
  expect(hintOf(mode())).toContain("不在可选列表中");
  // Picking another and coming back is no edit: the old value stays a choice.
  changeControl(mode(), { target: { value: "plan" } });
  expect(hintOf(mode())).not.toContain("不在可选列表中");
  changeControl(mode(), { target: { value: "legacy" } });
  expect(hintOf(mode())).toContain("不在可选列表中");
  fireEvent.change(within(form).getByRole("textbox", { name: "推理强度" }), {
    target: { value: "low" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "预览修改" }));
  await waitFor(() =>
    expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
      op: "edit_profile",
      name: "claude-opus",
      fields: { effort: "low" },
    }),
  );
});

test("a changed model is an unapplied edit: leaving asks first", async () => {
  const api = harness();
  const form = await editProfile(api.client, "claude-opus");
  fireEvent.change(modelField(form), { target: { value: "gateway-only" } });
  fireEvent.click(within(form).getByRole("button", { name: "取消" }));
  expect(
    await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
  ).toBeTruthy();
});

test("a typed ID can be checked online before saving; editing it drops the result (V-2818:6)", async () => {
  const checkLaunchModel = vi.fn(
    async (_version: string, provider: string, model: string) => ({
      provider,
      model,
      status: model === "gateway-hidden" ? "listed" : "not_listed",
    }),
  ) as CardiganClient["checkLaunchModel"] & ReturnType<typeof vi.fn>;
  const api = harness({ checkLaunchModel });
  const form = await editProfile(api.client, "claude-opus");
  const input = modelField(form);
  await waitFor(() => expect(hintOf(input)).toContain("别名"));
  // Alias or listed values have nothing to check.
  expect(within(form).queryByRole("button", { name: "在线核对" })).toBeNull();
  fireEvent.change(input, { target: { value: "gateway-hidden" } });
  fireEvent.click(within(form).getByRole("button", { name: "在线核对" }));
  await waitFor(() => expect(hintOf(input)).toContain("已核对"));
  expect(hintOf(input)).toContain("Provider 列出了这个模型");
  expect(hintOf(input)).not.toContain("未验证");
  expect(checkLaunchModel).toHaveBeenCalledWith(
    V1,
    "anthropic",
    "gateway-hidden",
  );
  // Another ID: the result does not carry over.
  fireEvent.change(input, { target: { value: "gateway-typo" } });
  expect(hintOf(input)).toContain("未验证");
  expect(hintOf(input)).not.toContain("已核对");
  fireEvent.click(within(form).getByRole("button", { name: "在线核对" }));
  await waitFor(() =>
    expect(hintOf(input)).toContain("Provider 未列出这个模型"),
  );
  expect(hintOf(input)).toContain("未验证");
  // Nothing was saved or previewed by checking.
  expect(api.previewLaunchChange).not.toHaveBeenCalled();
});

test("editing the ID while a check runs drops it: A→B→A can be checked again, and the late reply is ignored (V-2827:1)", async () => {
  const pending: ((status: "listed" | "not_listed") => void)[] = [];
  const checkLaunchModel = vi.fn(
    (_version: string, provider: string, model: string) =>
      new Promise<{
        provider: string;
        model: string;
        status: "listed" | "not_listed";
      }>((resolve) => {
        pending.push((status) => resolve({ provider, model, status }));
      }),
  ) as CardiganClient["checkLaunchModel"] & ReturnType<typeof vi.fn>;
  const api = harness({ checkLaunchModel });
  const form = await editProfile(api.client, "claude-opus");
  const input = modelField(form);
  await waitFor(() => expect(hintOf(input)).toContain("别名"));
  const button = () => within(form).getByRole("button", { name: /核对/ });
  // ① Check A; it stays in flight.
  fireEvent.change(input, { target: { value: "gateway-a" } });
  fireEvent.click(button());
  expect(button().textContent).toBe("正在核对…");
  // ② Edit to B without checking: nothing runs for B.
  fireEvent.change(input, { target: { value: "gateway-b" } });
  expect(button().textContent).toBe("在线核对");
  // ③ A's reply arrives while B is shown: dropped.
  pending[0]?.("not_listed");
  await Promise.resolve();
  expect(hintOf(input)).not.toContain("Provider 未列出这个模型");
  // ④ Back to A: no stale "正在核对…", and it can be checked again.
  fireEvent.change(input, { target: { value: "gateway-a" } });
  expect(button().textContent).toBe("在线核对");
  expect(button().getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(button());
  expect(checkLaunchModel).toHaveBeenCalledTimes(2);
  expect(button().textContent).toBe("正在核对…");
  // A late reply of an edited-away request never lands on the new one.
  fireEvent.change(input, { target: { value: "gateway-b" } });
  fireEvent.change(input, { target: { value: "gateway-a" } });
  fireEvent.click(button());
  expect(checkLaunchModel).toHaveBeenCalledTimes(3);
  pending[1]?.("not_listed");
  await Promise.resolve();
  expect(button().textContent).toBe("正在核对…");
  expect(hintOf(input)).not.toContain("Provider 未列出这个模型");
  pending[2]?.("listed");
  await waitFor(() => expect(hintOf(input)).toContain("已核对"));
  expect(hintOf(input)).toContain("Provider 列出了这个模型");
  expect(api.previewLaunchChange).not.toHaveBeenCalled();
});

test("a profile keeping an unsupported permission mode cannot be copied (V-2818:3)", async () => {
  const settings: LaunchSettingsView = {
    ...launchSettingsFixture,
    profiles: launchSettingsFixture.profiles.map((p) =>
      p.name === "claude-opus"
        ? { ...p, parameters: { ...p.parameters, permission_mode: "legacy" } }
        : p,
    ),
  };
  const api = harness({ launchSettings: vi.fn(async () => settings) });
  render(<SettingsPage projectId="p-1" client={api.client} />);
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  await screen.findByRole("table", { name: "启动配置" });
  fireEvent.click(screen.getByRole("button", { name: "claude-opus" }));
  const dialog = await screen.findByRole("dialog", { name: "claude-opus" });
  fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
  expect(within(dialog).getByRole("alert").textContent).toContain(
    "原配置的权限模式 legacy 不在可选列表中，不能复制",
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "新配置名称" }),
    {
      target: { value: "copy-1" },
    },
  );
  expect(
    within(dialog)
      .getByRole("button", { name: "预览修改" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("more than 100 matches show the first 100 and the count of the rest", async () => {
  const many = list(
    "anthropic",
    Array.from({ length: 105 }, (_, i) => ({
      id: `m-${String(i).padStart(3, "0")}`,
      sources: ["provider" as const],
    })),
  );
  const api = harness({ launchModels: vi.fn(async () => many) });
  const form = await editProfile(api.client, "claude-opus");
  const input = modelField(form);
  fireEvent.change(input, { target: { value: "m-" } });
  await waitFor(() => expect(options()).toHaveLength(100));
  expect(screen.getByText("另有 5 项")).toBeTruthy();
});
