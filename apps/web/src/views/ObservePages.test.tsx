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
import type { SnapshotData } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { ActivityPage } from "./ActivityPage.js";
import { SnapshotPage } from "./SnapshotPage.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const review = {
  ...card,
  id: "C-2",
  title: "审核卡片",
  status: "review" as const,
  why: "等待审核",
};
const snapshot: SnapshotData = {
  cards: [card, review],
  in_progress: [card],
  in_review: [review],
  waiting: { human: [card.id], agent: [review.id] },
  blocked: [{ card_id: review.id, work_item_id: "W-2", label: "缺少环境" }],
  recent_deliveries: [
    { id: "D-1", card_id: review.id, summary: "审核版本", status: "submitted" },
  ],
};

test.each([
  ["activity", ActivityPage, "cardigan.activity.refresh.p-1"],
  ["snapshot", SnapshotPage, "cardigan.snapshot.refresh.p-1"],
] as const)(
  "%s uses the shared refresh group: 30 s default, per-project choice, single manual request",
  async (method, Page, key) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const defaults = fakeClient();
    const read = vi.fn(defaults[method]);
    render(<Page client={fakeClient({ [method]: read })} projectId="p-1" />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const refresh = screen.getByRole("combobox", { name: "自动刷新" });
    expect(refresh.textContent).toContain("30 秒");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    changeControl(refresh, { target: { value: "0" } });
    expect(localStorage.getItem(key)).toBe("0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  },
);

test.each([
  ["activity", ActivityPage],
  ["snapshot", SnapshotPage],
] as const)(
  "%s timed refresh stays quiet until the slow threshold; manual refresh reports at once",
  async (method, Page) => {
    vi.useFakeTimers();
    const defaults = fakeClient();
    let delay = 0;
    let startedAt = 0;
    const read = vi.fn(
      async (...args: Parameters<typeof defaults.activity>) => {
        startedAt = Date.now();
        const result = await (defaults[method] as typeof defaults.activity)(
          ...args,
        );
        await new Promise((done) => setTimeout(done, delay));
        return result;
      },
    );
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const feedback = () =>
      document.querySelector(".request-feedback")?.textContent ?? "";
    render(<Page client={fakeClient({ [method]: read })} projectId="p-1" />);
    await advance(0);
    expect(read).toHaveBeenCalledTimes(1);
    // A 450 ms background read never announces progress.
    delay = 450;
    await advance(30000);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(startedAt + 110 - Date.now());
    expect(feedback()).toBe("");
    await advance(startedAt + 450 - Date.now());
    expect(feedback()).toBe("");
    // A slow background read reports after one second, as other pages do.
    delay = 1500;
    await advance(30000);
    expect(read).toHaveBeenCalledTimes(3);
    await advance(startedAt + 999 - Date.now());
    expect(feedback()).toBe("");
    await advance(1);
    expect(feedback()).toBe("正在加载…");
    await advance(500);
    expect(feedback()).toBe("");
    // Manual refresh shows progress immediately.
    delay = 450;
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await advance(0);
    expect(read).toHaveBeenCalledTimes(4);
    expect(feedback()).toBe("正在加载…");
  },
);

test("activity toolbar uses labelled single-choice filters and shows clear only when filtered", async () => {
  window.location.hash = "#/p/p-1/activity";
  const activity = vi.fn(fakeClient().activity);
  render(<ActivityPage client={fakeClient({ activity })} projectId="p-1" />);
  await screen.findByText("没有事件");
  for (const label of ["卡片", "发言方", "事件类别", "时间范围"])
    expect(
      screen.getByRole("combobox", { name: `${label}：全部` }).textContent,
    ).toBe(`${label}：全部`);
  expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  changeControl(screen.getByRole("combobox", { name: "发言方：全部" }), {
    target: { value: "pm" },
  });
  await waitFor(() =>
    expect(activity).toHaveBeenLastCalledWith("p-1", { actor: "pm" }),
  );
  await screen.findByText("没有匹配的事件");
  expect(screen.getByRole("button", { name: "移除发言方筛选" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(activity).toHaveBeenLastCalledWith("p-1", {}));
});

test("snapshot groups cards in one table, links header counts and filters by group and search", async () => {
  window.location.hash = "#/p/p-1/snapshot";
  render(
    <SnapshotPage
      client={fakeClient({ snapshot: async () => snapshot })}
      projectId="p-1"
    />,
  );
  const overview = await screen.findByRole("navigation", { name: "项目概览" });
  expect(
    within(overview)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual([
    "等你处理 1",
    "等 Agent 处理 1",
    "进行中 1",
    "审核与待合并 1",
    "阻塞 1",
  ]);
  const groups = screen.getByRole("region", { name: "卡片分组" });
  expect(
    within(groups)
      .getAllByRole("columnheader")
      .map((head) => head.textContent),
  ).toEqual(["编号", "标题", "状态", "下一步", "原因"]);
  expect(
    within(screen.getByRole("rowgroup", { name: "阻塞" })).getByText(
      "缺少环境",
    ),
  ).toBeTruthy();
  changeControl(screen.getByRole("combobox", { name: "分组：全部" }), {
    target: { value: "agent" },
  });
  await waitFor(() =>
    expect(screen.queryByRole("rowgroup", { name: "等你处理" })).toBeNull(),
  );
  expect(screen.getByRole("rowgroup", { name: "等 Agent 处理" })).toBeTruthy();
  // A group filter shows card groups only.
  expect(screen.queryByRole("region", { name: "最近交付" })).toBeNull();
  changeControl(screen.getByRole("combobox", { name: /^分组：/u }), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索标题或编号" }), {
    target: { value: "审核版本" },
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "卡片分组" })).toBeNull(),
  );
  expect(screen.getByRole("region", { name: "最近交付" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索标题或编号" }), {
    target: { value: "不存在" },
  });
  await screen.findByText("没有匹配的卡片");
});
