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
  DecisionSuggestionView,
  NeedsDecision,
  NeedsPage,
} from "../api.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const suggestion = (
  overrides: Partial<DecisionSuggestionView> = {},
): DecisionSuggestionView => ({
  option: "merge",
  rationale: "检查和审核都通过",
  by: "assignment:A-9",
  at: "2026-11-13T00:00:00.000Z",
  stale: false,
  ...overrides,
});
const merge = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "Q-3",
  question: "Merge C-1 into main?",
  context: "",
  why: "确认合并",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "merge", description: "合并已通过验收的交付", impact: "更新基线" },
    { key: "hold", description: "暂缓合并", impact: "等待" },
    { key: "request_changes", description: "退回修改", impact: "返工" },
  ],
  recommended: "merge",
  waited_ms: 0,
  trigger: "merge_confirmation",
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "界面卡" }],
  merge_confirmation: {
    completion: {
      id: "D-9",
      work_item_id: "W-1",
      summary: "全部验收通过",
      subject: { kind: "git_head", value: "abcdef123456" },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
  },
  ...overrides,
});
const choose = (overrides: Partial<NeedsDecision> = {}): NeedsDecision =>
  merge({
    id: "Q-4",
    question: "用哪种布局？",
    trigger: null,
    category: "feature_detail",
    options: [
      { key: "a", description: "左侧栏", impact: "保持宽度" },
      { key: "b", description: "右侧栏", impact: "更宽" },
    ],
    recommended: "a",
    merge_confirmation: null,
    ...overrides,
  });
const page = (decisions: NeedsDecision[]): NeedsPage => ({
  decisions,
  human_actions: [],
  incidents: [],
});
function renderNeeds(decisions: NeedsDecision[]) {
  const applySuggestion = vi.fn().mockResolvedValue(undefined),
    recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page(decisions),
        applySuggestion,
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  return { applySuggestion, recordDecision };
}

test("C-192: without a suggestion the decision looks as before", async () => {
  renderNeeds([merge(), choose()]);
  await screen.findByRole("article", { name: "合并确认 Q-3" });
  expect(screen.queryByRole("button", { name: SUGGESTION_COPY.apply })).toBe(
    null,
  );
  expect(screen.queryByText(/^建议：/u)).toBe(null);
});

test("C-192: a merge suggestion shows its reason and submits it in one click", async () => {
  const { applySuggestion, recordDecision } = renderNeeds([
    merge({ suggestion: suggestion() }),
  ]);
  const card = await screen.findByRole("article", { name: "合并确认 Q-3" });
  const box = within(card).getByRole("region", { name: "Q-3 建议" });
  expect(
    within(box).getByText(SUGGESTION_COPY.line("确认合并", "检查和审核都通过")),
  ).toBeTruthy();
  fireEvent.click(
    within(box).getByRole("button", { name: SUGGESTION_COPY.apply }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "",
      expect.any(String),
    ),
  );
  expect(recordDecision).not.toHaveBeenCalled();
});

test("C-192: a suggested return prefills an editable reason, also in the return form", async () => {
  const { applySuggestion } = renderNeeds([
    merge({
      recommended: "request_changes",
      suggestion: suggestion({
        option: "request_changes",
        rationale: "窄屏错位",
        return_reason: "修好按钮换行",
      }),
    }),
  ]);
  const card = await screen.findByRole("article", { name: "合并确认 Q-3" });
  const box = within(card).getByRole("region", { name: "Q-3 建议" });
  expect(
    within(box).getByText(SUGGESTION_COPY.line("退回修改", "窄屏错位")),
  ).toBeTruthy();
  const reason = within(box).getByLabelText(
    "Q-3 建议的退回原因",
  ) as HTMLTextAreaElement;
  expect(reason.value).toBe("修好按钮换行");
  fireEvent.click(
    within(card).getByRole("button", { name: "退回修改", exact: true }),
  );
  expect(
    (within(card).getByLabelText("Q-3 退回原因") as HTMLTextAreaElement).value,
  ).toBe("修好按钮换行");
  fireEvent.change(reason, { target: { value: "修好按钮换行，补暗色截图" } });
  fireEvent.click(
    within(box).getByRole("button", { name: SUGGESTION_COPY.apply }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "request_changes",
      "修好按钮换行，补暗色截图",
      expect.any(String),
    ),
  );
});

test("C-192: an emptied return reason cannot be submitted", async () => {
  renderNeeds([
    merge({
      suggestion: suggestion({
        option: "request_changes",
        return_reason: "修好按钮换行",
      }),
    }),
  ]);
  const box = await screen.findByRole("region", { name: "Q-3 建议" });
  fireEvent.change(within(box).getByLabelText("Q-3 建议的退回原因"), {
    target: { value: " " },
  });
  expect(
    within(box)
      .getByRole("button", { name: SUGGESTION_COPY.apply })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("C-192: a stale suggestion is marked and offers no one-click button", async () => {
  renderNeeds([
    merge({ suggestion: suggestion({ stale: true }) }),
    choose({ suggestion: suggestion({ option: "a", stale: true }) }),
  ]);
  for (const id of ["Q-3", "Q-4"]) {
    const box = await screen.findByRole("region", { name: `${id} 建议` });
    expect(within(box).getByText(SUGGESTION_COPY.stale)).toBeTruthy();
    expect(within(box).getByText(SUGGESTION_COPY.staleHint)).toBeTruthy();
    expect(within(box).queryByRole("button")).toBe(null);
  }
});

test("C-192: a business decision names the suggested option and applies it", async () => {
  const { applySuggestion } = renderNeeds([
    choose({ suggestion: suggestion({ option: "a", rationale: "更省空间" }) }),
  ]);
  const box = await screen.findByRole("region", { name: "Q-4 建议" });
  expect(
    within(box).getByText(SUGGESTION_COPY.line("左侧栏", "更省空间")),
  ).toBeTruthy();
  fireEvent.click(
    within(box).getByRole("button", { name: SUGGESTION_COPY.apply }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-4",
      "a",
      "",
      expect.any(String),
    ),
  );
});

test("C-192: with open pre-merge checks the suggestion still asks for confirmation first", async () => {
  const base = merge();
  const { applySuggestion } = renderNeeds([
    merge({
      suggestion: suggestion(),
      merge_confirmation: {
        ...(base.merge_confirmation as NonNullable<
          NeedsDecision["merge_confirmation"]
        >),
        pre_merge_checks: [
          { label: "截图核对", status: "pending", stale: false },
        ],
      },
    }),
  ]);
  const box = await screen.findByRole("region", { name: "Q-3 建议" });
  fireEvent.click(
    within(box).getByRole("button", { name: SUGGESTION_COPY.apply }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(applySuggestion).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "仍然确认合并" }));
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "",
      expect.any(String),
    ),
  );
});

test("C-192: card details show the suggestion on the merge confirmation and apply it", async () => {
  const detail = cardDetail();
  const q = merge({ suggestion: suggestion() });
  const applySuggestion = vi.fn().mockResolvedValue(undefined);
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          card: { ...detail.card, status: "awaiting_merge" },
          decisions: [q],
          merge_confirmations: [q],
        }),
        applySuggestion,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  const box = within(region.getByRole("region", { name: "Q-3 建议" }));
  expect(
    box.getByText(SUGGESTION_COPY.line("确认合并", "检查和审核都通过")),
  ).toBeTruthy();
  fireEvent.click(box.getByRole("button", { name: SUGGESTION_COPY.apply }));
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "",
      expect.any(String),
    ),
  );
});
