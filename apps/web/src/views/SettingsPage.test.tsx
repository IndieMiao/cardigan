// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import { HttpCardiganClient } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
test("settings navigation opens preferences, default off with the missing-gate warning", async () => {
  window.location.hash = "#/p/p-1/settings";
  render(<App client={fakeClient()} />);
  expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "设置" }).getAttribute("aria-current"),
  ).toBe("page");
  const toggle = await screen.findByRole("checkbox", { name: "超时自动合并" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(
    (screen.getByLabelText("等待分钟数") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("没有合并闸门时，自动合并会合并未经全量测试和 e2e 的代码"),
  ).toBeTruthy();
});

test("enable, validate, retry with the same idempotency key, then disable", async () => {
  const setPreferences = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setPreferences })} />,
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "超时自动合并" }),
  );
  const minutes = screen.getByLabelText("等待分钟数");
  fireEvent.change(minutes, { target: { value: "1.5" } });
  expect(
    (screen.getByRole("button", { name: "保存偏好" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(minutes, { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
  await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(2));
  expect(setPreferences.mock.calls[0]?.slice(0, 2)).toEqual(["p-1", 20]);
  expect(setPreferences.mock.calls[1]?.[2]).toBe(
    setPreferences.mock.calls[0]?.[2],
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "保存偏好" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "超时自动合并" }));
  fireEvent.click(screen.getByRole("button", { name: "保存偏好" }));
  await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(3));
  expect(setPreferences.mock.calls[2]?.slice(0, 2)).toEqual(["p-1", null]);
  expect(setPreferences.mock.calls[2]?.[2]).not.toBe(
    setPreferences.mock.calls[0]?.[2],
  );
});

test("existing setting loads and a configured gate hides the warning", async () => {
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: 30,
          merge_gate_enabled: true,
        }),
      })}
    />,
  );
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "超时自动合并",
      })) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect((screen.getByLabelText("等待分钟数") as HTMLInputElement).value).toBe(
    "30",
  );
  expect(screen.queryByText(/没有合并闸门时/)).toBeNull();
});

test("HTTP preferences carry the required key and encoded project", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("{}", { status: 200 }));
  const client = new HttpCardiganClient(fetcher);
  await client.setPreferences("a/b", 10, "preference-key");
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(url).toBe("/api/projects/a%2Fb/preferences");
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
    "preference-key",
  );
  expect(init?.body).toBe('{"auto_merge_after_minutes":10}');
});

test("authorization exposes defaults, retries safely, and fixes high-risk categories to human confirmation", async () => {
  const setDelegation = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setDelegation })} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "授权", exact: true }));
  const process = await screen.findByRole("checkbox", {
    name: "流程：由 PM 代拍",
  });
  expect((process as HTMLInputElement).checked).toBe(true);
  expect(
    process.closest("label")?.querySelector("svg.status-shape-success"),
  ).toBeTruthy();
  expect(
    screen.getByText("由人拍板").querySelector("svg.status-shape-review"),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "需求范围变化：由人拍板",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  for (const category of ["花钱", "账号", "权限", "删除数据"]) {
    const toggle = screen.getByRole("checkbox", {
      name: `${category}：固定由人确认（Workbench 或本机 CLI）`,
    });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(
      toggle
        .closest("label")
        ?.querySelector("svg.status-shape-review")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  }
  fireEvent.click(process);
  await screen.findByRole("alert");
  fireEvent.click(process);
  await waitFor(() => expect(setDelegation).toHaveBeenCalledTimes(2));
  expect(setDelegation.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "general",
    false,
  ]);
  expect(setDelegation.mock.calls[1]?.[3]).toBe(
    setDelegation.mock.calls[0]?.[3],
  );
});

test("preferences, authorization, roles and templates coexist as separate settings tabs", async () => {
  render(<SettingsPage client={fakeClient()} projectId="p-1" />);
  const preferences = screen.getByRole("button", { name: "偏好", exact: true });
  const authorization = screen.getByRole("button", {
    name: "授权",
    exact: true,
  });
  const roles = screen.getByRole("button", { name: "角色", exact: true });
  const templates = screen.getByRole("button", {
    name: "卡片模板",
    exact: true,
  });
  expect(preferences.getAttribute("aria-current")).toBe("page");
  await screen.findByRole("checkbox", { name: "超时自动合并" });
  fireEvent.click(authorization);
  expect(authorization.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("heading", { name: "授权", exact: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: "超时自动合并" })).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "流程：由 PM 代拍" }),
  ).toBeTruthy();
  fireEvent.click(roles);
  await screen.findByText("本项目还没有登记角色。");
  expect(roles.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("heading", { name: "角色", exact: true }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "新建角色" })).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "授权", exact: true }),
  ).toBeNull();
  fireEvent.click(templates);
  await screen.findByRole("table", { name: "项目卡片模板" });
  expect(screen.queryByRole("button", { name: "新建角色" })).toBeNull();
  expect(templates.getAttribute("aria-current")).toBe("page");
  expect(
    screen.queryByRole("heading", { name: "授权", exact: true }),
  ).toBeNull();
  fireEvent.click(preferences);
  expect(preferences.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("checkbox", { name: "超时自动合并" })).toBeTruthy();
  expect(screen.queryByRole("table", { name: "项目卡片模板" })).toBeNull();
  fireEvent.click(roles);
  await screen.findByText("本项目还没有登记角色。");
  expect(screen.queryByRole("checkbox", { name: "超时自动合并" })).toBeNull();
  fireEvent.click(authorization);
  expect(
    screen.getByRole("checkbox", { name: "流程：由 PM 代拍" }),
  ).toBeTruthy();
});
