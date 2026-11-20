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
import { App } from "../App.js";
import {
  HttpCardiganClient,
  type LaunchProfileView,
  type LaunchSettingsView,
  type RoleDetailView,
  type RoleHistoryEntry,
  type RoleListView,
} from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { launchSettingsFixture } from "../testing/launch-settings-fixture.js";
import { SettingsPage } from "./SettingsPage.js";

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

async function openModels(overrides: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    launchSettings: async () => launchSettingsFixture,
    ...overrides,
  });
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  return client;
}

test("settings navigation lists 模型 after the existing panels", async () => {
  render(<SettingsPage projectId="p-1" client={fakeClient()} />);
  const nav = screen.getByRole("navigation", { name: "设置分栏" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual([
    "偏好",
    "并发与容量",
    "授权",
    "飞书绑定",
    "角色",
    "卡片模板",
    "员工",
    "模型",
  ]);
  fireEvent.click(within(nav).getByRole("button", { name: "模型" }));
  expect(
    within(nav)
      .getByRole("button", { name: "模型" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(await screen.findByRole("heading", { name: "模型" })).toBeTruthy();
});

test("the list shows each profile's harness, model, parameters, secrets, references and last check", async () => {
  await openModels();
  const table = await screen.findByRole("table", { name: "启动配置" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.textContent)).toEqual([
    "claude-opusclaude-codeopus → claude-opus-fixture-1effort high、bypassPermissions、不自动更新、自定义配置 1已设置3通过",
    "codex-solcodexgpt-fixture-soleffort medium、provider openai、自定义参数 21 项未设置1未通过",
    "pi-deepseekpideepseek-chat自动更新已设置0未检查",
    "claude-localclaude-code———1检查中",
  ]);
});

test("the detail shows metadata, provider, CLI, secret key names and who uses the profile", async () => {
  await openModels();
  fireEvent.click(await screen.findByRole("button", { name: "claude-opus" }));
  const dialog = await screen.findByRole("dialog", { name: "claude-opus" });
  const text = dialog.textContent ?? "";
  for (const fact of [
    "Anthropic",
    "https://anthropic.example.test",
    "opus",
    "claude-opus-fixture-1",
    "200,000 tokens",
    "32,000 tokens",
    "输入 $15 · 输出 $75（每百万 tokens）",
    "low、medium、high",
    "9.9.1",
    "/opt/fixture/bin/claude",
    "ANTHROPIC_API_KEY",
    "已设置",
    "本地检查",
  ])
    expect(text).toContain(fact);
  // Read only: no write controls, no secret value field.
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  expect(within(dialog).queryByRole("switch")).toBeNull();
  expect(
    within(dialog)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["关闭抽屉"]);
  const users = within(dialog).getByRole("table", { name: "使用者" });
  expect(
    within(users).getByRole("link", { name: "文档写手" }).getAttribute("href"),
  ).toBe("#/p/p-1/settings?tab=roles&role=writer&version=2");
  expect(
    within(users).getByRole("link", { name: "代码审核" }).getAttribute("href"),
  ).toBe("#/p/p-2/settings?tab=roles&role=reviewer&version=3");
  // The employee by id, in any status: not a text search for the name.
  expect(
    within(users).getByRole("link", { name: "悟空" }).getAttribute("href"),
  ).toBe("#/p/p-1/execution?view=all&employee=E-3");
  expect(users.textContent).toContain("v3");
  expect(users.textContent).toContain("E-3");
});

test("missing values, unset secrets, failed checks and unused profiles read as facts", async () => {
  await openModels();
  fireEvent.click(await screen.findByRole("button", { name: "codex-sol" }));
  let dialog = await screen.findByRole("dialog", { name: "codex-sol" });
  expect(dialog.textContent).toContain("OPENAI_API_KEY未设置");
  expect(dialog.textContent).toContain("OPENAI_ORG已设置");
  expect(dialog.textContent).toContain("未通过");
  expect(dialog.textContent).toContain("在线探测");
  expect(dialog.textContent).toContain("secret_missing");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "pi-deepseek" }));
  dialog = await screen.findByRole("dialog", { name: "pi-deepseek" });
  expect(dialog.textContent).toContain("未检查");
  expect(dialog.textContent).toContain("没有角色或员工使用");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "claude-local" }));
  dialog = await screen.findByRole("dialog", { name: "claude-local" });
  expect(dialog.textContent).toContain("不需要密钥");
  expect(dialog.textContent).toContain("检查中");
});

test("loading, empty and failed reads have distinct states", async () => {
  let release: (() => void) | undefined;
  await openModels({
    launchSettings: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ version: "0".repeat(64), profiles: [], providers: [] });
      }),
  });
  // Shown once the read is slow (the shared feedback waits one second).
  expect(
    await screen.findByText("正在加载启动配置…", undefined, { timeout: 3000 }),
  ).toBeTruthy();
  release?.();
  expect(await screen.findByText("没有启动配置")).toBeTruthy();
  cleanup();

  let fail = true;
  await openModels({
    launchSettings: async () => {
      if (fail) throw new Error("读取启动配置失败");
      return launchSettingsFixture;
    },
  });
  expect(await screen.findByText(/读取启动配置失败/)).toBeTruthy();
  expect(screen.queryByRole("table", { name: "启动配置" })).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("table", { name: "启动配置" })).toBeTruthy();
});

test("the client reads the global endpoint without a project", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(launchSettingsFixture), { status: 200 }),
  );
  const view = await new HttpCardiganClient(fetch).launchSettings();
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/launch-settings");
  expect(view.profiles).toHaveLength(4);
});

test("a role reference opens that role's detail in settings", async () => {
  const list: RoleListView = {
    project_id: "p-1",
    roles: [],
    default_roles: [],
    harnesses: ["pi"],
    allowlists: { produce: [], verify: [], standing: [] },
  };
  const role = {
    role_id: "writer",
    version: 2,
    display_name: "写手",
    kind: "produce",
    status: "active",
    instructions: "负责写文档。",
    core_prompt: "",
    harness: "pi",
    launch_profile_ref: "claude-opus",
    allowed_tools: [],
    capabilities: [],
    abilities: [],
    worktree: "readonly",
    required_machine_tags: [],
  } as const;
  const detail: RoleDetailView = {
    project_id: "p-1",
    role,
    previous: null,
    allowlist: [],
    allowlists: list.allowlists,
    harnesses: ["pi"],
    legacy_conversion: null,
  };
  window.location.hash = "#/p/p-1/settings";
  render(
    <App
      client={fakeClient({
        launchSettings: async () => launchSettingsFixture,
        roles: async () => list,
        role: async () => detail,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "模型" }));
  fireEvent.click(await screen.findByRole("button", { name: "claude-opus" }));
  const link = await screen.findByRole("link", { name: "文档写手" });
  // jsdom does not follow hash links: navigate as the browser would.
  window.location.hash = link.getAttribute("href") ?? "";
  const dialog = await screen.findByRole("dialog", { name: "写手" });
  expect(
    screen
      .getByRole("button", { name: "角色", hidden: true })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Closing drops the link, so following it again reopens the role.
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/p-1/settings?tab=roles"),
  );
});

const roleList: RoleListView = {
  project_id: "p-1",
  roles: [],
  default_roles: [],
  harnesses: ["pi"],
  allowlists: { produce: [], verify: [], standing: [] },
};
const coder = (version: number) =>
  ({
    role_id: "coder",
    version,
    display_name: "开发工程师",
    kind: "produce",
    status: "active",
    instructions: "负责实现。",
    core_prompt: "",
    harness: "pi",
    launch_profile_ref: version === 1 ? "codex-sol" : "claude-opus",
    allowed_tools: [],
    capabilities: [],
    abilities: [],
    worktree: "readonly",
    required_machine_tags: [],
  }) as const;
const coderHistory = (version: number): RoleHistoryEntry => ({
  version,
  role: coder(version),
  action: version === 1 ? "create" : "update",
  summary: `第 ${version} 版`,
  changes: [],
  created_at: null,
  actor: null,
  author_display: null,
});

/** Two versions of one role use the profile: v1 is history, v2 is current. */
function versionedApp() {
  const profile = launchSettingsFixture.profiles[1] as LaunchProfileView;
  const settings: LaunchSettingsView = {
    ...launchSettingsFixture,
    profiles: [
      {
        ...profile,
        references: [
          {
            project_id: "p-1",
            role_id: "coder",
            version: 1,
            name: "开发工程师",
          },
          {
            project_id: "p-1",
            role_id: "coder",
            version: 2,
            name: "开发工程师",
          },
        ],
      },
    ],
  };
  render(
    <App
      client={fakeClient({
        launchSettings: async () => settings,
        roles: async () => roleList,
        role: async () => ({
          project_id: "p-1",
          role: coder(2),
          previous: coder(1),
          allowlist: [],
          allowlists: roleList.allowlists,
          harnesses: ["pi"],
          legacy_conversion: null,
        }),
        roleHistory: async (project_id, role_id) => ({
          project_id,
          role_id,
          versions: [coderHistory(2), coderHistory(1)],
        }),
      })}
    />,
  );
}

test("profiles with the same masked name each open their own detail", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const [first, second] = launchSettingsFixture.profiles as [
    LaunchProfileView,
    LaunchProfileView,
  ];
  await openModels({
    launchSettings: async () => ({
      ...launchSettingsFixture,
      profiles: [
        { ...first, name: "***" },
        { ...second, name: "***" },
      ],
    }),
  });
  const masked = await screen.findAllByRole("button", { name: "***" });
  expect(masked).toHaveLength(2);
  fireEvent.click(masked[1] as HTMLElement);
  let dialog = await screen.findByRole("dialog", { name: "***" });
  expect(dialog.textContent).toContain("gpt-fixture-sol");
  expect(dialog.textContent).not.toContain("claude-opus-fixture-1");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(masked[0] as HTMLElement);
  dialog = await screen.findByRole("dialog", { name: "***" });
  expect(dialog.textContent).toContain("claude-opus-fixture-1");
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes("same key")),
  ).toBe(false);
  errors.mockRestore();
});

test("each role version keeps its own row and lands on that version", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  window.location.hash = "#/p/p-1/settings?tab=models";
  versionedApp();
  fireEvent.click(await screen.findByRole("button", { name: "codex-sol" }));
  const users = await screen.findByRole("table", { name: "使用者" });
  const links = within(users).getAllByRole("link", { name: "开发工程师" });
  expect(links.map((l) => l.getAttribute("href"))).toEqual([
    "#/p/p-1/settings?tab=roles&role=coder&version=1",
    "#/p/p-1/settings?tab=roles&role=coder&version=2",
  ]);
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes("same key")),
  ).toBe(false);
  errors.mockRestore();
  window.location.hash = links[0]?.getAttribute("href") ?? "";
  const dialog = await screen.findByRole("dialog", { name: "开发工程师" });
  const history = await within(dialog).findByRole("table", {
    name: "版本历史",
  });
  const rows = within(history).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([
    null,
    "true",
  ]);
  expect(rows[1]?.textContent).toContain("v1");
});

test("browser back from a followed role link returns to 模型 and closes the role", async () => {
  window.location.hash = "#/p/p-1/settings";
  versionedApp();
  const nav = await screen.findByRole("navigation", { name: "设置分栏" });
  fireEvent.click(within(nav).getByRole("button", { name: "模型" }));
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/p-1/settings?tab=models"),
  );
  fireEvent.click(await screen.findByRole("button", { name: "codex-sol" }));
  const link = (
    await screen.findAllByRole("link", { name: "开发工程师" })
  )[1] as HTMLElement;
  window.location.hash = link.getAttribute("href") ?? "";
  expect(
    await screen.findByRole("dialog", { name: "开发工程师" }),
  ).toBeTruthy();
  window.history.back();
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/p-1/settings?tab=models"),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.getByRole("button", { name: "模型" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(await screen.findByRole("table", { name: "启动配置" })).toBeTruthy();
});

test("a role drawer opened from the list is not closed by the link logic", async () => {
  window.location.hash = "#/p/p-1/settings?tab=roles";
  render(
    <App
      client={fakeClient({
        roles: async () => ({
          ...roleList,
          roles: [coder(2)],
        }),
        role: async () => ({
          project_id: "p-1",
          role: coder(2),
          previous: null,
          allowlist: [],
          allowlists: roleList.allowlists,
          harnesses: ["pi"],
          legacy_conversion: null,
        }),
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "开发工程师" }));
  const dialog = await screen.findByRole("dialog", { name: "开发工程师" });
  // No version was linked: nothing in the history is marked.
  const history = await within(dialog).findByRole("table", {
    name: "版本历史",
  });
  expect(history.querySelector('[aria-current="true"]')).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByRole("dialog", { name: "开发工程师" })).toBeTruthy();
  expect(window.location.hash).toBe("#/p/p-1/settings?tab=roles");
});

test("browser back on the roles panel closes a role opened by a link", async () => {
  window.location.hash = "#/p/p-1/settings?tab=roles";
  versionedApp();
  expect(await screen.findByRole("heading", { name: "角色" })).toBeTruthy();
  window.location.hash = "#/p/p-1/settings?tab=roles&role=coder&version=1";
  expect(
    await screen.findByRole("dialog", { name: "开发工程师" }),
  ).toBeTruthy();
  window.history.back();
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/p-1/settings?tab=roles"),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
