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
import type {
  CardiganClient,
  DecisionSuggestionView,
  NeedsDecision,
  NeedsPage,
} from "../api.js";
import type { StreamCallbacks } from "../stream.js";
import { SUGGESTION_COPY } from "../suggestion-copy.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { useProjectStream } from "../useProjectStream.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { MergeConfirmation, NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const expired = () => {};
function LiveDetail({ client }: { client: CardiganClient }) {
  const live = useProjectStream(client, "p-1", expired);
  return (
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-2"
      cardRevision={live.cardRevision}
    />
  );
}

const suggestion = (
  overrides: Partial<DecisionSuggestionView> = {},
): DecisionSuggestionView => ({
  version: 1,
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
  expect(
    screen.queryByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  ).toBe(null);
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
    within(box).getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "",
      expect.any(String),
      undefined,
      1,
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
    within(box).getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "request_changes",
      "修好按钮换行，补暗色截图",
      expect.any(String),
      undefined,
      1,
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
      .getByRole("button", {
        name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
      })
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
    within(box).getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-4",
      "a",
      "",
      expect.any(String),
      undefined,
      1,
    ),
  );
});

test("C-264: a merge suggestion cannot bypass waiting checks", async () => {
  const base = merge();
  if (!base.merge_confirmation) throw new Error("Missing fixture");
  const { applySuggestion } = renderNeeds([
    merge({
      suggestion: suggestion(),
      merge_confirmation: {
        ...base.merge_confirmation,
        blockers: ["截图核对：待核"],
      },
    }),
  ]);
  const box = await screen.findByRole("region", { name: "Q-3 建议" });
  const trigger = within(box).getByRole("button", { name: "按建议：确认合并" });
  expect(trigger.hasAttribute("disabled")).toBe(true);
  expect(
    within(box)
      .getByRole("button", { name: "暂不合并" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(
    within(box)
      .getByRole("button", { name: "退回修改" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(trigger);
  expect(applySuggestion).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
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
  fireEvent.click(
    box.getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "",
      expect.any(String),
      undefined,
      1,
    ),
  );
});

test("C-192: card details offer one-click handling for a business decision, with an editable prefilled return", async () => {
  const detail = cardDetail();
  const q = choose({
    id: "Q-5",
    question: "这一版要退回吗？",
    options: [
      { key: "approve", description: "通过", impact: "继续" },
      { key: "request_changes", description: "退回修改", impact: "返工" },
    ],
    recommended: "request_changes",
    suggestion: suggestion({
      option: "request_changes",
      rationale: "缺暗色截图",
      return_reason: "补暗色截图",
    }),
  });
  const applySuggestion = vi.fn().mockResolvedValue(undefined);
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({ ...detail, decisions: [q] }),
        applySuggestion,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const section = within(
    await screen.findByRole("region", { name: SUGGESTION_COPY.cardSection }),
  );
  const box = within(section.getByRole("region", { name: "Q-5 建议" }));
  expect(
    box.getByText(SUGGESTION_COPY.line("退回修改", "缺暗色截图")),
  ).toBeTruthy();
  const reason = box.getByLabelText(
    "Q-5 建议的退回原因",
  ) as HTMLTextAreaElement;
  expect(reason.value).toBe("补暗色截图");
  fireEvent.change(reason, { target: { value: "补暗色和窄屏截图" } });
  fireEvent.click(
    box.getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-5",
      "request_changes",
      "补暗色和窄屏截图",
      expect.any(String),
      undefined,
      1,
    ),
  );
});

test("C-192: card details show no suggestion section without a suggestion or for decisions not with the human", async () => {
  const detail = cardDetail();
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          decisions: [
            choose({ id: "Q-6" }),
            choose({ id: "Q-7", decider: "role:pm", suggestion: suggestion() }),
            choose({ id: "Q-8", status: "resolved", suggestion: suggestion() }),
          ],
        }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("complementary", { name: "卡片概况" });
  expect(
    screen.queryByRole("region", { name: SUGGESTION_COPY.cardSection }),
  ).toBe(null);
  expect(
    screen.queryByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  ).toBe(null);
});

test("C-192: a suggestion arriving while the page stays open prefills the reason, but keeps what the human typed", () => {
  const client = fakeClient({});
  const props = { client, projectId: "p-1", done: () => {}, elapsed: 0 };
  const first = merge({ decider: "role:pm" });
  const arrived = merge({
    suggestion: suggestion({
      option: "request_changes",
      rationale: "窄屏错位",
      return_reason: "修好窄屏布局",
    }),
  });
  const { rerender } = render(<MergeConfirmation q={first} {...props} />);
  rerender(<MergeConfirmation q={arrived} {...props} />);
  const box = within(screen.getByRole("region", { name: "Q-3 建议" }));
  const reason = box.getByLabelText(
    "Q-3 建议的退回原因",
  ) as HTMLTextAreaElement;
  expect(reason.value).toBe("修好窄屏布局");
  expect(
    box
      .getByRole("button", {
        name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
      })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.change(reason, { target: { value: "我自己的原因" } });
  rerender(
    <MergeConfirmation
      q={merge({
        suggestion: suggestion({
          option: "request_changes",
          rationale: "窄屏错位",
          return_reason: "修好窄屏布局（新）",
          at: "2026-11-13T01:00:00.000Z",
        }),
      })}
      {...props}
    />,
  );
  expect(
    (
      within(screen.getByRole("region", { name: "Q-3 建议" })).getByLabelText(
        "Q-3 建议的退回原因",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("我自己的原因");
});

test("C-192: a confirmed merge whose check failed shows the return suggestion and applies it", async () => {
  const base = merge();
  const applySuggestion = vi.fn().mockResolvedValue(undefined);
  render(
    <MergeConfirmation
      q={merge({
        status: "resolved",
        options: [
          { key: "request_changes", description: "退回修改", impact: "返工" },
        ],
        recommended: "request_changes",
        suggestion: suggestion({
          option: "request_changes",
          rationale: "测试真实失败",
          return_reason: "修好失败的测试",
        }),
        merge_confirmation: {
          ...(base.merge_confirmation as NonNullable<
            NeedsDecision["merge_confirmation"]
          >),
          merge_gate_enabled: true,
          merge_check: {
            completion_id: "D-9",
            attempt_id: "attempt-1",
            candidate_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
            status: "failed",
            checks: [{ name: "test", status: "failed" }],
            summary: "断言失败",
            updated_at: "2026-11-13T00:00:00Z",
          },
        },
      })}
      client={fakeClient({ applySuggestion })}
      projectId="p-1"
      done={() => {}}
      elapsed={0}
    />,
  );
  const box = within(screen.getByRole("region", { name: "Q-3 建议" }));
  expect(
    (box.getByLabelText("Q-3 建议的退回原因") as HTMLTextAreaElement).value,
  ).toBe("修好失败的测试");
  fireEvent.click(
    box.getByRole("button", {
      name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
    }),
  );
  await waitFor(() =>
    expect(applySuggestion).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "request_changes",
      "修好失败的测试",
      expect.any(String),
      undefined,
      1,
    ),
  );
});

test("C-192: a confirmed merge no longer offers its merge suggestion", () => {
  render(
    <MergeConfirmation
      q={merge({ status: "resolved", suggestion: suggestion() })}
      client={fakeClient({})}
      projectId="p-1"
      done={() => {}}
      elapsed={0}
    />,
  );
  expect(screen.queryByRole("region", { name: "Q-3 建议" })).toBe(null);
});

test("C-205: direct confirmation beside a suggestion submits the same folded quote without applying the suggestion", async () => {
  const { applySuggestion, recordDecision } = renderNeeds([
    merge({ suggestion: suggestion() }),
  ]);
  const card = await screen.findByRole("article", { name: "合并确认 Q-3" });
  fireEvent.click(within(card).getByText("补充说明", { selector: "summary" }));
  fireEvent.change(within(card).getByLabelText("Q-3 原话或补充说明"), {
    target: { value: "我的确认原话" },
  });
  fireEvent.click(within(card).getByText("补充说明", { selector: "summary" }));
  fireEvent.click(
    within(card).getByRole("button", { name: "确认合并", exact: true }),
  );
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      "我的确认原话",
      expect.any(String),
    ),
  );
  expect(applySuggestion).not.toHaveBeenCalled();
});

test.each(["a", "merge", "request_changes"])(
  "C-303: %s submits the visible evidence token only after confirmation",
  async (option) => {
    const progress = {
      count: 1,
      token: "evidence-version",
      entries: [
        {
          id: "e1",
          at: "2026-11-13T00:00:01.000Z",
          author_display: "证据作者",
          summary: "新增证据",
        },
      ],
    };
    const advice = suggestion({
      option,
      progress,
      ...(option === "request_changes"
        ? { return_reason: "按新证据修复" }
        : {}),
    });
    const q =
      option === "a"
        ? choose({ suggestion: advice })
        : merge({ suggestion: advice });
    const { applySuggestion, recordDecision } = renderNeeds([q]);
    const box = await screen.findByRole("region", { name: `${q.id} 建议` });
    fireEvent.click(
      within(box).getByRole("button", {
        name: /^(按建议处理|按建议：确认合并|按建议：退回修改)$/u,
      }),
    );
    expect(applySuggestion).not.toHaveBeenCalled();
    fireEvent.click(
      within(box).getByRole("button", { name: SUGGESTION_COPY.confirm }),
    );
    await waitFor(() =>
      expect(applySuggestion).toHaveBeenCalledWith(
        "p-1",
        q.id,
        option,
        option === "request_changes" ? "按新证据修复" : "",
        expect.any(String),
        progress.token,
        advice.version,
      ),
    );
    expect(recordDecision).not.toHaveBeenCalled();
  },
);

test.each(["choose", "merge"])(
  "C-303: affected-card details refresh %s suggestions from every displayed dependency",
  async (kind) => {
    let stream: StreamCallbacks | undefined;
    let advice = suggestion({ option: kind === "choose" ? "a" : "merge" });
    const q = () =>
      (kind === "choose" ? choose : merge)({
        suggestion: advice,
        affected_cards: ["C-1", "C-2", "C-3"],
        affected_card_views: ["C-1", "C-2", "C-3"].map((id) => ({
          id,
          title: id,
          status: "review",
        })),
      });
    const detail = cardDetail();
    const read = vi.fn(async () => ({
      ...detail,
      card: { ...detail.card, id: "C-2" },
      decisions: [q()],
      merge_confirmations: kind === "merge" ? [q()] : [],
    }));
    const applySuggestion = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      card: read,
      applySuggestion,
      subscribe: (_id, callbacks) => {
        stream = callbacks;
        return () => {};
      },
    });
    const push = async (card: string, type: string) => {
      await act(async () => {
        stream?.change({ stream: card, seq: 1, type });
        await new Promise((resolve) => setTimeout(resolve, 140));
      });
    };
    render(<LiveDetail client={client} />);
    await screen.findByRole("region", { name: `${q().id} 建议` });
    const initialReads = read.mock.calls.length;
    const progress = {
      count: 1,
      token: "source-comment",
      entries: [
        {
          id: "e1",
          at: "2026-11-13T00:00:01Z",
          author_display: "证据作者",
          summary: "发起卡新证据",
        },
      ],
    };
    advice = { ...advice, progress };
    await push("C-1", "comment_posted");
    await screen.findByText("建议生成后有 1 条新进展");
    expect(read.mock.calls.length).toBeGreaterThan(initialReads);
    expect(screen.getByText("发起卡新证据")).toBeTruthy();
    const box = () =>
      within(screen.getByRole("region", { name: `${q().id} 建议` }));
    fireEvent.click(
      box().getByRole("button", { name: /^(按建议处理|按建议：确认合并)$/u }),
    );
    expect(
      box().getByRole("button", { name: SUGGESTION_COPY.confirm }),
    ).toBeTruthy();
    advice = {
      ...advice,
      progress: { ...progress, count: 2, token: "affected-comment" },
    };
    await push("C-3", "comment_posted");
    await screen.findByText("建议生成后有 2 条新进展");
    expect(
      box().queryByRole("button", { name: SUGGESTION_COPY.confirm }),
    ).toBeNull();
    expect(applySuggestion).not.toHaveBeenCalled();
    fireEvent.click(
      box().getByRole("button", { name: /^(按建议处理|按建议：确认合并)$/u }),
    );
    advice = suggestion({
      option: advice.option,
      version: 2,
      rationale: "已重新核对所有证据",
    });
    await push("C-1", "decision_suggestion_updated");
    await screen.findByText(/已重新核对所有证据/u);
    expect(screen.queryByText(/建议生成后有/u)).toBeNull();
    expect(
      box().queryByRole("button", { name: SUGGESTION_COPY.confirm }),
    ).toBeNull();
    fireEvent.click(
      box().getByRole("button", { name: /^(按建议处理|按建议：确认合并)$/u }),
    );
    await waitFor(() =>
      expect(applySuggestion).toHaveBeenCalledWith(
        "p-1",
        q().id,
        advice.option,
        "",
        expect.any(String),
        undefined,
        2,
      ),
    );
  },
);
