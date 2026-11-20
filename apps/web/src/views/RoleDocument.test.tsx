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
  type RoleDocumentPreview,
  type RoleListView,
  type TemplateVersion,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { withTemplate } from "./RoleDocument.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(cleanup);
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
  produce: ["whoami", "get_card", "submit_delivery"],
  verify: ["whoami", "get_card", "submit_review"],
  standing: ["whoami", "get_card"],
};
const proofreader: RoleDefinitionView = {
  role_id: "proofreader",
  version: 1,
  display_name: "校对员",
  kind: "produce",
  status: "active",
  instructions: "逐条列出需修改的地方。",
  core_prompt: "",
  harness: "codex",
  launch_profile_ref: "codex-agent",
  allowed_tools: ["whoami", "get_card", "submit_delivery"],
  capabilities: ["produce"],
  abilities: [],
  worktree: "readonly",
  required_machine_tags: [],
};
const list: RoleListView = {
  project_id: "p-1",
  roles: [
    {
      role_id: "proofreader",
      display_name: "校对员",
      kind: "produce",
      status: "active",
      version: 1,
      harness: "codex",
      launch_profile_ref: "codex-agent",
    },
  ],
  default_roles: ["coder", "reviewer"],
  harnesses: ["claude-code", "codex", "pi"],
  allowlists,
  launch_profiles: [
    { name: "codex-agent", harness: "codex", model: "gpt-fixture" },
    { name: "claude-agent", harness: "claude-code", model: null },
  ],
};
const docTemplate: TemplateVersion = {
  id: "doc",
  title: "文档卡",
  description: "",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [
    {
      key: "writing",
      title: "写作",
      kind: "produce",
      role_id: "writer",
      required: true,
    },
  ],
  primary_work_item_key: "writing",
  completion: { mode: "human_mark_done" },
  version: 2,
  builtin: false,
  status: "active",
  summary: "",
  created_at: null,
};
const markdown = `---
role_id: proofreader
display_name: 校对员
based_on: reviewer
launch_profile: codex-agent
template: {id: proofread, from: dev, replace_role: reviewer}
employees:
  - {name: 小林, title: 校对员}
---
逐条列出需修改的地方。
`;
const created: RoleDocumentPreview = {
  snapshot: "a".repeat(64),
  role: {
    action: "create",
    role: proofreader,
    fields: [],
    relaxations: ["新增可用工具：submit_delivery"],
  },
  template: {
    action: "create",
    before: null,
    after: {
      ...docTemplate,
      id: "proofread",
      title: "校对卡",
      work_items: [
        {
          key: "writing",
          title: "写作",
          kind: "produce",
          role_id: "proofreader",
          required: true,
        },
      ],
    },
  },
  employees: [
    {
      name: "小林",
      title: "校对员",
      role_id: "proofreader",
      launch_profile_ref: null,
      action: "create",
      id: "preview-0",
    },
  ],
};

function client(overrides: Parameters<typeof fakeClient>[0] = {}) {
  return fakeClient({
    roles: async () => list,
    role: async () => ({
      project_id: "p-1",
      role: { ...proofreader, kind: "produce", status: "active" },
      previous: null,
      allowlist: allowlists.produce,
      allowlists,
      harnesses: list.harnesses,
      legacy_conversion: null,
    }),
    templates: async () => ({ templates: [docTemplate] }),
    launchProfileNames: async () => ["codex-agent", "claude-agent"],
    ...overrides,
  });
}

async function openRoles(c = client()) {
  render(<SettingsPage projectId="p-1" client={c} />);
  fireEvent.click(await screen.findByRole("button", { name: "角色" }));
  await waitFor(() => expect(document.activeElement?.id).toBe("roles"));
  return c;
}

async function openImport() {
  fireEvent.click(
    await screen.findByRole("button", { name: "从 Markdown 导入" }),
  );
  return screen.getByRole("dialog", { name: "从 Markdown 导入" });
}

test("import previews the role, template and people, then applies them once with the preview's snapshot", async () => {
  const previewRoleDocument = vi.fn(async () => created);
  const applyRoleDocument = vi.fn(async () => ({
    ...created,
    employees: [{ ...created.employees[0], id: "E-7" }],
  })) as never;
  const roles = vi.fn(async () => list);
  await openRoles(client({ previewRoleDocument, applyRoleDocument, roles }));
  const drawer = await openImport();
  expect(
    (within(drawer).getByRole("button", { name: "预览" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(within(drawer).getByLabelText("Markdown"), {
    target: { value: markdown },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  await within(drawer).findByRole("button", { name: "应用" });
  expect(previewRoleDocument).toHaveBeenCalledWith("p-1", markdown);
  expect(within(drawer).getByText(/校对员（/).textContent).toContain("新建");
  expect(
    within(drawer).getByRole("note", { name: "放宽的权限" }).textContent,
  ).toContain("新增可用工具：submit_delivery");
  expect(
    within(drawer).getByRole("table", { name: "模板工作项" }).textContent,
  ).toContain("新增");
  expect(
    within(drawer).getByRole("table", { name: "员工" }).textContent,
  ).toContain("小林");
  const before = roles.mock.calls.length;
  fireEvent.click(within(drawer).getByRole("button", { name: "应用" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "从 Markdown 导入" }),
    ).toBeNull(),
  );
  const apply = applyRoleDocument as unknown as ReturnType<typeof vi.fn>;
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    markdown,
    created.snapshot,
  ]);
  expect(
    await screen.findByText(
      "已应用：新建角色 proofreader，新建模板 proofread，新建员工 小林（E-7）",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(roles.mock.calls.length).toBeGreaterThan(before));
});

test("a validation error stays at the Markdown field, nothing is applied, and an edit hides the old preview", async () => {
  const previewRoleDocument = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(
        400,
        "validation_failed",
        "启动配置 nope 不存在于 launch.yaml",
      ),
    )
    .mockResolvedValue(created);
  const applyRoleDocument = vi.fn();
  await openRoles(client({ previewRoleDocument, applyRoleDocument }));
  const drawer = await openImport();
  const field = within(drawer).getByLabelText("Markdown");
  fireEvent.change(field, { target: { value: markdown } });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  const alert = await within(drawer).findByRole("alert");
  expect(alert.textContent).toContain("启动配置 nope 不存在于 launch.yaml");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  expect(within(drawer).queryByRole("button", { name: "应用" })).toBeNull();
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  await within(drawer).findByRole("button", { name: "应用" });
  fireEvent.change(field, { target: { value: `${markdown}补充。\n` } });
  expect(within(drawer).queryByRole("button", { name: "应用" })).toBeNull();
  expect(within(drawer).queryByRole("table", { name: "员工" })).toBeNull();
  expect(applyRoleDocument).not.toHaveBeenCalled();
});

test("a stale snapshot drops the preview; the next preview applies with a new key, and a lost reply retries with the same key", async () => {
  const previewRoleDocument = vi
    .fn()
    .mockResolvedValueOnce(created)
    .mockResolvedValue({ ...created, snapshot: "b".repeat(64) });
  const applyRoleDocument = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, "stale_target", "文件或相关配置已变化，请重新预览"),
    )
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue(created);
  await openRoles(client({ previewRoleDocument, applyRoleDocument }));
  const drawer = await openImport();
  fireEvent.change(within(drawer).getByLabelText("Markdown"), {
    target: { value: markdown },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  fireEvent.click(await within(drawer).findByRole("button", { name: "应用" }));
  expect((await within(drawer).findByRole("alert")).textContent).toContain(
    "请重新预览",
  );
  expect(within(drawer).queryByRole("button", { name: "应用" })).toBeNull();
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  fireEvent.click(await within(drawer).findByRole("button", { name: "应用" }));
  await waitFor(() => expect(applyRoleDocument).toHaveBeenCalledTimes(2));
  fireEvent.click(await within(drawer).findByRole("button", { name: "应用" }));
  await waitFor(() => expect(applyRoleDocument).toHaveBeenCalledTimes(3));
  const [first, second, third] = applyRoleDocument.mock.calls;
  expect(first?.[2]).toBe("a".repeat(64));
  expect(second?.[2]).toBe("b".repeat(64));
  expect(second?.[3]).not.toBe(first?.[3]);
  expect(third?.[3]).toBe(second?.[3]);
});

test("re-importing an exported role previews no change and cannot be applied", async () => {
  await openRoles(
    client({
      previewRoleDocument: async () => ({
        ...created,
        role: { ...created.role, action: "unchanged", relaxations: [] },
        template: null,
        employees: [],
      }),
    }),
  );
  const drawer = await openImport();
  fireEvent.change(within(drawer).getByLabelText("Markdown"), {
    target: { value: markdown },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  expect(await within(drawer).findByText("没有变化")).toBeTruthy();
  expect(
    (within(drawer).getByRole("button", { name: "应用" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("closing with unapplied text asks first; keeping returns to the draft, discarding closes", async () => {
  await openRoles();
  const drawer = await openImport();
  // Nothing typed: closes at once.
  fireEvent.click(within(drawer).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const again = await openImport();
  fireEvent.change(within(again).getByLabelText("Markdown"), {
    target: { value: markdown },
  });
  fireEvent.click(within(again).getByRole("button", { name: "关闭抽屉" }));
  const ask = await screen.findByRole("dialog", {
    name: "放弃未应用的修改？",
  });
  fireEvent.click(within(ask).getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未应用的修改？" }),
    ).toBeNull(),
  );
  expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe(
    markdown,
  );
  fireEvent.keyDown(screen.getByLabelText("Markdown"), { key: "Escape" });
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
    ).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a role exports as a Markdown download", async () => {
  const exportRole = vi.fn(async () => ({ markdown }));
  const created: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      created.push(blob);
      return "blob:role";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("proofreader.md");
    });
  await openRoles(client({ exportRole }));
  fireEvent.click(await screen.findByRole("button", { name: "校对员" }));
  fireEvent.click(await screen.findByRole("button", { name: "导出 Markdown" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(exportRole).toHaveBeenCalledWith("p-1", "proofreader");
  expect(await created[0]?.text()).toBe(markdown);
  click.mockRestore();
  vi.unstubAllGlobals();
});

test("a new role goes straight into a template: append a work item through the same preview and apply", async () => {
  const exported = `---\nrole_id: proofreader\nkind: produce\n---\n逐条列出需修改的地方。\n`;
  const previewRoleDocument = vi.fn(async () => ({
    ...created,
    role: { ...created.role, action: "unchanged" as const, relaxations: [] },
    employees: [],
    template: {
      action: "update" as const,
      before: docTemplate,
      after: {
        ...docTemplate,
        version: 3,
        work_items: [
          ...docTemplate.work_items,
          {
            key: "proofreading",
            title: "校对",
            kind: "produce" as const,
            role_id: "proofreader",
            required: true,
          },
        ],
      },
    },
  }));
  const applyRoleDocument = vi.fn(async () => ({
    ...created,
    role: { ...created.role, action: "unchanged" as const },
    employees: [],
    template: created.template && {
      ...created.template,
      action: "update" as const,
      after: { ...created.template.after, id: "doc" },
    },
  }));
  const copyRole = vi.fn(async () => proofreader);
  await openRoles(
    client({
      copyRole,
      exportRole: async () => ({ markdown: exported }),
      previewRoleDocument,
      applyRoleDocument,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "proofreader" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  fireEvent.click(await screen.findByRole("button", { name: "加进模板" }));
  const drawer = await screen.findByRole("dialog", { name: "加进模板" });
  await waitFor(() =>
    expect(within(drawer).getByLabelText("模板").textContent).toContain(
      "请选择项目模板",
    ),
  );
  changeControl(within(drawer).getByLabelText("模板"), {
    target: { value: "doc" },
  });
  fireEvent.change(within(drawer).getByLabelText("工作项编号"), {
    target: { value: "proofreading" },
  });
  fireEvent.change(within(drawer).getByLabelText("工作项标题"), {
    target: { value: "校对" },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  await within(drawer).findByRole("button", { name: "应用" });
  const sent = previewRoleDocument.mock.calls[0]?.[1] as string;
  expect(sent).toBe(
    withTemplate(exported, {
      id: "doc",
      add_work_item: {
        key: "proofreading",
        title: "校对",
        required: true,
        kind: "produce",
      },
    }),
  );
  expect(sent).toContain(
    'template: {"id":"doc","add_work_item":{"key":"proofreading"',
  );
  fireEvent.click(within(drawer).getByRole("button", { name: "应用" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "加进模板" })).toBeNull(),
  );
  expect(applyRoleDocument.mock.calls[0]?.[1]).toBe(sent);
  // Back on the role's detail with the result.
  expect(
    await screen.findByText("已应用：角色 proofreader 不变，修改模板 doc"),
  ).toBeTruthy();
});

test("copying a template with a role replaced builds the replace_role section", () => {
  expect(
    withTemplate("---\nrole_id: x\n---\nbody\n---\nnot a header\n", {
      id: "dev-x",
      from: "dev",
      replace_role: "reviewer",
    }),
  ).toBe(
    '---\nrole_id: x\ntemplate: {"id":"dev-x","from":"dev","replace_role":"reviewer"}\n---\nbody\n---\nnot a header\n',
  );
});

test("launch profiles are a list of the host's profiles; choosing one also sets its harness", async () => {
  const copyRole = vi.fn(async () => proofreader);
  await openRoles(client({ copyRole }));
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  const select = within(form).getByLabelText("启动配置");
  fireEvent.keyDown(select, { key: "ArrowDown" });
  const options = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  expect(options).toEqual([
    "请选择启动配置",
    "codex-agent（codex · gpt-fixture）",
    "claude-agent（claude-code · 默认模型）",
  ]);
  fireEvent.keyDown(document, { key: "Escape" });
  changeControl(select, { target: { value: "claude-agent" } });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "proofreader" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  await waitFor(() => expect(copyRole).toHaveBeenCalledOnce());
  expect((copyRole.mock.calls[0] as unknown[])[1]).toMatchObject({
    source: { harness: "claude-code", launch_profile_ref: "claude-agent" },
  });
});

test("the role description editor switches between editing and a rendered preview", async () => {
  await openRoles();
  fireEvent.click(await screen.findByRole("button", { name: "校对员" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const text = screen.getByLabelText("角色说明（instructions）");
  fireEvent.change(text, { target: { value: "# 标题\n\n- 第一条" } });
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  const preview = screen.getByRole("region", {
    name: "角色说明（instructions）预览",
  });
  expect(preview.querySelector("h1")?.textContent).toBe("标题");
  expect(preview.querySelector("li")?.textContent).toBe("第一条");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(
    (screen.getByLabelText("角色说明（instructions）") as HTMLTextAreaElement)
      .value,
  ).toBe("# 标题\n\n- 第一条");
  // The unsaved edit asks before the drawer closes.
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  expect(
    await screen.findByRole("dialog", { name: "放弃未应用的修改？" }),
  ).toBeTruthy();
});

test("HTTP client posts previews, keyed applies and reads exports on the project routes", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(created), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const http = new HttpCardiganClient(fetchImpl as never);
  await http.previewRoleDocument("p 1", markdown);
  await http.applyRoleDocument("p 1", markdown, "s", "key-1");
  await http.exportRole("p 1", "proofreader");
  await http.updateEmployee("p 1", "E-1", { role_id: "coder" }, "key-2");
  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([path, init]) => [path, init.method])).toEqual([
    ["/api/projects/p%201/role-document/preview", "POST"],
    ["/api/projects/p%201/role-document/apply", "POST"],
    ["/api/projects/p%201/roles/proofreader/export", "GET"],
    ["/api/projects/p%201/employees/E-1/update", "POST"],
  ]);
  expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({
    markdown,
    snapshot: "s",
  });
  expect(
    (calls[1]?.[1].headers as Record<string, string> | undefined)?.[
      "Idempotency-Key"
    ],
  ).toBe("key-1");
  expect(
    (calls[0]?.[1].headers as Record<string, string> | undefined)?.[
      "Idempotency-Key"
    ],
  ).toBeUndefined();
});

test("the preview lists every field the server reports and every template work item change, removed ones included", async () => {
  await openRoles(
    client({
      previewRoleDocument: async () => ({
        ...created,
        role: {
          action: "update",
          role: { ...proofreader, version: 2 },
          fields: [
            {
              field: "required_capabilities",
              before: null,
              after: ["browser.chromium"],
            },
          ],
          relaxations: [],
        },
        template: {
          action: "update",
          before: {
            ...docTemplate,
            work_items: [
              ...docTemplate.work_items,
              {
                key: "review",
                title: "审核",
                kind: "verify",
                role_id: "reviewer",
                required: true,
                target_work_item_key: "writing",
              },
            ],
          },
          after: {
            ...docTemplate,
            title: "文档卡二",
            version: 3,
            work_items: [
              { ...docTemplate.work_items[0], required: false } as never,
            ],
          },
        },
        employees: [],
      }),
    }),
  );
  const drawer = await openImport();
  fireEvent.change(within(drawer).getByLabelText("Markdown"), {
    target: { value: markdown },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  await within(drawer).findByRole("button", { name: "应用" });
  expect(drawer.textContent).toContain("机器能力要求（required_capabilities）");
  expect(drawer.textContent).toContain("新增 browser.chromium");
  expect(drawer.textContent).not.toContain("只改了状态");
  expect(drawer.textContent).toContain("文档卡 → 文档卡二");
  const rows = within(within(drawer).getByRole("table", { name: "模板工作项" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);
  expect(rows).toEqual([
    "写作（writing）writer产出，可选改为可选",
    "审核（review）reviewer验证，必需删除",
  ]);
});

test("choosing another file drops the previous file's preview; an oversized or failed file never applies the old text", async () => {
  const previewRoleDocument = vi.fn(async () => created);
  const applyRoleDocument = vi.fn();
  await openRoles(client({ previewRoleDocument, applyRoleDocument }));
  const drawer = await openImport();
  const input = drawer.querySelector("input[type=file]") as HTMLInputElement;
  const pick = (file: File) =>
    fireEvent.change(input, { target: { files: [file] } });
  pick(new File([markdown], "a.md", { type: "text/markdown" }));
  await waitFor(() =>
    expect(
      (within(drawer).getByLabelText("Markdown") as HTMLTextAreaElement).value,
    ).toBe(markdown),
  );
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  await within(drawer).findByRole("button", { name: "应用" });
  pick(new File(["x".repeat(64 * 1024 + 1)], "b.md"));
  expect((await within(drawer).findByRole("alert")).textContent).toContain(
    "64 KiB",
  );
  expect(within(drawer).queryByRole("button", { name: "应用" })).toBeNull();
  expect(
    (within(drawer).getByLabelText("Markdown") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(applyRoleDocument).not.toHaveBeenCalled();
});

test("adding to a template never rewrites the role or an existing template", async () => {
  const exportRole = vi.fn(async () => ({
    markdown: "---\nrole_id: proofreader\n---\nbody\n",
  }));
  let roleChanged = false;
  const previewRoleDocument = vi.fn(async () => ({
    ...created,
    employees: [],
    role: {
      ...created.role,
      action: roleChanged ? ("update" as const) : ("unchanged" as const),
      relaxations: [],
    },
    template: created.template && {
      ...created.template,
      action: "update" as const,
    },
  }));
  const applyRoleDocument = vi.fn();
  await openRoles(
    client({
      copyRole: async () => proofreader,
      exportRole,
      previewRoleDocument,
      applyRoleDocument,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "proofreader" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  fireEvent.click(await screen.findByRole("button", { name: "加进模板" }));
  const drawer = await screen.findByRole("dialog", { name: "加进模板" });
  await waitFor(() => expect(exportRole).toHaveBeenCalledTimes(1));
  fireEvent.click(
    within(drawer).getByRole("button", { name: "复制模板并替换角色" }),
  );
  await waitFor(() =>
    expect(within(drawer).getByLabelText("来源模板").textContent).toContain(
      "请选择模板",
    ),
  );
  changeControl(within(drawer).getByLabelText("来源模板"), {
    target: { value: "doc" },
  });
  changeControl(within(drawer).getByLabelText("替换的角色"), {
    target: { value: "writer" },
  });
  fireEvent.change(within(drawer).getByLabelText("新模板编号"), {
    target: { value: "doc" },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "预览" }));
  expect((await within(drawer).findByRole("alert")).textContent).toBe(
    "模板 doc 已存在，请换一个新模板编号",
  );
  expect(
    (within(drawer).getByRole("button", { name: "应用" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // Someone changed the role meanwhile: the role must not be written back.
  roleChanged = true;
  fireEvent.click(within(drawer).getByRole("button", { name: "重新预览" }));
  expect(
    await within(drawer).findByText(
      "角色在打开后已有新版本，已重新读取，请重新预览",
    ),
  ).toBeTruthy();
  await waitFor(() => expect(exportRole).toHaveBeenCalledTimes(2));
  expect(applyRoleDocument).not.toHaveBeenCalled();
});

test("every unapplied draft asks before it is dropped: template choices, a new role's profile, an edit's cancel", async () => {
  await openRoles(client({ copyRole: async () => proofreader }));
  // New role: only the launch profile changed.
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  changeControl(within(form).getByLabelText("启动配置"), {
    target: { value: "claude-agent" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "取消" }));
  let ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "继续编辑" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未应用的修改？" }),
    ).toBeNull(),
  );
  changeControl(within(form).getByLabelText("新角色编号"), {
    target: { value: "proofreader" },
  });
  fireEvent.click(within(form).getByRole("button", { name: "创建角色" }));
  // Template: only the work item kind and "required" changed.
  fireEvent.click(await screen.findByRole("button", { name: "加进模板" }));
  const drawer = await screen.findByRole("dialog", { name: "加进模板" });
  changeControl(within(drawer).getByLabelText("类型"), {
    target: { value: "verify" },
  });
  fireEvent.keyDown(drawer, { key: "Escape" });
  ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "加进模板" })).toBeNull(),
  );
  // Back on the new role: its own actions are behind 更多 until it closes.
  expect(screen.getByRole("button", { name: "更多角色操作" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "导出 Markdown" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByLabelText("角色说明（instructions）"), {
    target: { value: "改过的说明" },
  });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("角色说明（instructions）")).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Reopened from the list, the role shows its usual actions again.
  fireEvent.click(await screen.findByRole("button", { name: "校对员" }));
  expect(
    await screen.findByRole("button", { name: "导出 Markdown" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "停用" })).toBeTruthy();
});

test("launch profile choices are the launch settings' valid names; the role list only adds their summary", async () => {
  await openRoles(
    client({ launchProfileNames: async () => ["claude-agent", "new-agent"] }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "新建角色" }));
  const form = screen.getByRole("form", { name: "新建角色" });
  fireEvent.keyDown(within(form).getByLabelText("启动配置"), {
    key: "ArrowDown",
  });
  const options = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  expect(options).toEqual([
    "请选择启动配置",
    "claude-agent（claude-code · 默认模型）",
    "new-agent",
  ]);
});
