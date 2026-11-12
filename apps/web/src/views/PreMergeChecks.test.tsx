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
import type {
  CardDetail,
  NeedsDecision,
  NeedsPage,
  PreMergeCheckView,
} from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const check = (
  label: string,
  status: PreMergeCheckView["status"],
  note: string | null = null,
): PreMergeCheckView => ({
  label,
  status,
  note,
  updated_at: "2026-11-12T00:00:00Z",
});
const merge = (checks: readonly PreMergeCheckView[]): NeedsDecision => ({
  id: "Q-7",
  question: "Merge C-1 into main?",
  context: "",
  why: "确认合并",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "等待" },
  ],
  recommended: "merge",
  waited_ms: 0,
  trigger: "merge_confirmation",
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "权限卡" }],
  merge_confirmation: {
    completion: {
      id: "D-9",
      work_item_id: "W-1",
      summary: "完成",
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    pre_merge_checks: checks,
  },
});
const needs = (q: NeedsDecision): NeedsPage => ({
  decisions: [q],
  human_actions: [],
  incidents: [],
});
const pending = [
  check("独立安全审核", "pending"),
  check("截图核对", "failed", "按钮颜色不对"),
];
const passed = [check("独立安全审核", "passed"), check("截图核对", "passed")];

test("C-160: Needs You warns while checks are open and asks again before confirming", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(pending)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: "合并前核对" });
  expect(
    within(status).getByText("等待独立安全审核、截图核对，请先不要确认合并"),
  ).toBeTruthy();
  expect(within(status).getByText(/待完成/)).toBeTruthy();
  expect(within(status).getByText(/有问题/)).toBeTruthy();
  expect(within(status).getByText(/按钮颜色不对/)).toBeTruthy();
  expect(screen.queryByText("核对已完成，可以确认合并")).toBeNull();

  const confirm = screen.getByRole("button", { name: "确认合并", exact: true });
  expect(confirm.hasAttribute("disabled")).toBe(false);
  fireEvent.click(confirm);
  const dialog = screen.getByRole("alertdialog", { name: "合并前核对未完成" });
  expect(within(dialog).getByText(/还有 2 项合并前核对没有完成/)).toBeTruthy();
  expect(recordDecision).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "先不确认" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();

  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  fireEvent.click(
    within(
      screen.getByRole("alertdialog", { name: "合并前核对未完成" }),
    ).getByRole("button", { name: "仍然确认合并" }),
  );
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-7",
      "merge",
      "",
      expect.any(String),
    ),
  );
});

test("C-160: once every check passes the warning is gone and numbered steps appear", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(passed)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: "合并前核对" });
  expect(within(status).getByText("核对已完成，可以确认合并")).toBeTruthy();
  expect(within(status).getAllByRole("listitem").length).toBeGreaterThan(2);
  expect(within(status).getByText("点“确认合并”。")).toBeTruthy();
  expect(screen.queryByText(/请先不要确认合并/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(recordDecision).toHaveBeenCalled());
});

test("C-160: no checks means no extra prompt", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => needs(merge([])) })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "确认合并", exact: true });
  expect(screen.queryByRole("status", { name: "合并前核对" })).toBeNull();
});

test("C-160: card detail shows the same waiting prompt and second confirmation", async () => {
  const base = cardDetail();
  const q = merge(pending);
  const detail: CardDetail = {
    ...base,
    card: { ...base.card, status: "awaiting_merge" },
    decisions: [q],
    merge_confirmations: [q],
  };
  const recordDecision = vi.fn(async () => undefined);
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail, recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  expect(
    region.getByText("等待独立安全审核、截图核对，请先不要确认合并"),
  ).toBeTruthy();
  fireEvent.click(
    region.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(region.getByRole("alertdialog")).toBeTruthy();
  expect(recordDecision).not.toHaveBeenCalled();
});
