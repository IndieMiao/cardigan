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
import type { DecisionView, NeedsDecision } from "../api.js";
import {
  attachment,
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { NeedsYouPanel as NeedsYouPage } from "../views/NeedsYouPage.js";

afterEach(cleanup);

/** Synthetic stand-in for a completion review like SEN-Q-299 / SEN-Q-303. */
const review: DecisionView = {
  id: "Q-9",
  card_id: "C-1",
  question: "请你确认：羊圈按 5×5 比例建",
  status: "open",
  blocking: false,
  decider: "human",
  trigger: "completion_review",
  human_required_reason: "卡片模板规定完成申请由人验收。",
  context: "按 D-437、V-570 缩小范围，LOCK-24 已释放。",
  plain_summary: {
    changed: "羊圈占地从 16 格变成 25 格",
    impact: "确认后按 5×5 建正式模型",
    risk: "无",
  },
  options: [
    { key: "approve", description: "验收通过", impact: "进入合并或完成" },
    { key: "reject", description: "退回修改", impact: "重新提交完成申请" },
  ],
  recommended: "approve",
  attachments: [
    attachment({
      id: "F-1",
      original_filename: "5x5-01-top.png",
      download_path: "/api/projects/p-1/attachments/F-1",
      thumbnail_path: "/api/projects/p-1/attachments/F-1/thumbnail",
    }),
    attachment({
      id: "F-2",
      original_filename: "5x5-02-angle.png",
      download_path: "/api/projects/p-1/attachments/F-2",
      thumbnail_path: "/api/projects/p-1/attachments/F-2/thumbnail",
    }),
    attachment({
      id: "F-3",
      mime: "text/html",
      inline: false,
      original_filename: "motion.html",
      download_path: "/api/projects/p-1/attachments/F-3",
      thumbnail_path: null,
    }),
  ],
  attachments_omitted: 3,
  acceptance_criteria_snapshot: ["移动表现设计稿", "设计总监审核通过"],
};

/** Each later node follows the previous one in document order. */
function inOrder(...nodes: Element[]) {
  return nodes.every(
    (node, i) =>
      i === 0 ||
      !!(
        nodes[i - 1]?.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ),
  );
}

function expectFirstScreen(region: HTMLElement) {
  const thumbnail = within(region).getByRole("button", {
    name: "预览 5x5-01-top.png",
  });
  expect(
    within(region).getByRole("button", { name: "预览 5x5-02-angle.png" }),
  ).toBeTruthy();
  const criteria = within(region).getByRole("region", { name: "验收标准" });
  expect(
    within(criteria)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["移动表现设计稿", "设计总监审核通过"]);
  const summary = within(region).getByRole("region", { name: "Q-9 人话概述" });
  expect(summary.textContent).toContain("羊圈占地从 16 格变成 25 格");
  const option = within(region).getByText("验收通过");
  const details = within(region).getByText("详细信息").closest("details");
  if (!details) throw new Error("missing 详细信息");
  expect(details.open).toBe(false);
  expect(inOrder(thumbnail, criteria, summary, option, details)).toBe(true);
  // Routing, why it is yours and the internal numbers fold into 详细信息.
  expect(details.textContent).toContain("须由你亲自决定：");
  expect(details.textContent).toContain("LOCK-24");
  // Options read by their Chinese names, never the stored keys.
  expect(within(region).queryByText(/approve|reject/u)).toBeNull();
  const more = within(region).getByRole("link", { name: "还有 3 个" });
  expect(more.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-1?at=card-C-1-attachments",
  );
}

test("C-810: the Needs You decision shows what to confirm, images, criteria, summary and Chinese options first", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const needs: NeedsDecision = {
    ...review,
    why: review.question,
    affected_cards: ["C-1"],
    category: "feature_detail",
    assignment_id: null,
    waited_ms: 0,
    related_cards: [{ id: "C-1", title: "羊圈" }],
    merge_confirmation: null,
  };
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        recordDecision,
        needsYou: async () => ({
          decisions: [needs],
          human_actions: [],
          incidents: [],
        }),
      })}
    />,
  );
  const row = await screen.findByRole("article", { name: "拍板 Q-9" });
  expectFirstScreen(row);
  fireEvent.click(within(row).getByRole("radio", { name: /^验收通过/u }));
  fireEvent.click(within(row).getByRole("button", { name: "按所选拍板" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-9",
      "approve",
      "",
      expect.any(String),
    ),
  );
});

test("C-810: the card's “下一步” answers the same decision in place, and its timeline entry reads alike", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const detail = cardDetail({
    card: {
      ...card,
      status: "review",
      waiting_on: [{ kind: "decision", ref: "Q-9", label: "等你拍板 Q-9" }],
    },
    decisions: [review],
    timeline: [
      timelineEntry({
        id: "C-1#7",
        event_seq: 7,
        type: "decision_request",
        decision_id: "Q-9",
        author: "system",
      }),
    ],
  });
  render(
    <CardDetailPage
      projectId="p-1"
      cardId="C-1"
      client={fakeClient({ card: async () => detail, recordDecision })}
    />,
  );
  const next = await screen.findByRole("region", { name: "下一步" });
  expect(within(next).getByText(review.question)).toBeTruthy();
  expectFirstScreen(next);
  fireEvent.click(within(next).getByRole("radio", { name: /^验收通过/u }));
  fireEvent.click(within(next).getByRole("button", { name: "确认选择" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-9",
      "approve",
      "",
      expect.any(String),
    ),
  );
  fireEvent.click(screen.getByRole("tab", { name: /^时间线/u }));
  const entry = document.getElementById("entry-C-1#7");
  if (!entry) throw new Error("missing timeline entry");
  expect(within(entry).getByText(review.question)).toBeTruthy();
  expectFirstScreen(entry);
  // The timeline lists the options; they are answered in the panel above.
  expect(within(entry).queryAllByRole("radio")).toHaveLength(0);
  expect(
    within(entry)
      .getAllByRole("listitem")
      .some((li) => li.textContent === "验收通过推荐进入合并或完成"),
  ).toBe(true);
});
