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
import { App } from "../App.js";
import { HttpCardiganClient } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { SettingsPage } from "./SettingsPage.js";
import { resetSettingWrites } from "./useSettingWrite.js";

// Radix tooltips and form-bound switches measure with ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const on = (control: HTMLElement) =>
  control.getAttribute("aria-checked") === "true";
/** Long explanations live in the row's help tooltip (keyboard focus opens it). */
async function help(name: string) {
  fireEvent.focus(screen.getByRole("button", { name: `${name}说明` }));
  return (await screen.findAllByText(/./, { selector: "[role=tooltip]" }))
    .map((node) => node.textContent)
    .join("");
}

test("the independent review link opens authorization directly", async () => {
  window.location.hash = "#/p/p-1/settings?tab=authorization";
  render(<App client={fakeClient()} />);
  expect(
    await screen.findByRole("switch", { name: /合并由 PM 代确认/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "授权" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(await help("授权")).toMatch(/原先保存的值不再控制新流程/);
});

test.each([
  ["forbidden_tool", "没有权限执行此操作。"],
  ["unauthorized", "没有权限执行此操作。"],
  ["origin_required", "请求被拒绝（来源校验未通过）。"],
  ["origin_rejected", "请求被拒绝（来源校验未通过）。"],
])(
  "auto-merge preserves server state after HTTP 403/%s",
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
          setAutoMerge: (...args) => http.setAutoMerge(...args),
        })}
      />,
    );
    const toggle = await screen.findByRole("switch", { name: "自动合并" });
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(on(toggle)).toBe(false);
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  },
);

test.each(
  [1, 4, 5].flatMap((flow_version) =>
    ([undefined, "off", "on"] as const).map((value) => ({
      flow_version,
      value,
    })),
  ),
)(
  "auto-merge displays $value at flow $flow_version without conflating inherited and disabled states",
  async ({ value, flow_version }) => {
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            flow_version,
            ...(value ? { auto_merge: value } : {}),
          }),
        })}
      />,
    );
    const toggle = await screen.findByRole("switch", { name: "自动合并" });
    expect(on(toggle)).toBe(
      value === "on" || (value === undefined && flow_version >= 4),
    );
    const status =
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent ?? "";
    expect(status).toContain(
      value === undefined
        ? flow_version >= 4
          ? "未设置，按流程级别由系统合并"
          : "未设置，按各卡流程级别处理"
        : value === "on"
          ? "已开启"
          : "已关闭",
    );
    if (value === undefined) expect(status).not.toContain("已关闭");
    expect(await help("自动合并")).toMatch(
      /未设置时，第 4 级及以上的卡按流程级别由系统合并/,
    );
  },
);

test.each([1, 4, 5])(
  "an unset auto-merge preference at flow %s can be disabled directly without first enabling Flow Lite",
  async (flow_version) => {
    let value: "off" | undefined;
    const fetcher = vi.fn().mockImplementation(async () => {
      value = "off";
      return new Response("{}");
    });
    const http = new HttpCardiganClient(fetcher);
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            flow_version,
            ...(value ? { auto_merge: value } : {}),
          }),
          setAutoMerge: (...args) => http.setAutoMerge(...args),
        })}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "关闭自动合并", exact: true }),
    );
    await screen.findByText("已关闭");
    const toggle = screen.getByRole("switch", { name: "自动合并" });
    expect(on(toggle)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ auto_merge: "off" }),
    });
    expect(
      screen.queryByRole("button", { name: "关闭自动合并", exact: true }),
    ).toBeNull();
  },
);

test("the inherited flow-four switch writes off when turned off", async () => {
  let value: "off" | undefined;
  const save = vi.fn(async () => {
    value = "off";
  });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          flow_version: 4,
          ...(value ? { auto_merge: value } : {}),
        }),
        setAutoMerge: save,
      })}
    />,
  );
  const toggle = await screen.findByRole("switch", { name: "自动合并" });
  expect(on(toggle)).toBe(true);
  fireEvent.click(toggle);
  await screen.findByText("已关闭");
  expect(save).toHaveBeenCalledExactlyOnceWith(
    "p-1",
    false,
    expect.any(String),
  );
});

test("auto-merge retries the same operation, reloads saved values and uses a fresh key when reversed", async () => {
  let enabled = false;
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
      auto_merge: enabled ? "on" : "off",
    }),
    setAutoMerge: save,
  });
  render(<SettingsPage projectId="p-1" client={client} />);
  const toggle = await screen.findByRole("switch", { name: "自动合并" });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(on(toggle)).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(true));
  expect(save.mock.calls[0]?.slice(0, 2)).toEqual(["p-1", true]);
  expect(save.mock.calls[1]?.[2]).toBe(save.mock.calls[0]?.[2]);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(save.mock.calls[2]?.slice(0, 2)).toEqual(["p-1", false]);
  expect(save.mock.calls[2]?.[2]).not.toBe(save.mock.calls[1]?.[2]);
});

test.each([true, false])(
  "auto-merge HTTP client writes only the %s preference through the human endpoint",
  async (enabled) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    await new HttpCardiganClient(fetcher).setAutoMerge(
      "p-1",
      enabled,
      "auto-key",
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/p-1/preferences");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ auto_merge: enabled ? "on" : "off" }),
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1].headers).get("Idempotency-Key"),
    ).toBe("auto-key");
  },
);

afterEach(() => {
  cleanup();
  resetSettingWrites();
  window.location.hash = "";
});
test("settings navigation opens preferences, default off with editable minutes and the missing-gate warning", async () => {
  window.location.hash = "#/p/p-1/settings";
  render(<App client={fakeClient()} />);
  expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "设置" }).getAttribute("aria-current"),
  ).toBe("page");
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  expect(on(toggle)).toBe(false);
  expect(
    (screen.getByLabelText("等待分钟数") as HTMLInputElement).disabled,
  ).toBe(false);
  expect(
    screen.getByText("没有合并闸门时，自动合并会合并未经全量测试和 e2e 的代码"),
  ).toBeTruthy();
});

test("timeout merge saves instantly, validates, retries with the same idempotency key, then disables", async () => {
  let minutes: number | null = null;
  const setPreferences = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockImplementation(async (_project, value) => {
      minutes = value;
    });
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: minutes,
          merge_gate_enabled: false,
        }),
        setPreferences,
      })}
    />,
  );
  const toggle = await screen.findByRole("switch", { name: "超时自动合并" });
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(on(toggle)).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(true));
  expect(setPreferences.mock.calls[0]?.slice(0, 2)).toEqual(["p-1", 10]);
  expect(setPreferences.mock.calls[1]?.[2]).toBe(
    setPreferences.mock.calls[0]?.[2],
  );
  const input = screen.getByLabelText("等待分钟数") as HTMLInputElement;
  expect(input.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "1.5" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toContain("请输入 1 到 1440");
  fireEvent.blur(input);
  expect(setPreferences).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value: "20" } });
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(input.closest("[data-dirty]")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(3));
  expect(setPreferences.mock.calls[2]?.slice(0, 2)).toEqual(["p-1", 20]);
  await waitFor(() => expect(input.closest("[data-dirty]")).toBeNull());
  expect(screen.getByText("偏好已保存")).toBeTruthy();
  expect(input.value).toBe("20");
  fireEvent.blur(input);
  expect(setPreferences).toHaveBeenCalledTimes(3);
  fireEvent.click(toggle);
  await waitFor(() => expect(on(toggle)).toBe(false));
  expect(setPreferences.mock.calls[3]?.slice(0, 2)).toEqual(["p-1", null]);
  expect(setPreferences.mock.calls[3]?.[2]).not.toBe(
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
  expect(on(await screen.findByRole("switch", { name: "超时自动合并" }))).toBe(
    true,
  );
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
      const toggle = await screen.findByRole("switch", {
        name: `${label} ${before}`,
      });
      toggle.focus();
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement).toBe(toggle);
      expect(await screen.findByText("保存授权中…")).toBeTruthy();
      await act(async () => {
        finish?.();
      });
      const saved = await screen.findByRole("switch", {
        name: `${label} ${after}`,
      });
      expect(on(saved)).toBe(enabled);
      expect(saved.getAttribute("aria-disabled")).toBe("false");
      expect(
        await screen.findByText(
          `${label}：${enabled ? "已授权 PM 代拍" : "已改为由人拍板"}`,
        ),
      ).toBeTruthy();
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
  const process = await screen.findByRole("switch", {
    name: "流程 由 PM 代拍",
  });
  expect(on(process)).toBe(true);
  expect(
    process
      .closest("[data-settings-row]")
      ?.querySelector("svg.status-shape-success"),
  ).toBeTruthy();
  expect(
    screen
      .getAllByText("由人拍板")[0]
      ?.querySelector("svg.status-shape-review"),
  ).toBeTruthy();
  expect(
    on(screen.getByRole("switch", { name: "需求范围变化 由 PM 代拍" })),
  ).toBe(true);
  for (const category of [
    "花钱",
    "账号",
    "删除数据",
    "凭据",
    "对外发布",
    "人标记的敏感卡",
  ]) {
    const toggle = screen.getByRole("switch", {
      name: `${category} 由人拍板`,
    }) as HTMLButtonElement;
    expect(on(toggle)).toBe(false);
    expect(toggle.disabled).toBe(false);
    // C-455: default-human categories sit in the caution group.
    expect(
      toggle.closest("[data-settings-group]")?.getAttribute("data-tone"),
    ).toBe("caution");
  }
  for (const category of ["权限"]) {
    const toggle = screen.getByRole("switch", {
      name: `${category} 由 PM 代拍`,
    });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(
      toggle
        .closest("[data-settings-row]")
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
  await screen.findByRole("switch", { name: "超时自动合并" });
  fireEvent.click(authorization);
  expect(authorization.getAttribute("aria-current")).toBe("page");
  expect(
    screen.getByRole("heading", { name: "授权", exact: true }),
  ).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "超时自动合并" })).toBeNull();
  expect(screen.getByRole("switch", { name: "流程 由 PM 代拍" })).toBeTruthy();
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
  expect(screen.getByRole("switch", { name: "超时自动合并" })).toBeTruthy();
  expect(screen.queryByRole("table", { name: "项目卡片模板" })).toBeNull();
  fireEvent.click(roles);
  await screen.findByText("本项目还没有登记角色。");
  expect(screen.queryByRole("switch", { name: "超时自动合并" })).toBeNull();
  fireEvent.click(authorization);
  expect(screen.getByRole("switch", { name: "流程 由 PM 代拍" })).toBeTruthy();
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
  const toggle = await screen.findByRole("switch", {
    name: "合并由 PM 代确认 由 PM 代确认",
  });
  expect(on(toggle)).toBe(true);
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
  expect(await help("PM 合并确认停留告警")).toMatch(
    /PM 持有的合并确认在合并检查出结论后，超过这么久还没处理，就提醒 PM Ops/,
  );
  fireEvent.change(input, { target: { value: "0" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.blur(input);
  expect(setMergeConfirmStallAfter).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.blur(input);
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
  for (const bad of ["0", "21", "1.5"]) {
    fireEvent.change(independent, { target: { value: bad } });
    expect(independent.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("请输入 1 到 20 的整数轮数。")).toBeTruthy();
    fireEvent.keyDown(independent, { key: "Enter" });
  }
  expect(setReviewMaxRounds).not.toHaveBeenCalled();
  for (const ok of ["11", "20"]) {
    fireEvent.change(independent, { target: { value: ok } });
    expect(independent.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("请输入 1 到 20 的整数轮数。")).toBeNull();
  }
  fireEvent.change(independent, { target: { value: "4" } });
  fireEvent.keyDown(independent, { key: "Enter" });
  await waitFor(() => expect(setReviewMaxRounds).toHaveBeenCalledTimes(1));
  expect(setReviewMaxRounds.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "independent",
    4,
  ]);
  fireEvent.change(review, { target: { value: "7" } });
  fireEvent.blur(review);
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
  await screen.findByRole("switch", { name: "超时自动合并" });
  expect(screen.queryByLabelText("普通审核轮数上限（轮）")).toBeNull();
  expect(screen.queryByLabelText("独立复核轮数上限（轮）")).toBeNull();
});

test("hidden preferences suppress validation feedback and retain the draft when returning", async () => {
  render(
    <SettingsPage
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: 30,
          merge_gate_enabled: false,
        }),
      })}
      projectId="p-1"
    />,
  );
  const enabled = await screen.findByRole("switch", { name: "超时自动合并" });
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
    expect(on(enabled)).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("请输入 1 到 1440");
  }
});

test.each([
  ["偏好", "setPreferences", "等待分钟数"],
  ["授权", "setDelegation", "流程 由 PM 代拍"],
  ["授权", "setPmMergeConfirmation", "合并由 PM 代确认 由 PM 代确认"],
] as const)(
  "%s hides pending and late %s errors outside its tab without losing the form",
  async (tab, method, control) => {
    const request = Promise.withResolvers<void>();
    const save = vi.fn(() => request.promise);
    render(
      <SettingsPage
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: 30,
            merge_gate_enabled: false,
          }),
          [method]: save,
        })}
        projectId="p-1"
      />,
    );
    const minutes = (await screen.findByLabelText(
      "等待分钟数",
    )) as HTMLInputElement;
    fireEvent.change(minutes, { target: { value: "23" } });
    fireEvent.click(screen.getByRole("button", { name: tab, exact: true }));
    if (method === "setPreferences")
      fireEvent.keyDown(screen.getByLabelText(control), { key: "Enter" });
    else fireEvent.click(screen.getByRole("switch", { name: control }));
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
  expect(await help("合并确认默认暂缓时长")).toMatch(
    /PM 或人暂缓一条合并确认时，没有填到期时间就用这个时长/,
  );
  fireEvent.change(input, { target: { value: "0" } });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.keyDown(input, { key: "Enter" });
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
  expect(screen.getByText(/默认 72 小时/)).toBeTruthy();
  for (const value of ["59", "10081", "60.5"]) {
    fireEvent.change(input, { target: { value } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(input);
  }
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "60" } });
  expect(input.getAttribute("aria-invalid")).toBeNull();
  fireEvent.change(input, { target: { value: "10080" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith("p-1", 10080, expect.any(String)),
  );
});

test("C-237 system toggles are independent, off initially, and numeric settings have no defaults", async () => {
  const setSystemRules = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setSystemRules })} />,
  );
  const assign = await screen.findByRole("switch", { name: "自动指派验证项" });
  const remind = screen.getByRole("switch", { name: "催办提醒" });
  expect(on(assign)).toBe(false);
  expect(on(remind)).toBe(false);
  fireEvent.click(assign);
  await waitFor(() =>
    expect(setSystemRules).toHaveBeenCalledWith(
      "p-1",
      { system_auto_assign_verifiers: true },
      expect.any(String),
    ),
  );
  expect(screen.getByText("未设置")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑催办阈值" }));
  const dialog = await screen.findByRole("dialog", { name: "催办阈值" });
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "设置催办阈值和允许范围" }),
  );
  const fields = within(dialog).getAllByRole("spinbutton");
  expect(fields).toHaveLength(8);
  for (const field of fields)
    expect((field as HTMLInputElement).value).toBe("");
});

test("C-455 reminder thresholds save together from the dialog without resending the switches", async () => {
  const setSystemRules = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsPage
      projectId="p-1"
      client={fakeClient({
        preferences: async () => ({
          auto_merge_after_minutes: null,
          merge_gate_enabled: true,
          system_auto_assign_verifiers: true,
          system_reminders: true,
        }),
        setSystemRules,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "编辑催办阈值" }));
  const dialog = await screen.findByRole("dialog", { name: "催办阈值" });
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "设置催办阈值和允许范围" }),
  );
  fireEvent.click(within(dialog).getByRole("switch", { name: "重复提醒" }));
  fireEvent.change(within(dialog).getByLabelText("允许的最少分钟数"), {
    target: { value: "5" },
  });
  fireEvent.change(within(dialog).getByLabelText(/重复提醒间隔/), {
    target: { value: "30" },
  });
  expect(setSystemRules).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存催办阈值" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(setSystemRules).toHaveBeenCalledExactlyOnceWith(
    "p-1",
    {
      system_reminder_policy: expect.objectContaining({
        min_minutes: 5,
        max_minutes: null,
        repeat_interval_minutes: 30,
        repeat: true,
      }),
    },
    expect.any(String),
  );
});

test("C-455 a failed reminder-threshold save stays in the dialog with its draft", async () => {
  const setSystemRules = vi
    .fn()
    .mockRejectedValueOnce(new Error("阈值保存失败"))
    .mockResolvedValue(undefined);
  render(
    <SettingsPage projectId="p-1" client={fakeClient({ setSystemRules })} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "编辑催办阈值" }));
  const dialog = await screen.findByRole("dialog", { name: "催办阈值" });
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "设置催办阈值和允许范围" }),
  );
  const field = within(dialog).getByLabelText(
    "允许的最少分钟数",
  ) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "7" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存催办阈值" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "阈值保存失败",
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(field.value).toBe("7");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存催办阈值" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(setSystemRules).toHaveBeenCalledTimes(2);
  // The retry of the same failed operation reuses its idempotency key.
  expect(setSystemRules.mock.calls[1]?.[2]).toBe(
    setSystemRules.mock.calls[0]?.[2],
  );
});

test.each([false, true])(
  "Flow Lite retires ineffective authorization controls even when legacy values are %s",
  async (enabled) => {
    const saveRole = vi.fn(),
      saveHuman = vi.fn(),
      saveRounds = vi.fn();
    render(
      <SettingsPage
        projectId="p-1"
        client={fakeClient({
          preferences: async () => ({
            auto_merge_after_minutes: null,
            merge_gate_enabled: true,
            pm_merge_confirmation: false,
            auto_merge: "on",
            pm_confirm_role_rule_implementations: enabled,
            pm_confirm_human_decided_merges: enabled,
            independent_review_limit_delegation: enabled,
          }),
          setPmConfirmRoleRuleImplementations: saveRole,
          setPmConfirmHumanDecidedMerges: saveHuman,
          setIndependentReviewLimitDelegation: saveRounds,
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "授权" }));
    await screen.findByRole("switch", { name: /合并由 PM 代确认/ });
    const text = await help("授权");
    expect(text).toMatch(/原先保存的值不再控制新流程/);
    for (const name of [
      /已拍角色正文由 PM 代确认/,
      /人已拍板的改动由 PM 核对后确认合并/,
      /允许后台代批独立复核加一轮/,
    ]) {
      expect(screen.queryByRole("checkbox", { name })).toBeNull();
      expect(screen.queryByRole("switch", { name })).toBeNull();
    }
    expect(text).toMatch(/收回默认交人事项的授权/);
    expect(screen.queryByText(/关闭后这类合并全部由你确认/)).toBeNull();
    expect(
      screen.getByRole("switch", { name: /合并由 PM 代确认/ }).textContent,
    ).toBe("");
    expect(
      screen.getByRole("switch", {
        name: "合并由 PM 代确认 PM 代确认已关闭",
      }),
    ).toBeTruthy();
    expect(saveRole).not.toHaveBeenCalled();
    expect(saveHuman).not.toHaveBeenCalled();
    expect(saveRounds).not.toHaveBeenCalled();
  },
);

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
  const checkbox = await screen.findByRole("switch", {
    name: "暂停自动合并",
  });
  expect(on(checkbox)).toBe(false);
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(on(checkbox)).toBe(false);
  const key = toggle.mock.calls[0]?.[2];
  fireEvent.click(checkbox);
  await waitFor(() => expect(on(checkbox)).toBe(true));
  expect(toggle.mock.calls[1]).toEqual(["p-1", true, key]);
  fireEvent.click(checkbox);
  await waitFor(() => expect(on(checkbox)).toBe(false));
  expect(toggle.mock.calls[2]?.[1]).toBe(false);
  expect(await help("暂停自动合并")).toMatch(/默认不暂停，只有你能修改/);
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
  const checkbox = await screen.findByRole("switch", {
    name: "暂停自动合并",
  });
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(paused).toBe(true);
  expect(on(checkbox)).toBe(false);
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={1} />);
  await waitFor(() => expect(on(checkbox)).toBe(true));
  fireEvent.click(checkbox);
  await waitFor(() => expect(on(checkbox)).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect(calls).toHaveLength(3));
  await waitFor(() => expect(on(checkbox)).toBe(true));
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
  const checkbox = await screen.findByRole("switch", {
    name: "暂停自动合并",
  });
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={1} />);
  await waitFor(() => expect(on(checkbox)).toBe(true));
  paused = false;
  view.rerender(<SettingsPage projectId="p-1" client={client} revision={2} />);
  await waitFor(() => expect(on(checkbox)).toBe(false));
  fireEvent.click(checkbox);
  await waitFor(() => expect(keys).toHaveLength(2));
  await waitFor(() => expect(on(checkbox)).toBe(true));
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
  const checkbox = await screen.findByRole("switch", {
    name: "跨卡只读",
  });
  expect(on(checkbox)).toBe(true);
  fireEvent.click(checkbox);
  await screen.findByRole("alert");
  expect(on(checkbox)).toBe(true);
  const key = toggle.mock.calls[0]?.[2];
  fireEvent.click(checkbox);
  await waitFor(() => expect(on(checkbox)).toBe(false));
  expect(toggle.mock.calls[1]).toEqual(["p-1", false, key]);
  fireEvent.click(checkbox);
  await waitFor(() => expect(on(checkbox)).toBe(true));
  expect(toggle.mock.calls[2]?.[1]).toBe(true);
  expect(
    screen.getByText(/所有角色可读取本项目其它非敏感卡片作参考/),
  ).toBeTruthy();
  expect(await help("跨卡只读")).toMatch(/默认开启，只有你能修改/);
});

test("cross-card HTTP client writes only the pause preference", async () => {
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  const http = new HttpCardiganClient(fetcher);
  await http.setCrossCardRead("p-1", true, "pause-key");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    body: '{"cross_card_read":true}',
  });
});

const focusSettings = [
  {
    name: "跨卡只读",
    method: "setCrossCardRead",
    preference: "cross_card_read",
    initial: true,
  },
  {
    name: "暂停自动合并",
    method: "setAutoMergePaused",
    preference: "auto_merge_paused",
    initial: false,
  },
] as const;

test.each(focusSettings)(
  "$method preserves focus through pending, denial, retry and success without repeated writes",
  async ({ name, method, preference, initial }) => {
    let value: boolean = initial;
    const requests: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const save = vi.fn(
      async (_project: string, next: boolean, _key: string) => {
        const request = Promise.withResolvers<void>();
        requests.push(request);
        await request.promise;
        value = next;
      },
    );
    const client = fakeClient({
      preferences: async () => ({
        auto_merge_after_minutes: null,
        merge_gate_enabled: true,
        [preference]: value,
      }),
      [method]: save,
    });
    render(<SettingsPage client={client} projectId="p-1" />);
    const checkbox = await screen.findByRole<HTMLButtonElement>("switch", {
      name,
    });
    checkbox.focus();
    fireEvent.click(checkbox);
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(checkbox);
    fireEvent.click(checkbox);
    fireEvent.click(checkbox);
    expect(save).toHaveBeenCalledTimes(1);
    expect(on(checkbox)).toBe(initial);
    await act(async () => requests[0]?.reject(new Error("Save denied")));
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.getAttribute("aria-disabled")).toBe("false");
    expect(on(checkbox)).toBe(initial);
    fireEvent.click(checkbox);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    await act(async () => requests[1]?.resolve());
    await waitFor(() => expect(on(checkbox)).toBe(!initial));
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(checkbox);
    const other = screen.getByRole("button", { name: "并发与容量" });
    other.focus();
    await act(async () => requests[2]?.resolve());
    await waitFor(() => expect(on(checkbox)).toBe(initial));
    expect(document.activeElement).toBe(other);
  },
);

test.each(focusSettings)(
  "$method ignores responses after project changes and unmount",
  async ({ name, method, preference, initial }) => {
    const requests: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const preferences = vi.fn(async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: true,
      [preference]: initial,
    }));
    const save = vi.fn(() => {
      const request = Promise.withResolvers<void>();
      requests.push(request);
      return request.promise;
    });
    const client = fakeClient({ preferences, [method]: save });
    const view = render(<SettingsPage client={client} projectId="p-1" />);
    fireEvent.click(await screen.findByRole("switch", { name }));
    view.rerender(<SettingsPage client={client} projectId="p-2" />);
    const checkbox = await screen.findByRole<HTMLButtonElement>("switch", {
      name,
    });
    checkbox.focus();
    await act(async () => requests[0]?.resolve());
    expect(document.activeElement).toBe(checkbox);
    expect(on(checkbox)).toBe(initial);
    expect(preferences.mock.calls).toEqual([["p-1"], ["p-2"]]);
    fireEvent.click(checkbox);
    view.unmount();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    try {
      await act(async () => requests[1]?.resolve());
      expect(document.activeElement).toBe(other);
      expect(preferences.mock.calls).toEqual([["p-1"], ["p-2"]]);
    } finally {
      other.remove();
    }
  },
);
