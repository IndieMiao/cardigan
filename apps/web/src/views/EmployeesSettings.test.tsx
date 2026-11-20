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
import { ApiError, type EmployeeOptions, HttpCardiganClient } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(cleanup);
const options: EmployeeOptions = {
  library: [
    {
      id: "guan-yu",
      name: "关羽",
      source: "三国演义",
      avatar: "/avatars/v1/guan-yu/head-128.webp",
      occupied_by: { id: "E-1", name: "云长", status: "active" },
    },
    {
      id: "zhuge-liang",
      name: "诸葛亮",
      source: "三国演义",
      avatar: "/avatars/v1/zhuge-liang/head-128.webp",
      occupied_by: { id: "E-2", name: "孔明", status: "inactive" },
    },
    {
      id: "sun-wukong",
      name: "孙悟空",
      source: "西游记",
      avatar: "/avatars/v1/sun-wukong/head-128.webp",
      occupied_by: null,
    },
  ],
  roles: [{ role_id: "coder", display_name: "开发" }],
};
async function open(overrides: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({
    employeeOptions: async () => options,
    ...overrides,
  });
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "员工" }));
  await screen.findByLabelText("搜索人物或出处");
  return client;
}
function fields() {
  changeControl(screen.getByLabelText("职位"), {
    target: { value: "开发工程师" },
  });
  changeControl(screen.getByLabelText("角色"), {
    target: { value: "coder" },
  });
}
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "创建员工" }));

/** Pick a library person in the open form's person select. */
const person = (value: string) =>
  changeControl(screen.getByLabelText("人物"), { target: { value } });

test("settings lists searchable characters with their occupants, offers only free ones, and submits the edited identity", async () => {
  const createEmployee = vi
    .fn()
    .mockResolvedValue({ id: "E-3", name: "悟空", role_id: "coder" });
  await open({ createEmployee });
  const table = screen.getByRole("table", { name: "人物库" });
  for (const [name, occupant] of [
    ["关羽", /云长（E-1）/],
    ["诸葛亮", /孔明（E-2，已离职）/],
  ] as const) {
    const row = within(table).getByRole("row", { name });
    expect(row.textContent).toMatch(occupant);
    expect(within(row).queryByRole("button")).toBeNull();
  }
  const search = screen.getByLabelText("搜索人物或出处");
  changeControl(search, { target: { value: "西游" } });
  expect(within(table).queryByRole("row", { name: "关羽" })).toBeNull();
  changeControl(search, { target: { value: "没有这个人" } });
  expect(screen.getByText("没有找到匹配的人物。")).toBeTruthy();
  changeControl(search, { target: { value: "西游" } });
  fireEvent.click(screen.getByRole("button", { name: "选用孙悟空" }));
  const form = await screen.findByRole("form", { name: "新建员工" });
  expect((within(form).getByLabelText("名字") as HTMLInputElement).value).toBe(
    "孙悟空",
  );
  expect(screen.getByRole("img", { name: "孙悟空" }).getAttribute("src")).toBe(
    "/avatars/v1/sun-wukong/head-128.webp",
  );
  // Occupied people are not offered in the form either.
  person("sun-wukong");
  expect(() => person("guan-yu")).toThrow("Missing select option guan-yu");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getByRole("form", { name: "新建员工" })).toBeTruthy();
  changeControl(screen.getByLabelText("名字"), {
    target: { value: "悟空" },
  });
  fields();
  changeControl(screen.getByLabelText("简介（可选）"), {
    target: { value: "负责开发" },
  });
  submit();
  await waitFor(() =>
    expect(createEmployee).toHaveBeenCalledWith(
      "p-1",
      {
        name: "悟空",
        title: "开发工程师",
        role_id: "coder",
        bio: "负责开发",
        avatar: "library:sun-wukong",
      },
      expect.any(String),
    ),
  );
  expect(await screen.findByText("已创建员工 悟空（E-3）")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("custom upload sends only bytes and preserves retry keys and fields after uncertain failures", async () => {
  const createEmployee = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue({ id: "E-3", name: "自定义", role_id: "coder" });
  await open({ createEmployee });
  fireEvent.click(screen.getByRole("button", { name: "新建员工" }));
  const custom = await screen.findByRole("button", {
    name: "自定义名字和头像",
  });
  fireEvent.click(custom);
  expect(custom.getAttribute("aria-pressed")).toBe("true");
  changeControl(screen.getByLabelText("名字"), {
    target: { value: "自定义" },
  });
  fields();
  changeControl(screen.getByLabelText(/上传头像/), {
    target: {
      files: [new File(["bitmap bytes"], "name.png", { type: "image/png" })],
    },
  });
  await waitFor(() => expect(screen.queryByText("正在读取头像…")).toBeNull());
  submit();
  expect(await screen.findByText(/操作可能已经成功/)).toBeTruthy();
  expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe(
    "自定义",
  );
  submit();
  await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(2));
  expect(createEmployee.mock.calls[0]?.[1]).toEqual({
    name: "自定义",
    title: "开发工程师",
    role_id: "coder",
    bio: "",
    avatar_file: btoa("bitmap bytes"),
  });
  expect(createEmployee.mock.calls[1]?.[2]).toBe(
    createEmployee.mock.calls[0]?.[2],
  );
});

test("oversized file prevents submitting and server occupancy conflicts refresh choices without losing the name", async () => {
  const createEmployee = vi
    .fn()
    .mockRejectedValue(
      new ApiError(400, "validation_failed", "人物已被员工占用"),
    );
  const employeeOptions = vi
    .fn()
    .mockResolvedValueOnce(options)
    .mockResolvedValue({
      ...options,
      library: options.library.map((item) => ({
        ...item,
        occupied_by: item.occupied_by ?? {
          id: "E-3",
          name: "新同事",
          status: "active",
        },
      })),
    });
  await open({ createEmployee, employeeOptions });
  fireEvent.click(screen.getByRole("button", { name: "新建员工" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "自定义名字和头像" }),
  );
  changeControl(screen.getByLabelText(/上传头像/), {
    target: {
      files: [new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png")],
    },
  });
  expect(await screen.findByText("头像图片不能超过 2 MiB。")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "创建员工" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(createEmployee).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "从人物库选择" }));
  person("sun-wukong");
  fields();
  submit();
  expect(await screen.findByText(/人物已被员工占用/)).toBeTruthy();
  await waitFor(() => expect(employeeOptions).toHaveBeenCalledTimes(2));
  // The list behind the drawer now shows the new occupant.
  await waitFor(() =>
    expect(
      screen.getByRole("row", { name: "孙悟空", hidden: true }).textContent,
    ).toContain("新同事"),
  );
  expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe(
    "孙悟空",
  );
});

test("empty roles prevent creation and changing projects discards the previous draft", async () => {
  const client = fakeClient({
    employeeOptions: async (projectId) =>
      projectId === "p-1" ? options : { ...options, roles: [] },
  });
  const view = render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "员工" }));
  fireEvent.click(await screen.findByRole("button", { name: "选用孙悟空" }));
  await screen.findByRole("form", { name: "新建员工" });
  view.rerender(<SettingsPage projectId="p-2" client={client} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "新建员工" }));
  await screen.findByText(/本项目还没有已启用的角色/);
  expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe("");
  expect(
    (screen.getByRole("button", { name: "创建员工" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("HTTP employee creation uses owner cookies and an idempotency key with the new routes", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ id: "E-3", name: "名字", role_id: "coder" }),
          { status: 200 },
        ),
    );
  const client = new HttpCardiganClient(fetcher);
  await client.employeeOptions("a b");
  await client.createEmployee(
    "a b",
    { name: "名字", title: "开发", role_id: "coder" },
    "employee-key",
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/api/projects/a%20b/employees/options",
  );
  expect(fetcher.mock.calls[1]).toEqual([
    "/api/projects/a%20b/employees",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({ "Idempotency-Key": "employee-key" }),
    }),
  ]);
});

test("an employee being created keeps its drawer until the reply, then focus goes to 新建员工", async () => {
  const reply = Promise.withResolvers<{
    id: string;
    name: string;
    role_id: string;
  }>();
  await open({ createEmployee: vi.fn(() => reply.promise) });
  const opener = screen.getByRole("button", { name: "选用孙悟空" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("form", { name: "新建员工" });
  fields();
  submit();
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("form", { name: "新建员工" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  reply.resolve({ id: "E-3", name: "孙悟空", role_id: "coder" });
  expect(await screen.findByText("已创建员工 孙悟空（E-3）")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The person is taken once created: focus goes to the 新建员工 fallback.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "新建员工" }),
    ),
  );
});

test("closing the new-employee drawer with Escape returns focus to 新建员工", async () => {
  await open();
  const opener = screen.getByRole("button", { name: "新建员工" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("after creating from 选用 the person is taken: focus falls back to 新建员工", async () => {
  const employeeOptions = vi
    .fn()
    .mockResolvedValueOnce(options)
    .mockResolvedValue({
      ...options,
      library: options.library.map((item) =>
        item.id === "sun-wukong"
          ? {
              ...item,
              occupied_by: { id: "E-3", name: "悟空", status: "active" },
            }
          : item,
      ),
    });
  await open({
    employeeOptions,
    createEmployee: vi
      .fn()
      .mockResolvedValue({ id: "E-3", name: "悟空", role_id: "coder" }),
  });
  const opener = screen.getByRole("button", { name: "选用孙悟空" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("form", { name: "新建员工" });
  fields();
  submit();
  await screen.findByText("已创建员工 悟空（E-3）");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "选用孙悟空" })).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "新建员工" }),
    ),
  );
});

test("focus goes to 新建员工 after creating from 选用 even when the refresh is slow", async () => {
  const refresh = Promise.withResolvers<EmployeeOptions>();
  const employeeOptions = vi
    .fn()
    .mockResolvedValueOnce(options)
    .mockImplementation(() => refresh.promise);
  await open({
    employeeOptions,
    createEmployee: vi
      .fn()
      .mockResolvedValue({ id: "E-3", name: "悟空", role_id: "coder" }),
  });
  const opener = screen.getByRole("button", { name: "选用孙悟空" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("form", { name: "新建员工" });
  fields();
  submit();
  await screen.findByText("已创建员工 悟空（E-3）");
  const fallback = screen.getByRole("button", { name: "新建员工" });
  await waitFor(() => expect(document.activeElement).toBe(fallback));
  await act(async () =>
    refresh.resolve({
      ...options,
      library: options.library.map((item) =>
        item.id === "sun-wukong"
          ? {
              ...item,
              occupied_by: { id: "E-3", name: "悟空", status: "active" },
            }
          : item,
      ),
    }),
  );
  expect(screen.queryByRole("button", { name: "选用孙悟空" })).toBeNull();
  expect(document.activeElement).toBe(fallback);
});

const staffed: EmployeeOptions = {
  ...options,
  roles: [
    { role_id: "coder", display_name: "开发" },
    { role_id: "reviewer", display_name: "审核" },
  ],
  employees: [
    {
      id: "E-1",
      name: "云长",
      title: "开发工程师",
      status: "active",
      avatar: "/avatars/v1/guan-yu/head-64.webp",
      role_id: "coder",
      projects: ["p-1"],
      role_change_blocked: null,
    },
    {
      id: "E-2",
      name: "孔明",
      title: "审核员",
      status: "active",
      avatar: null,
      role_id: "reviewer",
      projects: [],
      role_change_blocked: "run",
    },
    {
      id: "E-3",
      name: "别处的人",
      title: "开发",
      status: "active",
      avatar: null,
      role_id: "coder",
      projects: ["p-2"],
      role_change_blocked: null,
    },
  ],
};

test("C-494: this project's employees are listed, and a role change is a keyed transfer", async () => {
  const updateEmployee = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ id: "E-1", name: "云长", role_id: "reviewer" });
  const employeeOptions = vi.fn(async () => staffed);
  await open({ employeeOptions, updateEmployee });
  const table = await screen.findByRole("table", { name: "员工列表" });
  expect(
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent),
  ).toEqual(["云长开发工程师开发在职", "孔明审核员审核在职"]);
  fireEvent.click(within(table).getByRole("button", { name: "云长" }));
  const drawer = await screen.findByRole("dialog", { name: "云长" });
  expect(
    (
      within(drawer).getByRole("button", {
        name: "保存角色",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  changeControl(within(drawer).getByLabelText("角色"), {
    target: { value: "reviewer" },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "保存角色" }));
  expect((await within(drawer).findByRole("alert")).textContent).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "保存角色" }));
  expect(await screen.findByText("已将 云长 的角色改为 审核")).toBeTruthy();
  expect(updateEmployee).toHaveBeenCalledTimes(2);
  expect(updateEmployee.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "E-1",
    { role_id: "reviewer" },
  ]);
  expect(updateEmployee.mock.calls[1]?.[3]).toBe(
    updateEmployee.mock.calls[0]?.[3],
  );
  expect(screen.queryByRole("dialog", { name: "云长" })).toBeNull();
});

test("C-494: an employee with work in progress cannot change role and the drawer says why", async () => {
  const updateEmployee = vi.fn();
  await open({ employeeOptions: async () => staffed, updateEmployee });
  fireEvent.click(await screen.findByRole("button", { name: "孔明" }));
  const drawer = await screen.findByRole("dialog", { name: "孔明" });
  expect(
    within(drawer).getByText("这名员工还有未结束的运行，结束后才能换角色。"),
  ).toBeTruthy();
  expect(
    (within(drawer).getByLabelText("角色") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (
      within(drawer).getByRole("button", {
        name: "保存角色",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(updateEmployee).not.toHaveBeenCalled();
});

test("C-494: closing an employee drawer with an unsaved role asks before discarding", async () => {
  await open({ employeeOptions: async () => staffed });
  fireEvent.click(await screen.findByRole("button", { name: "云长" }));
  const drawer = await screen.findByRole("dialog", { name: "云长" });
  changeControl(within(drawer).getByLabelText("角色"), {
    target: { value: "reviewer" },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "取消" }));
  const ask = await screen.findByRole("dialog", { name: "放弃未应用的修改？" });
  fireEvent.click(within(ask).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
