// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DecisionHistoryRecord } from "../api.js";
import { changeControl } from "../testing/controls.js";
import { fakeClient } from "../testing/fixtures.js";
import { DecisionHistoryPage } from "./DecisionHistoryPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
const records = () =>
  screen
    .getAllByRole("row")
    .filter((row) => row.getAttribute("aria-label")?.startsWith("拍板记录 "));
const record: DecisionHistoryRecord = {
  id: "Q-1",
  question: "是否继续",
  status: "resolved",
  blocking: false,
  decider: "role:pm",
  category: "general",
  affected_cards: ["C-1"],
  decision_maker: "pm",
  recommended: "go",
  options: [{ key: "go", description: "继续开发", impact: "安排下一轮" }],
  resolution: {
    option: "go",
    rationale: "符合授权",
    raw_quote: "符合授权",
    at: "2026-11-10T00:00:00Z",
    resolved_by: "assignment:A-4",
    via: "delegated",
    proxy_authority: "project:p-1/default-decision-delegation/general",
  },
};

test("history shows the record row, and the drawer shows option, rationale and authority; all five filters persist in the route", async () => {
  const decisionHistory = vi.fn(async () => ({
    decisions: [record],
    next_cursor: null,
  }));
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  const row = await screen.findByRole("row", { name: "拍板记录 Q-1" });
  expect(row.textContent).toContain("继续开发");
  expect(row.textContent).toContain("PM 代拍");
  expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "是否继续" }));
  const drawer = await screen.findByRole("dialog");
  expect(drawer.textContent).toContain("符合授权");
  expect(drawer.textContent).toContain("授权依据");
  expect(drawer.textContent).toContain(
    "project:p-1/default-decision-delegation/general",
  );
  expect(window.location.hash).toContain("decision=Q-1");
  fireEvent.keyDown(drawer, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.location.hash).not.toContain("decision=");
  changeControl(screen.getByLabelText("决定人：全部"), {
    target: { value: "pm" },
  });
  changeControl(screen.getByLabelText("类别：全部"), {
    target: { value: "general" },
  });
  changeControl(screen.getByLabelText("卡片"), { target: { value: "C-1" } });
  changeControl(screen.getByLabelText("开始日期"), {
    target: { value: "2026-11-01" },
  });
  changeControl(screen.getByLabelText("结束日期"), {
    target: { value: "2026-11-10" },
  });
  await waitFor(() =>
    expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {
      decider: "pm",
      category: "general",
      card_id: "C-1",
      from: expect.stringContaining("2026-"),
      to: expect.stringContaining("2026-"),
    }),
  );
  expect(window.location.hash).toContain("decision-history?");
  expect(window.location.hash).toContain("card_id=C-1");
});

test("empty and failed history queries have readable states", async () => {
  render(<DecisionHistoryPage projectId="p-1" client={fakeClient()} />);
  expect(await screen.findByText("没有拍板记录")).toBeTruthy();
  expect(screen.queryByText(/已显示全部/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  cleanup();
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => {
          throw new Error("offline");
        },
      })}
    />,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

test("human decision records display the owner's profile instead of the raw human author", async () => {
  const { container } = render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [
            {
              ...record,
              decision_maker: "human",
              decider: "human",
              resolution: {
                ...record.resolution,
                resolved_by: "human",
                via: "needs_you",
                author_display: "邵杰",
                member: {
                  id: "M-1",
                  name: "邵杰",
                  title: "所有者",
                  avatar: "/avatars/v1/liu-bei/head-64.webp",
                },
              },
            },
          ],
          next_cursor: null,
        }),
      })}
    />,
  );
  expect(await screen.findByText("邵杰")).toBeTruthy();
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "/avatars/v1/liu-bei/head-64.webp",
  );
  expect(screen.queryByText(/^(你|人|human)$/)).toBeNull();
});

const many = (n: number, from = 0): DecisionHistoryRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    ...record,
    id: `Q-${from + i + 1}`,
    question: `问题 ${from + i + 1}`,
    // Newest first, as the server returns them.
    resolution: {
      ...record.resolution,
      at: new Date(Date.UTC(2026, 10, 10) - (from + i) * 60_000).toISOString(),
    },
  }));

test("each record is one table row; the drawer shows options, the plain summary and the full result", async () => {
  const long = "很长的理由。".repeat(40);
  const decisionHistory = vi.fn(async () => ({
    decisions: [
      {
        ...record,
        options: [
          ...record.options,
          { key: "hold", description: "暂缓", impact: "保持现状" },
        ],
        plain_summary: { changed: "继续开发", impact: "无影响", risk: "无" },
        resolution: { ...record.resolution, rationale: long },
      },
    ],
    next_cursor: null,
  }));
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  const row = await screen.findByRole("row", { name: "拍板记录 Q-1" });
  for (const text of [
    "Q-1",
    "是否继续",
    "已拍板",
    "继续开发",
    "PM 代拍",
    "流程",
    "C-1",
  ])
    expect(row.textContent).toContain(text);
  expect(row.querySelector(".employee-title")).toBeNull();
  expect(row.textContent).not.toContain(long);
  const link = screen.getByRole("link", { name: "是否继续" });
  link.focus();
  fireEvent.click(link);
  const drawer = await screen.findByRole("dialog");
  for (const text of [
    "人话概述",
    "继续开发（推荐）（已选）",
    "影响：安排下一轮",
    "暂缓",
    "影响：保持现状",
    long,
    "project:p-1/",
  ])
    expect(drawer.textContent).toContain(text);
  fireEvent.keyDown(drawer, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(link));
  // Opening a record only changes the route, not the server query.
  expect(decisionHistory).toHaveBeenCalledTimes(1);
});

test("refresh defaults to 30 seconds, persists per project and refreshes on demand", async () => {
  const decisionHistory = vi.fn(async () => ({
    decisions: [record],
    next_cursor: null,
  }));
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-1" });
  const interval = screen.getByLabelText("自动刷新");
  expect(interval.textContent).toContain("30 秒");
  changeControl(interval, { target: { value: "0" } });
  expect(localStorage.getItem("cardigan.decision-history.refresh.p-1")).toBe(
    "0",
  );
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  await waitFor(() => expect(decisionHistory).toHaveBeenCalledTimes(2));
  localStorage.clear();
});

test("shows the newest 10, loads 10 more at a time, and stops on the last page", async () => {
  const decisionHistory = vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) =>
      cursor === undefined
        ? { decisions: many(10), next_cursor: "c1" }
        : cursor === "c1"
          ? { decisions: many(10, 10), next_cursor: "c2" }
          : { decisions: many(3, 20), next_cursor: null },
  );
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-10" });
  expect(records()).toHaveLength(10);
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {});
  expect(screen.queryByText(/已显示全部/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-20" });
  expect(records()).toHaveLength(20);
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {}, "c1");
  expect(screen.queryByText(/已显示全部/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-23" });
  expect(records()).toHaveLength(23);
  expect(screen.getByText("已显示全部 23 条")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("exactly 10 records show no load-more button", async () => {
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: many(10),
          next_cursor: null,
        }),
      })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-10" });
  expect(screen.getByText("已显示全部 10 条")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("changing a filter starts again from the newest 10 of the filtered records", async () => {
  const decisionHistory = vi.fn(
    async (_p: string, f: Readonly<Record<string, string>>, cursor?: string) =>
      f.decider === "human"
        ? { decisions: many(2, 100), next_cursor: null }
        : cursor
          ? { decisions: many(10, 10), next_cursor: null }
          : { decisions: many(10), next_cursor: "c1" },
  );
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-10" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-20" });
  changeControl(screen.getByLabelText("决定人：全部"), {
    target: { value: "human" },
  });
  await screen.findByRole("row", { name: "拍板记录 Q-101" });
  expect(records()).toHaveLength(2);
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", { decider: "human" });
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("a refresh keeps loaded pages and a failed load-more can be retried", async () => {
  let fail = true;
  const decisionHistory = vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) => {
      if (!cursor) return { decisions: many(10), next_cursor: "c1" };
      if (fail) throw new Error("offline");
      return { decisions: many(5, 10), next_cursor: null };
    },
  );
  const client = fakeClient({ decisionHistory });
  const { rerender } = render(
    <DecisionHistoryPage projectId="p-1" client={client} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-10" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("row", { name: "拍板记录 Q-15" });
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  await waitFor(() => expect(decisionHistory).toHaveBeenCalledTimes(4));
  expect(records()).toHaveLength(15);
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("a refresh after new decisions keeps the whole loaded range without gaps", async () => {
  // Server double: newest first, 10 per page, cursor = last id on the page.
  let total = 30;
  const decisionHistory = vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) => {
      // Distinct times, so the order is by time as on the real server.
      const all = many(total)
        .map((q, i) => ({
          ...q,
          resolution: {
            ...q.resolution,
            at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
          },
        }))
        .reverse();
      const start = cursor ? all.findIndex((q) => q.id === cursor) + 1 : 0;
      const decisions = all.slice(start, start + 10);
      return {
        decisions,
        next_cursor:
          start + 10 < all.length ? (decisions.at(-1)?.id ?? null) : null,
      };
    },
  );
  const client = fakeClient({ decisionHistory });
  const ids = () =>
    screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-label"))
      .map((a) => a.getAttribute("aria-label")?.replace("拍板记录 ", ""));
  const { rerender } = render(
    <DecisionHistoryPage projectId="p-1" client={client} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-21" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-11" });
  total = 31;
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-31" });
  // Contiguous from the newest record down past the old last one (Q-11).
  const after = ids();
  expect(after).toEqual(
    Array.from({ length: after.length }, (_, i) => `Q-${31 - i}`),
  );
  expect(after.length).toBeGreaterThanOrEqual(21);
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-1" });
  expect(ids()).toEqual(Array.from({ length: 31 }, (_, i) => `Q-${31 - i}`));
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("a refresh with only the first page loaded stays at the newest 10", async () => {
  let total = 15;
  const decisionHistory = vi.fn(async () => ({
    decisions: many(total).reverse().slice(0, 10),
    next_cursor: "more",
  }));
  const client = fakeClient({ decisionHistory });
  const { rerender } = render(
    <DecisionHistoryPage projectId="p-1" client={client} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-6" });
  total = 16;
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-16" });
  expect(records()).toHaveLength(10);
  expect(decisionHistory).toHaveBeenCalledTimes(2);
});
