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
    .getAllByRole("row", { hidden: true })
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
    "继续开发（推荐，已选）",
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

test("a decision link opens its drawer when loaded and is dropped when it is not", async () => {
  window.location.hash = "#/p/p-1/decision-history?decision=Q-1";
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [record],
          next_cursor: null,
        }),
      })}
    />,
  );
  expect((await screen.findByRole("dialog")).textContent).toContain("符合授权");
  cleanup();
  window.location.hash = "#/p/p-1/decision-history?decision=Q-99";
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [record],
          next_cursor: null,
        }),
      })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-1" });
  await waitFor(() =>
    expect(window.location.hash).not.toContain("decision=Q-99"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("refresh waits for a pending load-more so the appended page is kept", async () => {
  let release: () => void = () => {};
  const decisionHistory = vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) => {
      if (!cursor) return { decisions: many(10), next_cursor: "c1" };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { decisions: many(3, 10), next_cursor: null };
    },
  );
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-10" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await waitFor(() => expect(decisionHistory).toHaveBeenCalledTimes(2));
  const refresh = screen.getByRole("button", { name: "立即刷新" });
  expect(refresh.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(refresh);
  expect(decisionHistory).toHaveBeenCalledTimes(2);
  release();
  await screen.findByRole("row", { name: "拍板记录 Q-13" });
  expect(records()).toHaveLength(13);
});

/** Server double: newest first, 10 per page, cursor = last id on the page. */
function pagedHistory(total: () => number) {
  return vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) => {
      const all = many(total())
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
}

test("load-more waits while a refresh is in flight, so the refresh cannot drop the appended page", async () => {
  const server = pagedHistory(() => 23);
  let hold: Promise<void> | undefined;
  const decisionHistory = vi.fn(
    async (p: string, f: Readonly<Record<string, string>>, cursor?: string) => {
      if (hold && !cursor) await hold;
      return server(p, f, cursor);
    },
  );
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-14" });
  let release: () => void = () => {};
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  const more = screen.getByRole("button", { name: "加载更多" });
  await waitFor(() => expect(more.getAttribute("aria-disabled")).toBe("true"));
  fireEvent.click(more);
  expect(decisionHistory.mock.calls.some(([, , cursor]) => cursor)).toBe(false);
  hold = undefined;
  release();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "加载更多" })
        .getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("row", { name: "拍板记录 Q-4" });
  expect(records()).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  await waitFor(() =>
    expect(decisionHistory.mock.calls.filter(([, , c]) => !c)).toHaveLength(3),
  );
  await waitFor(() => expect(records()).toHaveLength(20));
});

test("a revision refresh during load-more runs afterwards and re-reads the whole loaded range", async () => {
  let total = 23;
  const server = pagedHistory(() => total);
  let release: () => void = () => {};
  let hold: Promise<void> | undefined;
  const decisionHistory = vi.fn(
    async (p: string, f: Readonly<Record<string, string>>, cursor?: string) => {
      if (hold && cursor) await hold;
      return server(p, f, cursor);
    },
  );
  const client = fakeClient({ decisionHistory });
  const { rerender } = render(
    <DecisionHistoryPage projectId="p-1" client={client} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-14" });
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await waitFor(() => expect(decisionHistory).toHaveBeenCalledTimes(2));
  total = 24;
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  // The refresh waits for the pending page instead of racing it.
  expect(decisionHistory).toHaveBeenCalledTimes(2);
  hold = undefined;
  release();
  await screen.findByRole("row", { name: "拍板记录 Q-24" });
  // Contiguous through the page holding the old oldest record (Q-4).
  await waitFor(() => expect(records()).toHaveLength(24));
  expect(
    records().map((row) => row.getAttribute("aria-label")?.slice(5)),
  ).toEqual(Array.from({ length: 24 }, (_, i) => `Q-${24 - i}`));
});

test("the open record stays open when a refresh moves it past the loaded range", async () => {
  let total = 30;
  const decisionHistory = pagedHistory(() => total);
  const client = fakeClient({ decisionHistory });
  const { rerender } = render(
    <DecisionHistoryPage projectId="p-1" client={client} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-21" });
  fireEvent.click(screen.getByRole("link", { name: "问题 21" }));
  expect((await screen.findByRole("dialog")).textContent).toContain("问题 21");
  total = 31;
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  await screen.findByRole("row", { name: "拍板记录 Q-31", hidden: true });
  expect(screen.getByRole("dialog").textContent).toContain("问题 21");
  // The drawer stays open and the next page is read for its current version.
  await screen.findByRole("row", { name: "拍板记录 Q-21", hidden: true });
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {}, "Q-22");
  expect(screen.getByRole("dialog").textContent).toContain("问题 21");
  expect(window.location.hash).toContain("decision=Q-21");
});

test("a link to a record on a later page reads pages until it is found", async () => {
  window.location.hash = "#/p/p-1/decision-history?decision=Q-11";
  const decisionHistory = pagedHistory(() => 30);
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  expect((await screen.findByRole("dialog")).textContent).toContain("问题 11");
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {}, "Q-21");
  expect(records()).toHaveLength(20);
});

test("dropping an invalid decision link replaces the history entry", async () => {
  window.location.hash = "#/p/p-1/cards";
  window.location.hash = "#/p/p-1/decision-history?decision=Q-123";
  const length = window.history.length;
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [record],
          next_cursor: null,
        }),
      })}
    />,
  );
  await waitFor(() =>
    expect(window.location.hash).toBe("#/p/p-1/decision-history"),
  );
  expect(window.history.length).toBe(length);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("merge confirmations keep the saved option description in the detail", async () => {
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [
            {
              ...record,
              question: "Merge C-1 into main?",
              trigger: "merge_confirmation",
              recommended: "merge",
              options: [
                {
                  key: "merge",
                  description: "合并已通过验收的交付",
                  impact: "合入主分支",
                },
              ],
              resolution: { ...record.resolution, option: "merge" },
            },
          ],
          next_cursor: null,
        }),
      })}
    />,
  );
  const row = await screen.findByRole("row", { name: "拍板记录 Q-1" });
  expect(row.textContent).toContain("确认合并");
  fireEvent.click(
    screen.getByRole("link", { name: "确认把 C-1 合并到 main？" }),
  );
  const drawer = await screen.findByRole("dialog");
  expect(drawer.textContent).toContain("确认合并（推荐，已选）");
  expect(drawer.textContent).toContain("合并已通过验收的交付");
});

test("several cards in one record are grouped in a spaced identity row", async () => {
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [{ ...record, card_id: "C-1", affected_cards: ["C-2"] }],
          next_cursor: null,
        }),
      })}
    />,
  );
  const row = await screen.findByRole("row", { name: "拍板记录 Q-1" });
  const cell = row.querySelector('[data-label="卡片"]');
  const links = cell?.querySelectorAll("a.id-tag") ?? [];
  expect(links).toHaveLength(2);
  for (const link of links)
    expect(link.parentElement?.classList.contains("identity-row")).toBe(true);
});

// V-2078 review scenarios (reviewer attachment-6064), kept as regressions.
test("refresh of an open record still observes revocation after a new record pushes it to page two", async () => {
  let updated = false;
  const initial = many(11);
  const decisionHistory = vi.fn(
    async (
      _p: string,
      _f: Readonly<Record<string, string>>,
      cursor?: string,
    ) => {
      const rows = updated
        ? [
            {
              ...(initial[0] as DecisionHistoryRecord),
              id: "Q-12",
              question: "新记录",
              resolution: { ...record.resolution, at: "2026-11-12T00:00:00Z" },
            },
            ...initial.map((q) =>
              q.id === "Q-10" ? { ...q, status: "revoked" as const } : q,
            ),
          ]
        : initial;
      return {
        decisions: cursor ? rows.slice(10) : rows.slice(0, 10),
        next_cursor: cursor ? null : (rows[9] as DecisionHistoryRecord).id,
      };
    },
  );
  const client = fakeClient({ decisionHistory });
  const ui = (revision: number) => (
    <DecisionHistoryPage projectId="p-1" client={client} revision={revision} />
  );
  const { rerender } = render(ui(0));
  fireEvent.click(await screen.findByRole("link", { name: "问题 10" }));
  expect((await screen.findByRole("dialog")).textContent).toContain("已拍板");
  updated = true;
  rerender(ui(1));
  await screen.findByRole("row", { name: "拍板记录 Q-12", hidden: true });
  rerender(ui(2));
  await waitFor(() =>
    expect(decisionHistory.mock.calls.filter((c) => !c[2]).length).toBe(3),
  );
  await waitFor(() =>
    expect(screen.getByRole("dialog").textContent).toContain("已撤销"),
  );
});
test("a failed load-more must not stop a later route from resolving its own deep link", async () => {
  window.location.hash = "#/p/p-1/decision-history";
  const rows = many(14);
  const decisionHistory = vi.fn(
    async (_p: string, f: Readonly<Record<string, string>>, c?: string) => {
      if (!f.category && c) throw Error("page two error");
      return {
        decisions: c ? rows.slice(10) : rows.slice(0, 10),
        next_cursor: c ? null : "c1",
      };
    },
  );
  const client = fakeClient({ decisionHistory });
  render(<DecisionHistoryPage client={client} projectId="p-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  window.location.hash =
    "#/p/p-1/decision-history?category=general&decision=Q-11";
  await waitFor(() =>
    expect(
      decisionHistory.mock.calls.some(([, f]) => f.category === "general"),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      decisionHistory.mock.calls.filter(
        ([, f, c]) => f.category === "general" && c === "c1",
      ),
    ).toHaveLength(1),
  );
  expect((await screen.findByRole("dialog")).textContent).toContain("问题 11");
});
test("a revision during multi-page lookup does not overlap a refresh with the next page", async () => {
  window.location.hash = "#/p/p-1/decision-history?decision=Q-25";
  const rows = many(29);
  let release2 = () => {},
    release3 = () => {},
    reading3 = false,
    overlapping = false;
  const trace: string[] = [];
  const wait2 = new Promise<void>((r) => {
    release2 = r;
  });
  const wait3 = new Promise<void>((r) => {
    release3 = r;
  });
  const decisionHistory = vi.fn(
    async (_p: string, _f: Readonly<Record<string, string>>, c?: string) => {
      trace.push(c ?? "first");
      if (!c) {
        if (reading3) overlapping = true;
        return { decisions: rows.slice(0, 10), next_cursor: "p2" };
      }
      if (c === "p2") {
        await wait2;
        return { decisions: rows.slice(10, 20), next_cursor: "p3" };
      }
      reading3 = true;
      await wait3;
      reading3 = false;
      return { decisions: rows.slice(20), next_cursor: null };
    },
  );
  const client = fakeClient({ decisionHistory });
  const ui = (revision: number) => (
    <DecisionHistoryPage projectId="p-1" client={client} revision={revision} />
  );
  const { rerender } = render(ui(0));
  await waitFor(() => expect(trace).toEqual(["first", "p2"]));
  rerender(ui(1));
  release2();
  await waitFor(() => expect(trace).toContain("p3"));
  release3();
  await screen.findByRole("dialog");
  expect(overlapping, `requests: ${trace.join(", ")}`).toBe(false);
});
