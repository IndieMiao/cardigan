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
import { App } from "../App.js";
import {
  ApiError,
  type NeedsDecision,
  type NeedsPage,
  type NoticesPage,
  type NoticeView,
} from "../api.js";
import { attachment, fakeClient } from "../testing/fixtures.js";
import { writeFailures } from "../testing/write-errors.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

const q = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "Q-1",
  question: "要发布吗？",
  context: "发布前的背景",
  why: "等待合并确认",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "保留工作树" },
  ],
  recommended: "merge",
  waited_ms: 120000,
  trigger: "merge_confirmation",
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "发布卡" }],
  merge_confirmation: null,
  ...overrides,
});
const merge = (overrides: Partial<NeedsDecision> = {}): NeedsDecision =>
  q({
    id: "Q-3",
    question: "Merge C-2 into main?",
    trigger: "merge_confirmation",
    why: "确认合并",
    merge_confirmation: {
      blockers: [],
      completion: {
        id: "D-9",
        work_item_id: "W-1",
        summary: "全部验收通过",
        subject: { kind: "git_head", value: "abcdef123456" },
      },
      deliveries: [
        {
          id: "D-8",
          work_item_id: "W-1",
          work_item_title: "实现",
          subject: { kind: "git_head", value: "abcdef123456" },
          summary: "增加 --json 输出",
        },
      ],
      reviews: [
        {
          id: "V-1",
          delivery_id: "D-8",
          work_item_id: "W-2",
          work_item_title: "代码审核",
          role_id: "reviewer",
          kind: "code",
          verdict: "pass",
          target_sha: "abcdef123456",
          issues: [],
        },
      ],
      known_gaps: [{ description: "Windows 未覆盖" }],
    },
    ...overrides,
  });
const page = (decisions = [q()]): NeedsPage => ({
  decisions,
  human_actions: [
    {
      id: "H-1",
      card_id: "C-1",
      why: "需要连接设备",
      instructions: "连接后运行 **检查**。",
      expected_return: "连接结果",
      due: null,
      waited_ms: 300000,
      blocked_work_items: [],
    },
  ],
  incidents: [],
});

test("pending merge checks show a count without adding a human task, then refresh after passing", async () => {
  let data: NeedsPage = {
    ...page([]),
    human_actions: [],
    waiting_merge_checks_count: 2,
    waiting_merge_check_items: [
      { decision_id: "Q-5", card_id: "C-4", check_status: "running" },
      { decision_id: "Q-6", card_id: null, check_status: null },
    ],
  };
  const client = fakeClient({ needsYou: async () => data });
  const view = render(
    <NeedsYouPage client={client} projectId="p-1" revision={0} />,
  );
  expect(
    await screen.findByText(
      "还有 2 条合并确认的检查在排队或运行中，检查结束后会出现在这里；也可以先到卡片详情处理：",
    ),
  ).toBeTruthy();
  // C-171: each counted confirmation links to its decision on the card.
  const list = within(screen.getByRole("list", { name: "等检查的合并确认" }));
  expect(
    list.getByRole("link", { name: "C-4 · Q-5" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-4?at=decision-Q-5");
  expect(list.getByText("（运行中）")).toBeTruthy();
  expect(list.getByText("Q-6")).toBeTruthy();
  expect(list.getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "合并确认" })).toBeNull();
  expect(screen.getByText(/没有需要你处理的事/)).toBeTruthy();
  data = {
    ...page([merge()]),
    waiting_merge_checks_count: 0,
    waiting_merge_check_items: [],
  };
  view.rerender(<NeedsYouPage client={client} projectId="p-1" revision={1} />);
  expect(await screen.findByRole("region", { name: "合并确认" })).toBeTruthy();
  expect(screen.queryByText(/排队或运行中/)).toBeNull();
});

test("C-171: a failed human merge check is listed with return, hold and recheck", async () => {
  const failed = merge({
    affected_cards: ["C-1", "C-2"],
    affected_card_views: [{ id: "C-2", title: "受影响卡", status: "review" }],
  });
  if (!failed.merge_confirmation) throw new Error("Missing fixture");
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => ({
          ...page([
            {
              ...failed,
              merge_confirmation: {
                ...failed.merge_confirmation,
                merge_gate_enabled: true,
                blockers: ["合并检查：未通过"],
                merge_check: {
                  status: "failed",
                  attempt_id: "a-1",
                  completion_id: "D-9",
                  checks: [],
                  updated_at: new Date().toISOString(),
                },
              },
            },
          ]),
          human_actions: [],
          waiting_merge_checks_count: 0,
          waiting_merge_check_items: [],
        }),
      })}
    />,
  );
  const group = within(await screen.findByRole("region", { name: "合并确认" }));
  const article = within(group.getByRole("article", { name: "合并确认 Q-3" }));
  expect(
    within(article.getByRole("region", { name: "Q-3 状态" })).getByText(
      "未通过",
    ),
  ).toBeTruthy();
  expect(article.getAllByText(/合并检查：未通过/).length).toBeGreaterThan(0);
  for (const name of ["确认合并", "退回修改", "暂不合并", "重新检查"])
    expect(article.getByRole("button", { name })).toBeTruthy();
  expect(article.getByText("等待中：")).toBeTruthy();
  expect(
    article
      .getByRole("button", { name: "确认合并", exact: true })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    within(article.getByRole("list", { name: "影响的卡片" }))
      .getByRole("link", { name: /C-2 受影响卡 审核中/ })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-2");
  expect(screen.queryByText(/排队或运行中/)).toBeNull();
});
test.each([null, "merge_confirmation"])(
  "C-133: %s separates the owning card from affected cards and refreshes their status",
  async (trigger) => {
    const affected = [
      { id: "C-1", title: "所属卡", status: "in_progress" },
      { id: "C-2", title: "标题很长的受影响卡片", status: "review" },
      { id: "C-3", title: "另一张卡", status: "done" },
    ];
    let data = page([
      q({
        trigger,
        affected_cards: affected.map((c) => c.id),
        affected_card_views: affected,
        related_cards: affected,
      }),
    ]);
    const client = fakeClient({ needsYou: async () => data });
    const view = render(
      <NeedsYouPage client={client} projectId="p-1" revision={0} />,
    );
    const row = within(await screen.findByRole("list", { name: "影响的卡片" }));
    expect(row.getAllByRole("link")).toHaveLength(2);
    expect(row.queryByText("C-1")).toBeNull();
    expect(
      row
        .getByRole("link", { name: /C-2 标题很长的受影响卡片 审核中/ })
        .getAttribute("href"),
    ).toBe("#/p/p-1/cards/C-2");
    expect(row.getByText("已完成")).toBeTruthy();
    expect(document.querySelector(".needs-meta")?.textContent).toContain("C-1");
    expect(document.querySelector(".needs-meta")?.textContent).not.toContain(
      "C-2",
    );
    data = page([
      q({
        trigger,
        affected_cards: ["C-2"],
        affected_card_views: [{ id: "C-2", title: "新标题", status: "done" }],
      }),
    ]);
    view.rerender(
      <NeedsYouPage client={client} projectId="p-1" revision={1} />,
    );
    expect(
      await screen.findByRole("link", { name: /C-2 新标题 已完成/ }),
    ).toBeTruthy();
  },
);

test.each([[], ["C-1"]].map((ids) => ({ ids })))(
  "C-133: no impact row for $ids",
  async ({ ids }) => {
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () =>
            page([
              q({
                affected_cards: ids,
                affected_card_views: ids.map((id) => ({
                  id,
                  title: "所属卡",
                  status: "in_progress",
                })),
              }),
            ]),
        })}
      />,
    );
    await screen.findByRole("article", { name: "合并确认 Q-1" });
    expect(screen.queryByRole("list", { name: "影响的卡片" })).toBeNull();
    expect(screen.getByRole("link", { name: "C-1 发布卡" })).toBeTruthy();
  },
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.location.hash = "";
});

test.each(
  writeFailures.flatMap((failure) =>
    ["decision", "comment", "action"].map((operation) => ({
      ...failure,
      operation,
    })),
  ),
)(
  "$operation shows the right write failure for $label",
  async ({ operation, error, uncertain, reason }) => {
    const fail = async () => {
      throw error;
    };
    render(
      <NeedsYouPage
        client={fakeClient({
          needsYou: async () => page([q({ trigger: null })]),
          recordDecision: fail,
          decisionComment: fail,
          completeAction: fail,
        })}
        projectId="p-1"
      />,
    );
    await screen.findByRole("article", { name: "执行 H-1" });
    if (operation === "action") {
      fireEvent.change(screen.getByLabelText("H-1 执行结果"), {
        target: { value: "已完成" },
      });
      fireEvent.click(screen.getByRole("button", { name: "确认已完成" }));
    } else if (operation === "comment") {
      fireEvent.click(screen.getByRole("button", { name: "要求补充信息" }));
    } else {
      fireEvent.click(screen.getByRole("radio", { name: /合并/u }));
      fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
    }
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.includes("可能已经成功")).toBe(uncertain);
    expect(alert.textContent).toContain(reason);
  },
);

test("groups runtime incidents, blocking decisions, merge confirmations, other decisions and actions in order", async () => {
  const data = page([
    q({ id: "Q-4", trigger: null, blocking: false, why: "普通拍板" }),
    merge({ id: "Q-3", blocking: true }),
    q({ id: "Q-1", trigger: null, blocking: true, why: "阻塞拍板" }),
    q({
      id: "Q-2",
      trigger: null,
      blocking: false,
      category: "permission",
      why: "权限确认",
    }),
  ]);
  data.incidents = [
    {
      id: "A-3",
      role_id: "coder",
      runtime_state: "lost",
      waited_ms: 60000,
      card_id: "C-1",
      disconnected_at: "2026-01-01T00:00:00.000Z",
      lost_at: "2026-01-01T00:05:00.000Z",
      last_run: null,
    },
  ];
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("article", { name: "拍板 Q-1" });
  const regions = [
    "运行异常",
    "阻塞拍板",
    "合并确认",
    "其他拍板",
    "待你执行",
  ].map((name) => screen.getByRole("region", { name }));
  const before = (left: Node, right: Node) =>
    Boolean(
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  for (let index = 1; index < regions.length; index += 1)
    expect(before(regions[index - 1] as Node, regions[index] as Node)).toBe(
      true,
    );

  const blocking = within(screen.getByRole("region", { name: "阻塞拍板" }));
  expect(blocking.getByRole("article", { name: "拍板 Q-1" })).toBeTruthy();
  expect(blocking.queryByRole("article", { name: "拍板 Q-2" })).toBeNull();
  const merges = within(screen.getByRole("region", { name: "合并确认" }));
  expect(merges.getByRole("article", { name: "合并确认 Q-3" })).toBeTruthy();
  const other = within(screen.getByRole("region", { name: "其他拍板" }));
  expect(other.getByRole("article", { name: "拍板 Q-2" })).toBeTruthy();
  expect(other.getByRole("article", { name: "拍板 Q-4" })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "待你执行" }).textContent,
  ).toContain("连接结果");
});

test("decision cards collapse the background, do not preselect an option and expose the impact", async () => {
  const data = page([
    q({
      id: "Q-1",
      trigger: null,
      context: "这是需要折叠的完整背景。",
      options: [
        { key: "a", description: "方案 A", impact: "影响 A" },
        { key: "b", description: "方案 B", impact: "影响 B" },
      ],
      recommended: "a",
    }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  const card = await screen.findByRole("article", { name: "拍板 Q-1" });
  expect(within(card).getAllByText("要发布吗？")).toHaveLength(1);
  expect(within(card).queryByText("待拍板")).toBeNull();
  expect(within(card).queryByText("等待合并确认")).toBeNull();
  expect(screen.getByText("这是需要折叠的完整背景。")).toBeTruthy();
  const background = within(card).getByText("背景").closest("details");
  expect(background?.open).toBe(false);
  const radios = within(card).getAllByRole("radio");
  expect(radios).toHaveLength(2);
  for (const radio of radios)
    expect((radio as HTMLInputElement).checked).toBe(false);
  expect(within(card).getByText("推荐")).toBeTruthy();
  expect(within(card).getByText("影响：影响 A")).toBeTruthy();
  const submit = within(card).getByRole("button", { name: "按所选拍板" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(radios[1] as HTMLInputElement);
  expect((submit as HTMLButtonElement).disabled).toBe(false);
});

test("C-95: referenced images show as thumbnails that open the lightbox; other files are download links", async () => {
  const file = (id: string, mime: string, name: string) =>
    attachment({
      id,
      original_filename: name,
      mime,
      inline: mime.startsWith("image/"),
      download_path: `/api/projects/p-1/attachments/${id}`,
    });
  const data = page([
    q({
      id: "Q-1",
      trigger: null,
      attachments: [
        file("F-2", "application/pdf", "spec.pdf"),
        file("F-1", "image/png", "before.png"),
      ],
    }),
    q({ id: "Q-2", trigger: null, question: "不带附件" }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  const card = await screen.findByRole("article", { name: "拍板 Q-1" });
  const list = within(card).getByRole("list", { name: "拍板附件" });
  const items = within(list).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual(["▤ spec.pdf", ""]);
  const link = within(list).getByRole("link", { name: "▤ spec.pdf" });
  expect(link.getAttribute("href")).toBe("/api/projects/p-1/attachments/F-2");
  expect(link.hasAttribute("download")).toBe(true);
  const thumb = within(list).getByRole("button", { name: "预览 before.png" });
  expect(within(thumb).getByRole("img").getAttribute("src")).toBe(
    "/api/projects/p-1/attachments/F-1",
  );
  const plain = screen.getByRole("article", { name: "拍板 Q-2" });
  expect(within(plain).queryByRole("list", { name: "拍板附件" })).toBeNull();
  fireEvent.click(thumb);
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByRole("img", { name: "附件 before.png" }).className,
  ).toBe("lightbox-image");
});

test("C-95: merge confirmations show the completion request's attachments", async () => {
  const data = page([
    merge({
      attachments: [attachment({ id: "F-7", original_filename: "after.png" })],
    }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  const card = await screen.findByRole("article", { name: "合并确认 Q-3" });
  expect(
    within(within(card).getByRole("list", { name: "拍板附件" })).getByRole(
      "button",
      { name: "预览 after.png" },
    ),
  ).toBeTruthy();
});

test.each(["approve", "reject", "merge", "keep", "force_clean"])(
  "submits %s with the exact quote and reloads Needs You",
  async (option) => {
    const data = page([
      q({
        recommended: option,
        options: [{ key: option, description: option, impact: "结果" }],
        trigger:
          option.includes("clean") || option === "keep"
            ? "worktree_cleanup"
            : null,
        assignment_id: "A-1",
      }),
    ]);
    const recordDecision = vi.fn().mockResolvedValue(undefined),
      needsYou = vi
        .fn()
        .mockResolvedValueOnce(data)
        .mockResolvedValue({ decisions: [], human_actions: [], incidents: [] });
    render(
      <NeedsYouPage
        client={fakeClient({ needsYou, recordDecision })}
        projectId="p-1"
      />,
    );
    await screen.findByRole("article", { name: "拍板 Q-1" });
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.change(screen.getByLabelText("Q-1 原话或补充说明"), {
      target: { value: "  我选这个  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
    await screen.findByText(
      "没有需要你处理的事。Agent 提出拍板或需要你确认合并时会出现在这里。",
    );
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-1",
      option,
      "  我选这个  ",
      expect.any(String),
    );
    expect(needsYou).toHaveBeenCalledTimes(2);
  },
);

test("merge confirmation lists the deliveries, reviews and known gaps and records merge", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page([merge({ id: "Q-3" })]),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const card = await screen.findByRole("article", { name: "合并确认 Q-3" });
  expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe(
    "确认把 C-2 合并到 main？",
  );
  const deliveries = within(card).getByRole("group", { name: "要合并的交付" });
  expect(deliveries.textContent).toContain("实现");
  expect(deliveries.textContent).toContain("增加 --json 输出");
  expect(deliveries.textContent).toContain("abcdef123456");
  expect(
    within(deliveries)
      .getByRole("link", { name: "查看改动" })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1?at=delivery-D-8");
  const reviews = within(card).getByRole("group", { name: "审核与验收" });
  expect(reviews.textContent).toContain("代码审核");
  expect(reviews.textContent).toContain("已通过");
  expect(
    within(card).getByRole("group", { name: "已知遗留" }).textContent,
  ).toContain("Windows 未覆盖");
  fireEvent.change(within(card).getByLabelText("Q-3 原话或补充说明"), {
    target: { value: " 可以合并 " },
  });
  fireEvent.click(within(card).getByRole("button", { name: "确认合并" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "merge",
      " 可以合并 ",
      expect.any(String),
    ),
  );
});

test.each([
  ["要求补充信息", "request_information"],
  ["请 PM 解释", "explain"],
] as const)("%s calls the decision-comment action", async (label, action) => {
  const decisionComment = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page([q({ trigger: null })]),
        decisionComment,
      })}
      projectId="p-1"
    />,
  );
  await screen.findByLabelText("Q-1 原话或补充说明");
  fireEvent.change(screen.getByLabelText("Q-1 原话或补充说明"), {
    target: { value: "请说明影响" },
  });
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(decisionComment).toHaveBeenCalledWith(
      "p-1",
      "Q-1",
      action,
      "请说明影响",
      expect.any(String),
    ),
  );
});

test.each(["open", "resolved"])(
  "returning a %s merge requires a nonblank reason and submits the exact explanation",
  async (status) => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    render(
      <NeedsYouPage
        client={fakeClient({
          needsYou: async () =>
            page([merge({ status, why: "合并检查失败或超时，可以退回修改" })]),
          recordDecision,
        })}
        projectId="p-1"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "退回修改" }));
    if (status === "resolved") {
      expect(screen.queryByRole("button", { name: "确认合并" })).toBeNull();
      expect(screen.queryByRole("button", { name: "暂不合并" })).toBeNull();
      expect(screen.getByText("合并检查失败或超时，可以退回修改")).toBeTruthy();
    }
    const reason = screen.getByLabelText("Q-3 退回原因");
    const submit = screen.getByRole("button", {
      name: "确认退回修改",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: " \n " } });
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(recordDecision).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: " 请补齐空输入校验 " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-3",
        "request_changes",
        " 请补齐空输入校验 ",
        expect.any(String),
      ),
    );
  },
);

test("hold requires a separate reason after cancelling the return form", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page([merge()]),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "退回修改" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByLabelText("Q-3 退回原因")).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "暂不合并" }));
  expect(
    (screen.getByRole("button", { name: "登记暂缓" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("暂缓原因（必填）"), {
    target: { value: "等待核对" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登记暂缓" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "hold",
      "等待核对",
      expect.any(String),
      false,
      undefined,
    ),
  );
});

test("C-196: a hold over the cap names the settings label, not the preference key", async () => {
  const recordDecision = vi
    .fn()
    .mockRejectedValue(
      new ApiError(
        400,
        "validation_failed",
        "暂缓到期时间距现在不能超过 4320 分钟（merge-confirm-snooze-max）",
      ),
    );
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page([merge()]),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "暂不合并" }));
  fireEvent.change(screen.getByLabelText("暂缓原因（必填）"), {
    target: { value: "等待核对" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登记暂缓" }));
  const alert = (await screen.findByRole("alert")).textContent ?? "";
  expect(alert).toContain(
    "暂缓到期时间距现在不能超过 4320 分钟（可在项目设置的“合并确认最长暂缓时长”中调整）",
  );
  expect(alert).not.toContain("merge-confirm-snooze-max");
  expect(
    (screen.getByLabelText("暂缓原因（必填）") as HTMLTextAreaElement).value,
  ).toBe("等待核对");
});

test("execution results require text; errors preserve the draft for retry", async () => {
  const completeAction = vi
    .fn()
    .mockRejectedValueOnce(new Error("暂时失败"))
    .mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => page(), completeAction })}
      projectId="p-1"
    />,
  );
  const submit = await screen.findByRole("button", { name: "确认已完成" });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("H-1 执行结果"), {
    target: { value: "设备已连接" },
  });
  fireEvent.click(submit);
  await screen.findByText("暂时失败");
  expect(
    (screen.getByLabelText("H-1 执行结果") as HTMLTextAreaElement).value,
  ).toBe("设备已连接");
  fireEvent.click(submit);
  await waitFor(() => expect(completeAction).toHaveBeenCalledTimes(2));
  expect(completeAction).toHaveBeenLastCalledWith(
    "p-1",
    "H-1",
    "设备已连接",
    expect.any(String),
  );
});

test("handles loading, failed reads with retry, and empty data", async () => {
  let settle: (p: NeedsPage) => void = () => {};
  const needsYou = vi
    .fn<() => Promise<NeedsPage>>()
    .mockRejectedValueOnce(new Error("读取失败"))
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
  render(<NeedsYouPage client={fakeClient({ needsYou })} projectId="p-1" />);
  await screen.findByText("读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(screen.getByText("正在加载…")).toBeTruthy();
  settle({ decisions: [], human_actions: [], incidents: [] });
  await screen.findByText(
    "没有需要你处理的事。Agent 提出拍板或需要你确认合并时会出现在这里。",
  );
});

test("project decisions explain unavailable comments; cleanup and lost runtimes show real commands", async () => {
  const data = page([
    q({ card_id: null, trigger: "worktree_cleanup", assignment_id: "A-2" }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...data,
          incidents: [
            {
              id: "A-3",
              role_id: "coder",
              runtime_state: "lost",
              waited_ms: 60000,
              card_id: "C-1",
              disconnected_at: "2026-01-01T00:00:00.000Z",
              lost_at: "2026-01-01T00:05:00.000Z",
              last_run: {
                id: "R-9",
                assignment_id: "A-3",
                status: "unknown",
                kind: "followup",
                model: "fixture",
                role_version: 1,
                agent_cli_version: "1",
                summary: "等待恢复",
              },
            },
          ],
        }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByText("失联");
  expect(
    document
      .querySelector('time[datetime="2026-01-01T00:00:00.000Z"]')
      ?.getAttribute("title"),
  ).toContain("GMT");
  expect(screen.getByText("R-9").closest("p")?.textContent).toContain(
    "最近 Run：R-9",
  );
  expect(screen.queryByRole("button", { name: /^(接管|替换)/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "要求补充信息" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByText("cardigan worktree diff 'A-2' --project 'p-1'"),
  ).toBeTruthy();
  expect(
    screen.getByText("cardigan assignment attach 'A-3' --project 'p-1'"),
  ).toBeTruthy();
  const article = screen.getByRole("article", { name: "运行异常 A-3" });
  const incident = within(article);
  // No host_ops and no PM Office: the human must contact the platform owner.
  expect(article.textContent).toContain(
    "这个项目没有配置主机运维，不会自动恢复。",
  );
  expect(
    incident.getByText("需要你操作：请按下面的步骤联系平台负责人。"),
  ).toBeTruthy();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const operator = incident
    .getByText("主机操作员用")
    .closest("details") as HTMLDetailsElement;
  expect(operator.open).toBe(false);
  expect(
    within(operator).getByText(/需要在主机上、加载了运行环境的 shell 里执行/),
  ).toBeTruthy();
  for (const name of ["复制查看终端（只看不动）", "复制检查异常"])
    expect(incident.getByRole("button", { name }).closest("details")).toBe(
      operator,
    );
  fireEvent.click(
    incident.getByRole("button", { name: "复制查看终端（只看不动）" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      "cardigan assignment attach 'A-3' --project 'p-1'",
    ),
  );
  const summary = incident.getByText("需要接管输入？");
  const details = summary.closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(details).not.toBe(operator);
  expect(
    incident.getByRole("button", { name: "复制接管输入" }).closest("details"),
  ).toBe(details);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  // The warning comes before the command.
  expect(details.querySelector("summary + p")?.textContent).toBe(
    "接管会直接向 Agent 终端输入，可能打断它。只在 PM Office 或主机运维请你接管时使用。",
  );
  fireEvent.click(incident.getByRole("button", { name: "复制接管输入" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "cardigan assignment attach 'A-3' --project 'p-1' --interactive",
    ),
  );
});

const lostIncident = (waited_ms: number) => ({
  id: "A-3",
  role_id: "coder",
  runtime_state: "lost",
  waited_ms,
  card_id: "C-1",
  disconnected_at: "2026-01-01T00:00:00.000Z",
  lost_at: null,
  last_run: null,
});
const handling = {
  host_ops: {
    assignment_id: "A-90",
    name: "张良",
    mention: "张良",
    patrol_interval_ms: 30 * 60000,
  },
  pm_office: { assignment_id: "A-91", name: "王熙凤", mention: "A-91" },
  hc_session: "prod-hc",
};

test("C-153: with host_ops patrolling, a fresh incident tells the human to wait", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          incident_handling: handling,
          incidents: [lostIncident(12 * 60000)],
        }),
      })}
      projectId="p-1"
    />,
  );
  const article = await screen.findByRole("article", {
    name: "运行异常 A-3",
  });
  const text = article.textContent ?? "";
  expect(text).toContain("这个 Agent 的运行环境失联了");
  expect(text).toContain(
    "主机运维 张良 每 30 分钟巡检一次，会自动取消、重排或重启卡住、失联的 Run。",
  );
  expect(within(article).getByText("你现在不需要操作。")).toBeTruthy();
  expect(text).toContain("已等待 12 分钟。超过 30 分钟仍未恢复时，请这样做：");
  const steps = [...article.querySelectorAll("ol.incident-steps > li")].map(
    (li) => li.textContent,
  );
  expect(steps).toEqual([
    "打开卡片 C-1。",
    "在卡片页底部的“评论正文”框里填写：@A-91 A-3 运行异常超过 30 分钟仍未恢复，请处理。",
    "点“发表评论”。",
    "等 PM Office（王熙凤）回复。只有 PM Office 或主机运维明确请你接管时，才展开下面的“需要接管输入？”。",
  ]);
  // C-153#3: commands carry the session registered in runtime.json.
  expect(
    within(article).getByText(
      "cardigan assignment attach 'A-3' --project 'p-1' --hc-session 'prod-hc'",
    ),
  ).toBeTruthy();
  expect(
    within(article).getByText(
      "cardigan assignment attach 'A-3' --project 'p-1' --hc-session 'prod-hc' --interactive",
    ),
  ).toBeTruthy();
  expect(text).toContain(
    "hc 会话 prod-hc 取自 server 登记的运行时（runtime.json）。",
  );
});

test("C-153: past the patrol interval the incident asks the human to act", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          incident_handling: handling,
          incidents: [lostIncident(31 * 60000)],
        }),
      })}
      projectId="p-1"
    />,
  );
  const article = await screen.findByRole("article", {
    name: "运行异常 A-3",
  });
  expect(
    within(article).getByText(
      "需要你操作：请按下面的步骤联系 PM Office（王熙凤）。",
    ),
  ).toBeTruthy();
  expect(within(article).queryByText("你现在不需要操作。")).toBeNull();
  expect(article.textContent).toContain("已超过 30 分钟仍未恢复：");
});

test("C-153: without host_ops the incident points straight to PM Office", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          incident_handling: {
            host_ops: null,
            pm_office: handling.pm_office,
            hc_session: null,
          },
          incidents: [lostIncident(60000)],
        }),
      })}
      projectId="p-1"
    />,
  );
  const article = await screen.findByRole("article", {
    name: "运行异常 A-3",
  });
  expect(article.textContent).toContain(
    "这个项目没有配置主机运维，不会自动恢复。",
  );
  expect(
    within(article).getByText(
      "需要你操作：请按下面的步骤联系 PM Office（王熙凤）。",
    ),
  ).toBeTruthy();
  expect(article.textContent).toContain("@A-91 A-3 运行异常仍未恢复，请处理。");
});

test("empty groups are not rendered", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => page([]) })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("article", { name: "执行 H-1" });
  for (const name of ["运行异常", "阻塞拍板", "合并确认", "其他拍板"])
    expect(screen.queryByRole("region", { name })).toBeNull();
  expect(screen.getByRole("region", { name: "待你执行" })).toBeTruthy();
});

test("Needs You is reachable through the hash navigation and preserves project switching", async () => {
  window.location.hash = "#/p/p-1/needs-you";
  const needsYou = vi.fn(async (projectId: string) => ({
    ...page([
      q({
        id: projectId === "p-1" ? "Q-1" : "Q-2",
        question:
          projectId === "p-1"
            ? "First project decision"
            : "Second project decision",
      }),
    ]),
    human_actions: [],
  }));
  render(
    <App
      client={fakeClient({
        needsYou,
        projects: async () => [
          { id: "p-1", name: "First", created_at: "now" },
          { id: "p-2", name: "Second", created_at: "now" },
        ],
      })}
    />,
  );
  await screen.findByText("First project decision");
  expect(
    screen
      .getByRole("link", { name: "Needs You 1" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.change(screen.getByLabelText("项目"), { target: { value: "p-2" } });
  // Automatic reads also carry the invalidation key used for shared reads.
  await waitFor(() =>
    expect(needsYou).toHaveBeenLastCalledWith("p-2", expect.any(String)),
  );
  expect(window.location.hash).toBe("#/p/p-2/needs-you");
  await screen.findByText("Second project decision");
  expect(screen.queryByText("First project decision")).toBeNull();

  fireEvent.change(screen.getByLabelText("项目"), { target: { value: "p-1" } });
  await screen.findByText("First project decision");
  expect(needsYou).toHaveBeenLastCalledWith("p-1", expect.any(String));
  expect(window.location.hash).toBe("#/p/p-1/needs-you");
  expect(screen.queryByText("Second project decision")).toBeNull();
});

test("waiting durations advance without changing the decision draft", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => page([q({ trigger: null })]),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByLabelText("Q-1 原话或补充说明");
  fireEvent.change(screen.getByLabelText("Q-1 原话或补充说明"), {
    target: { value: "未提交" },
  });
  act(() => vi.advanceTimersByTime(60000));
  expect(
    screen.getByRole("article", { name: "拍板 Q-1" }).textContent,
  ).toContain("已等待 3 分钟");
  expect(
    (screen.getByLabelText("Q-1 原话或补充说明") as HTMLTextAreaElement).value,
  ).toBe("未提交");
});

test.each(["decision", "clarification", "completion"] as const)(
  "%s retries keep their key and a later successful operation gets a new one",
  async (kind) => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(undefined);
    render(
      <NeedsYouPage
        client={fakeClient({
          needsYou: async () => page([q({ trigger: null })]),
          recordDecision: operation,
          decisionComment: operation,
          completeAction: operation,
        })}
        projectId="p-1"
      />,
    );
    await screen.findByText("需要连接设备");
    if (kind === "decision")
      fireEvent.click(screen.getByRole("radio", { name: /merge/u }));
    const input = kind === "completion" ? "H-1 执行结果" : "Q-1 原话或补充说明";
    const button =
      kind === "completion"
        ? "确认已完成"
        : kind === "clarification"
          ? "要求补充信息"
          : "按所选拍板";
    fireEvent.change(screen.getByLabelText(input), {
      target: { value: "同一次操作" },
    });
    fireEvent.click(screen.getByRole("button", { name: button }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const firstKey = operation.mock.calls[0]?.at(-1);
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(operation.mock.calls[1]?.at(-1)).toBe(firstKey);
    await screen.findByText("已提交");
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    expect(operation.mock.calls[2]?.at(-1)).not.toBe(firstKey);
  },
);

test.each(["pause", "raise_limit"])(
  "review-limit options show Chinese labels and the server recommendation (%s)",
  async (recommended) => {
    const decision = q({
      trigger: "review_limit",
      question: "审核轮数已用完：W-1",
      context: "已达到审核上限，上一轮结论已记录。",
      options: [
        {
          key: "pause",
          description: "暂停：保持停止，不安排返工",
          impact: "保留阻塞",
        },
        { key: "raise_limit", description: "增加轮数", impact: "继续审核" },
      ],
      recommended,
    });
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({ needsYou: async () => page([decision]) })}
      />,
    );
    const article = within(
      await screen.findByRole("article", { name: "拍板 Q-1" }),
    );
    const pause = article.getByRole("radio", { name: /暂停：保持停止/u });
    const raise = article.getByRole("radio", { name: /增加一轮审核额度/u });
    expect(
      (recommended === "pause" ? pause : raise).getAttribute("value"),
    ).toBe(recommended);
    expect(article.getByText("推荐").closest("label")?.textContent).toContain(
      recommended === "pause" ? "暂停" : "增加轮数",
    );
    expect(article.queryByText(/raise_limit|pause/u)).toBeNull();
  },
);

test.each([
  ["open", "授权已关闭"],
  ["open", "累计代批已达上限"],
  ["open", "没有新交付"],
  ["provisional", "卡片被标记为敏感"],
])(
  "independent review %s/%s points to its dedicated setting without granting a category",
  async (status, context) => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const decision = q({
      trigger: "review_limit",
      status,
      context,
      independent_review_limit: { max_delegated_raises: 3 },
      options: [
        { key: "raise_limit", description: "增加轮数", impact: "增加一轮" },
      ],
      recommended: "raise_limit",
    });
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          recordDecision,
          needsYou: async () => page([decision]),
        })}
      />,
    );
    const article = within(
      await screen.findByRole("article", { name: "拍板 Q-1" }),
    );
    expect(
      article.queryByRole("checkbox", { name: "此类问题以后由 PM 代拍" }),
    ).toBeNull();
    expect(
      article
        .getByRole("link", { name: "管理独立复核加轮授权" })
        .getAttribute("href"),
    ).toBe("#/p/p-1/settings?tab=authorization");
    expect(article.getByText(/每项累计最多代批 3 次/)).toBeTruthy();
    expect(article.getByText(/重新开启也不接回已交人的事项/)).toBeTruthy();
    if (status !== "provisional") fireEvent.click(article.getByRole("radio"));
    fireEvent.click(
      article.getByRole("button", {
        name: status === "provisional" ? "增加一轮审核额度" : "按所选拍板",
      }),
    );
    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-1",
        "raise_limit",
        "",
        expect.any(String),
      ),
    );
  },
);

test("a category checkbox selected before refresh cannot grant an independent review category", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const client = fakeClient({ recordDecision });
  const decision = q({
    trigger: "review_limit",
    options: [
      { key: "raise_limit", description: "增加轮数", impact: "增加一轮" },
    ],
  });
  const view = (current: NeedsDecision) => (
    <NeedsYouPage
      projectId="p-1"
      client={client}
      resource={{
        data: page([current]),
        pending: false,
        error: undefined,
        reload: () => {},
      }}
    />
  );
  const rendered = render(view(decision));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "此类问题以后由 PM 代拍" }),
  );
  fireEvent.click(screen.getByRole("radio"));
  rendered.rerender(
    view({
      ...decision,
      independent_review_limit: { max_delegated_raises: 3 },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-1",
      "raise_limit",
      "",
      expect.any(String),
    ),
  );
});

test("a paused review-limit decision keeps only raise_limit and explains its automatic effect", async () => {
  const decision = q({
    trigger: "review_limit",
    status: "provisional",
    options: [
      { key: "pause", description: "暂停", impact: "保留阻塞" },
      { key: "raise_limit", description: "旧版说明", impact: "旧版后果" },
    ],
    recommended: "pause",
  });
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => page([decision]),
        recordDecision,
      })}
    />,
  );
  const article = within(
    await screen.findByRole("article", { name: "拍板 Q-1" }),
  );
  expect(article.getByText("已暂停（临时决定）")).toBeTruthy();
  expect(article.getAllByRole("radio")).toHaveLength(1);
  expect(article.getAllByRole("button")).toHaveLength(1);
  expect(article.getByText(/审核上限加 1；没有其他阻塞/u)).toBeTruthy();
  expect(article.queryByText(/raise_limit|pause/u)).toBeNull();
  fireEvent.click(article.getByRole("button", { name: "增加一轮审核额度" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-1",
      "raise_limit",
      "",
      expect.any(String),
    ),
  );
});

test("merge confirmation shows due time and a decreasing countdown", async () => {
  vi.useFakeTimers();
  const data = page([
    merge({
      auto_merge: { minutes: 10, due_at: "2026-01-01T00:10:00.000Z" },
      waited_ms: 120000,
    }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient()}
      projectId="p-1"
      resource={{ data, pending: false, error: undefined, reload: () => {} }}
    />,
  );
  expect(screen.getByText(/偏好设置：10 分钟/)).toBeTruthy();
  expect(screen.getByText(/剩余 8 分钟/)).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(screen.getByText(/剩余 7 分钟/)).toBeTruthy();
});

test("answering a human scope decision can grant future PM authority in the same request", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        recordDecision,
        needsYou: async () => ({
          decisions: [q({ trigger: null, category: "scope_change" })],
          human_actions: [],
          incidents: [],
        }),
      })}
    />,
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "此类问题以后由 PM 代拍" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: /merge/ }));
  fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-1",
      "merge",
      "",
      expect.any(String),
      true,
    ),
  );
});
test.each(["spending", "account", "permission", "data_deletion"])(
  "%s never offers the delegation checkbox",
  async (category) => {
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () => ({
            decisions: [q({ trigger: null, category })],
            human_actions: [],
            incidents: [],
          }),
        })}
      />,
    );
    await screen.findByRole("article", { name: "拍板 Q-1" });
    expect(
      screen.queryByRole("checkbox", { name: "此类问题以后由 PM 代拍" }),
    ).toBeNull();
  },
);

test("unclaimed decision follow-up displays its outcome without offering a second decision", async () => {
  const recordDecision = vi.fn();
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        recordDecision,
        needsYou: async () => ({
          decisions: [
            q({
              trigger: null,
              status: "resolved",
              followup_notice: "无 PM Ops 接手，请跟进落实",
              resolution: {
                option: "merge",
                rationale: "已确认",
                raw_quote: "同意",
                at: "2026-11-10T00:00:00Z",
              },
            }),
          ],
          human_actions: [],
          incidents: [],
        }),
      })}
    />,
  );
  const notice = await screen.findByRole("article", { name: "拍板落实 Q-1" });
  expect(within(notice).getByText("已选方案：合并")).toBeTruthy();
  expect(within(notice).getByText("影响：更新基线")).toBeTruthy();
  expect(within(notice).queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "按所选拍板" })).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();
});

test("failed confirmed merges remain returnable beside read-only decision follow-up notices", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const followup = q({
    trigger: null,
    status: "resolved",
    followup_notice: "当前无 PM Ops 接手，请安排落实",
    resolution: {
      option: "merge",
      rationale: "已决定",
      raw_quote: "同意",
      at: "2026-11-10T00:00:00Z",
    },
  });
  const failed = merge({
    status: "resolved",
    why: "合并检查失败或超时，可以退回修改",
    options: [
      { key: "request_changes", description: "退回修改", impact: "重新交付" },
    ],
    recommended: "request_changes",
  });
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        recordDecision,
        needsYou: async () => page([followup, failed]),
      })}
    />,
  );
  const notice = await screen.findByRole("article", { name: "拍板落实 Q-1" });
  expect(within(notice).queryByRole("radio")).toBeNull();
  expect(within(notice).queryByRole("button", { name: "退回修改" })).toBeNull();
  const confirmation = screen.getByRole("article", { name: "合并确认 Q-3" });
  expect(
    within(confirmation).queryByRole("button", { name: "确认合并" }),
  ).toBeNull();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "退回修改" }),
  );
  fireEvent.change(within(confirmation).getByLabelText("Q-3 退回原因"), {
    target: { value: "修复检查失败" },
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "确认退回修改" }),
  );
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-3",
      "request_changes",
      "修复检查失败",
      expect.any(String),
    ),
  );
  expect(recordDecision).toHaveBeenCalledTimes(1);
});

test.each(["host", "human"] as const)(
  "a PM %s handoff shows only what to do by default and folds the explanations (C-212)",
  async (triage) => {
    const item = {
      id: "H-3",
      card_id: "C-1",
      instructions: "1. 在主机终端执行 git fetch\n2. 回传最新版本号",
      expected_return: "最新版本号",
      why: "需要主机权限",
      triage,
      ...(triage === "host" ? { host_operator: "external" as const } : {}),
      waited_ms: 0,
      due: null,
      blocked_work_items: [],
      handoff: {
        title: "请同步主机上的最新项目代码",
        todo: "在主机上同步最新代码并回传版本号",
        summary: "开发者缺少继续修改所需的最新代码。",
        why_human: "仓库凭据只在你的主机上，项目经理无法读取。",
        instructions: "1. 在主机终端执行 git fetch\n2. 回传最新版本号",
        expected_outcome: "同步完成后开发者就能继续工作。",
        expected_return: "最新版本号",
        rewritten_by: "assignment:A-4",
        rewritten_at: "2026-11-10T09:00:00Z",
      },
      original_request: {
        instructions: "submit_delivery(kind=card_completion) blocked",
        why_human: "repository unavailable",
        expected_return: "SHA",
      },
    };
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () => ({
            decisions: [],
            human_actions: [item],
            incidents: [],
          }),
        })}
      />,
    );
    const article = await screen.findByRole("article", { name: "执行 H-3" });
    expect(
      within(article).getByRole("heading", {
        name: `${triage === "host" ? "主机操作：" : ""}请同步主机上的最新项目代码`,
      }),
    ).toBeTruthy();
    expect(
      within(article)
        .getByText(triage === "host" ? "待外接操作员" : "待你执行")
        .querySelector("svg.status-shape-pending"),
    ).toBeTruthy();
    // Shown by default: todo, numbered steps and the confirm button.
    const todo = within(article).getByLabelText("H-3 你要做什么");
    expect(todo.textContent).toBe(item.handoff.todo);
    // Not inside the article's folds (a host group folds as a whole).
    const inFold = (el: Element) => !!el.closest("article details");
    expect(inFold(todo)).toBe(false);
    const steps = within(article).getByLabelText("H-3 步骤");
    expect(inFold(steps)).toBe(false);
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(
      inFold(within(article).getByRole("button", { name: "确认已完成" })),
    ).toBe(false);
    // Folded: what it is, why you, what happens, what to return, prior text.
    const folded = within(article)
      .getByText("说明与回传要求")
      .closest("details");
    expect(folded?.open).toBe(false);
    for (const title of ["这是什么", "为什么需要你", "做完会怎样", "回传要求"])
      expect(
        within(folded as HTMLElement).getByRole("heading", { name: title }),
      ).toBeTruthy();
    for (const text of [
      item.handoff.summary,
      item.handoff.why_human,
      item.handoff.expected_outcome,
      "最新版本号",
    ])
      expect(within(folded as HTMLElement).getByText(text)).toBeTruthy();
    expect(
      within(folded as HTMLElement)
        .getByText("项目经理已改写")
        .querySelector("svg.status-shape-success")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    const prior = within(article)
      .getByText(item.original_request.instructions)
      .closest("details");
    expect(prior?.open).toBe(false);
    expect(within(article).getByText("查看改写前的内容")).toBeTruthy();
    // Host actions sit in their own folded group, outside "待你执行".
    const group = article.closest("details, section");
    expect(group?.getAttribute("aria-label")).toBe(
      triage === "host" ? "待主机操作" : "待你执行",
    );
    if (triage === "host") {
      expect((group as HTMLDetailsElement).open).toBe(false);
      expect(screen.queryByRole("region", { name: "待你执行" })).toBeNull();
      expect(
        screen.getByText("没有需要你处理的事。", { exact: false }),
      ).toBeTruthy();
    }
  },
);

test("deferred items show only as a folded later count with their reason (C-212)", async () => {
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => ({
          decisions: [],
          human_actions: [],
          incidents: [],
          later: [
            {
              kind: "human_action",
              id: "H-34",
              card_id: "C-201",
              title: "自动部署首次上线",
              triage: "host",
              waiting_for: "等 C-200 合并",
            },
            {
              kind: "decision",
              id: "Q-9",
              card_id: null,
              title: "是否保留旧入口？",
              waiting_for: "等 C-201 出现新交付",
            },
          ],
        }),
      })}
    />,
  );
  const later = await screen.findByText("稍后（2）", { exact: false });
  const details = later.closest("details");
  expect(details?.open).toBe(false);
  expect(details?.getAttribute("aria-label")).toBe("稍后");
  expect(
    within(details as HTMLElement).getByRole("link", { name: "C-201 · H-34" }),
  ).toBeTruthy();
  expect(
    within(details as HTMLElement).getByText("（等 C-200 合并）"),
  ).toBeTruthy();
  // Deferred items are not counted as waiting on the human.
  expect(
    screen.getByText("没有需要你处理的事。", { exact: false }),
  ).toBeTruthy();
});

const checkStates = [
  ["queued", "排队中", "pending"],
  ["running", "运行中", "progress"],
  ["passed", "已通过", "success"],
  ["failed", "未通过", "error"],
  ["timed_out", "超时", "error"],
  ["interrupted", "已中断", "paused"],
  ["executor_unreachable", "执行机不可达", "error"],
] as const;
const attempt = "e42de008-2c67-49e2-a59d-077a0f7936de";
function checkedMerge(status: (typeof checkStates)[number][0]) {
  const decision = merge();
  if (!decision.merge_confirmation) throw new Error("Missing fixture");
  return {
    ...decision,
    merge_confirmation: {
      ...decision.merge_confirmation,
      merge_gate_enabled: true,
      blockers:
        status === "passed"
          ? []
          : [`合并检查：${checkStates.find(([key]) => key === status)?.[1]}`],
      merge_check: {
        status,
        attempt_id: attempt,
        completion_id: "D-9",
        checks: [
          { name: "Web", status: "passed" as const, duration_ms: 65000 },
        ],
        updated_at: new Date().toISOString(),
        summary: "Error: test failed\n<script>unsafe</script>",
        log_ref: `${attempt}.log`,
      },
    },
  };
}

test.each(checkStates)(
  "merge gate %s shows a badge and only retryable failures offer recheck",
  async (status, label, shape) => {
    const recordDecision = vi.fn(async () => undefined);
    const { container } = render(
      <NeedsYouPage
        projectId="p/a"
        client={fakeClient({
          needsYou: async () => page([checkedMerge(status)]),
          recordDecision,
        })}
      />,
    );
    const article = await screen.findByRole("article", {
      name: "合并确认 Q-3",
    });
    const content = within(article);
    const checkGroup = content.getByRole("region", { name: "Q-3 状态" });
    const disclosure = content.getByText("合并检查详情").closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(content.getByText("合并检查详情"));
    const badge = within(checkGroup).getByText(label, {
      selector: ".decision-check > .status",
    });
    expect(badge.className).toContain(`status-${status}`);
    const icon = badge.querySelector(`svg.status-shape-${shape}`);
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("aria-label")).toBeNull();
    const items = within(content.getByRole("list", { name: "单项检查" }));
    expect(items.getByText("Web")).toBeTruthy();
    expect(
      items
        .getByText("已通过")
        .querySelector("svg.status-shape-success")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(content.queryByRole("button", { name: "重新检查" }) !== null).toBe(
      ["failed", "timed_out"].includes(status),
    );
    expect(content.queryByText("等待中：") !== null).toBe(status !== "passed");
    // C-171: an ended, unpassed check says it will not pass by itself.
    expect(
      content.queryByText(
        "合并检查：未通过。检查不会自己变成通过，请退回修改；确认是偶发失败的，可以重新检查。",
      ) !== null,
    ).toBe(["failed", "timed_out"].includes(status));
    expect(
      content.queryByText(
        "合并检查：已中断。主机恢复后会自动重新排队；也可以先退回修改或暂不合并。",
      ) !== null,
    ).toBe(["interrupted", "executor_unreachable"].includes(status));
    expect(content.getByRole("button", { name: "退回修改" })).toBeTruthy();
    expect(content.getByRole("button", { name: "暂不合并" })).toBeTruthy();
    expect(
      content.getByRole("link", { name: "查看日志" }).getAttribute("href"),
    ).toBe(`/api/projects/p%2Fa/merge-checks/${attempt}`);
    if (!["queued", "running"].includes(status))
      expect(content.getByText("用时：1 分 5 秒")).toBeTruthy();
    if (["failed", "timed_out", "interrupted"].includes(status))
      expect(content.getByText(/Error: test failed/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    const confirm = content.getByRole("button", {
      name: "确认合并",
      exact: true,
    });
    expect(confirm.hasAttribute("disabled")).toBe(status !== "passed");
    fireEvent.click(confirm);
    if (status === "passed")
      await waitFor(() =>
        expect(recordDecision).toHaveBeenCalledWith(
          "p/a",
          "Q-3",
          "merge",
          "",
          expect.any(String),
        ),
      );
    else expect(recordDecision).not.toHaveBeenCalled();
  },
);

test("recheck preserves its idempotency key on uncertain failure and refreshes on success", async () => {
  let current = checkedMerge("failed");
  const retry = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockImplementationOnce(async () => {
      current = checkedMerge("queued");
    });
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => page([current]),
        recheckMerge: retry,
      })}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "重新检查" }));
  expect(await screen.findByText(/操作可能已经成功/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "重新检查" })).toBeNull(),
  );
  expect(retry.mock.calls[0]).toEqual([
    "p-1",
    "C-1",
    "D-9",
    expect.any(String),
  ]);
  expect(retry.mock.calls[1]).toEqual(retry.mock.calls[0]);
  expect(screen.getByText("排队中")).toBeTruthy();
});

test.each(["failed", "timed_out"] as const)(
  "a confirmed %s merge keeps its check and recheck action without another confirmation",
  async (status) => {
    const recheckMerge = vi.fn(async () => undefined);
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () =>
            page([{ ...checkedMerge(status), status: "resolved" }]),
          recheckMerge,
        })}
      />,
    );
    const article = within(
      await screen.findByRole("article", { name: "合并确认 Q-3" }),
    );
    expect(
      article.getByText(status === "failed" ? "未通过" : "超时"),
    ).toBeTruthy();
    expect(article.getByRole("link", { name: "查看日志" })).toBeTruthy();
    expect(article.queryByRole("button", { name: "确认合并" })).toBeNull();
    expect(article.queryByRole("button", { name: "暂不合并" })).toBeNull();
    expect(article.getByRole("button", { name: "退回修改" })).toBeTruthy();
    fireEvent.click(article.getByRole("button", { name: "重新检查" }));
    await waitFor(() =>
      expect(recheckMerge).toHaveBeenCalledWith(
        "p-1",
        "C-1",
        "D-9",
        expect.any(String),
      ),
    );
  },
);

test("a gate waiting for its first event shows no result, while disabled projects are unchanged", async () => {
  const q = checkedMerge("queued");
  const client = fakeClient({
    needsYou: async () =>
      page([
        {
          ...q,
          merge_confirmation: {
            ...q.merge_confirmation,
            merge_check: null,
            blockers: ["合并检查：尚无结果"],
          },
        },
      ]),
  });
  const view = render(<NeedsYouPage projectId="p-1" client={client} />);
  await screen.findByRole("article", { name: "合并确认 Q-3" });
  expect(view.container.querySelector(".decision-check")?.textContent).toBe(
    "合并检查：尚无结果",
  );
  expect(screen.queryByText("排队中")).toBeNull();
  expect(screen.getByText("用时：尚未开始")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "查看日志" })).toBeNull();
  view.unmount();
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({ needsYou: async () => page([merge()]) })}
    />,
  );
  await screen.findByRole("button", { name: "确认合并" });
  expect(screen.queryByText("合并检查")).toBeNull();
  expect(screen.queryByText("检查通过后才会合并")).toBeNull();
  expect(
    screen.queryByText("合并闸门配置无效，请查看 server 启动日志"),
  ).toBeNull();
});

test("an invalid merge gate shows a fixed warning without a queued badge or recheck", async () => {
  const decision = merge();
  const confirmation = decision.merge_confirmation;
  if (!confirmation) throw new Error("Missing fixture");
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () =>
          page([
            {
              ...decision,
              merge_confirmation: {
                ...confirmation,
                merge_gate_invalid: true,
              },
            },
          ]),
      })}
    />,
  );
  const article = within(
    await screen.findByRole("article", { name: "合并确认 Q-3" }),
  );
  expect(
    article.getByText("合并闸门配置无效，请查看 server 启动日志"),
  ).toBeTruthy();
  expect(article.queryByText("排队中")).toBeNull();
  expect(article.queryByRole("button", { name: "重新检查" })).toBeNull();
  expect(article.getByRole("button", { name: "确认合并" })).toBeTruthy();
});

test("notices list delegated merges and decisions without blocking, and can be marked read", async () => {
  const markNoticesRead = vi.fn().mockResolvedValue(undefined);
  const notice = (id: string, kind: "merge" | "decision", read = false) => ({
    id,
    kind,
    card_id: "C-1",
    decision_id: kind === "merge" ? "Q-7" : "Q-8",
    question: "",
    option: "merge",
    resolved_by: "pm",
    body: kind === "merge" ? "改了登录页；无风险。" : "方案 A。理由：按惯例",
    proxy_authority: null,
    at: "2026-01-01T00:00:00.000Z",
    read,
  });
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          human_actions: [],
          notices: [notice("E-2", "merge"), notice("E-1", "decision", true)],
        }),
        markNoticesRead,
      })}
      projectId="p-1"
    />,
  );
  const group = await screen.findByRole("region", { name: "知会" });
  expect(within(group).getByText("知会（未读 1）")).toBeTruthy();
  expect(within(group).getByText("PM 代确认合并")).toBeTruthy();
  expect(within(group).getByText("改了登录页；无风险。")).toBeTruthy();
  // Notices do not count as things waiting on the human.
  expect(screen.queryByText(/件事等你处理/)).toBeNull();
  const merge = within(group).getByRole("article", { name: "知会 Q-7" });
  expect(
    within(merge)
      .getByRole("link", { name: "查看拍板记录" })
      .getAttribute("href"),
  ).toContain("decision-history");
  fireEvent.click(within(merge).getByRole("button", { name: "标为已读" }));
  await waitFor(() =>
    expect(markNoticesRead).toHaveBeenCalledWith("p-1", ["E-2"]),
  );
  const read = within(group).getByRole("article", { name: "知会 Q-8" });
  expect(within(read).queryByRole("button", { name: "标为已读" })).toBeNull();
});

const pagedNotice = (n: number, read = true): NoticeView => ({
  id: `notice-${n}`,
  kind: "decision",
  card_id: "C-1",
  decision_id: `Q-${n}`,
  question: "",
  option: "go",
  resolved_by: "pm",
  author_display: "PM 后台（PM Ops）",
  body: `已选择方案 ${n}`,
  proxy_authority: null,
  at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  read,
});

test.each(["all", "one"])(
  "marking %s notices read before expanding preserves the loaded history boundary",
  async (mark) => {
    const unread = Array.from({ length: 25 }, (_, i) =>
      pagedNotice(53 - i, false),
    );
    const first = Array.from({ length: 10 }, (_, i) => pagedNotice(28 - i));
    let current: NeedsPage = {
      ...page([]),
      human_actions: [],
      notices: [...unread, ...first],
      notices_next_cursor: "notice-19",
    };
    const markNoticesRead = vi.fn().mockImplementation(async () => {
      current = {
        ...current,
        notices:
          mark === "all"
            ? Array.from({ length: 10 }, (_, i) => pagedNotice(53 - i))
            : [...unread.slice(1), pagedNotice(53), ...first.slice(0, 9)],
        notices_next_cursor: mark === "all" ? "notice-44" : "notice-20",
      };
    });
    const notices = vi
      .fn()
      .mockResolvedValueOnce({
        notices: Array.from({ length: 10 }, (_, i) => pagedNotice(18 - i)),
        next_cursor: "notice-9",
        unread_count: mark === "all" ? 0 : 24,
      })
      .mockResolvedValueOnce({
        notices: Array.from({ length: 8 }, (_, i) => pagedNotice(8 - i)),
        next_cursor: null,
        unread_count: mark === "all" ? 0 : 24,
      });
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () => current,
          notices,
          markNoticesRead,
        })}
      />,
    );
    const group = await screen.findByRole("region", { name: "知会" });
    const rows = () => within(group).getAllByRole("article");
    const initialRows = rows();
    expect(initialRows).toHaveLength(35);
    fireEvent.click(
      mark === "all"
        ? within(group).getByRole("button", { name: "全部标为已读" })
        : within(initialRows[0] as HTMLElement).getByRole("button", {
            name: "标为已读",
          }),
    );
    await within(group).findByText(`知会（未读 ${mark === "all" ? 0 : 24}）`);
    expect(rows()).toHaveLength(35);
    expect(notices).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("button", { name: "显示更多" }));
    const expandedRows = await waitFor(() => {
      const current = rows();
      expect(current).toHaveLength(45);
      return current;
    });
    expect(notices).toHaveBeenNthCalledWith(1, "p-1", "notice-19");
    // Query once per state, not once per old row (35 full visibility scans).
    expect(initialRows.every((row) => expandedRows.includes(row))).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "显示更多" }));
    await waitFor(() => expect(rows()).toHaveLength(53));
    expect(notices).toHaveBeenNthCalledWith(2, "p-1", "notice-9");
    expect(
      within(group).queryByRole("button", { name: "显示更多" }),
    ).toBeNull();
  },
);

test("marking all notices read does not reopen pagination when every notice was already visible", async () => {
  const unread = Array.from({ length: 25 }, (_, i) =>
    pagedNotice(35 - i, false),
  );
  const first = Array.from({ length: 10 }, (_, i) => pagedNotice(10 - i));
  let current: NeedsPage = {
    ...page([]),
    human_actions: [],
    notices: [...unread, ...first],
    notices_next_cursor: null,
  };
  const notices = vi.fn();
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => current,
        notices,
        markNoticesRead: async () => {
          current = {
            ...current,
            notices: Array.from({ length: 10 }, (_, i) => pagedNotice(35 - i)),
            notices_next_cursor: "notice-26",
          };
        },
      })}
    />,
  );
  const group = await screen.findByRole("region", { name: "知会" });
  expect(within(group).queryByRole("button", { name: "显示更多" })).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: "全部标为已读" }));
  await within(group).findByText("知会（未读 0）");
  expect(within(group).getAllByRole("article")).toHaveLength(35);
  expect(within(group).queryByRole("button", { name: "显示更多" })).toBeNull();
  expect(notices).not.toHaveBeenCalled();
});

test("notices append server pages, keep all unread first and retain visible rows during requests and refreshes", async () => {
  const unread = Array.from({ length: 12 }, (_, i) =>
    pagedNotice(12 - i, false),
  );
  const first = Array.from({ length: 10 }, (_, i) => pagedNotice(35 - i));
  let current: NeedsPage = {
    ...page([]),
    human_actions: [],
    notices: [...unread, ...first],
    notices_next_cursor: "notice-26",
  };
  let finish: (page: NoticesPage) => void = () => {};
  const notices = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<NoticesPage>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("暂时离线"))
    .mockResolvedValueOnce({
      notices: [pagedNotice(15), pagedNotice(14), pagedNotice(13)],
      next_cursor: null,
      unread_count: 12,
    });
  const markNoticesRead = vi.fn().mockImplementation(async () => {
    current = { ...current, notices: first };
  });
  const client = fakeClient({
    needsYou: async () => current,
    notices,
    markNoticesRead,
  });
  const view = render(<NeedsYouPage client={client} projectId="p-1" />);
  const group = await screen.findByRole("region", { name: "知会" });
  const rows = () => within(group).getAllByRole("article");
  const initialRows = rows();
  expect(initialRows).toHaveLength(22);
  expect(
    initialRows
      .slice(0, 12)
      .every((row) => within(row).queryByRole("button", { name: "标为已读" })),
  ).toBe(true);
  fireEvent.click(within(group).getByRole("button", { name: "显示更多" }));
  fireEvent.click(within(group).getByRole("button", { name: "显示更多" }));
  expect(notices).toHaveBeenCalledTimes(1);
  expect(notices).toHaveBeenLastCalledWith("p-1", "notice-26");
  expect(rows()).toEqual(initialRows);
  const feedback = screen.getByText("正在加载更多知会…");
  expect(group.contains(feedback)).toBe(false);
  await act(async () =>
    finish({
      notices: Array.from({ length: 10 }, (_, i) => pagedNotice(25 - i)),
      next_cursor: "notice-16",
      unread_count: 12,
    }),
  );
  const expandedRows = rows();
  expect(expandedRows).toHaveLength(32);
  expect(expandedRows.slice(0, 22)).toEqual(initialRows);
  fireEvent.click(within(group).getByRole("button", { name: "显示更多" }));
  expect((await screen.findByRole("alert")).textContent).toContain("暂时离线");
  expect(rows()).toHaveLength(32);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(rows()).toHaveLength(35));
  expect(notices).toHaveBeenLastCalledWith("p-1", "notice-16");
  expect(within(group).queryByRole("button", { name: "显示更多" })).toBeNull();
  // First-page SSE refreshes must not collapse already expanded history.
  current = { ...current, notices: [...unread, ...first] };
  view.rerender(<NeedsYouPage client={client} projectId="p-1" revision={1} />);
  await waitFor(() => expect(rows()).toHaveLength(35));
  fireEvent.click(within(group).getByRole("button", { name: "全部标为已读" }));
  await waitFor(() =>
    expect(markNoticesRead).toHaveBeenCalledWith(
      "p-1",
      unread.map((n) => n.id),
    ),
  );
  await within(group).findByText("知会（未读 0）");
  expect(rows()).toHaveLength(35);
  expect(within(group).queryByRole("button", { name: "标为已读" })).toBeNull();
});

test("a late notice page from a previous project cannot appear in the next project", async () => {
  let finish: (page: NoticesPage) => void = () => {};
  const client = fakeClient({
    needsYou: async (project) => ({
      ...page([]),
      human_actions: [],
      notices: [pagedNotice(project === "p-1" ? 20 : 99)],
      notices_next_cursor: project === "p-1" ? "notice-20" : null,
    }),
    notices: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const view = render(<NeedsYouPage client={client} projectId="p-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "显示更多" }));
  view.rerender(<NeedsYouPage client={client} projectId="p-2" />);
  await screen.findByRole("article", { name: "知会 Q-99" });
  await act(async () =>
    finish({ notices: [pagedNotice(19)], next_cursor: null, unread_count: 0 }),
  );
  expect(screen.queryByRole("article", { name: "知会 Q-19" })).toBeNull();
});

test("PM-held merges are listed without counting as waiting, and the human can answer them directly", async () => {
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          human_actions: [],
          pm_held_merges: [
            merge({ id: "Q-9", decider: "role:pm", blocking: false }),
          ],
        }),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const group = await screen.findByRole("region", {
    name: "PM 代确认中的合并",
  });
  expect(screen.queryByText(/件事等你处理/)).toBeNull();
  const item = within(group).getByRole("article", { name: "合并确认 Q-9" });
  expect(within(item).getByText("PM 代确认中")).toBeTruthy();
  fireEvent.click(within(item).getByRole("button", { name: "暂不合并" }));
  fireEvent.change(within(item).getByLabelText("暂缓原因（必填）"), {
    target: { value: "等待核对" },
  });
  fireEvent.click(within(item).getByRole("button", { name: "登记暂缓" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-9",
      "hold",
      "等待核对",
      expect.any(String),
      false,
      undefined,
    ),
  );
  fireEvent.click(within(item).getByRole("button", { name: "确认合并" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-9",
      "merge",
      "",
      expect.any(String),
    ),
  );
});

test("C-154: a confirmation handed over by the PM is labelled and counts down from the restarted due time", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () =>
          page([
            merge({
              id: "Q-3",
              // Opened long ago: a countdown from creation would show 0.
              waited_ms: 3_600_000,
              handed_over_from_pm: {
                at: "2026-01-01T01:00:00.000Z",
                reason:
                  "后台项目经理 A-2 已暂停，项目已无活跃后台，待处理事项转交给你。",
              },
              auto_merge: {
                minutes: 5,
                due_at: "2026-01-01T01:05:00.000Z",
                remaining_ms: 4 * 60_000 + 30_000,
              },
            }),
            merge({ id: "Q-4", card_id: "C-4" }),
          ]),
      })}
      projectId="p-1"
    />,
  );
  const handed = await screen.findByRole("article", { name: "合并确认 Q-3" });
  expect(
    within(handed).getByText("由 PM 转交").getAttribute("title"),
  ).toContain("已暂停");
  expect(handed.textContent).toContain("剩余 5 分钟");
  const direct = screen.getByRole("article", { name: "合并确认 Q-4" });
  expect(within(direct).queryByText("由 PM 转交")).toBeNull();
});

test("C-182: human snoozed confirmations show an accessible tag, reason and expiry", async () => {
  const until = "2035-01-01T04:30:00.000Z";
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () =>
          page([
            {
              ...merge(),
              status: "snoozed",
              snooze: {
                reason: "等待核对",
                until,
                at: "2035-01-01T00:30:00.000Z",
                by: "human",
              },
            },
          ]),
      })}
      projectId="p-1"
    />,
  );
  expect(await screen.findByText("暂缓原因：等待核对")).toBeTruthy();
  const status = screen.getByRole("region", { name: "Q-3 状态" });
  expect(status.textContent).toContain("已暂缓至");
  const expiry = status.querySelector("time");
  expect(expiry?.dateTime).toBe(until);
  expect(expiry?.title).toContain("2035");
  expect(
    within(status)
      .getByText("等你确认")
      .querySelector("svg")
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
});

test("C-179: an open action shows the pre-merge check reminder with a direct link", async () => {
  const base = page([]);
  const text =
    "合并前核对项「张良截图核对」已通过，H-1「需要连接设备」仍在挡合并，请确认是否可以完成";
  const needsYou = vi.fn().mockResolvedValue({
    ...base,
    human_actions: base.human_actions.map((h) => ({
      ...h,
      pre_merge_check_reminder: {
        label: "张良截图核对",
        text,
        at: "2031-01-01T00:00:00.000Z",
      },
    })),
  });
  render(<NeedsYouPage client={fakeClient({ needsYou })} projectId="p-1" />);
  const reminder = await screen.findByLabelText("H-1 核对项提醒");
  expect(reminder.textContent).toContain(text);
  expect(
    within(reminder).getByRole("link", { name: "在卡片中查看" }),
  ).toHaveProperty(
    "href",
    expect.stringContaining("#/p/p-1/cards/C-1?at=human-action-H-1"),
  );
});

test.each(["C-1", null])(
  "external delivery failure keeps its error icon after marking read (card %s)",
  async (card_id) => {
    let notice: NoticeView = {
      id: "ext-event",
      kind: "external_message",
      decision_id: null,
      card_id,
      question: "外部提醒未能送达，请在工作台查看待办",
      body: "外部提醒已停止重试。原事项仍可在工作台处理。",
      option: "",
      resolved_by: "system",
      proxy_authority: null,
      at: "2026-01-01T00:00:00.000Z",
      read: false,
    };
    const mark = vi.fn(async () => {
      notice = { ...notice, read: true };
      return { notice_ids: [notice.id] };
    });
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          needsYou: async () => ({ ...page([]), notices: [notice] }),
          markNoticesRead: mark,
        })}
      />,
    );
    const row = await screen.findByRole("article", { name: "知会 ext-event" });
    expect(within(row).getByText("外部提醒未送达")).toBeTruthy();
    expect(
      row.querySelector(".status-failed svg.status-shape-error"),
    ).not.toBeNull();
    expect(row.querySelector("svg.status-shape-success")).toBeNull();
    expect(row.classList.contains("read")).toBe(false);
    expect(within(row).queryByText("PM 代拍")).toBeNull();
    expect(
      within(row).queryByRole("link", { name: "查看拍板记录" }),
    ).toBeNull();
    if (card_id)
      expect(
        within(row)
          .getByRole("link", { name: `${card_id} 卡片` })
          .getAttribute("href"),
      ).toBe("#/p/p-1/cards/C-1");
    else expect(within(row).queryByRole("link")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "标为已读" }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith("p-1", [notice.id]));
    await waitFor(() => expect(row.classList.contains("read")).toBe(true));
    expect(within(row).queryByRole("button", { name: "标为已读" })).toBeNull();
    expect(
      row.querySelector(".status-failed svg.status-shape-error"),
    ).not.toBeNull();
    expect(row.querySelector("svg.status-shape-success")).toBeNull();
    expect(within(row).getByText("外部提醒未送达")).toBeTruthy();
  },
);

test.each(["accepted_delivery_rework", null] as const)(
  "human-only %s decisions expose no future delegation",
  async (trigger) => {
    const recordDecision = vi.fn().mockResolvedValue(undefined);
    const decision = q({
      trigger,
      category: "feature_detail",
      human_required_reason: "本次必须由人亲自确认",
      question: "退回产出修改？",
      options: [
        {
          key: "return_for_rework",
          description: "正式退回作者修改",
          impact: "重新交付并审核",
        },
        { key: "keep", description: "保留当前产出", impact: "不执行返工" },
      ],
      recommended: "return_for_rework",
    });
    render(
      <NeedsYouPage
        projectId="p-1"
        client={fakeClient({
          recordDecision,
          needsYou: async () => page([decision]),
        })}
      />,
    );
    const article = within(
      await screen.findByRole("article", { name: "拍板 Q-1" }),
    );
    expect(
      article.queryByRole("checkbox", { name: "此类问题以后由 PM 代拍" }),
    ).toBeNull();
    if (trigger === "accepted_delivery_rework") {
      expect(article.queryByText("return_for_rework")).toBeNull();
      expect(article.queryByText("keep")).toBeNull();
      expect(article.getByRole("radio", { name: /退回作者修改/ })).toBeTruthy();
      expect(article.getByRole("radio", { name: /保留当前产出/ })).toBeTruthy();
    }
    fireEvent.click(
      article.getAllByRole("radio")[0] ??
        (() => {
          throw new Error("Missing option");
        })(),
    );
    fireEvent.change(article.getByRole("textbox"), {
      target: { value: "本人确认" },
    });
    fireEvent.click(article.getByRole("button", { name: "按所选拍板" }));
    await waitFor(() =>
      expect(recordDecision).toHaveBeenCalledWith(
        "p-1",
        "Q-1",
        "return_for_rework",
        "本人确认",
        expect.any(String),
      ),
    );
  },
);

test.each([0, 3])(
  "A3b pause banner shows %i waiting cards and a settings link",
  async (waiting_count) => {
    const client = fakeClient({
      needsYou: async () => ({
        decisions: [],
        human_actions: [],
        incidents: [],
        auto_merge_pause: { paused: true, waiting_count },
        waiting_merge_checks_count: 2,
      }),
    });
    render(<NeedsYouPage client={client} projectId="p-1" />);
    expect(
      await screen.findByText(`自动合并已暂停（${waiting_count} 张等待）`),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "前往设置管理暂停" })
        .getAttribute("href"),
    ).toBe("#/p/p-1/settings");
    expect(screen.getByText(/条合并确认的检查在排队或运行中/)).toBeTruthy();
  },
);

test("A3b older servers and an unpaused project do not show a pause banner", async () => {
  render(<NeedsYouPage client={fakeClient()} projectId="p-1" />);
  await screen.findByRole("heading", { name: "Needs You" });
  expect(screen.queryByLabelText("自动合并暂停")).toBeNull();
});

test("C-383 later action close requires a reason, supports keyboard cancellation, retries and refreshes counts", async () => {
  let data: NeedsPage = {
    ...page([]),
    human_actions: [],
    incidents: [],
    later: [
      {
        kind: "human_action",
        id: "H-9",
        card_id: "C-1",
        title: "等待上线后核对",
        waiting_for: "等待项目经理放行",
      },
      {
        kind: "decision",
        id: "Q-9",
        card_id: "C-1",
        title: "等待拍板",
        waiting_for: "等待交付",
      },
    ],
  };
  let resolve: (() => void) | undefined;
  const cancelAction = vi
    .fn()
    .mockRejectedValueOnce(new Error("网络故障"))
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = () => {
            data = {
              ...data,
              later: data.later?.filter((item) => item.id !== "H-9"),
            };
            done();
          };
        }),
    );
  const needsYou = vi.fn(async () => data);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou, cancelAction })}
      projectId="p-1"
    />,
  );
  const later = await screen.findByText(/稍后（2）/);
  fireEvent.click(later);
  const trigger = screen.getByRole("button", { name: "关闭（不再需要）" });
  expect(
    screen.getAllByRole("button", { name: "关闭（不再需要）" }),
  ).toHaveLength(1);
  fireEvent.click(trigger);
  let dialog = screen.getByRole("dialog", { name: "关闭待办 H-9" });
  const reason = within(dialog).getByLabelText("关闭理由（必填）");
  await waitFor(() => expect(document.activeElement).toBe(reason));
  expect(
    within(dialog).getByRole("button", { name: "确认关闭" }),
  ).toHaveProperty("disabled", true);
  fireEvent.keyDown(reason, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(cancelAction).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("关闭理由（必填）"), {
    target: { value: "方案已取消" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认关闭" }));
  await waitFor(() => expect(cancelAction).toHaveBeenCalledTimes(1));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认关闭" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "确认关闭" }));
  expect(cancelAction).toHaveBeenCalledTimes(2);
  expect(cancelAction.mock.calls[0]).toEqual(cancelAction.mock.calls[1]);
  expect(cancelAction.mock.calls[0]?.slice(0, 3)).toEqual([
    "p-1",
    "H-9",
    "方案已取消",
  ]);
  expect(within(dialog).getByRole("button", { name: "取消" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => resolve?.());
  expect(
    await screen.findByText("H-9 已关闭（不再需要），未记为完成。"),
  ).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText(/稍后（1）/)).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe(
      "H-9 已关闭（不再需要），未记为完成。",
    ),
  );
  expect(screen.queryByRole("button", { name: "关闭（不再需要）" })).toBeNull();
});

test("C-383 host execution notices are distinct from delegated decisions", async () => {
  render(
    <NeedsYouPage
      projectId="p-1"
      client={fakeClient({
        needsYou: async () => ({
          ...page([]),
          human_actions: [],
          notices: [
            {
              id: "host-result",
              kind: "human_action",
              decision_id: null,
              card_id: "C-1",
              question: "H-9 外接维护者已完成",
              option: "已完成",
              body: "只读取证已完成",
              resolved_by: "assignment:A-9",
              proxy_authority: null,
              at: "2026-01-01T00:00:00Z",
              read: false,
            },
          ],
        }),
      })}
    />,
  );
  expect(await screen.findByText("外接维护者已完成")).toBeTruthy();
  expect(screen.getByText("只读取证已完成")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "查看拍板记录" })).toBeNull();
});
