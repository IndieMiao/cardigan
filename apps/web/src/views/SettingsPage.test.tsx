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

test("the independent review link opens authorization directly", async () => {
  window.location.hash = "#/p/p-1/settings?tab=authorization";
  render(<App client={fakeClient()} />);
  expect(
    await screen.findByRole("checkbox", { name: "允许后台代批独立复核加一轮" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "授权" }).getAttribute("aria-current"),
  ).toBe("page");
});

test.each([
  ["forbidden_tool", "没有权限执行此操作。"],
  ["unauthorized", "没有权限执行此操作。"],
  ["origin_required", "请求被拒绝（来源校验未通过）。"],
  ["origin_rejected", "请求被拒绝（来源校验未通过）。"],
])(
  "authorization explains HTTP 403/%s without discarding the draft",
  async (code, message) => {
    const http = new HttpCardiganClient(
      async () =>
        new Response(
          JSON.stringify({ error: { code, message: "Request denied" } }),
          { status: 403 },
        ),
    );
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            independent_review_limit_delegation: false,
            independent_review_limit_delegation_ceiling: 3,
          }),
          setIndependentReviewLimitDelegation: (...args) =>
            http.setIndependentReviewLimitDelegation(...args),
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "授权" }));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "允许后台代批独立复核加一轮",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存加轮授权" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByText("有更改，待保存")).toBeTruthy();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "允许后台代批独立复核加一轮",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "保存加轮授权",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  },
);

test("independent review authorization shows its fixed budget and unsaved state, retries and saves human changes", async () => {
  let enabled = false;
  const save = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockImplementation(async (_project, next) => {
      enabled = next;
    });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          independent_review_limit_delegation: enabled,
          independent_review_limit_delegation_max: enabled ? 3 : null,
          independent_review_limit_delegation_ceiling: 3,
        }),
        setIndependentReviewLimitDelegation: save,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "授权" }));
  const toggle = await screen.findByRole("checkbox", {
    name: "允许后台代批独立复核加一轮",
  });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("每个复核项累计最多代批 3 次。")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.getByText("有更改，待保存")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存加轮授权" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "保存加轮授权" }));
  await screen.findByText("已保存：授权开启");
  expect(save.mock.calls[0]?.slice(0, 3)).toEqual(["p-1", true, 3]);
  expect(save.mock.calls[0]?.[3]).toBe(save.mock.calls[1]?.[3]);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "允许后台代批独立复核加一轮" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存加轮授权" }));
  await screen.findByText("已保存：授权关闭");
  expect(save.mock.calls[2]?.slice(0, 3)).toEqual(["p-1", false, 3]);
});

test("missing authorization policy cannot enable grants", async () => {
  render(<SettingsPage projectId="p-1" client={fakeClient()} />);
  fireEvent.click(await screen.findByRole("button", { name: "授权" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "允许后台代批独立复核加一轮" }),
  );
  expect(
    (screen.getByRole("button", { name: "保存加轮授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByText("暂时无法读取已批准的累计上限，请刷新后再开启。"),
  ).toBeTruthy();
});

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
  await client.setIndependentReviewLimitDelegation("a/b", true, 3, "grant-key");
  const [grantUrl, grantInit] = fetcher.mock.calls[2] ?? [];
  expect(grantUrl).toBe("/api/projects/a%2Fb/preferences");
  expect(new Headers(grantInit?.headers).get("Idempotency-Key")).toBe(
    "grant-key",
  );
  expect(JSON.parse(String(grantInit?.body))).toEqual({
    independent_review_limit_delegation: true,
    independent_review_limit_delegation_max: 3,
  });
});

test.each([
  ["spending", "花钱"],
  ["account", "账号"],
  ["data_deletion", "删除数据"],
])(
  "human settings saves and revokes %s with visible pending feedback",
  async (category, label) => {
    if (!category || !label) throw new Error("Missing category");
    const grants: Record<string, boolean> = {};
    let finish: (() => void) | undefined;
    const setDelegation = vi.fn(
      async (_project: string, key: string, enabled: boolean) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        grants[key] = enabled;
      },
    );
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: false,
            decision_delegation: { ...grants },
          }),
          setDelegation,
        })}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "授权", exact: true }),
    );
    for (const [before, after, enabled] of [
      ["由人拍板", "由 PM 代拍", true],
      ["由 PM 代拍", "由人拍板", false],
    ] as const) {
      const toggle = await screen.findByRole("checkbox", {
        name: `${label}：${before}`,
      });
      fireEvent.click(toggle);
      expect((toggle as HTMLInputElement).disabled).toBe(true);
      expect(await screen.findByText("保存授权中…")).toBeTruthy();
      await act(async () => {
        finish?.();
      });
      const saved = await screen.findByRole("checkbox", {
        name: `${label}：${after}`,
      });
      expect((saved as HTMLInputElement).checked).toBe(enabled);
      expect((saved as HTMLInputElement).disabled).toBe(false);
      expect(setDelegation).toHaveBeenLastCalledWith(
        "p-1",
        category,
        enabled,
        expect.any(String),
      );
    }
  },
);

test("authorization exposes defaults, retries safely, and allows human authorization for every category", async () => {
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
    screen
      .getAllByText("由人拍板")[0]
      ?.querySelector("svg.status-shape-review"),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "需求范围变化：由 PM 代拍",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  for (const category of [
    "花钱",
    "账号",
    "删除数据",
    "凭据",
    "对外发布",
    "人标记的敏感卡",
  ]) {
    const toggle = screen.getByRole("checkbox", {
      name: `${category}：由人拍板`,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
  }
  for (const category of ["权限"]) {
    const toggle = screen.getByRole("checkbox", {
      name: `${category}：由 PM 代拍`,
    });
    expect((toggle as HTMLInputElement).disabled).toBe(false);
    expect(
      toggle
        .closest("label")
        ?.querySelector("svg.status-shape-success")
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
  for (const ok of ["11", "20"]) {
    fireEvent.change(independent, { target: { value: ok } });
    expect(save("保存独立复核轮数").disabled).toBe(false);
    expect(screen.queryByText("请输入 1 到 20 的整数轮数。")).toBeNull();
  }
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

test("role-body setting defaults on, explains the human boundary, and saves off through the client", async () => {
  let enabled: boolean | undefined;
  const save = vi.fn(async (_p: string, next: boolean, _key: string) => {
    enabled = next;
  });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          ...(enabled === undefined
            ? {}
            : { pm_confirm_role_rule_implementations: enabled }),
        }),
        setPmConfirmRoleRuleImplementations: save,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "授权" }));
  const checkbox = (await screen.findByRole("checkbox", {
    name: /已拍角色正文由 PM 代确认/,
  })) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  expect(
    screen.getByText(/仅落实你已拍板的角色正文且逐处依据可核验/).textContent,
  ).toContain("PM 自身代确认权限");
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("p-1", false, expect.any(String)),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: /已拍角色正文由 PM 代确认/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  );
});

test.each([false, true])(
  "role-body keyboard focus survives saving and reload (failure=%s)",
  async (failure) => {
    let enabled = true;
    let settle: () => void = () => {};
    const save = vi.fn(
      (_p: string, next: boolean) =>
        new Promise<void>((resolve, reject) => {
          settle = () => {
            if (failure) reject(new TypeError("offline"));
            else {
              enabled = next;
              resolve();
            }
          };
        }),
    );
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            pm_confirm_role_rule_implementations: enabled,
          }),
          setPmConfirmRoleRuleImplementations: save,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "授权" }));
    const checkbox = (await screen.findByRole("checkbox", {
      name: /已拍角色正文由 PM 代确认/,
    })) as HTMLInputElement;
    checkbox.focus();
    fireEvent.click(checkbox); // the native checkbox change produced by Space
    await waitFor(() => expect(checkbox.disabled).toBe(true));
    // jsdom does not blur disabled controls, so reproduce the browser focus state.
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);
    await act(async () => settle());
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(checkbox));
    expect(
      screen.getByRole("checkbox", { name: /已拍角色正文由 PM 代确认/ }),
    ).toBe(checkbox);
    expect(checkbox.checked).toBe(failure);
    if (failure) expect(await screen.findByRole("alert")).toBeTruthy();
  },
);

test("role-body enabled preference describes the main merge switch without claiming PM is the current confirmer", async () => {
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          pm_merge_confirmation: false,
          pm_confirm_role_rule_implementations: true,
        }),
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "授权" }));
  const checkbox = (await screen.findByRole("checkbox", {
    name: /已拍角色正文由 PM 代确认/,
  })) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  expect(checkbox.labels?.[0]?.textContent).toContain(
    "偏好已开启，受总开关限制",
  );
});

test("human-decided merge switch defaults on, explains risk, survives failed save and reloads the saved value", async () => {
  let enabled: boolean | undefined;
  const save = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockImplementation(async (_project, next) => {
      enabled = next;
    });
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      ...(enabled === undefined
        ? {}
        : { pm_confirm_human_decided_merges: enabled }),
    }),
    setPmConfirmHumanDecidedMerges: save,
  });
  const view = render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "授权", exact: true }));
  const toggle = (await screen.findByRole("checkbox", {
    name: /人已拍板的改动由 PM 核对后确认合并/,
  })) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(screen.getByText(/核对不符、超出批准/)).toBeTruthy();
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: /人已拍板的改动由 PM 核对后确认合并/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  );
  expect(save.mock.calls[0]?.slice(0, 2)).toEqual(["p-1", false]);
  expect(save.mock.calls[1]?.[2]).toBe(save.mock.calls[0]?.[2]);
  view.unmount();
  render(<SettingsPage projectId="p-1" client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "授权", exact: true }));
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: /人已拍板的改动由 PM 核对后确认合并/,
      })) as HTMLInputElement
    ).checked,
  ).toBe(false);
});

test("human-decided merge HTTP setting includes a real boolean and idempotency key", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  await new HttpCardiganClient(fetcher).setPmConfirmHumanDecidedMerges(
    "p-1",
    false,
    "human-merge-off",
  );
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/p-1/preferences");
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
    pm_confirm_human_decided_merges: false,
  });
  expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({
    "Idempotency-Key": "human-merge-off",
  });
});

test("A3b pause switch waits for server confirmation, preserves state on denial and retries", async () => {
  const toggle = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  let paused = false;
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      auto_merge_paused: paused,
    }),
    setAutoMergePaused: async (...args) => {
      await toggle(...args);
      paused = args[1];
    },
  });
  render(<SettingsPage projectId="p-1" client={client} />);
  const checkbox = (await screen.findByRole("checkbox", {
    name: /暂停自动合并/,
  })) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(checkbox.checked).toBe(false);
  const key = toggle.mock.calls[0]?.[2];
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(toggle.mock.calls[1]).toEqual(["p-1", true, key]);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  expect(toggle.mock.calls[2]?.[1]).toBe(false);
  expect(screen.getByText(/默认不暂停，只有你能修改/)).toBeTruthy();
});

test("A3b HTTP client writes only the pause preference", async () => {
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  const http = new HttpCardiganClient(fetcher);
  await http.setAutoMergePaused("p-1", true, "pause-key");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    body: '{"auto_merge_paused":true}',
  });
});

test("A3b committed response loss, refresh and reverse switches never replay an old operation", async () => {
  let paused = false;
  let loseResponse = true;
  const responses = new Set<string>();
  const calls: { value: boolean; key: string; replay: boolean }[] = [];
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      auto_merge_paused: paused,
    }),
    setAutoMergePaused: async (_project, value, key) => {
      const replay = responses.has(key);
      calls.push({ value, key, replay });
      if (replay) return;
      paused = value;
      responses.add(key);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Response lost after commit");
      }
    },
  });
  const view = render(<SettingsPage projectId="p-1" client={client} />);
  const checkbox = (await screen.findByRole("checkbox", {
    name: /暂停自动合并/,
  })) as HTMLInputElement;
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(paused).toBe(true);
  expect(checkbox.checked).toBe(false);
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={1} />);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect(calls).toHaveLength(3));
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(paused).toBe(true);
  expect(calls.map((c) => c.replay)).toEqual([false, false, false]);
  expect(new Set(calls.map((c) => c.key)).size).toBe(3);
});

test("A3b observing a committed operation retires its key even if another session reverses it", async () => {
  let paused = false;
  const keys: string[] = [];
  const responses = new Set<string>();
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      auto_merge_paused: paused,
    }),
    setAutoMergePaused: async (_project, value, key) => {
      keys.push(key);
      if (responses.has(key)) return;
      paused = value;
      responses.add(key);
      if (keys.length === 1) throw new Error("Committed response lost");
    },
  });
  const view = render(<SettingsPage projectId="p-1" client={client} />);
  const checkbox = (await screen.findByRole("checkbox", {
    name: /暂停自动合并/,
  })) as HTMLInputElement;
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={1} />);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  paused = false;
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={2} />);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect(keys).toHaveLength(2));
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(paused).toBe(true);
  expect(keys[1]).not.toBe(keys[0]);
});

test("cross-card read switch waits for server confirmation, preserves state on denial and retries", async () => {
  const toggle = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  let paused = true;
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      cross_card_read: paused,
    }),
    setCrossCardRead: async (...args) => {
      await toggle(...args);
      paused = args[1];
    },
  });
  render(<SettingsPage projectId="p-1" client={client} />);
  const checkbox = (await screen.findByRole("checkbox", {
    name: /跨卡只读/,
  })) as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(checkbox.checked).toBe(true);
  const key = toggle.mock.calls[0]?.[2];
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  expect(toggle.mock.calls[1]).toEqual(["p-1", false, key]);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(toggle.mock.calls[2]?.[1]).toBe(true);
  expect(screen.getByText(/默认开启，所有角色可读取/)).toBeTruthy();
});

test("cross-card HTTP client writes only the pause preference", async () => {
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  const http = new HttpCardiganClient(fetcher);
  await http.setCrossCardRead("p-1", true, "pause-key");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    body: '{"cross_card_read":true}',
  });
});
