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
  type LaunchChange,
  type LaunchSettingsView,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { launchSettingsFixture } from "../testing/launch-settings-fixture.js";
import { SettingsPage } from "./SettingsPage.js";

/**
 * C-549: Providers are listed on their own, created, edited and deleted
 * through preview → confirm; secret values are typed here, sent only with
 * the confirmation and never kept after a failure. Synthetic fixture, fake
 * secret values, no host.
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
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const FAKE = "fixture-secret-not-real";

function harness(overrides: Partial<CardiganClient> = {}) {
  let current: LaunchSettingsView = launchSettingsFixture;
  const launchSettings = vi.fn(async () => current);
  const previewLaunchChange = vi.fn(
    async (version: string, change: LaunchChange) => ({
      version,
      preview_id: PREVIEW,
      diff:
        change.op === "delete_provider"
          ? [
              {
                field: `providers.${change.name}`,
                before: change.name,
                after: null,
              },
            ]
          : [
              {
                field: `providers.${change.name}.name`,
                before: null,
                after: "x",
              },
              ...("secrets" in change
                ? (change.secrets?.set ?? []).map((key) => ({
                    field: `secrets.${key}`,
                    before: "unset",
                    after: "new",
                  }))
                : []),
            ],
    }),
  );
  const confirmLaunchChange = vi.fn<CardiganClient["confirmLaunchChange"]>(
    async () => {},
  );
  const startProviderCheck = vi.fn(async (version: string, id: string) => ({
    id: "probe",
    profile: `provider:${id}`,
    mode: "online" as const,
    version,
    status: "running" as const,
  }));
  const client = fakeClient({
    launchSettings,
    previewLaunchChange,
    confirmLaunchChange,
    startProviderCheck,
    ...overrides,
  });
  return {
    client,
    launchSettings,
    previewLaunchChange,
    confirmLaunchChange,
    startProviderCheck,
    set: (next: LaunchSettingsView) => {
      current = next;
    },
  };
}
async function openModels(client: CardiganClient) {
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  return screen.findByRole("table", { name: "Provider" });
}
const field = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("textbox", { name });
const password = (scope: HTMLElement) =>
  [...scope.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
const click = (scope: HTMLElement, name: string) =>
  fireEvent.click(within(scope).getByRole("button", { name }));

test("the Provider list shows id, name, harness, endpoint and how many profiles use it", async () => {
  const api = harness();
  const table = await openModels(api.client);
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.textContent)).toEqual([
    "anthropicAnthropicclaude-codehttps://anthropic.example.test1",
    "openaiOpenAIcodex—1",
    "deepseekDeepSeekpihttps://deepseek.example.test/v11",
    "relayRelayclaude-codehttps://relay.example.test0",
  ]);
  fireEvent.click(within(table).getByRole("button", { name: "anthropic" }));
  const d = await screen.findByRole("dialog", { name: "Anthropic" });
  // Secret: key name, status and time; a hidden variable shows no value.
  expect(d.textContent).toMatch(/ANTHROPIC_API_KEY\s*已设置/u);
  expect(d.textContent).toContain("最后修改");
  expect(d.textContent).toContain("ANTHROPIC_CUSTOM_HEADERS_TOKEN已隐藏");
  expect(d.textContent).toContain("已列出模型");
  click(d, "在线探测");
  await waitFor(() =>
    expect(api.startProviderCheck).toHaveBeenCalledWith(V1, "anthropic"),
  );
});

test("a new Provider is checked in place, previewed without the secret and confirmed with it", async () => {
  const api = harness();
  await openModels(api.client);
  click(document.body, "新建 Provider");
  const d = await screen.findByRole("dialog", { name: "新建 Provider" });
  const preview = within(d).getByRole("button", { name: "预览修改" });
  const id = field(d, "ID");
  // V-2709: the ID field names the ID, not the separate name field.
  expect(
    document.getElementById(id.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("请填写 ID。");
  fireEvent.change(id, { target: { value: "Bad ID" } });
  expect(
    document.getElementById(id.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("ID 只能用小写字母");
  fireEvent.change(id, { target: { value: "anthropic" } });
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(id.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toContain("已有同一 ID");
  fireEvent.change(id, { target: { value: "gateway" } });
  const url = field(d, "端点");
  fireEvent.change(url, { target: { value: "ftp://x" } });
  expect(url.getAttribute("aria-invalid")).toBe("true");
  expect(preview.hasAttribute("disabled")).toBe(true);
  fireEvent.change(url, { target: { value: "https://gateway.example.test" } });
  fireEvent.change(field(d, "名称"), { target: { value: "Gateway" } });

  click(d, "添加环境变量");
  const env = within(d).getByRole("group", { name: "新环境变量" });
  fireEvent.change(field(env, "变量名"), { target: { value: "1BAD" } });
  expect(preview.hasAttribute("disabled")).toBe(true);
  fireEvent.change(field(env, "变量名"), {
    target: { value: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  });
  fireEvent.change(field(env, "值"), { target: { value: "gateway-opus" } });

  click(d, "添加密钥变量");
  const secret = within(d).getByRole("group", { name: "新密钥变量" });
  fireEvent.change(field(secret, "变量名"), {
    target: { value: "ANTHROPIC_AUTH_TOKEN" },
  });
  // The key follows the id and variable until edited.
  expect((field(secret, "secrets.env 键名") as HTMLInputElement).value).toBe(
    "GATEWAY_ANTHROPIC_AUTH_TOKEN",
  );
  // A new key needs its value.
  expect(preview.hasAttribute("disabled")).toBe(true);
  const [value] = password(secret);
  expect(value?.getAttribute("autocomplete")).toBe("new-password");
  fireEvent.change(value as HTMLInputElement, {
    target: { value: ` ${FAKE}` },
  });
  expect(value?.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(value as HTMLInputElement, { target: { value: FAKE } });
  expect(preview.hasAttribute("disabled")).toBe(false);
  fireEvent.click(preview);
  const confirm = await within(d).findByRole("form", {
    name: "确认新建 Provider",
  });
  expect(api.previewLaunchChange).toHaveBeenCalledWith(V1, {
    op: "create_provider",
    name: "gateway",
    fields: {
      name: "Gateway",
      harness: "claude-code",
      base_url: "https://gateway.example.test",
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway-opus" },
      secret_env: { ANTHROPIC_AUTH_TOKEN: "GATEWAY_ANTHROPIC_AUTH_TOKEN" },
    },
    secrets: { set: ["GATEWAY_ANTHROPIC_AUTH_TOKEN"] },
  });
  expect(JSON.stringify(api.previewLaunchChange.mock.calls)).not.toContain(
    FAKE,
  );
  expect(confirm.textContent).toContain("密钥 GATEWAY_ANTHROPIC_AUTH_TOKEN");
  expect(confirm.textContent).toContain("写入新密钥");
  expect(confirm.textContent).not.toContain(FAKE);
  click(d, "确认保存");
  await waitFor(() =>
    expect(api.confirmLaunchChange).toHaveBeenCalledWith(
      V1,
      PREVIEW,
      expect.any(String),
      { GATEWAY_ANTHROPIC_AUTH_TOKEN: FAKE },
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建 Provider" })).toBeNull(),
  );
});

test("a failed write keeps the form but empties every secret input", async () => {
  const api = harness({
    confirmLaunchChange: vi
      .fn()
      .mockRejectedValue(new ApiError(500, "write_failed", "写入失败", false)),
  });
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  const d = await screen.findByRole("dialog", { name: "Relay" });
  click(d, "编辑");
  fireEvent.change(field(d, "名称"), { target: { value: "Relay 2" } });
  const group = within(d).getByRole("group", {
    name: "密钥变量 ANTHROPIC_AUTH_TOKEN",
  });
  expect(group.textContent).toContain("未设置");
  click(group, "填写");
  // V-2709: undoing a first value says so (not "replace").
  expect(within(group).getByRole("button", { name: "撤销填写" })).toBeTruthy();
  fireEvent.change(password(group)[0] as HTMLInputElement, {
    target: { value: FAKE },
  });
  click(d, "预览修改");
  await within(d).findByRole("form", { name: "确认编辑 Provider" });
  expect(api.previewLaunchChange.mock.lastCall?.[1]).toEqual({
    op: "edit_provider",
    name: "relay",
    fields: { name: "Relay 2" },
    secrets: { set: ["RELAY_TOKEN"] },
  });
  click(d, "确认保存");
  const alerts = await within(d).findAllByRole("alert");
  expect(alerts.map((a) => a.textContent).join()).toContain(
    "写入失败，已恢复原文件，没有改动",
  );
  expect(alerts.map((a) => a.textContent).join()).toContain(
    "密钥没有写入，输入框已清空，请重新输入",
  );
  expect((field(d, "名称") as HTMLInputElement).value).toBe("Relay 2");
  const emptied = password(
    within(d).getByRole("group", { name: "密钥变量 ANTHROPIC_AUTH_TOKEN" }),
  );
  expect(emptied.map((i) => i.value)).toEqual([""]);
  expect(
    within(d)
      .getByRole("button", { name: "预览修改" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("replace and clear send key names only; leaving with a typed secret asks first", async () => {
  const api = harness();
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "anthropic" }));
  const d = await screen.findByRole("dialog", { name: "Anthropic" });
  click(d, "编辑");
  const group = within(d).getByRole("group", {
    name: "密钥变量 ANTHROPIC_API_KEY",
  });
  click(group, "清除");
  expect(group.textContent).toContain("将清除");
  const hidden = within(d).getByRole("group", {
    name: "环境变量 ANTHROPIC_CUSTOM_HEADERS_TOKEN",
  });
  expect(hidden.textContent).toContain("已隐藏");
  click(hidden, "移除");
  click(d, "预览修改");
  await within(d).findByRole("form", { name: "确认编辑 Provider" });
  expect(api.previewLaunchChange.mock.lastCall?.[1]).toEqual({
    op: "edit_provider",
    name: "anthropic",
    fields: { env: { ANTHROPIC_CUSTOM_HEADERS_TOKEN: null } },
    secrets: { clear: ["ANTHROPIC_API_KEY"] },
  });
  click(d, "返回修改");
  const again = within(d).getByRole("group", {
    name: "密钥变量 ANTHROPIC_API_KEY",
  });
  click(again, "撤销清除");
  click(again, "替换");
  fireEvent.change(password(again)[0] as HTMLInputElement, {
    target: { value: FAKE },
  });
  click(d, "取消");
  const ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  // Back on the detail: nothing of the typed secret is kept anywhere.
  await within(d).findByRole("button", { name: "编辑" });
  expect(document.body.innerHTML).not.toContain(FAKE);
  click(d, "编辑");
  expect(password(d)).toEqual([]);
});

test("a Provider in use cannot be deleted and says who uses it; an unused one can", async () => {
  const api = harness();
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "anthropic" }));
  let d = await screen.findByRole("dialog", { name: "Anthropic" });
  click(d, "删除");
  expect(within(d).getByRole("alert").textContent).toContain(
    "启动配置 claude-opus",
  );
  expect(within(d).getByRole("alert").textContent).toContain("模型别名 opus");
  expect(
    within(d)
      .getByRole("button", { name: "预览删除" })
      .hasAttribute("disabled"),
  ).toBe(true);
  click(d, "取消");
  fireEvent.keyDown(d, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Anthropic" })).toBeNull(),
  );

  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  d = await screen.findByRole("dialog", { name: "Relay" });
  click(d, "删除");
  click(d, "预览删除");
  fireEvent.click(await within(d).findByRole("button", { name: "确认删除" }));
  await waitFor(() =>
    expect(api.confirmLaunchChange).toHaveBeenCalledWith(
      V1,
      PREVIEW,
      expect.any(String),
    ),
  );
  expect(api.previewLaunchChange.mock.lastCall?.[1]).toEqual({
    op: "delete_provider",
    name: "relay",
  });
});

test("a reference found at preview lists the users and keeps the delete unavailable", async () => {
  const api = harness({
    previewLaunchChange: vi.fn().mockRejectedValue(
      new ApiError(409, "provider_in_use", "使用中", false, {
        profiles: ["late-profile"],
        models: [],
      }),
    ),
  });
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  const d = await screen.findByRole("dialog", { name: "Relay" });
  click(d, "删除");
  click(d, "预览删除");
  expect((await within(d).findByRole("alert")).textContent).toContain(
    "late-profile",
  );
  await waitFor(() =>
    expect(
      within(d)
        .getByRole("button", { name: "预览删除" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
});

test("harness and protocol choices go out as edits of those fields only", async () => {
  const api = harness();
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "openai" }));
  const d = await screen.findByRole("dialog", { name: "OpenAI" });
  click(d, "编辑");
  changeControl(within(d).getByRole("combobox", { name: /协议/ }), {
    target: { value: "openai-responses" },
  });
  click(d, "预览修改");
  await within(d).findByRole("form", { name: "确认编辑 Provider" });
  expect(api.previewLaunchChange.mock.lastCall?.[1]).toEqual({
    op: "edit_provider",
    name: "openai",
    fields: { api: "openai-responses" },
  });
});

/** The fixture with no profile check running: nothing else keeps the poll going. */
const idle: LaunchSettingsView = {
  ...launchSettingsFixture,
  profiles: launchSettingsFixture.profiles.map((p) =>
    p.last_check?.status === "running"
      ? {
          ...p,
          last_check: {
            ...p.last_check,
            status: "passed",
            finished_at: "2026-01-01T00:00:00.000Z",
          },
        }
      : p,
  ),
};
const withRelayCheck = (status: "running" | "failed"): LaunchSettingsView => ({
  ...idle,
  providers: idle.providers.map((p) =>
    p.id === "relay"
      ? {
          ...p,
          last_check: {
            id: "probe",
            version: V1,
            mode: "online",
            started_at: "2026-01-01T00:00:00.000Z",
            finished_at:
              status === "running" ? null : "2026-01-01T00:00:02.000Z",
            status,
            problems: status === "running" ? [] : ["online_failed"],
            cli_version: null,
          },
        }
      : p,
  ),
});

test("a Provider probe first read as running is polled until it ends, without a manual refresh", async () => {
  const api = harness();
  api.set(idle);
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  const d = await screen.findByRole("dialog", { name: "Relay" });
  // The very next read already shows this probe, still running; no profile
  // check is running, so only the Provider keeps the page polling.
  api.set(withRelayCheck("running"));
  click(d, "在线探测");
  expect(await within(d).findByText("在线探测中")).toBeTruthy();
  api.set(withRelayCheck("failed"));
  expect(
    await within(d).findByText("在线探测未通过", {}, { timeout: 6000 }),
  ).toBeTruthy();
  expect(
    within(d)
      .getByRole("button", { name: "在线探测" })
      .hasAttribute("disabled"),
  ).toBe(false);
}, 10000);

async function relayWithSecret(api: ReturnType<typeof harness>) {
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  const d = await screen.findByRole("dialog", { name: "Relay" });
  click(d, "编辑");
  const group = within(d).getByRole("group", {
    name: "密钥变量 ANTHROPIC_AUTH_TOKEN",
  });
  click(group, "填写");
  fireEvent.change(password(group)[0] as HTMLInputElement, {
    target: { value: FAKE },
  });
  click(d, "预览修改");
  await within(d).findByRole("form", { name: "确认编辑 Provider" });
  click(d, "确认保存");
  return d;
}

test("a confirmation whose reply is lost is verified with the same key and no values; a settled receipt counts as saved", async () => {
  const confirmLaunchChange = vi
    .fn<CardiganClient["confirmLaunchChange"]>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(undefined);
  const api = harness({ confirmLaunchChange });
  await relayWithSecret(api);
  await waitFor(() => expect(confirmLaunchChange).toHaveBeenCalledTimes(2));
  const [first, second] = confirmLaunchChange.mock.calls;
  expect(first).toEqual([
    V1,
    PREVIEW,
    expect.any(String),
    { RELAY_TOKEN: FAKE },
  ]);
  expect(second).toEqual([V1, PREVIEW, first?.[2]]);
  expect(await screen.findByText(/已保存 Provider relay/u)).toBeTruthy();
  expect(document.body.innerHTML).not.toContain(FAKE);
});

test("a confirmation that cannot be verified is reported as unknown, never as not written", async () => {
  const confirmLaunchChange = vi
    .fn<CardiganClient["confirmLaunchChange"]>()
    .mockRejectedValueOnce(
      new ApiError(500, "write_unsettled", "写入结果暂未确认", false),
    )
    .mockRejectedValueOnce(
      new ApiError(400, "validation_failed", "x", false, { field: "secrets" }),
    );
  const api = harness({ confirmLaunchChange });
  const d = await relayWithSecret(api);
  const alert = await within(d).findByText(/无法确认密钥是否已写入/u);
  expect(alert).toBeTruthy();
  expect(d.textContent).not.toContain("密钥没有写入");
  const group = within(d).getByRole("group", {
    name: "密钥变量 ANTHROPIC_AUTH_TOKEN",
  });
  expect(password(group).map((i) => i.value)).toEqual([""]);
  expect(confirmLaunchChange).toHaveBeenCalledTimes(2);
  expect(document.body.innerHTML).not.toContain(FAKE);
});

test("a key another Provider reads cannot be rewritten here; the preview names it", async () => {
  const api = harness();
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "relay" }));
  const d = await screen.findByRole("dialog", { name: "Relay" });
  click(d, "编辑");
  click(d, "添加密钥变量");
  const secret = within(d).getByRole("group", { name: "新密钥变量" });
  fireEvent.change(field(secret, "变量名"), {
    target: { value: "ANTHROPIC_API_KEY" },
  });
  fireEvent.change(field(secret, "secrets.env 键名"), {
    target: { value: "ANTHROPIC_API_KEY" },
  });
  fireEvent.change(password(secret)[0] as HTMLInputElement, {
    target: { value: FAKE },
  });
  expect(within(d).getByRole("alert").textContent).toContain(
    "密钥键 ANTHROPIC_API_KEY 也被 Provider anthropic 使用",
  );
  expect(
    within(d)
      .getByRole("button", { name: "预览修改" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("a hidden value in a diff is shown as hidden", async () => {
  const api = harness({
    previewLaunchChange: vi.fn(async (version: string) => ({
      version,
      preview_id: PREVIEW,
      diff: [
        {
          field: "providers.anthropic.env.ANTHROPIC_CUSTOM_HEADERS_TOKEN",
          before: { hidden: true },
          after: null,
        },
      ],
    })),
  });
  const table = await openModels(api.client);
  fireEvent.click(within(table).getByRole("button", { name: "anthropic" }));
  const d = await screen.findByRole("dialog", { name: "Anthropic" });
  click(d, "编辑");
  click(
    within(d).getByRole("group", {
      name: "环境变量 ANTHROPIC_CUSTOM_HEADERS_TOKEN",
    }),
    "移除",
  );
  click(d, "预览修改");
  const confirm = await within(d).findByRole("form", {
    name: "确认编辑 Provider",
  });
  expect(confirm.textContent).toContain(
    "环境变量 ANTHROPIC_CUSTOM_HEADERS_TOKEN已隐藏 → 未设置",
  );
});
