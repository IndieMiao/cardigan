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
import { ApiError, type CardDetail, type NeedsDecision } from "../api.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(cleanup);

function fixture(confirmed = false): CardDetail {
  const detail = cardDetail();
  const q: NeedsDecision = {
    id: "Q-115",
    question: "确认合并",
    context: "",
    why: "合并检查失败或超时，可退回修改或重新检查",
    status: confirmed ? "resolved" : "open",
    blocking: true,
    decider: "human",
    card_id: "C-1",
    affected_cards: [],
    waited_ms: 0,
    trigger: "merge_confirmation",
    category: "general",
    assignment_id: null,
    related_cards: [{ id: "C-1", title: "敏感卡" }],
    options: [
      { key: "merge", description: "合并", impact: "更新基线" },
      { key: "hold", description: "暂缓", impact: "等待" },
      { key: "request_changes", description: "退回修改", impact: "返工" },
    ],
    recommended: "merge",
    merge_confirmation: {
      completion: {
        id: "D-115",
        work_item_id: "W-1",
        summary: "等待合并",
        subject: { kind: "git_head", value: "a".repeat(40) },
      },
      deliveries: [],
      reviews: [],
      known_gaps: [],
      merge_gate_enabled: true,
      merge_check: {
        completion_id: "D-115",
        attempt_id: "attempt-115",
        candidate_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
        status: "failed",
        checks: [{ name: "test", status: "failed" }],
        summary: "断言失败",
        updated_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  return {
    ...detail,
    card: { ...detail.card, status: "awaiting_merge", sensitive: true },
    decisions: [q],
    merge_confirmations: [q],
  };
}

test.each(["merge", "hold", "request_changes", "recheck"] as const)(
  "C-115: sensitive card detail performs %s and refreshes the current controls",
  async (option) => {
    let detail = fixture();
    const done = () => {
      detail = { ...detail, merge_confirmations: [] };
      return Promise.resolve();
    };
    const recordDecision = vi.fn(done),
      recheckMerge = vi.fn(done),
      read = vi.fn(async () => detail);
    render(
      <CardDetailPage
        client={fakeClient({ card: read, recordDecision, recheckMerge })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const controls = within(
      await screen.findByRole("region", { name: "合并处理" }),
    );
    expect(controls.getByText("断言失败")).toBeTruthy();
    const label = {
      merge: "确认合并",
      hold: "暂不合并",
      request_changes: "退回修改",
      recheck: "重新检查",
    }[option];
    fireEvent.click(controls.getByRole("button", { name: label, exact: true }));
    if (option === "request_changes") {
      expect(
        controls
          .getByRole("button", { name: "确认退回修改" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.change(controls.getByLabelText("Q-115 退回原因"), {
        target: { value: "请修复断言失败" },
      });
      fireEvent.click(controls.getByRole("button", { name: "确认退回修改" }));
    }
    if (option === "recheck")
      expect(recheckMerge).toHaveBeenCalledWith(
        "p-1",
        "C-1",
        "D-115",
        expect.any(String),
      );
    else
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-115",
        option,
        option === "request_changes" ? "请修复断言失败" : "",
        expect.any(String),
      );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "合并处理" })).toBeNull(),
    );
    expect(read).toHaveBeenCalledTimes(2);
  },
);

test("C-115: confirmed failure exposes return/recheck only, and stale targets keep the error visible", async () => {
  const detail = fixture(true);
  const recheckMerge = vi.fn(async () => {
    throw new ApiError(409, "stale_target", "完成申请已更新，请刷新后重试");
  });
  const read = vi.fn(async () => detail);
  render(
    <CardDetailPage
      client={fakeClient({ card: read, recheckMerge })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const controls = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  expect(controls.queryByRole("button", { name: "确认合并" })).toBeNull();
  expect(controls.queryByRole("button", { name: "暂不合并" })).toBeNull();
  expect(controls.getByRole("button", { name: "退回修改" })).toBeTruthy();
  fireEvent.click(controls.getByRole("button", { name: "重新检查" }));
  expect(await screen.findByText(/完成申请已更新/)).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  expect(recheckMerge).toHaveBeenCalledWith(
    "p-1",
    "C-1",
    "D-115",
    expect.any(String),
  );
});

test("C-115: a verified noop keeps human confirmation without claiming a passed or queued check", async () => {
  const detail = fixture();
  const q = detail.merge_confirmations?.[0];
  if (!q?.merge_confirmation) throw new Error("Missing confirmation");
  const merge = q.merge_confirmation;
  const client = fakeClient({
    card: async () => ({
      ...detail,
      merge_confirmations: [
        {
          ...q,
          merge_confirmation: {
            ...merge,
            merge_noop: true,
            merge_check: null,
          },
        },
      ],
    }),
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  const controls = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  expect(controls.getByText(/交付均在基线中/)).toBeTruthy();
  expect(controls.getByRole("button", { name: "确认合并" })).toBeTruthy();
  expect(controls.queryByRole("region", { name: "合并检查" })).toBeNull();
  expect(controls.queryByRole("button", { name: "重新检查" })).toBeNull();
});
