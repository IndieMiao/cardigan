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
  HttpCardiganClient,
  type RoleDefinitionView,
  type RoleDetailView,
  type RoleHistoryView,
  type RoleListView,
} from "../api.js";
import { diffLines, roleRelaxations } from "../role-diff.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(cleanup);
// Radix Checkbox measures itself; jsdom has no ResizeObserver.
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

const allowlists = {
  produce: ["whoami", "get_card", "submit_delivery", "post_comment"],
  verify: ["whoami", "get_card", "submit_review", "post_comment"],
  standing: ["whoami", "get_card", "record_decision"],
};
const v1: RoleDefinitionView = {
  role_id: "writer",
  version: 1,
  display_name: "写手",
  kind: "produce",
  status: "active",
  instructions: "负责写文档。",
  core_prompt: "",
  harness: "pi",
  launch_profile_ref: "fixture",
  allowed_tools: ["whoami", "get_card"],
  capabilities: ["produce"],
  abilities: ["docs"],
  worktree: "readonly",
  required_machine_tags: ["gpu"],
};
const v2 = {
  ...v1,
  version: 2,
  instructions: "负责写文档。\n也写发布说明。",
  abilities: ["docs", "release"],
  status: "active" as const,
  kind: "produce" as const,
};
const list: RoleListView = {
  project_id: "p-1",
  roles: [
    {
      role_id: "writer",
      display_name: "写手",
      kind: "produce",
      status: "active",
      version: 2,
      harness: "pi",
      launch_profile_ref: "fixture",
    },
    {
      role_id: "reviewer",
      display_name: "审核",
      kind: "verify",
      status: "inactive",
      version: 3,
      harness: "codex",
      launch_profile_ref: "codex-agent",
    },
  ],
  default_roles: ["coder", "designer"],
  harnesses: ["claude-code", "codex", "pi"],
  allowlists,
};
const detail: RoleDetailView = {
  project_id: "p-1",
  role: v2,
  previous: v1,
  allowlist: allowlists.produce,
  allowlists,
  harnesses: ["claude-code", "codex", "pi"],
  legacy_conversion: null,
};
const history: RoleHistoryView = {
  project_id: "p-1",
  role_id: "writer",
  versions: [
    {
      version: 2,
      role: v2,
      action: "编辑",
      summary: "编辑：改动 instructions、abilities",
      changes: ["instructions", "abilities"],
      created_at: "2026-11-10T10:00:00.000Z",
      actor: "human",
      author_display: "所有者",
    },
    {
      version: 1,
      role: v1,
      action: "创建",
      summary: "创建",
      changes: [],
      created_at: "2026-11-09T10:00:00.000Z",
      actor: "human",
      author_display: "所有者",
    },
  ],
};

function client(overrides: Parameters<typeof fakeClient>[0] = {}) {
  return fakeClient({
    roles: async () => list,
    role: async () => detail,
    roleHistory: async () => history,
    ...overrides,
  });
}

async function openRoles(c = client()) {
  render(<SettingsPage projectId="p-1" client={c} />);
  fireEvent.click(await screen.findByRole("button", { name: "角色" }));
  return c;
}

test("roles tab lists name, kind, version and status", async () => {
  await openRoles();
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows[0]?.textContent).toContain("名称");
  expect(rows[1]?.textContent).toContain("写手");
  expect(rows[1]?.textContent).toContain("writer");
  expect(rows[1]?.textContent).toContain("产出");
  expect(rows[1]?.textContent).toContain("v2");
  expect(rows[1]?.textContent).toContain("启用");
  expect(rows[2]?.textContent).toContain("验证");
  expect(rows[2]?.textContent).toContain("已停用");
  // C-48 StatusTag: shared shape plus Chinese label, not plain text.
  expect(
    within(rows[1] as HTMLElement)
      .getByText("启用")
      .classList.contains("status-shape-success"),
  ).toBe(true);
  expect(
    within(rows[2] as HTMLElement)
      .getByText("已停用")
      .classList.contains("status-shape-cancelled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "角色" }).getAttribute("aria-current"),
  ).toBe("page");
});

test("detail shows every field, the version-pin notice, the diff and history", async () => {
  await openRoles();
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  const drawer = await screen.findByRole("dialog");
  // The version-pin notice is the hover/focus help next to the version.
  fireEvent.focus(
    await within(drawer).findByRole("button", { name: "版本说明" }),
  );
  expect(
    (
      await screen.findAllByText(
        /内部工作项 Assignment 空闲且旧终端退出后会分批升级/,
      )
    ).length,
  ).toBeGreaterThan(0);
  const fields = drawer.querySelector("dl") as HTMLElement;
  expect(fields.textContent).toContain("whoami、get_card");
  expect(fields.textContent).toContain("只读");
  expect(fields.textContent).toContain("gpu");
  expect(fields.textContent).toContain("produce");
  expect(fields.textContent).toContain("pi / fixture");
  const diff = screen.getByRole("region", { name: "与上一版本的差异" });
  expect(diff.textContent).toContain("v1 → v2");
  expect(diff.textContent).toContain("+ 也写发布说明。");
  expect(diff.textContent).toContain("新增 release");
  const historyList = await screen.findByRole("table", { name: "版本历史" });
  expect(historyList.textContent).toContain(
    "编辑：改动 instructions、abilities",
  );
  expect(historyList.textContent).toContain("所有者");
  expect(within(historyList).getAllByRole("button")).toHaveLength(1);
});

test("deactivate, activate and rollback call the server with stable keys per input", async () => {
  const setRoleActive = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue({ ...v2, version: 3, status: "inactive" });
  const rollbackRole = vi.fn().mockResolvedValue({ ...v1, version: 3 });
  await openRoles(client({ setRoleActive, rollbackRole }));
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  fireEvent.click(await screen.findByRole("button", { name: "停用" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(setRoleActive).toHaveBeenCalledTimes(2));
  expect(setRoleActive.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "writer",
    false,
  ]);
  expect(setRoleActive.mock.calls[1]?.[3]).toBe(
    setRoleActive.mock.calls[0]?.[3],
  );
  expect(await screen.findByText("角色已停用，不能再被新指派")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "回退到 v1" }));
  await waitFor(() =>
    expect(rollbackRole).toHaveBeenCalledWith(
      "p-1",
      "writer",
      1,
      expect.any(String),
    ),
  );
  expect(await screen.findByText(/已回退到 v1 的内容/)).toBeTruthy();
});

test("edit offers only allowlisted tools, explains widened permissions without a confirm dialog, and shows the server's Chinese error", async () => {
  const confirm = vi.spyOn(window, "confirm");
  const updateRole = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(
        400,
        "validation_failed",
        "produce 角色含有白名单之外的工具",
      ),
    )
    .mockResolvedValue({ ...v2, version: 3 });
  await openRoles(client({ updateRole }));
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const tools = screen.getByRole("group", { name: /可用工具/ });
  const boxes = within(tools)
    .getAllByRole("checkbox")
    .map((box) => box.parentElement?.textContent);
  expect(boxes).toEqual(allowlists.produce);
  expect(screen.queryByRole("note")).toBeNull();
  fireEvent.click(
    within(tools).getByRole("checkbox", { name: "submit_delivery" }),
  );
  changeControl(screen.getByLabelText(/worktree 模式/), {
    target: { value: "write" },
  });
  changeControl(screen.getByLabelText(/机器标签/), {
    target: { value: "" },
  });
  const note = screen.getByRole("note", { name: "这次改动放宽的权限" });
  expect(note.textContent).toContain("新增可用工具：submit_delivery");
  expect(note.textContent).toContain("“只读”放宽到“可写”");
  expect(note.textContent).toContain("移除机器标签限制：gpu");
  fireEvent.click(screen.getByRole("button", { name: "保存为新版本" }));
  expect(
    await screen.findByText(/produce 角色含有白名单之外的工具/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存为新版本" }));
  await waitFor(() => expect(updateRole).toHaveBeenCalledTimes(2));
  expect(updateRole.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "writer",
    {
      allowed_tools: ["whoami", "get_card", "submit_delivery"],
      worktree: "write",
      required_machine_tags: [],
    },
  ]);
  expect(updateRole.mock.calls[1]?.[3]).toBe(updateRole.mock.calls[0]?.[3]);
  expect(await screen.findByText("角色已保存，生成了新版本")).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
});

test("changing kind narrows the tool list and flags tools outside the new allowlist", async () => {
  await openRoles(
    client({
      role: async () => ({
        ...detail,
        role: { ...v2, allowed_tools: ["whoami", "submit_delivery"] },
      }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  changeControl(screen.getByLabelText("类型"), {
    target: { value: "verify" },
  });
  const tools = screen.getByRole("group", { name: /验证型角色的系统白名单/ });
  expect(
    within(tools).getByRole("checkbox", { name: "submit_review" }),
  ).toBeTruthy();
  expect(
    within(tools)
      .getByRole("checkbox", { name: "submit_delivery" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByText(/submit_delivery 不在验证型角色的工具白名单内/),
  ).toBeTruthy();
  expect(screen.getByRole("note").textContent).toContain(
    "角色类型从“产出”改为“验证”",
  );
});

test("legacy roles prefill converted instructions and warn about the new format", async () => {
  await openRoles(
    client({
      role: async () => ({
        ...detail,
        role: { ...v2, instructions: undefined, core_prompt: "旧提示词" },
        legacy_conversion: {
          instructions: "旧提示词",
          warnings: ["无法按默认角色包结构拆出角色说明"],
        },
      }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  expect(
    await screen.findByRole("button", { name: "旧格式角色说明" }),
  ).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("旧提示词");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(screen.getByText(/保存后将转换为新格式/)).toBeTruthy();
  expect(screen.getByText("无法按默认角色包结构拆出角色说明")).toBeTruthy();
  expect(
    (screen.getByLabelText("角色说明（instructions）") as HTMLTextAreaElement)
      .value,
  ).toBe("旧提示词");
  expect(
    (screen.getByRole("button", { name: "保存为新版本" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test("a newly created role leads directly to employee creation with that role selected", async () => {
  await openRoles(
    client({
      copyRole: async () => ({ ...v1, role_id: "designer-x" }),
      employeeOptions: async () => ({
        library: [],
        roles: [{ role_id: "designer-x", display_name: "设计" }],
      }),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "designer-x" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "为这个角色新建员工" }),
  );
  expect((await screen.findByLabelText("角色")).textContent).toContain(
    "designer-x",
  );
});

test("new role copies from the default pack or from an existing role in another project", async () => {
  const copyRole = vi.fn().mockResolvedValue({ ...v1, role_id: "designer-x" });
  await openRoles(
    client({
      copyRole,
      projects: async () => [
        { id: "p-1", name: "P1" } as never,
        { id: "p-2", name: "P2" } as never,
      ],
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("默认角色"), {
    target: { value: "designer" },
  });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "Bad Id" },
  });
  expect(screen.getByText(/角色编号只能用小写字母/)).toBeTruthy();
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "designer-x" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  await waitFor(() => expect(copyRole).toHaveBeenCalledTimes(1));
  expect(copyRole.mock.calls[0]?.slice(0, 2)).toEqual([
    "p-1",
    {
      role_id: "designer-x",
      source: {
        kind: "default",
        role_id: "designer",
        harness: "pi",
        launch_profile_ref: "fixture",
      },
    },
  ]);
  expect(await screen.findByText("已创建角色 designer-x v1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const second = screen.getByRole("form", { name: "新建角色" });
  const fromProject = within(second).getByRole("button", {
    name: "从现有角色复制",
  });
  fireEvent.click(fromProject);
  expect(fromProject.getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(within(second).getByLabelText("来源项目"), {
    key: "ArrowDown",
  });
  await screen.findByRole("option", { name: "p-2" });
  fireEvent.keyDown(document, { key: "Escape" });
  changeControl(within(second).getByLabelText("来源项目"), {
    target: { value: "p-2" },
  });
  fireEvent.keyDown(within(second).getByLabelText("来源角色"), {
    key: "ArrowDown",
  });
  await screen.findByRole("option", { name: /写手（writer v2）/ });
  fireEvent.keyDown(document, { key: "Escape" });
  changeControl(within(second).getByLabelText("来源角色"), {
    target: { value: "writer" },
  });
  changeControl(within(second).getByLabelText(/来源版本/), {
    target: { value: "1" },
  });
  changeControl(within(second).getByLabelText("新角色编号"), {
    target: { value: "writer-2" },
  });
  changeControl(within(second).getByLabelText("显示名（可选）"), {
    target: { value: "写手二号" },
  });
  fireEvent.click(within(second).getByRole("button", { name: "创建角色" }));
  await waitFor(() => expect(copyRole).toHaveBeenCalledTimes(2));
  expect(copyRole.mock.calls[1]?.[1]).toEqual({
    role_id: "writer-2",
    display_name: "写手二号",
    source: {
      kind: "project",
      project_id: "p-2",
      role_id: "writer",
      version: 1,
    },
  });
});

test("role diff helpers: line diff and relaxation list", () => {
  expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
    { op: "same", text: "a" },
    { op: "remove", text: "b" },
    { op: "same", text: "c" },
    { op: "add", text: "d" },
  ]);
  expect(
    roleRelaxations(v1, {
      display_name: "写手",
      kind: "produce",
      harness: "pi",
      launch_profile_ref: "fixture",
      allowed_tools: ["whoami"],
      capabilities: ["produce", "verify"],
      abilities: [],
      worktree: "none",
      required_machine_tags: ["gpu"],
    }),
  ).toEqual(["新增可承担的工作项种类：verify"]);
});

test("HTTP role client uses encoded role routes and the idempotency header", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("{}", { status: 200 }));
  const http = new HttpCardiganClient(fetcher);
  await http.roles("a/b");
  await http.role("p", "r.1");
  await http.roleHistory("p", "r.1");
  await http.copyRole(
    "p",
    { role_id: "x", source: { kind: "project", role_id: "r" } },
    "k1",
  );
  await http.updateRole("p", "r", { abilities: [] }, "k2");
  await http.setRoleActive("p", "r", false, "k3");
  await http.setRoleActive("p", "r", true, "k4");
  await http.rollbackRole("p", "r", 2, "k5");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/projects/a%2Fb/roles",
    "/api/projects/p/roles/r.1",
    "/api/projects/p/roles/r.1/history",
    "/api/projects/p/roles/copy",
    "/api/projects/p/roles/r/update",
    "/api/projects/p/roles/r/deactivate",
    "/api/projects/p/roles/r/activate",
    "/api/projects/p/roles/r/rollback",
  ]);
  const last = fetcher.mock.calls.at(-1)?.[1];
  expect(new Headers(last?.headers).get("Idempotency-Key")).toBe("k5");
  expect(last?.body).toBe('{"version":2}');
});

test("a role being created keeps its drawer: close, Escape and the overlay wait for the reply", async () => {
  const reply = Promise.withResolvers<RoleDefinitionView>();
  const copyRole = vi.fn(() => reply.promise);
  await openRoles(client({ copyRole }));
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "tester-x" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  await waitFor(() => expect(copyRole).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("form", { name: "新建角色" })).toBeTruthy();
  expect(
    (within(form).getByRole("button", { name: "取消" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  reply.resolve({ ...v1, role_id: "tester-x" });
  expect(await screen.findByText("已创建角色 tester-x v1")).toBeTruthy();
});

test("a role status change in flight keeps the detail drawer open", async () => {
  const reply = Promise.withResolvers<RoleDefinitionView>();
  await openRoles(client({ setRoleActive: vi.fn(() => reply.promise) }));
  fireEvent.click(await screen.findByRole("button", { name: "写手" }));
  fireEvent.click(await screen.findByRole("button", { name: "停用" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  reply.resolve({ ...v2, version: 3, status: "inactive" });
  expect(await screen.findByText("角色已停用，不能再被新指派")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("closing a role drawer returns focus to the row that opened it", async () => {
  await openRoles();
  const row = await screen.findByRole("button", { name: "写手" });
  row.focus();
  fireEvent.click(row);
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "写手" }),
    ),
  );
});

test("closing the new-role drawer with Escape returns focus to 新建角色", async () => {
  await openRoles();
  const opener = await screen.findByRole("button", { name: "新建角色" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
