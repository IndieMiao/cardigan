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
import { fakeClient } from "../testing/fixtures.js";
import { DecisionHistoryPage } from "./DecisionHistoryPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
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

test("history shows option, rationale and authority, and persists all four filters in the route", async () => {
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
  expect(await screen.findByText("所选方案：继续开发")).toBeTruthy();
  expect(screen.getByText(/理由：符合授权/)).toBeTruthy();
  expect(screen.getByText("授权依据")).toBeTruthy();
  expect(
    screen.getByText("project:p-1/default-decision-delegation/general"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("决策人"), {
    target: { value: "pm" },
  });
  fireEvent.change(screen.getByLabelText("类别"), {
    target: { value: "general" },
  });
  fireEvent.change(screen.getByLabelText("卡片"), { target: { value: "C-1" } });
  fireEvent.change(screen.getByLabelText("开始日期"), {
    target: { value: "2026-11-01" },
  });
  fireEvent.change(screen.getByLabelText("结束日期"), {
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
  expect(await screen.findByText("没有符合条件的拍板记录")).toBeTruthy();
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
  }));

test("each record is compact, and expanding it shows impact, rationale and authority in full", async () => {
  const long = "很长的理由。".repeat(40);
  const { container } = render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({
        decisionHistory: async () => ({
          decisions: [
            {
              ...record,
              resolution: { ...record.resolution, rationale: long },
            },
          ],
          next_cursor: null,
        }),
      })}
    />,
  );
  const item = await screen.findByRole("article", { name: "拍板记录 Q-1" });
  // Line 1: id, question, card, maker, category and time.
  const head = item.querySelector("header");
  expect(head?.textContent).toContain("Q-1");
  expect(head?.textContent).toContain("是否继续");
  expect(head?.textContent).toContain("C-1");
  expect(head?.textContent).toContain("PM 代拍");
  // Line 2: chosen option and the recorder, without the job title.
  expect(item.querySelector(".decision-record-choice")?.textContent).toContain(
    "所选方案：继续开发",
  );
  expect(item.querySelector(".employee-title")).toBeNull();
  // Line 3: collapsed one-line summary; the full text is in the details.
  const details = item.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toContain(
    "影响：安排下一轮",
  );
  fireEvent.click(screen.getByText(/影响：安排下一轮/));
  expect(details?.open).toBe(true);
  const detail = item.querySelector("dl")?.textContent ?? "";
  for (const text of ["是否继续", "安排下一轮", long, "project:p-1/"])
    expect(detail).toContain(text);
  expect(container.querySelectorAll(".decision-record")).toHaveLength(1);
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
  await screen.findByRole("article", { name: "拍板记录 Q-10" });
  expect(screen.getAllByRole("article")).toHaveLength(10);
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {});
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("article", { name: "拍板记录 Q-20" });
  expect(screen.getAllByRole("article")).toHaveLength(20);
  expect(decisionHistory).toHaveBeenLastCalledWith("p-1", {}, "c1");
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("article", { name: "拍板记录 Q-23" });
  expect(screen.getAllByRole("article")).toHaveLength(23);
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
  await screen.findByRole("article", { name: "拍板记录 Q-10" });
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
  await screen.findByRole("article", { name: "拍板记录 Q-10" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("article", { name: "拍板记录 Q-20" });
  fireEvent.change(screen.getByLabelText("决策人"), {
    target: { value: "human" },
  });
  await screen.findByRole("article", { name: "拍板记录 Q-101" });
  expect(screen.getAllByRole("article")).toHaveLength(2);
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
  await screen.findByRole("article", { name: "拍板记录 Q-10" });
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("article", { name: "拍板记录 Q-15" });
  rerender(
    <DecisionHistoryPage projectId="p-1" client={client} revision={1} />,
  );
  await waitFor(() => expect(decisionHistory).toHaveBeenCalledTimes(4));
  expect(screen.getAllByRole("article")).toHaveLength(15);
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});
