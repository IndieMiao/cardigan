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
  MergeCheckView,
  MergeConfirmationView,
  NeedsDecision,
} from "../api.js";
import { cardDetail, fakeClient, NOW } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { MergeConfirmation } from "./NeedsYouPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function decision(): NeedsDecision & {
  merge_confirmation: MergeConfirmationView & { merge_check: MergeCheckView };
} {
  return {
    id: "Q-1",
    card_id: "C-1",
    related_cards: [],
    affected_cards: [],
    question: "确认合并",
    context: "交付上下文原文",
    why: "等你确认",
    waited_ms: 0,
    trigger: "merge_confirmation",
    category: "general",
    assignment_id: null,
    status: "open",
    blocking: true,
    decider: "human",
    options: [],
    recommended: "merge",
    plain_summary: {
      changed: "优化拍板布局",
      impact: "更快看到处理入口",
      risk: "需要补齐截图",
    },
    merge_confirmation: {
      blockers: [],
      completion: null,
      deliveries: [],
      reviews: [],
      known_gaps: [],
      merge_gate_enabled: true,
      merge_check: {
        status: "passed",
        completion_id: "D-1",
        attempt_id: "attempt-1",
        checks: [],
        updated_at: NOW,
      },
    },
  };
}
function show(q: NeedsDecision) {
  return render(
    <MergeConfirmation
      q={q}
      client={fakeClient()}
      projectId="p-1"
      elapsed={0}
      done={() => {}}
    />,
  );
}

test("C-205: controls precede folded evidence; supplied empty gaps differ from absent data", () => {
  const q = decision();
  const view = show(q);
  const evidence = [
    "要合并的交付（0 项）",
    "审核与验收（0 项）",
    "已知遗留 0 项",
    "详细信息",
    "操作说明",
  ];
  const confirm = screen.getByRole("button", { name: "确认合并" });
  for (const label of evidence) {
    const disclosure = screen.getByText(label).closest("details");
    if (!disclosure) throw new Error("Missing disclosure");
    expect(disclosure.open).toBe(false);
    expect(
      confirm.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  view.unmount();
  show({ ...q, merge_confirmation: null });
  const missing = screen.getByText("已知遗留 资料未提供").closest("details");
  expect(missing?.open).toBe(true);
  expect(screen.getByText("遗留资料未提供，不能视为无遗留")).toBeTruthy();
  expect(screen.queryByText("没有已知遗留。")).toBeNull();
});

test.each([undefined, null])(
  "C-205: an incomplete gap field (%s) is not an empty list",
  (known_gaps) => {
    const q = decision();
    // Exercise legacy JSON, including null, beyond the current API type.
    show({
      ...q,
      merge_confirmation: { ...q.merge_confirmation, known_gaps },
    } as unknown as NeedsDecision);
    expect(
      screen.getByText("已知遗留 资料未提供").closest("details")?.open,
    ).toBe(true);
  },
);

test("C-205: nonempty gaps show all original text, while critical facts survive manual folding", () => {
  const q = decision();
  show({
    ...q,
    merge_confirmation: {
      ...q.merge_confirmation,
      known_gaps: [
        {
          description: "与概述不同的遗留第一行\n第二行",
          precondition: "先升级角色",
        },
        { description: "另一项尚未覆盖的行为" },
      ],
      reviews: [
        {
          id: "V-1",
          delivery_id: "D-1",
          work_item_id: "W-2",
          work_item_title: "审核",
          role_id: "reviewer",
          kind: "code",
          verdict: "reject",
          target_sha: "a",
          issues: [
            {
              severity: "major",
              impact: "functional",
              must_fix: true,
              pre_existing: false,
              description: "修复失效按钮",
            },
          ],
        },
      ],
    },
  });
  const gaps = screen.getByText("已知遗留 2 项").closest("details");
  if (!gaps) throw new Error("Missing gap disclosure");
  expect(gaps.open).toBe(true);
  expect(gaps.textContent).toContain("与概述不同的遗留第一行\n第二行");
  expect(gaps.textContent).toContain("另一项尚未覆盖的行为");
  fireEvent.click(screen.getByText("已知遗留 2 项"));
  expect(gaps.open).toBe(false);
  for (const text of ["需要补齐截图", "必须修复：修复失效按钮 · 功能错误"])
    expect(screen.getByText(text).closest("details")).toBeNull();
  expect(
    screen.getByText(/· 前置条件：先升级角色/).closest("details"),
  ).toBeNull();
});

test("C-205: PM ownership comes from the read model even when its snooze reason says to hand off", () => {
  show({
    ...decision(),
    status: "snoozed",
    decider: "role:pm",
    snooze: {
      until: "2026-11-14T01:30:00Z",
      at: NOW,
      by: "assignment:A-2",
      reason: "待截图通过后交人确认",
    },
  });
  const status = screen.getByRole("region", { name: "Q-1 状态" });
  expect(within(status).getByText("PM 暂缓中")).toBeTruthy();
  expect(within(status).getByText("你可直接处理")).toBeTruthy();
  expect(within(status).queryByText("等你确认")).toBeNull();
  expect(status.querySelector("time")?.dateTime).toBe("2026-11-14T01:30:00Z");
  expect(screen.getAllByRole("region", { name: /状态/ })).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "确认合并" }).hasAttribute("disabled"),
  ).toBe(false);
});

test.each(["review", "human_action", "blocked"] as const)(
  "C-205: a card waiting on %s has a header and no merge controls",
  async (kind) => {
    const base = cardDetail();
    const detail = {
      ...base,
      card: {
        ...base.card,
        status: "review" as const,
        waiting_on: [{ kind, ref: "W-2", label: "待办原文" }],
        next_owners: [{ kind: "human" as const, ref: "human" }],
      },
    };
    render(
      <CardDetailPage
        client={fakeClient({ card: async () => detail })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const status = await screen.findByRole("region", { name: "卡片状态" });
    expect(status.textContent).toContain("审核中");
    expect(status.textContent).toContain("等谁");
    expect(status.textContent).toContain(
      {
        review: "下一步：完成审核",
        human_action: "下一步：处理人工事项",
        blocked: "下一步：解除阻塞",
      }[kind],
    );
    expect(screen.queryByRole("button", { name: "确认合并" })).toBeNull();
    const overview = screen.getByRole("region", {
      name: "目标和验收标准",
    });
    expect(overview.tagName).toBe("SECTION");
    expect(overview.closest("[hidden]")).toBeNull();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    fireEvent.click(
      within(screen.getByRole("tablist", { name: "卡片区块导航" })).getByRole(
        "tab",
        { name: "概览" },
      ),
    );
    expect(overview.tagName).toBe("SECTION");
    expect(overview.closest("[hidden]")).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "概览" })).toBeTruthy();
  },
);

test("C-205: card refresh preserves the folded quote across snooze/check updates and shows one risk", async () => {
  const q = decision();
  let detail = cardDetail({
    merge_confirmations: [q],
    relations: { cards: [], decisions: [], pull_requests: [] },
  });
  const read = vi.fn(async () => detail);
  const client = fakeClient({ card: read });
  const view = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await screen.findByRole("article", { name: "合并确认 Q-1" });
  expect(screen.getAllByText("需要补齐截图")).toHaveLength(1);
  expect(document.querySelectorAll(".decision-status-line")).toHaveLength(1);
  const quote = screen.getByLabelText(
    "Q-1 原话或补充说明",
  ) as HTMLTextAreaElement;
  fireEvent.click(screen.getByText("补充说明", { selector: "summary" }));
  fireEvent.change(quote, { target: { value: "保留我的补充说明" } });
  fireEvent.click(screen.getByText("补充说明", { selector: "summary" }));
  detail = {
    ...detail,
    merge_confirmations: [
      {
        ...q,
        status: "snoozed",
        merge_confirmation: {
          ...q.merge_confirmation,
          merge_check: {
            ...q.merge_confirmation.merge_check,
            attempt_id: "attempt-2",
          },
        },
      },
    ],
  };
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(quote.value).toBe("保留我的补充说明");
  expect(quote.closest("details")?.open).toBe(false);
});
