// @vitest-environment jsdom
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
  type CardiganClient,
  type FeishuTestResult,
} from "../api.js";
import {
  type FakeFeishuOptions,
  fakeFeishuSettings,
  syntheticFeishuView,
} from "../testing/feishu-settings.js";
import { fakeClient } from "../testing/fixtures.js";
import { FeishuSettings } from "./FeishuSettings.js";
import { buildChange, draftFrom } from "./feishu-config.js";
import { SettingsPage } from "./SettingsPage.js";
import { resetSettingWrites } from "./useSettingWrite.js";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  resetSettingWrites();
  window.location.hash = "";
  vi.useRealTimers();
});

// Synthetic values only; nothing here is a real credential or endpoint.
const SIGN = "fixture-signing-value";

function setup(
  options: FakeFeishuOptions = {},
  extra: Partial<CardiganClient> = {},
  bound = true,
) {
  const server = fakeFeishuSettings(syntheticFeishuView(), options);
  const reads = vi.fn(server.client.feishuSettings);
  const client = fakeClient({
    feishuBinding: async () => ({ state: "connected", bound }),
    ...server.client,
    feishuSettings: reads,
    ...extra,
  });
  return { server, reads, client };
}
const groupTitles = () =>
  [
    ...screen
      .getByRole("region", { name: "飞书绑定" })
      .querySelectorAll("[data-settings-group] h3"),
  ].map((h) => h.textContent?.trim());
const dialog = () => screen.getByRole("dialog", { name: "编辑飞书配置" });
const field = (name: string) =>
  within(dialog()).getByLabelText<HTMLInputElement>(name);
const type = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const secretBlock = (label: string) =>
  within(dialog()).getByRole("group", { name: label });
async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "编辑配置" }));
  return dialog();
}
async function preview() {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name: "预览修改" }));
  });
}
async function confirm() {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name: "确认保存" }));
  });
}

test("the server read fills six read-only groups; 高级 stays folded", async () => {
  const { client } = setup();
  render(<FeishuSettings client={client} />);
  await screen.findByText("已绑定");
  await screen.findByText("每分钟 20 条");
  expect(groupTitles()).toEqual([
    "状态",
    "渠道",
    "免打扰",
    "限速",
    "凭据",
    "高级",
  ]);
  const status = screen.getByRole("region", { name: "状态" });
  expect(status.textContent).toContain("已开启");
  expect(
    status.contains(screen.getByRole("button", { name: "解除绑定" })),
  ).toBe(true);
  expect(screen.getByText("22:00–08:00")).toBeTruthy();
  const secrets = screen.getByRole("region", { name: "凭据" });
  expect(secrets.textContent).toContain("未设置");
  // The page itself has no inputs: edits happen in the drawer only.
  expect(document.querySelector("[role=switch], input, textarea")).toBeNull();
  const advanced = screen.getByRole("button", { name: "高级" });
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("重试间隔").closest("[hidden]")).not.toBeNull();
  fireEvent.click(advanced);
  expect(screen.getByText("30 秒、60 秒")).toBeTruthy();
  expect(screen.getByText("1440 分钟")).toBeTruthy();
});

test.each([
  ["a non-owner session (403)", new ApiError(403, "human_only", "仅限人员")],
  ["a server without the endpoint (404)", new ApiError(404, "not_found", "")],
])("%s keeps only the binding entry, without an error", async (_, error) => {
  const { client } = setup(
    {},
    {
      feishuSettings: async () => {
        throw error;
      },
    },
  );
  window.location.hash = "#/p/p-1/settings?tab=feishu";
  render(<SettingsPage projectId="p-1" client={client} />);
  await screen.findByText("已绑定");
  await act(async () => {});
  expect(groupTitles()).toEqual(["状态"]);
  expect(screen.queryByRole("button", { name: "编辑配置" })).toBeNull();
  expect(screen.queryByText(/未能读取飞书配置/u)).toBeNull();
});

test("a failed read offers a retry and keeps the binding entry", async () => {
  let fail = true;
  const { client, server } = setup(
    {},
    {
      feishuSettings: async () => {
        if (fail) throw new ApiError(500, "internal", "合成失败");
        return server.view;
      },
    },
  );
  render(<FeishuSettings client={client} />);
  expect(await screen.findByText(/未能读取飞书配置/u)).toBeTruthy();
  expect(screen.getByRole("button", { name: "解除绑定" })).toBeTruthy();
  fail = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
  });
  expect(await screen.findByText("每分钟 20 条")).toBeTruthy();
});

test("preview sends only changed fields, confirm saves, then the page reads the server again", async () => {
  const { client, server, reads } = setup();
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  type("群机器人（条/分钟）", "30");
  type("重试间隔（秒）", "5, 30, 60");
  fireEvent.click(within(dialog()).getByRole("switch", { name: "免打扰" }));
  await preview();
  expect(server.log.previews).toEqual([
    {
      settings: {
        "quiet_hours.enabled": false,
        "channels.lark.max_per_minute": 30,
        "policy.retry_delays_ms": [5000, 30000, 60000],
        "policy.max_attempts": 4,
      },
    },
  ]);
  const review = within(dialog());
  expect(review.getByText("群机器人限速")).toBeTruthy();
  expect(review.getByText("每分钟 30 条")).toBeTruthy();
  expect(review.getByText("5 秒、30 秒、60 秒")).toBeTruthy();
  // Nothing written yet.
  expect(server.log.confirms).toHaveLength(0);
  const before = reads.mock.calls.length;
  await confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(server.log.confirms).toHaveLength(1);
  expect(server.log.confirms[0]?.secretKeys).toEqual([]);
  await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
  expect(await screen.findByText("每分钟 30 条")).toBeTruthy();
  expect(screen.getByText("已保存飞书配置")).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("编辑配置"),
  );
});

test("a restart the server asks for is shown in the preview", async () => {
  const { client, server } = setup();
  const previewOnce = server.client.previewFeishuSettings;
  render(
    <FeishuSettings
      client={{
        ...client,
        previewFeishuSettings: async (version, change) => ({
          ...(await previewOnce(version, change)),
          restart_required: true,
        }),
      }}
    />,
  );
  await screen.findByText("每分钟 20 条");
  await openEditor();
  type("标题长度（字）", "100");
  await preview();
  expect(
    within(dialog()).getByText("这次修改需要重启后台才能生效。"),
  ).toBeTruthy();
});

test("unconfirmed edits ask before closing; leaving the page asks through the browser", async () => {
  const { client } = setup();
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  // Untouched: closing does not ask.
  fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await openEditor();
  type("时区", "Europe/Berlin");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(
    await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(field("时区").value).toBe("Europe/Berlin");
  // In review the edits are still unconfirmed.
  await preview();
  fireEvent.click(within(dialog()).getByRole("button", { name: "关闭抽屉" }));
  fireEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const after = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

test("a refused save explains why at the top and keeps every edit but the credential", async () => {
  const { client, server } = setup({
    confirmError: () => new ApiError(400, "invalid_settings", "无效"),
  });
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  type("时区", "Europe/Berlin");
  fireEvent.click(
    within(secretBlock("群机器人签名密钥")).getByRole("button", {
      name: "填写",
    }),
  );
  type("新群机器人签名密钥", SIGN);
  expect(field("新群机器人签名密钥").type).toBe("password");
  expect(field("新群机器人签名密钥").autocomplete).toBe("new-password");
  await preview();
  // The preview names the key only; the value never leaves before confirm.
  expect(JSON.stringify(server.log.previews)).not.toContain(SIGN);
  expect(dialog().textContent).not.toContain(SIGN);
  await confirm();
  const form = within(dialog()).getByRole("form", { name: "编辑飞书配置" });
  const alerts = within(form).getAllByRole("alert");
  expect(alerts[0]?.textContent).toContain("服务端未接受这次修改");
  // The notice comes before the first field of the form.
  expect(
    alerts[0]?.compareDocumentPosition(field("消息推送")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(form.textContent).toContain("凭据没有保存，输入框已清空");
  expect(field("时区").value).toBe("Europe/Berlin");
  expect(field("新群机器人签名密钥").value).toBe("");
  expect(dialog().textContent).not.toContain(SIGN);
  expect(JSON.stringify(localStorage)).not.toContain(SIGN);
  expect(JSON.stringify(sessionStorage)).not.toContain(SIGN);
});

test("credentials: replace and clear, never shown; enabling a channel needs its credentials", async () => {
  const { client, server } = setup();
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  const webhook = secretBlock("群机器人 Webhook");
  expect(within(webhook).getByText("已设置")).toBeTruthy();
  expect(webhook.querySelector("input")).toBeNull();
  // Clearing the webhook of an enabled group bot needs the bot turned off.
  fireEvent.click(within(webhook).getByRole("button", { name: "清除" }));
  expect(within(webhook).getByText("将清除")).toBeTruthy();
  await preview();
  expect(server.log.previews).toHaveLength(0);
  expect(webhook.textContent).toContain("要清除请同时关闭群机器人");
  fireEvent.click(within(dialog()).getByRole("switch", { name: "群机器人" }));
  // A malformed replacement is marked before any request.
  fireEvent.click(
    within(secretBlock("应用 App ID")).getByRole("button", { name: "替换" }),
  );
  type("新应用 App ID", "not-an-app-id");
  await preview();
  expect(server.log.previews).toHaveLength(0);
  expect(field("新应用 App ID").getAttribute("aria-invalid")).toBe("true");
  type("新应用 App ID", "cli_0123456789abcdef");
  await preview();
  expect(server.log.previews).toEqual([
    {
      settings: { "channels.lark.enabled": false },
      secrets: { set: ["app_id"], clear: ["lark_webhook"] },
    },
  ]);
  expect(dialog().textContent).toContain("写入新值");
  expect(dialog().textContent).not.toContain("cli_0123456789abcdef");
  await confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(server.log.confirms[0]?.secretKeys).toEqual(["app_id"]);
  const secrets = screen.getByRole("region", { name: "凭据" });
  await waitFor(() =>
    expect(
      within(secrets)
        .getAllByText("未设置")
        .map((e) => e.closest("[data-settings-row]")?.textContent),
    ).toContain("群机器人 Webhook未设置"),
  );
  expect(document.body.textContent).not.toContain("cli_0123456789abcdef");
});

test("a stale read: refresh, keep the person's edits and preview again against the new read", async () => {
  const { client, server } = setup();
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  type("标题长度（字）", "100");
  server.changeElsewhere({ "policy.digest_limit": 7 });
  await preview();
  expect(dialog().textContent).toContain("这次预览已作废");
  await act(async () => {
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "刷新并重新预览" }),
    );
  });
  // The untouched digest limit follows the new read; only the edit is sent.
  expect(server.log.previews.at(-1)).toEqual({
    settings: { "policy.title_limit": 100 },
  });
  expect(within(dialog()).getByText("确认修改")).toBeTruthy();
  await confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(server.view.settings["policy.digest_limit"]).toBe(7);
  expect(server.view.settings["policy.title_limit"]).toBe(100);
});

test("a lost reply asks again with the same key and no credential values", async () => {
  let lose = true;
  const { client, server } = setup();
  const confirmOnce = server.client.confirmFeishuSettings;
  render(
    <FeishuSettings
      client={{
        ...client,
        confirmFeishuSettings: async (...args) => {
          await confirmOnce(...args);
          if (lose) {
            lose = false;
            throw new ApiError(502, "http_502", "网关", true);
          }
        },
      }}
    />,
  );
  await screen.findByText("每分钟 20 条");
  await openEditor();
  fireEvent.click(
    within(secretBlock("群机器人签名密钥")).getByRole("button", {
      name: "填写",
    }),
  );
  type("新群机器人签名密钥", SIGN);
  await preview();
  await confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(server.log.confirms).toEqual([
    { key: expect.any(String), secretKeys: ["lark_sign_secret"] },
    { key: server.log.confirms[0]?.key, secretKeys: [] },
  ]);
  expect(screen.getByText("已保存飞书配置")).toBeTruthy();
});

test("an unverifiable save says so, empties the credential and reads again", async () => {
  const { client, server, reads } = setup({
    confirmError: () => new ApiError(502, "http_502", "网关", true),
  });
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await openEditor();
  fireEvent.click(
    within(secretBlock("群机器人签名密钥")).getByRole("button", {
      name: "填写",
    }),
  );
  type("新群机器人签名密钥", SIGN);
  await preview();
  const before = reads.mock.calls.length;
  await confirm();
  expect(dialog().textContent).toContain("无法确认是否已保存");
  expect(field("新群机器人签名密钥").value).toBe("");
  expect(reads.mock.calls.length).toBeGreaterThan(before);
  expect(server.log.confirms.map((c) => c.secretKeys)).toEqual([
    ["lark_sign_secret"],
    [],
  ]);
});

test("each test entry sends once per click, ignores repeats while pending and shows the result", async () => {
  let release: (r: FeishuTestResult) => void = () => {};
  const { client, server } = setup({
    test: (channel) =>
      channel === "lark"
        ? new Promise<FeishuTestResult>((resolve) => {
            release = resolve;
          })
        : "timeout",
  });
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  const lark = screen.getByRole("button", {
    name: "发送测试消息 群机器人测试",
  });
  fireEvent.click(lark);
  fireEvent.click(lark);
  expect(lark.getAttribute("aria-disabled")).toBe("true");
  expect(lark.textContent).toBe("发送中…");
  await act(async () => release("sent"));
  expect(await screen.findByText("已发送")).toBeTruthy();
  expect(server.log.tests).toHaveLength(1);
  await act(async () => {
    fireEvent.click(lark);
  });
  await act(async () => release("permanent"));
  expect(await screen.findByText("发送失败")).toBeTruthy();
  // A new click is a new request with a new key.
  expect(new Set(server.log.tests.map((t) => t.key)).size).toBe(2);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "发送测试消息 应用私聊测试" }),
    );
  });
  expect(await screen.findByText("超时，未确认送达")).toBeTruthy();
  expect(server.log.sent).toBe(3);
});

test.each([
  [new ApiError(409, "channel_disabled", ""), "未发送：渠道未开启"],
  [
    new ApiError(409, "binding_unavailable", ""),
    "未发送：本人未绑定或凭据无效",
  ],
  [new ApiError(429, "rate_limited", ""), "未发送：渠道已限速"],
  [new ApiError(502, "http_502", "", true), "结果未知"],
])("a refused or unclear test (%s) is shown as %s", async (error, label) => {
  const { client } = setup({ test: () => error });
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "发送测试消息 群机器人测试" }),
    );
  });
  expect(await screen.findByText(label)).toBeTruthy();
});

test("tests are unavailable while the channel is off or the person is not bound", async () => {
  const server = fakeFeishuSettings();
  server.changeElsewhere({ "channels.lark.enabled": false });
  const send = vi.fn(server.client.testFeishuChannel);
  const client = fakeClient({
    feishuBinding: async () => ({ state: "connected", bound: false }),
    ...server.client,
    testFeishuChannel: send,
  });
  render(<FeishuSettings client={client} />);
  await screen.findByText("每分钟 20 条");
  const lark = screen.getByRole<HTMLButtonElement>("button", {
    name: "发送测试消息 群机器人测试",
  });
  const app = screen.getByRole<HTMLButtonElement>("button", {
    name: "发送测试消息 应用私聊测试",
  });
  expect(lark.disabled).toBe(true);
  expect(lark.title).toBe("群机器人未开启");
  await screen.findByText("未绑定");
  expect(app.disabled).toBe(true);
  expect(app.title).toBe("本人尚未绑定");
  fireEvent.click(lark);
  fireEvent.click(app);
  expect(send).not.toHaveBeenCalled();
});

test("change rules: units, retry attempts and masked fields", () => {
  const view = syntheticFeishuView();
  const draft = draftFrom(view);
  expect(draft.fields.timeout).toBe("10");
  expect(draft.fields.retry_delays).toBe("30, 60");
  expect(draft.fields.binding_ttl).toBe("5");
  expect(buildChange(view, draft, {})).toEqual({ problems: {}, dirty: false });
  const edit = (fields: Partial<typeof draft.fields>) =>
    buildChange(view, { ...draft, fields: { ...draft.fields, ...fields } }, {});
  expect(edit({ timeout: "1.5", retry_delays: "" }).change).toEqual({
    settings: {
      "policy.timeout_ms": 1500,
      "policy.retry_delays_ms": [],
      "policy.max_attempts": 1,
    },
  });
  expect(edit({ binding_ttl: "0" }).problems.binding_ttl).toBeTruthy();
  expect(edit({ title_limit: "1.5" }).problems.title_limit).toBeTruthy();
  expect(edit({ quiet_end: "22:00" }).problems.quiet_end).toBe(
    "结束时间不能与开始时间相同。",
  );
  expect(
    edit({ workbench_url: "https://open.feishu.cn/open-apis/bot/v2/hook/x" })
      .problems.workbench_url,
  ).toBeTruthy();
  expect(edit({ workbench_url: "" }).problems.workbench_url).toBe(
    "开启消息推送需要填写 Workbench 链接。",
  );
  // A field the server masked (it held a credential) must be retyped first.
  const masked = {
    ...view,
    settings: { ...view.settings, workbench_url: null },
  };
  const start = draftFrom(masked);
  expect(start.fields.workbench_url).toBe("");
  const other = buildChange(
    masked,
    { ...start, fields: { ...start.fields, title_limit: "100" } },
    {},
  );
  expect(other.change).toBeUndefined();
  expect(other.problems.workbench_url).toContain("已隐藏");
  const fixed = buildChange(
    masked,
    {
      ...start,
      fields: { ...start.fields, workbench_url: "https://wb.example.test" },
      retyped: new Set(["workbench_url"]),
    },
    {},
  );
  expect(fixed.change).toEqual({
    settings: { workbench_url: "https://wb.example.test" },
  });
});
