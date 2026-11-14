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
    .mockImplementation(async () => new Response("{}", { status: 200 }));
  const client = new HttpCardiganClient(fetcher);
  await client.setPreferences("a/b", 10, "preference-key");
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(url).toBe("/api/projects/a%2Fb/preferences");
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
    "preference-key",
  );
  expect(init?.body).toBe('{"auto_merge_after_minutes":10}');
  await client.setMergeConfirmSnoozeMax("a/b", 60, "snooze-max-key");
  const [maxUrl, maxInit] = fetcher.mock.calls[1] ?? [];
  expect(maxUrl).toBe("/api/projects/a%2Fb/preferences");
  expect(new Headers(maxInit?.headers).get("Idempotency-Key")).toBe(
    "snooze-max-key",
  );
  expect(maxInit?.body).toBe('{"merge_confirm_snooze_max_minutes":60}');
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

test("PM merge confirmation defaults on and can be turned off", async () => {
  const setPmMergeConfirmation = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setPmMergeConfirmation })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "授权", exact: true }));
  const toggle = (await screen.findByRole("checkbox", {
    name: "合并由 PM 代确认：由 PM 代确认",
  })) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  await waitFor(() => expect(setPmMergeConfirmation).toHaveBeenCalledTimes(1));
  expect(setPmMergeConfirmation.mock.calls[0]?.slice(0, 2)).toEqual([
    "p-1",
    false,
  ]);
});

test("PM merge confirmation stall alert shows the default 60 minutes and saves a new value", async () => {
  const setMergeConfirmStallAfter = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setMergeConfirmStallAfter })}
    />,
  );
  const input = (await screen.findByLabelText(
    "PM 合并确认停留告警（分钟）",
  )) as HTMLInputElement;
  expect(input.value).toBe("60");
  expect(
    screen.getByText(
      /PM 持有的合并确认在合并检查出结论后，超过这么久还没处理，就提醒 PM Ops/,
    ),
  ).toBeTruthy();
  fireEvent.change(input, { target: { value: "0" } });
  expect(
    (screen.getByRole("button", { name: "保存停留告警" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "保存停留告警" }));
  await waitFor(() =>
    expect(setMergeConfirmStallAfter).toHaveBeenCalledTimes(1),
  );
  expect(setMergeConfirmStallAfter.mock.calls[0]?.slice(0, 2)).toEqual([
    "p-1",
    90,
  ]);
});

test("review round limits show the defaults 5 and 3 and save new values", async () => {
  const setReviewMaxRounds = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setReviewMaxRounds })}
    />,
  );
  const review = (await screen.findByLabelText(
    "普通审核轮数上限（轮）",
  )) as HTMLInputElement;
  const independent = screen.getByLabelText(
    "独立复核轮数上限（轮）",
  ) as HTMLInputElement;
  expect(review.value).toBe("5");
  expect(independent.value).toBe("3");
  // Q-420: the ceiling 20 comes from the server and bounds both inputs.
  expect(review.max).toBe("20");
  expect(independent.max).toBe("20");
  expect(screen.getByText(/默认 5 轮，可设为 1 到 20 轮/)).toBeTruthy();
  expect(screen.getByText(/默认 3 轮，可设为 1 到 20 轮/)).toBeTruthy();
  expect(
    screen.getAllByText(/只影响之后新建的审核项/).length,
  ).toBeGreaterThanOrEqual(2);
  const save = (name: string) =>
    screen.getByRole("button", { name }) as HTMLButtonElement;
  for (const bad of ["0", "21", "1.5"]) {
    fireEvent.change(independent, { target: { value: bad } });
    expect(save("保存独立复核轮数").disabled).toBe(true);
    expect(screen.getByText("请输入 1 到 20 的整数轮数。")).toBeTruthy();
  }
  fireEvent.change(independent, { target: { value: "20" } });
  expect(save("保存独立复核轮数").disabled).toBe(false);
  fireEvent.change(independent, { target: { value: "4" } });
  fireEvent.click(save("保存独立复核轮数"));
  await waitFor(() => expect(setReviewMaxRounds).toHaveBeenCalledTimes(1));
  expect(setReviewMaxRounds.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "independent",
    4,
  ]);
  fireEvent.change(review, { target: { value: "7" } });
  fireEvent.click(save("保存审核轮数"));
  await waitFor(() => expect(setReviewMaxRounds).toHaveBeenCalledTimes(2));
  expect(setReviewMaxRounds.mock.calls[1]?.slice(0, 3)).toEqual([
    "p-1",
    "review",
    7,
  ]);
});

test("review round limits stay hidden when the server omits the ceiling", async () => {
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: false,
        }),
      })}
    />,
  );
  await screen.findByRole("checkbox", { name: "超时自动合并" });
  expect(screen.queryByLabelText("普通审核轮数上限（轮）")).toBeNull();
  expect(screen.queryByLabelText("独立复核轮数上限（轮）")).toBeNull();
});

test("hidden preferences suppress validation feedback and retain the draft when returning", async () => {
  render(<SettingsPage client={fakeClient()} projectId="p-1" />);
  const enabled = await screen.findByRole("checkbox", { name: "超时自动合并" });
  fireEvent.click(enabled);
  const minutes = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  fireEvent.change(minutes, { target: { value: "0" } });
  expect(screen.getByRole("alert").textContent).toContain("请输入 1 到 1440");
  for (const tab of ["授权", "角色", "卡片模板"]) {
    fireEvent.click(screen.getByRole("button", { name: tab, exact: true }));
    expect(document.getElementById("preferences")?.hidden).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      document.querySelector(".request-feedback-region")?.textContent,
    ).not.toContain("请输入 1 到 1440");
    fireEvent.click(screen.getByRole("button", { name: "偏好", exact: true }));
    expect(screen.getByLabelText("等待分钟数")).toBe(minutes);
    expect(minutes.value).toBe("0");
    expect((enabled as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("请输入 1 到 1440");
  }
});

test.each([
  ["偏好", "setPreferences", "保存偏好"],
  ["授权", "setDelegation", "流程：由 PM 代拍"],
  ["授权", "setPmMergeConfirmation", "合并由 PM 代确认：由 PM 代确认"],
] as const)(
  "%s hides pending and late %s errors outside its tab without losing the form",
  async (tab, method, control) => {
    const request = Promise.withResolvers<void>();
    const save = vi.fn(() => request.promise);
    render(
      <SettingsPage client={fakeClient({ [method]: save })} projectId="p-1" />,
    );
    const minutes = (await screen.findByLabelText(
      "等待分钟数",
    )) as HTMLInputElement;
    fireEvent.click(screen.getByRole("checkbox", { name: "超时自动合并" }));
    fireEvent.change(minutes, { target: { value: "23" } });
    fireEvent.click(screen.getByRole("button", { name: tab, exact: true }));
    fireEvent.click(
      screen.getByRole(method === "setPreferences" ? "button" : "checkbox", {
        name: control,
      }),
    );
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByText(/保存.*中…/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "卡片模板", exact: true }),
    );
    expect(screen.queryByText(/保存.*中…/)).toBeNull();
    await act(async () => request.reject(new Error("设置保存失败")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      document.querySelector(".request-feedback-region")?.textContent,
    ).not.toContain("设置保存失败");
    fireEvent.click(screen.getByRole("button", { name: tab, exact: true }));
    expect(screen.getByRole("alert").textContent).toContain("设置保存失败");
    fireEvent.click(
      screen.getByRole("button", {
        name: tab === "偏好" ? "授权" : "偏好",
        exact: true,
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "偏好", exact: true }));
    expect(screen.getByLabelText("等待分钟数")).toBe(minutes);
    expect(minutes.value).toBe("23");
  },
);

test("PM merge confirmation snooze duration shows the default 240 minutes and saves a new value", async () => {
  const setMergeConfirmSnoozeDefault = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setMergeConfirmSnoozeDefault })}
    />,
  );
  const input = (await screen.findByLabelText(
    "合并确认默认暂缓时长（分钟）",
  )) as HTMLInputElement;
  expect(input.value).toBe("240");
  expect(
    screen.getByText(/PM 或人暂缓一条合并确认时，没有填到期时间就用这个时长/),
  ).toBeTruthy();
  fireEvent.change(input, { target: { value: "0" } });
  expect(
    (screen.getByRole("button", { name: "保存暂缓时长" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "保存暂缓时长" }));
  await waitFor(() =>
    expect(setMergeConfirmSnoozeDefault).toHaveBeenCalledTimes(1),
  );
  expect(setMergeConfirmSnoozeDefault.mock.calls[0]?.slice(0, 2)).toEqual([
    "p-1",
    90,
  ]);
});

test("C-193: snooze cap shows 72 hours, validates bounds and saves the setting", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({ setMergeConfirmSnoozeMax: save })}
    />,
  );
  const input = (await screen.findByLabelText(
    "合并确认最长暂缓时长（分钟）",
  )) as HTMLInputElement;
  expect(input.value).toBe("4320");
  const button = screen.getByRole("button", {
    name: "保存暂缓上限",
  }) as HTMLButtonElement;
  for (const value of ["59", "10081", "60.5"]) {
    fireEvent.change(input, { target: { value } });
    expect(button.disabled).toBe(true);
  }
  fireEvent.change(input, { target: { value: "60" } });
  expect(button.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "10080" } });
  fireEvent.click(button);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("p-1", 10080, expect.any(String)),
  );
});

test("C-237 system toggles are independent, off initially, and numeric settings have no defaults", async () => {
  const setSystemRules = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setSystemRules })} />,
  );
  const assign = await screen.findByRole("checkbox", {
    name: "自动指派验证项（含完成验收）",
  });
  const remind = screen.getByRole("checkbox", { name: "启用催办提醒" });
  expect((assign as HTMLInputElement).checked).toBe(false);
  expect((remind as HTMLInputElement).checked).toBe(false);
  fireEvent.click(assign);
  fireEvent.click(screen.getByRole("button", { name: "保存自动指派与催办" }));
  await waitFor(() =>
    expect(setSystemRules).toHaveBeenCalledWith(
      "p-1",
      {
        system_auto_assign_verifiers: true,
        system_reminders: false,
        system_reminder_policy: null,
      },
      expect.any(String),
    ),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "设置催办阈值和允许范围" }),
  );
  for (const field of screen
    .getAllByRole("spinbutton")
    .filter((node) => node.closest("fieldset")))
    expect((field as HTMLInputElement).value).toBe("");
});
