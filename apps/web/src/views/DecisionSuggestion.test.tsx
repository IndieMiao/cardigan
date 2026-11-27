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
import {
  MergeConfirmation,
  NeedsYouPanel as NeedsYouPage,
} from "./NeedsYouPage.js";

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

test("C-810: the human-only reason folds into 详细信息 after the plain summary and legacy decisions remain readable", async () => {
  const reason = "数值上限与行为规则须由你亲自决定。".repeat(20);
  renderNeeds([
    choose({
      human_required_reason: reason,
      plain_summary: {
        changed: "调整规则",
        impact: "改变处理方式",
        risk: "无",
      },
      context: "完整背景",
    }),
    choose({ id: "Q-5", question: "旧拍板" }),
  ]);
  const shown = await screen.findByText(reason, { exact: false });
  expect(shown.closest("details")?.querySelector("summary")?.textContent).toBe(
    "详细信息",
  );
  const item = screen.getByRole("article", { name: "拍板 Q-4" });
  expect(within(item).getByText("须由你亲自决定：")).toBeTruthy();
  expect(
    (item.querySelector(".plain-summary")?.compareDocumentPosition(shown) ??
      0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(screen.getByRole("article", { name: "拍板 Q-5" })).queryByText(
      "须由你亲自决定：",
    ),
  ).toBeNull();
});

test("C-304: card decision details show human-only reasons and readable delegated routing", async () => {
  const forced = choose({
    human_required_reason: "需求范围须由人决定",
    suggestion: suggestion({ option: "a" }),
  });
  const delegated = choose({
    id: "Q-8",
    decider: "role:pm",
    delegation_authority:
      "project:synthetic/default-decision-delegation/feature_detail",
  });
  const detail = cardDetail({ decisions: [forced, delegated] });
  render(
    <CardDetailPage
      projectId="p-1"
      cardId="C-1"
      client={fakeClient({
        card: async () => ({
          ...detail,
          relations: { ...detail.relations, decisions: [forced, delegated] },
        }),
      })}
    />,
  );
  expect(
    (await screen.findAllByText("需求范围须由人决定", { exact: false })).length,
  ).toBeGreaterThan(0);
  expect(await screen.findByText("已按常驻授权转给 PM")).toBeTruthy();
  expect(
    screen.queryByText(delegated.delegation_authority as string),
  ).toBeNull();
});

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
  // C-697: the suggestion is a line of the “下一步” panel; following it is
  // the panel's emphasis button.
  const region = within(await screen.findByRole("region", { name: "下一步" }));
  const box = within(region.getByRole("note", { name: "Q-3 建议" }));
  expect(
    box.getByText(SUGGESTION_COPY.line("确认合并", "检查和审核都通过")),
  ).toBeTruthy();
  const follow = region.getByRole("button", { name: "按建议：确认合并" });
  expect(follow.className).toContain("ui-button-emphasis");
  expect(
    region.getByRole("button", { name: "确认合并" }).className,
  ).not.toContain("ui-button-emphasis");
  fireEvent.click(follow);
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

test("C-698: card details answer a suggested business decision in “下一步”, with an editable prefilled return", async () => {
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
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          card: { ...detail.card, waiting_on: [] },
          decisions: [q],
        }),
        recordDecision,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const next = within(await screen.findByRole("region", { name: "下一步" }));
  expect(
    next.getByText(SUGGESTION_COPY.line("退回修改", "缺暗色截图")),
  ).toBeTruthy();
  expect(
    (next.getByRole("radio", { name: /退回修改/u }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  const reason = next.getByLabelText(
    "Q-5 建议的退回原因",
  ) as HTMLTextAreaElement;
  expect(reason.value).toBe("补暗色截图");
  fireEvent.change(reason, { target: { value: "补暗色和窄屏截图" } });
  fireEvent.click(next.getByRole("button", { name: "确认选择" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-5",
      "request_changes",
      "补暗色和窄屏截图",
      expect.any(String),
    ),
  );
  // The overview no longer repeats the decision or sends you to Needs You.
  expect(screen.queryByRole("region", { name: "待你拍板" })).toBe(null);
  expect(screen.queryByText(/要选其他方案/u)).toBe(null);
});

test("C-698: card details offer no one-click suggestion button; decisions not with the human stay out of the panel", async () => {
  const detail = cardDetail();
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => ({
          ...detail,
          card: { ...detail.card, waiting_on: [] },
          decisions: [
            choose({ id: "Q-7", decider: "role:pm", suggestion: suggestion() }),
            choose({ id: "Q-8", status: "resolved", suggestion: suggestion() }),
          ],
        }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("complementary", { name: "卡片信息" });
  const next = within(screen.getByRole("region", { name: "下一步" }));
  expect(next.queryByText(/等你拍板/u)).toBe(null);
  expect(next.queryAllByRole("radio")).toHaveLength(0);
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

test.each(["merge"])(
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
    // C-697: a merge suggestion is a line of the “下一步” panel, its buttons
    // the panel's and its confirmation a dialog.
    await screen.findByRole(kind === "merge" ? "note" : "region", {
      name: `${q().id} 建议`,
    });
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
      kind === "merge"
        ? within(document.body)
        : within(screen.getByRole("region", { name: `${q().id} 建议` }));
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

test("C-303/C-698: affected-card details refresh a decision's suggestion progress in “下一步”", async () => {
  let stream: StreamCallbacks | undefined;
  let advice = suggestion({ option: "a" });
  const q = () =>
    choose({
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
    card: { ...detail.card, id: "C-2", waiting_on: [] },
    decisions: [q()],
    merge_confirmations: [],
  }));
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const client = fakeClient({
    card: read,
    recordDecision,
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
  const next = () => within(screen.getByRole("region", { name: "下一步" }));
  const left = () => next().getByRole("radio", { name: /左侧栏/u });
  await screen.findByRole("form", { name: "拍板 Q-4" });
  expect((left() as HTMLInputElement).checked).toBe(true);
  const initialReads = read.mock.calls.length;
  advice = {
    ...advice,
    progress: { count: 1, token: "source-comment", entries: [] },
  };
  await push("C-1", "comment_posted");
  await screen.findByText("建议生成后有 1 条新进展");
  expect(read.mock.calls.length).toBeGreaterThan(initialReads);
  // Newer progress: the suggestion is no longer chosen for you.
  expect((left() as HTMLInputElement).checked).toBe(false);
  advice = {
    ...advice,
    progress: { count: 2, token: "affected-comment", entries: [] },
  };
  await push("C-3", "comment_posted");
  await screen.findByText("建议生成后有 2 条新进展");
  advice = suggestion({
    option: "a",
    version: 2,
    rationale: "已重新核对所有证据",
  });
  await push("C-1", "decision_suggestion_updated");
  await screen.findByText(/已重新核对所有证据/u);
  expect(screen.queryByText(/建议生成后有/u)).toBeNull();
  expect((left() as HTMLInputElement).checked).toBe(true);
  fireEvent.click(next().getByRole("button", { name: "确认选择" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-4",
      "a",
      "",
      expect.any(String),
    ),
  );
});
