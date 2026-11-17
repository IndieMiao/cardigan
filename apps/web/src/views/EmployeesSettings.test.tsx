// @vitest-environment jsdom
import {
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

test("settings groups searchable characters, disables active and inactive occupants, and submits editable selected identity", async () => {
  const createEmployee = vi
    .fn()
    .mockResolvedValue({ id: "E-3", name: "悟空", role_id: "coder" });
  await open({ createEmployee });
  const three = screen.getByRole("region", { name: "三国演义" });
  for (const name of [/关羽.*云长.*E-1/, /诸葛亮.*孔明.*已离职/]) {
    const button = within(three).getByRole("button", {
      name,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe("");
  }
  const search = screen.getByLabelText("搜索人物或出处");
  changeControl(search, { target: { value: "西游" } });
  expect(screen.queryByRole("region", { name: "三国演义" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "孙悟空" }));
  expect((screen.getByLabelText("名字") as HTMLInputElement).value).toBe(
    "孙悟空",
  );
  expect(screen.getByRole("img", { name: "孙悟空" }).getAttribute("src")).toBe(
    "/avatars/v1/sun-wukong/head-128.webp",
  );
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
});

test("custom upload sends only bytes and preserves retry keys and fields after uncertain failures", async () => {
  const createEmployee = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue({ id: "E-3", name: "自定义", role_id: "coder" });
  await open({ createEmployee });
  fireEvent.click(screen.getByLabelText("自定义名字和头像"));
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
  fireEvent.click(screen.getByLabelText("自定义名字和头像"));
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
  fireEvent.click(screen.getByLabelText("从人物库选择"));
  fireEvent.click(screen.getByRole("button", { name: "孙悟空" }));
  fields();
  submit();
  expect(await screen.findByText(/人物已被员工占用/)).toBeTruthy();
  await waitFor(() => expect(employeeOptions).toHaveBeenCalledTimes(2));
  expect(
    (
      screen.getByRole("button", {
        name: /孙悟空.*新同事/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
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
  fireEvent.click(await screen.findByRole("button", { name: "孙悟空" }));
  view.rerender(<SettingsPage projectId="p-2" client={client} />);
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
