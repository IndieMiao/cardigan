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
  id: "q(1)",
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
  const decisionHistory = vi.fn(async () => ({ decisions: [record] }));
  render(
    <DecisionHistoryPage
      projectId="p-1"
      client={fakeClient({ decisionHistory })}
    />,
  );
  expect(await screen.findByText("所选方案：继续开发")).toBeTruthy();
  expect(screen.getByText(/理由：符合授权/)).toBeTruthy();
  expect(screen.getByText(/授权依据：project:p-1/)).toBeTruthy();
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
