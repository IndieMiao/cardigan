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
  AuthorPrecheck,
  CardDetail,
  CardiganClient,
  NeedsDecision,
  TemplateView,
} from "../api.js";
import { card, cardDetail, fakeClient, NOW } from "../testing/fixtures.js";
import { CardDetailPage } from "../views/CardDetailPage.js";
import { MergePanel } from "../views/MergePanel.js";
import { CardNextStep, cardNextSteps } from "./CardNextStep.js";

afterEach(cleanup);

const blocked = {
  ...card,
  status: "in_progress" as const,
  waiting_on: [{ kind: "blocked" as const, ref: "W-1", label: "W-1 阻塞" }],
};
const check = (status: AuthorPrecheck["status"]): AuthorPrecheck => ({
  attempt_id: "P-1",
  head_sha: "a".repeat(40),
  status,
  log_ref: "P-1.log",
});
const hold = {
  reason: "等待现场".repeat(30),
  resume_condition: "现场证据已核对",
  set_by: "human" as const,
  set_at: NOW,
};
const general: TemplateView = {
  id: "general",
  title: "通用任务",
  description: "",
  version: 1,
  builtin: true,
  status: "active",
  requires_repo: false,
  merge: "none",
  require_acceptance_criteria: false,
  work_items: [],
  primary_work_item_key: null,
  completion: { mode: "human_mark_done" },
};
const merge = (over: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "Q-2",
  card_id: "C-1",
  related_cards: [],
  affected_cards: [],
  question: "确认合并",
  context: "",
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
  plain_summary: { changed: "加筛选", impact: "多一个控件", risk: "无" },
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
  ...over,
});

function panel(
  detail: CardDetail,
  {
    client = fakeClient(),
    onReveal = vi.fn(),
    markDone = vi.fn((emphasis: boolean) => (
      <button type="button" data-emphasis={emphasis}>
        标记完成
      </button>
    )),
    onSaved = vi.fn(),
  }: {
    client?: CardiganClient;
    onReveal?: ReturnType<typeof vi.fn>;
    markDone?: (emphasis: boolean) => React.ReactNode;
    onSaved?: () => void;
  } = {},
) {
  render(
    <CardNextStep
      detail={detail}
      client={client}
      projectId="p 1"
      onSaved={onSaved}
      onReveal={onReveal}
      markDone={markDone}
      mergePanel={(q, { title, mine, dockFor }) => (
        <MergePanel
          q={q}
          client={client}
          projectId="p 1"
          done={onSaved}
          title={title}
          mine={mine}
          dockFor={dockFor}
        />
      )}
    />,
  );
  const region = screen.getByRole("region", { name: "下一步" });
  return {
    region,
    title: within(region).getByRole("heading", { level: 2 }).textContent,
    emphasis: region.querySelectorAll(".ui-button-emphasis"),
    onReveal,
  };
}

test("a precheck wait reads 预检中 with its log, not a red blocker (C-567)", () => {
  const { region, title } = panel(
    cardDetail({
      card: {
        ...blocked,
        next_owners: [{ kind: "role", ref: "coder" }],
        prechecks: [check("running")],
        checking: {
          precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] },
        },
      },
    }),
  );
  expect(
    within(region).getByRole("link", { name: "预检中" }).getAttribute("href"),
  ).toBe("/api/projects/p%201/prechecks/P-1");
  expect(region.textContent).not.toContain("W-1 阻塞");
  expect(title).not.toContain("被阻塞");
});

test("a queued precheck without a log shows plain 预检中", () => {
  const { region } = panel(
    cardDetail({
      card: {
        ...blocked,
        prechecks: [{ ...check("queued"), log_ref: undefined }],
        checking: {
          precheck: { attempt_ids: ["P-1"], waiting_items: ["W-1"] },
        },
      },
    }),
  );
  expect(screen.queryByRole("link", { name: "预检中" })).toBeNull();
  expect(region.textContent).toContain("预检中");
});

test("after the precheck fails the blocker shows as before", () => {
  const { region, title, emphasis } = panel(
    cardDetail({ card: { ...blocked, prechecks: [check("failed")] } }),
  );
  expect(region.textContent).not.toContain("预检中");
  expect(title).toBe("被阻塞");
  expect(region.textContent).toContain("W-1 阻塞");
  expect(region.dataset.mine).toBeUndefined();
  expect(emphasis).toHaveLength(0);
});

test("a running merge check reads 合并检查中", () => {
  const { region } = panel(
    cardDetail({
      card: {
        ...card,
        status: "awaiting_merge",
        waiting_on: [],
        next_owners: [],
        checking: { merge_check: { attempt_id: "M-1", status: "queued" } },
      },
    }),
  );
  expect(region.textContent).toContain("合并检查中");
});

test("waiting on someone else: owners and the step in the title, only 写评论", () => {
  const onReveal = vi.fn();
  const { region, title, emphasis } = panel(
    cardDetail({
      card: {
        ...card,
        waiting_on: [],
        next_owners: [{ kind: "role", ref: "coder", author_display: "李逵" }],
      },
    }),
    { onReveal },
  );
  expect(title).toContain("等");
  expect(title).toContain("李逵");
  expect(title).toContain("处理工作项");
  expect(region.dataset.mine).toBeUndefined();
  expect(emphasis).toHaveLength(0);
  expect(region.textContent).toContain("工作项 0/2");
  fireEvent.click(within(region).getByRole("button", { name: "写评论" }));
  expect(onReveal).toHaveBeenCalledWith("comment");
});

test("C-697: a merge waiting on you is the panel: 确认合并 is its one emphasis action", async () => {
  const recordDecision = vi.fn(async () => {});
  const onSaved = vi.fn();
  const q = merge({
    plain_summary: { changed: "a", impact: "b", risk: "删库" },
  });
  const { region, title, emphasis } = panel(
    cardDetail({
      card: {
        ...card,
        status: "awaiting_merge",
        waiting_on: [{ kind: "decision", ref: "Q-2", label: "等你确认合并" }],
      },
      merge_confirmations: [q],
      decisions: [q],
    }),
    { client: fakeClient({ recordDecision }), onSaved },
  );
  expect(title).toBe("等你确认合并Q-2");
  expect(region.dataset.mine).toBe("true");
  expect([...emphasis].map((b) => b.textContent)).toEqual(["确认合并"]);
  expect(region.textContent).toContain("合并检查：");
  expect(within(region).getByRole("note").textContent).toContain("删库");
  const actions = within(
    within(region).getByRole("group", { name: "合并处理操作" }),
  );
  expect(
    actions
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["确认合并", "暂不合并", "退回修改", "更多合并操作"]);
  fireEvent.click(emphasis[0] as HTMLElement);
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p 1",
      "Q-2",
      "merge",
      "",
      expect.any(String),
    ),
  );
  expect(onSaved).toHaveBeenCalled();
});

test("C-697: 合并详情 opens the folded evidence below the panel", () => {
  const { region } = panel(
    cardDetail({
      card: { ...card, status: "awaiting_merge" },
      merge_confirmations: [merge()],
    }),
  );
  const toggle = within(region).getByRole("button", { name: "合并详情" });
  const details = document.getElementById(
    toggle.getAttribute("aria-controls") ?? "",
  );
  expect(details?.hidden).toBe(true);
  expect(region.contains(details)).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(details?.hidden).toBe(false);
  expect(details?.textContent).toContain("要合并的交付（0 项）");
  expect(details?.textContent).toContain("审核与验收（0 项）");
  fireEvent.click(toggle);
  expect(details?.hidden).toBe(true);
});

test("a merge PM confirms is not yours: 接手处理 leads until you take it over", async () => {
  const q = merge({ decider: "role:pm" });
  const { region, title, emphasis } = panel(
    cardDetail({
      card: { ...card, status: "awaiting_merge", waiting_on: [] },
      merge_confirmations: [q],
    }),
  );
  expect(title).toBe("等 PM 确认合并Q-2");
  expect(region.dataset.mine).toBeUndefined();
  // C-687 §3.2: before a takeover, 接手处理 is the panel's only main action.
  expect([...emphasis].map((e) => e.textContent)).toEqual(["接手处理"]);
  expect(within(region).queryByRole("button", { name: "确认合并" })).toBeNull();
  expect(within(region).getByRole("button", { name: "合并详情" })).toBeTruthy();
  fireEvent.click(within(region).getByRole("button", { name: "接手处理" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认接手" }));
  await waitFor(() =>
    expect(
      within(region).getByRole("button", { name: "确认合并" }).className,
    ).toContain("ui-button-emphasis"),
  );
  expect(within(region).queryByRole("button", { name: "接手处理" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(region).getByRole("group", { name: "合并处理操作" }),
    ),
  );
});

test("a failed merge check after confirming still waits on you: 重新检查 leads", async () => {
  const recheckMerge = vi.fn(async () => {});
  const q = merge({
    status: "resolved",
    merge_confirmation: {
      ...(merge().merge_confirmation as NonNullable<
        NeedsDecision["merge_confirmation"]
      >),
      merge_check: {
        status: "failed",
        completion_id: "D-1",
        attempt_id: "attempt-1",
        checks: [],
        updated_at: NOW,
      },
    },
  });
  const { region, title, emphasis } = panel(
    cardDetail({
      card: { ...card, status: "awaiting_merge", waiting_on: [] },
      merge_confirmations: [q],
    }),
    { client: fakeClient({ recheckMerge }) },
  );
  expect(title).toBe("合并检查未通过Q-2");
  expect([...emphasis].map((b) => b.textContent)).toEqual(["重新检查"]);
  expect(
    within(region)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toEqual(["合并详情", "重新检查", "退回修改"]);
  fireEvent.click(emphasis[0] as HTMLElement);
  await waitFor(() =>
    expect(recheckMerge).toHaveBeenCalledWith(
      "p 1",
      "C-1",
      "D-1",
      expect.any(String),
    ),
  );
});

test("a confirmed merge waiting for its check is not yours: only 退回修改", () => {
  const q = merge({ status: "resolved" });
  const { region, title, emphasis } = panel(
    cardDetail({
      card: { ...card, status: "awaiting_merge", waiting_on: [] },
      merge_confirmations: [q],
    }),
  );
  expect(title).toBe("已确认合并Q-2");
  expect(region.dataset.mine).toBeUndefined();
  expect(emphasis).toHaveLength(0);
  expect(
    within(within(region).getByRole("group", { name: "合并处理操作" }))
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["退回修改"]);
});

test("a decision with a suggestion leads into the card; without one to Needs You; more items are counted", () => {
  const suggested = {
    ...merge({ id: "Q-3", trigger: null, question: "放哪里？" }),
    suggestion: {
      version: 1,
      option: "a",
      rationale: "习惯",
      by: "assignment:A-1",
      at: NOW,
      stale: false,
    },
  };
  const onReveal = vi.fn();
  const detail = cardDetail({
    card: {
      ...card,
      waiting_on: [
        { kind: "decision", ref: "Q-3", label: "等你拍板" },
        { kind: "human_action", ref: "H-4", label: "等你执行 H-4" },
      ],
    },
    decisions: [suggested],
  });
  const first = panel(detail, { onReveal });
  expect(first.title).toBe("等你拍板Q-3还有 1 件");
  expect(first.region.textContent).toContain("放哪里？");
  expect(first.emphasis).toHaveLength(1);
  fireEvent.click(first.emphasis[0] as HTMLElement);
  expect(onReveal).toHaveBeenCalledWith("decisions");
  cleanup();
  const plain = panel({
    ...detail,
    decisions: [{ ...suggested, suggestion: undefined }],
  });
  expect(
    within(plain.region)
      .getByRole("link", { name: "处理拍板" })
      .getAttribute("href"),
  ).toBe("#/p/p%201/needs-you");
  expect(
    within(plain.region)
      .getByRole("link", { name: "还有 1 件" })
      .getAttribute("href"),
  ).toBe("#/p/p%201/needs-you");
});

test("a decision PM decides is not yours", () => {
  const q = merge({ id: "Q-3", trigger: null, decider: "role:pm" });
  const { current } = cardNextSteps(
    cardDetail({
      card: {
        ...card,
        waiting_on: [{ kind: "decision", ref: "Q-3", label: "等 PM 拍板" }],
        next_owners: [{ kind: "role", ref: "pm" }],
      },
      decisions: [q],
    }),
  );
  expect(current).toEqual({ kind: "others", step: "处理拍板" });
});

test("a human action on a development card opens Needs You", () => {
  const { region, title, emphasis } = panel(
    cardDetail({
      card: {
        ...card,
        waiting_on: [{ kind: "human_action", ref: "H-4", label: "等你执行" }],
      },
      human_actions: [
        {
          id: "H-4",
          instructions: "轮换凭据",
          why_human: "",
          expected_return: "",
          status: "open",
        },
      ],
    }),
  );
  expect(title).toBe("等你执行H-4");
  expect(region.textContent).toContain("轮换凭据");
  expect(emphasis).toHaveLength(1);
  expect(
    within(region)
      .getByRole("link", { name: "处理人工事项" })
      .getAttribute("href"),
  ).toBe("#/p/p%201/needs-you");
});

test("a general card asks you to mark it done, emphasised, with its human actions as links", () => {
  const markDone = vi.fn((emphasis: boolean) => (
    <button type="button" data-emphasis={emphasis}>
      标记完成
    </button>
  ));
  const { region, title } = panel(
    cardDetail({
      card: {
        ...card,
        waiting_on: [{ kind: "human_action", ref: "H-50", label: "等你执行" }],
        next_owners: [{ kind: "human", ref: "human" }],
      },
      template: general,
      mark_done: { allowed: true, reason: null },
    }),
    { markDone },
  );
  expect(title).toBe("等你标记完成");
  expect(markDone).toHaveBeenCalledWith(true);
  expect(region.textContent).toContain("等你执行");
  expect(
    within(region).getByRole("link", { name: /H-50/ }).getAttribute("href"),
  ).toBe("#/p/p%201/needs-you");
  expect(within(region).getByRole("button", { name: "写评论" })).toBeTruthy();
});

test("marking done stays reachable, not emphasised, behind a more urgent item", () => {
  const markDone = vi.fn(() => null);
  panel(
    cardDetail({
      card: {
        ...card,
        waiting_on: [{ kind: "decision", ref: "Q-3", label: "等你拍板" }],
      },
      template: general,
      mark_done: { allowed: true, reason: null },
    }),
    { markDone },
  );
  expect(markDone).toHaveBeenCalledWith(false);
  expect(markDone).not.toHaveBeenCalledWith(true);
});

test("a story with open questions asks for answers; marking done is secondary", () => {
  const onReveal = vi.fn();
  const markDone = vi.fn(() => null);
  const { region, title, emphasis } = panel(
    cardDetail({
      card: {
        ...card,
        waiting_on: [],
        next_owners: [{ kind: "human", ref: "human" }],
        story: {
          question_groups: [
            {
              id: "C-1#3",
              questions: [
                { question: "格式？", recommended: "CSV", impact: "" },
                { question: "范围？", recommended: "全部", impact: "" },
              ],
            },
          ],
        },
        story_progress: {
          children: [],
          counts: {
            backlog: 0,
            todo: 1,
            in_progress: 1,
            review: 0,
            awaiting_merge: 0,
            done: 1,
            cancelled: 0,
          },
          finished: 1,
          total: 3,
        },
      },
      template: { ...general, id: "story", story: true },
      mark_done: { allowed: false, reason: "子卡未全部结束" },
    }),
    { onReveal, markDone },
  );
  expect(title).toBe("等你回答 2 个问题");
  expect(region.textContent).toContain("子卡已结束 1/3");
  expect(markDone).toHaveBeenCalledWith(false);
  expect(emphasis).toHaveLength(1);
  fireEvent.click(within(region).getByRole("button", { name: "回答问题" }));
  expect(onReveal).toHaveBeenCalledWith("questions");
});

test("a paused card offers 恢复卡片; a retry after an uncertain failure reuses the key", async () => {
  const updateCard = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue(undefined);
  const onSaved = vi.fn();
  const { region, title, emphasis } = panel(
    cardDetail({
      card: {
        ...card,
        hold,
        waiting_on: [
          { kind: "blocked", ref: card.id, label: `已暂停：${hold.reason}` },
        ],
      },
    }),
    { client: fakeClient({ updateCard }), onSaved },
  );
  expect(title).toBe(`已暂停：${hold.reason}`);
  // The reason is said once; the old “见下方说明” pointer is gone.
  expect(region.textContent?.split(hold.reason)).toHaveLength(2);
  expect(region.textContent).toContain(`恢复条件：${hold.resume_condition}`);
  expect(emphasis).toHaveLength(1);
  const resume = within(region).getByRole("button", { name: "恢复卡片" });
  fireEvent.click(resume);
  await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(updateCard.mock.calls[0]).toEqual(updateCard.mock.calls[1]);
  expect(updateCard.mock.calls[0]?.[2]).toEqual({ hold: null });
});

test.each(["done", "cancelled"] as const)(
  "a closed card (%s) has no panel action, even while paused",
  (status) => {
    const { title, region } = panel(
      cardDetail({ card: { ...card, status, hold, waiting_on: [] } }),
    );
    expect(title).toBe(status === "done" ? "已完成" : "已取消");
    expect(within(region).queryByRole("button")).toBeNull();
  },
);

test("an unmet prerequisite reads 等 C-x 完成 with a link", () => {
  const { region, title } = panel(
    cardDetail({
      card: {
        ...card,
        status: "todo",
        waiting_on: [],
        next_owners: [],
        dependency: {
          predecessors: [],
          successors: [],
          waiting_on: ["C-9"],
          critical_path_length: 2,
        },
      },
    }),
  );
  expect(title).toBe("等C-9 完成");
  expect(
    within(region).getByRole("link", { name: /C-9/ }).getAttribute("href"),
  ).toBe("#/p/p%201/cards/C-9");
});

test("C-695: the status row keeps only status, time and risk, with 编辑 and ⋯ on it", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const q = merge();
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          cardDetail({
            card: {
              ...card,
              status: "awaiting_merge",
              risk_tags: ["security"],
              waiting_on: [{ kind: "decision", ref: "Q-2", label: "等你确认" }],
            },
            merge_confirmations: [q],
            decisions: [q],
          }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const row = await screen.findByRole("region", { name: "卡片状态" });
  for (const gone of ["等谁", "下一步：", "检查都已通过", "阻塞后续"])
    expect(row.textContent).not.toContain(gone);
  // The merge risk moved to the panel; the card's risk tags stay.
  expect(row.querySelector(".plain-summary-risk")).toBeNull();
  expect(row.textContent).toContain("风险标签：安全");
  expect(row.textContent).toContain("待合并");
  expect(row.textContent).toContain("更新于");
  expect(within(row).getByRole("button", { name: "编辑" })).toBeTruthy();
  expect(
    within(row).getByRole("button", { name: "更多卡片操作" }),
  ).toBeTruthy();
  // The page has one emphasis button: the panel's own 确认合并 (C-697).
  const next = screen.getByRole("region", { name: "下一步" });
  const emphasis = document.querySelectorAll(".ui-button-emphasis");
  expect(emphasis).toHaveLength(1);
  expect(next.contains(emphasis[0] as Node)).toBe(true);
  expect(emphasis[0]?.textContent).toBe("确认合并");
  // The overview no longer repeats the merge controls.
  expect(screen.queryByRole("region", { name: "合并处理" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "确认合并" })).toHaveLength(1);
  vi.unstubAllGlobals();
});

test("C-695: 写评论 opens the timeline and focuses the comment box", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          cardDetail({
            card: {
              ...card,
              waiting_on: [],
              next_owners: [{ kind: "role", ref: "coder" }],
            },
          }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const next = await screen.findByRole("region", { name: "下一步" });
  fireEvent.click(within(next).getByRole("button", { name: "写评论" }));
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("评论正文"),
  );
  expect(
    screen.getByRole("tab", { name: /时间线/ }).getAttribute("aria-selected"),
  ).toBe("true");
  vi.unstubAllGlobals();
});

const storyDetail = (answered: boolean) =>
  cardDetail({
    card: {
      ...card,
      waiting_on: [],
      next_owners: [{ kind: "human", ref: "human" }],
      story: {
        question_groups: [
          {
            id: "C-1#3",
            questions: [
              {
                question: "格式？",
                recommended: "CSV",
                impact: "",
                ...(answered
                  ? {
                      resolution: {
                        source: "answer" as const,
                        value: "CSV",
                        entry_id: "C-1#4",
                      },
                    }
                  : {}),
              },
              { question: "范围？", recommended: "全部", impact: "" },
            ],
          },
        ],
      },
    },
    template: { ...general, id: "story", story: true },
    mark_done: { allowed: false, reason: "子卡未全部结束" },
  });

test.each([
  [false, "第 1 题回答"],
  [true, "第 2 题回答"],
])(
  "C-695 V-3335: 回答问题 focuses the first open answer, not the comment box (first answered: %s)",
  async (answered, label) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      <CardDetailPage
        client={fakeClient({ card: async () => storyDetail(answered) })}
        projectId="p-1"
        cardId="C-1"
      />,
    );
    const next = await screen.findByRole("region", { name: "下一步" });
    fireEvent.click(within(next).getByRole("button", { name: "回答问题" }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(label),
    );
    expect(
      screen.getByRole("tab", { name: /时间线/ }).getAttribute("aria-selected"),
    ).toBe("true");
    vi.unstubAllGlobals();
  },
);

test("C-695: 恢复卡片 waits while another card form is open", () => {
  render(
    <CardNextStep
      detail={cardDetail({ card: { ...card, hold, waiting_on: [] } })}
      client={fakeClient()}
      projectId="p-1"
      onSaved={() => {}}
      onReveal={() => {}}
      markDone={() => null}
      busy
    />,
  );
  expect(
    screen.getByRole("button", { name: "恢复卡片" }).hasAttribute("disabled"),
  ).toBe(true);
});

/** C-701: an IntersectionObserver the test moves the panel through. */
function stubPanelObserver() {
  const observers: ((entries: IntersectionObserverEntry[]) => void)[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return (where: "above" | "in view" | "below") =>
    act(() => {
      for (const callback of observers)
        callback([
          {
            isIntersecting: where === "in view",
            boundingClientRect: {
              top: where === "above" ? -200 : where === "below" ? 900 : 100,
              bottom: where === "above" ? -40 : where === "below" ? 1100 : 300,
            },
            rootBounds: { top: 0 },
          } as unknown as IntersectionObserverEntry,
        ]);
    });
}

test("C-701: the page dock shows the card and the main action once the panel scrolls away", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const move = stubPanelObserver();
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () =>
          cardDetail({
            card: {
              ...card,
              waiting_on: [],
              next_owners: [{ kind: "human", ref: "human" }],
            },
            template: general,
            mark_done: { allowed: true, reason: null },
          }),
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const article = await screen.findByRole("article", { name: "卡片 C-1" });
  await screen.findByRole("region", { name: "下一步" });
  expect(screen.queryByRole("region", { name: "主操作" })).toBeNull();
  move("above");
  const dock = screen.getByRole("region", { name: "主操作" });
  // First in the detail, so it sticks to the top of what scrolls.
  expect(article.firstElementChild?.contains(dock)).toBe(true);
  expect(dock.textContent).toContain("C-1");
  expect(dock.textContent).toContain(card.title);
  const action = within(dock).getByRole("button", { name: "标记完成" });
  expect(action.className).toContain("ui-button-emphasis");
  fireEvent.click(action);
  // The panel's own action ran: its form opened and took the focus.
  await waitFor(() =>
    expect(
      screen
        .getByRole("form", { name: "标记完成" })
        .contains(document.activeElement),
    ).toBe(true),
  );
  // The modal dialog hides the page from the accessibility tree.
  expect(
    within(dock)
      .getByRole("button", { name: "标记完成", hidden: true })
      .hasAttribute("disabled"),
  ).toBe(true);
  move("in view");
  expect(screen.queryByRole("region", { name: "主操作" })).toBeNull();
  vi.unstubAllGlobals();
});

test("C-697: the drawer dock names the step and repeats 确认合并 from the merge panel", async () => {
  const move = stubPanelObserver();
  const recordDecision = vi.fn(async () => undefined);
  const client = fakeClient({ recordDecision });
  const slot = document.createElement("div");
  document.body.append(slot);
  const q = merge();
  render(
    <CardNextStep
      detail={cardDetail({
        card: {
          ...card,
          status: "awaiting_merge",
          waiting_on: [{ kind: "decision", ref: "Q-2", label: "等你确认合并" }],
        },
        merge_confirmations: [q],
        decisions: [q],
      })}
      client={client}
      projectId="p-1"
      onSaved={() => {}}
      onReveal={() => {}}
      markDone={() => null}
      mergePanel={(item, { title, mine, dockFor }) => (
        <MergePanel
          q={item}
          client={client}
          projectId="p-1"
          done={() => {}}
          title={title}
          mine={mine}
          dockFor={dockFor}
        />
      )}
      inDrawer
      dock={slot}
    />,
  );
  move("below");
  expect(slot.childElementCount).toBe(0);
  move("above");
  const dock = within(slot).getByRole("region", { name: "主操作" });
  expect(dock.textContent).toBe("等你确认合并Q-2确认合并");
  const action = within(dock).getByRole("button", { name: "确认合并" });
  expect(action.className).toContain("ui-button-emphasis");
  fireEvent.click(action);
  // The panel's own 确认合并 ran, with its idempotency key.
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-2",
      "merge",
      "",
      expect.any(String),
    ),
  );
  slot.remove();
  vi.unstubAllGlobals();
});

test("C-697: before a PM takeover the dock repeats 接手处理 and opens its dialog", async () => {
  const move = stubPanelObserver();
  const client = fakeClient();
  const slot = document.createElement("div");
  document.body.append(slot);
  const q = merge({ decider: "role:pm" });
  render(
    <CardNextStep
      detail={cardDetail({
        card: { ...card, status: "awaiting_merge", waiting_on: [] },
        merge_confirmations: [q],
        decisions: [q],
      })}
      client={client}
      projectId="p-1"
      onSaved={() => {}}
      onReveal={() => {}}
      markDone={() => null}
      mergePanel={(item, { title, mine, dockFor }) => (
        <MergePanel
          q={item}
          client={client}
          projectId="p-1"
          done={() => {}}
          title={title}
          mine={mine}
          dockFor={dockFor}
        />
      )}
      inDrawer
      dock={slot}
    />,
  );
  move("above");
  const dock = within(slot).getByRole("region", { name: "主操作" });
  expect(dock.textContent).toBe("等 PM 确认合并Q-2接手处理");
  const action = within(dock).getByRole("button", { name: "接手处理" });
  expect(action.className).toContain("ui-button-emphasis");
  fireEvent.click(action);
  expect(
    await screen.findByRole("dialog", { name: "接手 PM 合并确认" }),
  ).toBeTruthy();
  slot.remove();
  vi.unstubAllGlobals();
});

test.each([
  [
    "waiting on someone else",
    cardDetail({
      card: {
        ...card,
        waiting_on: [],
        next_owners: [{ kind: "role", ref: "coder" }],
      },
    }),
  ],
  [
    "a refused mark done",
    cardDetail({
      card: {
        ...card,
        waiting_on: [],
        next_owners: [{ kind: "human", ref: "human" }],
      },
      template: general,
      mark_done: { allowed: false, reason: "当前会话不能标记完成" },
    }),
  ],
])("C-701: no main action, no dock: %s", (_name, detail) => {
  const move = stubPanelObserver();
  const slot = document.createElement("div");
  render(
    <CardNextStep
      detail={detail}
      client={fakeClient()}
      projectId="p-1"
      onSaved={() => {}}
      onReveal={() => {}}
      markDone={() => (
        <button type="button" aria-disabled="true">
          标记完成
        </button>
      )}
      dock={slot}
    />,
  );
  move("above");
  expect(slot.childElementCount).toBe(0);
  vi.unstubAllGlobals();
});
