// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { NeedsDecision, NeedsPage, PlainSummaryView } from "../api.js";
import { PLAIN_SUMMARY_COPY } from "../plain-summary-copy.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const plain = (
  overrides: Partial<PlainSummaryView> = {},
): PlainSummaryView => ({
  changed:
    "开了截图核对开关后，界面卡的截图核对只能由二郎神给结论，PM 只有在它通过时才能代确认合并",
  impact: "开关默认关着，现在行为不变",
  risk: "改了 pm 和独立复核员的角色规则",
  ...overrides,
});
const merge = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "Q-3",
  question: "Merge C-1 into main?",
  context: "完成申请 D-684，审核 V-658，提交 acc700fa",
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
    blockers: [],
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
    context: "实现者原话：两种都按 `layout=left` 做过",
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
const renderNeeds = (decisions: NeedsDecision[]) =>
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => page(decisions) })}
      projectId="p-1"
    />,
  );

/** True when `a` comes before `b`, both inside `article`. */
const before = (article: HTMLElement, a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) &&
  article.contains(a) &&
  article.contains(b);

test("C-202: a decision shows the plain summary first and folds the context into 详细信息", async () => {
  renderNeeds([choose({ plain_summary: plain() })]);
  const article = await screen.findByRole("article", { name: "拍板 Q-4" });
  const box = within(article).getByRole("region", {
    name: `Q-4 ${PLAIN_SUMMARY_COPY.region}`,
  });
  for (const label of [
    PLAIN_SUMMARY_COPY.changed,
    PLAIN_SUMMARY_COPY.impact,
    PLAIN_SUMMARY_COPY.risk,
  ])
    expect(within(box).getByText(label)).toBeTruthy();
  expect(within(box).getByText(plain().impact)).toBeTruthy();
  const details = within(article)
    .getByText(PLAIN_SUMMARY_COPY.details)
    .closest("details");
  expect(details).toBeTruthy();
  expect(details?.open).toBe(false);
  expect(within(article).queryByText("背景")).toBe(null);
  // The summary comes before the folded details and the options.
  expect(before(article, box, details as Element)).toBe(true);
  expect(
    before(article, box, within(article).getAllByRole("radio")[0] as Element),
  ).toBe(true);
});

test("C-202: a risk other than 无 is flagged; 无 is not", async () => {
  renderNeeds([
    choose({ plain_summary: plain() }),
    choose({ id: "Q-5", plain_summary: plain({ risk: "无" }) }),
  ]);
  const risky = within(
    await screen.findByRole("region", {
      name: `Q-4 ${PLAIN_SUMMARY_COPY.region}`,
    }),
  );
  expect(risky.getByRole("note")).toBeTruthy();
  expect(risky.getByText(PLAIN_SUMMARY_COPY.riskFlag)).toBeTruthy();
  const calm = within(
    screen.getByRole("region", { name: `Q-5 ${PLAIN_SUMMARY_COPY.region}` }),
  );
  expect(calm.queryByRole("note")).toBe(null);
  expect(calm.queryByText(PLAIN_SUMMARY_COPY.riskFlag)).toBe(null);
  expect(calm.getByText("无")).toBeTruthy();
});

test("C-810: an older decision without a plain summary folds its context into 详细信息", async () => {
  renderNeeds([choose(), merge()]);
  const article = await screen.findByRole("article", { name: "拍板 Q-4" });
  expect(
    within(article).queryByRole("region", {
      name: `Q-4 ${PLAIN_SUMMARY_COPY.region}`,
    }),
  ).toBe(null);
  expect(within(article).queryByText("背景")).toBe(null);
  expect(
    within(article).getByText(PLAIN_SUMMARY_COPY.details).closest("details")
      ?.open,
  ).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: /^合并确认/ }));
  const confirmation = await screen.findByRole("article", {
    name: "合并确认 Q-3",
  });
  expect(within(confirmation).queryByText(PLAIN_SUMMARY_COPY.details)).toBe(
    null,
  );
  expect(
    within(confirmation).getByText(/D-684/u).closest("details")?.open,
  ).toBe(false);
  expect(
    within(confirmation).getByText("尚未提供改动概述 / 风险尚未说明"),
  ).toBeTruthy();
});

test("C-202: a merge confirmation shows the completion's plain summary on top, context folded", async () => {
  renderNeeds([merge({ plain_summary: plain({ risk: "无" }) })]);
  const article = await screen.findByRole("article", { name: "合并确认 Q-3" });
  const box = within(article).getByRole("region", {
    name: `Q-3 ${PLAIN_SUMMARY_COPY.region}`,
  });
  expect(within(box).getByText(plain().changed)).toBeTruthy();
  const details = within(article)
    .getByText(PLAIN_SUMMARY_COPY.details)
    .closest("details");
  expect(details?.open).toBe(false);
  expect(
    before(
      article,
      box,
      within(article).getByRole("group", { name: "要合并的交付" }),
    ),
  ).toBe(true);
});

test("C-202: card details show the plain summary on the merge confirmation and in the decision list", async () => {
  const detail = cardDetail();
  const q = merge({ plain_summary: plain() });
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          card: { ...detail.card, status: "awaiting_merge" },
          decisions: [q],
          merge_confirmations: [q],
        }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(await screen.findByRole("region", { name: "下一步" }));
  expect(
    region.getByRole("region", { name: `Q-3 ${PLAIN_SUMMARY_COPY.region}` }),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("region", { name: `Q-3 ${PLAIN_SUMMARY_COPY.region}` })
      .length,
  ).toBeGreaterThanOrEqual(1);
});
