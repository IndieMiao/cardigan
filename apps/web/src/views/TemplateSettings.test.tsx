// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ApiError,
  HttpCardiganClient,
  type TemplateChange,
  type TemplateDefinition,
  type TemplateVersion,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";

const general: TemplateVersion = {
  id: "general",
  title: "通用任务",
  description: "由人记录结果",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
  work_items: [],
  version: 1,
  builtin: true,
  status: "active",
  summary: "通用任务 · 0 个工作项",
  created_at: null,
};
const dev: TemplateVersion = {
  ...general,
  id: "dev",
  title: "开发卡",
  requires_repo: true,
  merge: "confirm",
  require_acceptance_criteria: true,
  completion: { mode: "review", reviewer: "role:pm" },
  primary_work_item_key: "code",
  work_items: [
    {
      key: "code",
      title: "开发",
      kind: "produce",
      role_id: "coder",
      required: true,
    },
    {
      key: "review",
      title: "代码审核",
      kind: "verify",
      role_id: "reviewer",
      required: true,
      target_work_item_key: "code",
    },
  ],
};
const custom: TemplateVersion = {
  ...general,
  id: "custom",
  title: "项目任务",
  builtin: false,
  created_at: "2026-11-10T00:00:00.000Z",
};
const api = (
  versions: TemplateVersion[] = [
    general,
    dev,
    { ...general, id: "artifact", title: "产出物" },
  ],
) =>
  fakeClient({
    templates: async () => ({ templates: versions }),
    template: async (_p, id) => ({
      template: versions.find((t) => t.id === id) ?? custom,
      previous: null,
    }),
    templateHistory: async (_p, id) => ({
      versions: [versions.find((t) => t.id === id) ?? custom],
    }),
    manageTemplate: async () => custom,
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function open(client = api()) {
  render(<SettingsPage client={client} projectId="p-1" />);
  fireEvent.click(screen.getByRole("button", { name: "卡片模板" }));
  await screen.findByRole("table");
}

test("settings lists all promised fields, builtin details are readonly with only copy", async () => {
  await open();
  for (const title of [
    "编号",
    "标题",
    "来源",
    "仓库要求",
    "合并方式",
    "完成方式",
    "版本",
    "状态",
  ])
    expect(screen.getByRole("columnheader", { name: title })).toBeTruthy();
  expect(screen.getAllByText("内置，只读")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "dev", exact: true }));
  await screen.findByRole("button", { name: "复制为项目模板" });
  expect(screen.getByText("验证目标：code", { exact: false })).toBeTruthy();
  expect(screen.getByText("角色：coder", { exact: false })).toBeTruthy();
  expect(screen.getByText("主产出 key")).toBeTruthy();
  expect(screen.getByText("首个版本，无上一版本。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "编辑模板" })).toBeNull();
  expect(screen.queryByRole("button", { name: "停用模板" })).toBeNull();
  expect(screen.queryByRole("button", { name: /回退到/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "创建卡片" })).toBeNull();
});

test("copy retries the exact request with the same key, then offers editing on the saved project template", async () => {
  const manageTemplate = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(custom);
  const client = { ...api(), manageTemplate };
  await open(client);
  fireEvent.click(screen.getByRole("button", { name: "general", exact: true }));
  fireEvent.click(
    await screen.findByRole("button", { name: "复制为项目模板" }),
  );
  changeControl(screen.getByLabelText("模板编号"), {
    target: { value: "custom" },
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: /^(确认复制|保存模板)$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认复制" }));
  await screen.findByText(/操作可能已经成功/);
  fireEvent.click(screen.getByRole("button", { name: "确认复制" }));
  await screen.findByRole("button", { name: "编辑模板" });
  expect(manageTemplate).toHaveBeenCalledTimes(2);
  expect(manageTemplate.mock.calls[0]?.[1]).toEqual({
    action: "copy",
    template_id: "general",
    new_id: "custom",
    version: 1,
  });
  expect(manageTemplate.mock.calls[1]?.[2]).toBe(
    manageTemplate.mock.calls[0]?.[2],
  );
});

test("create and edit forms validate current drafts, display server reasons and preserve failed edits", async () => {
  const validateTemplate = vi.fn(
    async (_p: string, change: TemplateChange) => ({
      valid: "definition" in change && !!change.definition.title,
      reason:
        "definition" in change && change.definition.title
          ? null
          : "模板标题不能为空",
    }),
  );
  const manageTemplate = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(400, "validation_failed", "角色 coder 未登记或已停用"),
    )
    .mockResolvedValue(custom);
  await open({ ...api([custom]), validateTemplate, manageTemplate });
  fireEvent.click(screen.getByRole("button", { name: "新建模板" }));
  await screen.findByText("模板标题不能为空");
  expect(
    (screen.getByRole("button", { name: "保存模板" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  changeControl(screen.getByLabelText("模板编号"), {
    target: { value: "custom" },
  });
  changeControl(screen.getByLabelText("模板标题"), {
    target: { value: "新项目任务" },
  });
  fireEvent.click(screen.getByLabelText("需要仓库"));
  changeControl(screen.getByLabelText("合并方式"), {
    target: { value: "confirm" },
  });
  fireEvent.click(screen.getByLabelText("要求验收标准"));
  fireEvent.click(screen.getByRole("button", { name: "添加工作项" }));
  changeControl(screen.getByLabelText("工作项 key"), {
    target: { value: "code" },
  });
  changeControl(screen.getByLabelText("工作项标题"), {
    target: { value: "开发" },
  });
  changeControl(screen.getByLabelText("角色编号"), {
    target: { value: "coder" },
  });
  changeControl(screen.getByLabelText("主产出 key"), {
    target: { value: "code" },
  });
  changeControl(screen.getByLabelText("完成方式"), {
    target: { value: "review" },
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: /^(确认复制|保存模板)$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await screen.findByText(/角色 coder 未登记或已停用/);
  expect((screen.getByLabelText("模板标题") as HTMLInputElement).value).toBe(
    "新项目任务",
  );
  const change = manageTemplate.mock.calls[0]?.[1];
  expect(change).toMatchObject({
    action: "add",
    definition: {
      requires_repo: true,
      merge: "confirm",
      require_acceptance_criteria: true,
      primary_work_item_key: "code",
      work_items: [{ key: "code", role_id: "coder", required: true }],
      completion: { mode: "review", reviewer: "human" },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑模板" }));
  expect((screen.getByLabelText("模板编号") as HTMLInputElement).disabled).toBe(
    true,
  );
  changeControl(screen.getByLabelText("模板标题"), {
    target: { value: "编辑标题" },
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: /^(确认复制|保存模板)$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await waitFor(() => expect(manageTemplate).toHaveBeenCalledTimes(3));
  expect(manageTemplate.mock.calls[2]?.[1]).toMatchObject({
    action: "update",
    definition: { title: "编辑标题" },
  });
});

test("history shows field differences, toggles status and rolls back the selected version", async () => {
  let current = { ...custom, title: "第二版", version: 2 };
  const manageTemplate = vi.fn(async (_p: string, change: TemplateChange) => {
    current = {
      ...current,
      version: current.version + 1,
      status: change.action === "deactivate" ? "inactive" : "active",
    };
    return current;
  });
  const client = {
    ...api([current]),
    template: async () => ({ template: current, previous: custom }),
    templateHistory: async () => ({ versions: [current, custom] }),
    manageTemplate,
  };
  await open(client);
  fireEvent.click(screen.getByRole("button", { name: "custom", exact: true }));
  await screen.findByText("之前");
  expect(screen.getByText("现在")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "停用模板" }));
  fireEvent.click(await screen.findByRole("button", { name: "启用模板" }));
  await screen.findByRole("button", { name: "停用模板" });
  changeControl(screen.getByLabelText("查看版本"), {
    target: { value: "1" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "回退到 v1（生成新版本）" }),
  );
  await waitFor(() => expect(manageTemplate).toHaveBeenCalledTimes(3));
  expect(manageTemplate.mock.calls.map((c) => c[1])).toEqual([
    { action: "deactivate", template_id: "custom" },
    { action: "activate", template_id: "custom" },
    { action: "rollback", template_id: "custom", version: 1 },
  ]);
});

test("late validation responses cannot enable a newer invalid draft; live refresh preserves editing", async () => {
  let resolveOld:
    | ((value: { valid: boolean; reason: null }) => void)
    | undefined;
  const validateTemplate = vi.fn((_p: string, change: TemplateChange) => {
    const id = "definition" in change ? change.definition.id : "";
    if (id === "older")
      return new Promise<{ valid: boolean; reason: null }>((resolve) => {
        resolveOld = resolve;
      });
    return Promise.resolve({
      valid: false,
      reason: "模板编号只能含小写字母、数字和短横线",
    });
  });
  const client = { ...api(), validateTemplate };
  const view = render(<SettingsPage client={client} projectId="p-1" />);
  fireEvent.click(screen.getByRole("button", { name: "卡片模板" }));
  fireEvent.click(await screen.findByRole("button", { name: "新建模板" }));
  changeControl(screen.getByLabelText("模板编号"), {
    target: { value: "older" },
  });
  await waitFor(() => expect(resolveOld).toBeDefined());
  changeControl(screen.getByLabelText("模板编号"), {
    target: { value: "INVALID" },
  });
  await screen.findByText("模板编号只能含小写字母、数字和短横线");
  await act(async () => resolveOld?.({ valid: true, reason: null }));
  view.rerender(<SettingsPage client={client} projectId="p-1" revision={1} />);
  expect((screen.getByLabelText("模板编号") as HTMLInputElement).value).toBe(
    "INVALID",
  );
  expect(
    (screen.getByRole("button", { name: "保存模板" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("HTTP template and mark-done calls encode IDs and send operation-specific idempotency keys", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("{}"));
  const client = new HttpCardiganClient(fetcher);
  await client.templates("a/b");
  await client.template("a/b", "x/y");
  await client.templateHistory("a/b", "x/y");
  const {
    builtin: _b,
    status: _s,
    version: _v,
    summary: _summary,
    created_at: _created,
    ...def
  } = general;
  const change = {
    action: "add",
    definition: def as TemplateDefinition,
  } as const;
  await client.validateTemplate("a/b", change);
  await client.manageTemplate("a/b", change, "template-key");
  await client.markCardDone("a/b", "C-1", "已确认", ["F-1"], "done-key");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/projects/a%2Fb/card-templates",
    "/api/projects/a%2Fb/card-templates/x%2Fy",
    "/api/projects/a%2Fb/card-templates/x%2Fy/history",
    "/api/projects/a%2Fb/card-templates/validate",
    "/api/projects/a%2Fb/card-templates",
    "/api/projects/a%2Fb/cards/C-1/mark-done",
  ]);
  expect(
    new Headers(fetcher.mock.calls[4]?.[1]?.headers).get("Idempotency-Key"),
  ).toBe("template-key");
  expect(
    new Headers(fetcher.mock.calls[5]?.[1]?.headers).get("Idempotency-Key"),
  ).toBe("done-key");
  expect(JSON.parse(fetcher.mock.calls[5]?.[1]?.body as string)).toEqual({
    result: "已确认",
    attachments: ["F-1"],
  });
});

test("manual validation retry immediately replaces the error with shared progress", async () => {
  const request = Promise.withResolvers<{ valid: boolean; reason: null }>();
  const validateTemplate = vi
    .fn()
    .mockRejectedValueOnce(new Error("校验失败"))
    .mockImplementation(() => request.promise);
  await open({ ...api([general]), validateTemplate });
  fireEvent.click(screen.getByRole("button", { name: "新建模板" }));
  const retry = await screen.findByRole("button", { name: "重新校验" });
  fireEvent.click(retry);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByText("正在校验…").closest(".request-feedback-region"),
  ).not.toBeNull();
  await waitFor(() => expect(validateTemplate).toHaveBeenCalledTimes(2));
  await act(async () => request.resolve({ valid: true, reason: null }));
  expect(screen.queryByText("正在校验…")).toBeNull();
});
