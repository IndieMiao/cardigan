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
import type { NeedsDecision, NeedsPage } from "../api.js";
import { fakeClient } from "../testing/fixtures.js";
import { writeFailures } from "../testing/write-errors.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

const q = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "q(1)",
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
    id: "q(3)",
    question: "Merge C-2 into main?",
    trigger: "merge_confirmation",
    why: "确认合并",
    merge_confirmation: {
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
      id: "h(1)",
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
    await screen.findByRole("article", { name: "执行 h(1)" });
    if (operation === "action") {
      fireEvent.change(screen.getByLabelText("h(1) 执行结果"), {
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
    q({ id: "q(4)", trigger: null, blocking: false, why: "普通拍板" }),
    merge({ id: "q(3)", blocking: true }),
    q({ id: "q(1)", trigger: null, blocking: true, why: "阻塞拍板" }),
    q({
      id: "q(2)",
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
  await screen.findByRole("article", { name: "拍板 q(1)" });
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
  expect(blocking.getByRole("article", { name: "拍板 q(1)" })).toBeTruthy();
  expect(blocking.queryByRole("article", { name: "拍板 q(2)" })).toBeNull();
  const merges = within(screen.getByRole("region", { name: "合并确认" }));
  expect(merges.getByRole("article", { name: "合并确认 q(3)" })).toBeTruthy();
  const other = within(screen.getByRole("region", { name: "其他拍板" }));
  expect(other.getByRole("article", { name: "拍板 q(2)" })).toBeTruthy();
  expect(other.getByRole("article", { name: "拍板 q(4)" })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "待你执行" }).textContent,
  ).toContain("连接结果");
});

test("decision cards collapse the background, do not preselect an option and expose the impact", async () => {
  const data = page([
    q({
      id: "q(1)",
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
  const card = await screen.findByRole("article", { name: "拍板 q(1)" });
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
    await screen.findByRole("article", { name: "拍板 q(1)" });
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
      target: { value: "  我选这个  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "按所选拍板" }));
    await screen.findByText(
      "没有需要你处理的事。Agent 提出拍板或需要你确认合并时会出现在这里。",
    );
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "q(1)",
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
        needsYou: async () => page([merge({ id: "q(3)" })]),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const card = await screen.findByRole("article", { name: "合并确认 q(3)" });
  expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe(
    "确认把 C-2 合并到 main？",
  );
  const deliveries = within(card).getByRole("region", { name: "要合并的交付" });
  expect(deliveries.textContent).toContain("实现");
  expect(deliveries.textContent).toContain("增加 --json 输出");
  expect(deliveries.textContent).toContain("abcdef123456");
  expect(
    within(deliveries)
      .getByRole("link", { name: "查看改动" })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1?at=delivery-D-8");
  const reviews = within(card).getByRole("region", { name: "审核与验收" });
  expect(reviews.textContent).toContain("代码审核");
  expect(reviews.textContent).toContain("已通过");
  expect(
    within(card).getByRole("region", { name: "已知遗留" }).textContent,
  ).toContain("Windows 未覆盖");
  fireEvent.change(within(card).getByLabelText("q(3) 原话或补充说明"), {
    target: { value: " 可以合并 " },
  });
  fireEvent.click(within(card).getByRole("button", { name: "确认合并" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "q(3)",
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
  await screen.findByLabelText("q(1) 原话或补充说明");
  fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
    target: { value: "请说明影响" },
  });
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(decisionComment).toHaveBeenCalledWith(
      "p-1",
      "q(1)",
      action,
      "请说明影响",
      expect.any(String),
    ),
  );
});

test("returning a merge requires a nonblank reason and submits the exact explanation", async () => {
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
  const reason = screen.getByLabelText("q(3) 退回原因");
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
      "q(3)",
      "request_changes",
      " 请补齐空输入校验 ",
      expect.any(String),
    ),
  );
});

test("hold still submits without a reason after cancelling the return form", async () => {
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
  expect(screen.queryByLabelText("q(3) 退回原因")).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "暂不合并" }));
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "q(3)",
      "hold",
      "",
      expect.any(String),
    ),
  );
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
  fireEvent.change(screen.getByLabelText("h(1) 执行结果"), {
    target: { value: "设备已连接" },
  });
  fireEvent.click(submit);
  await screen.findByText("暂时失败");
  expect(
    (screen.getByLabelText("h(1) 执行结果") as HTMLTextAreaElement).value,
  ).toBe("设备已连接");
  fireEvent.click(submit);
  await waitFor(() => expect(completeAction).toHaveBeenCalledTimes(2));
  expect(completeAction).toHaveBeenLastCalledWith(
    "p-1",
    "h(1)",
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
  expect(screen.queryByRole("button", { name: /接管|替换/ })).toBeNull();
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
});

test("empty groups are not rendered", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => page([]) })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("article", { name: "执行 h(1)" });
  for (const name of ["运行异常", "阻塞拍板", "合并确认", "其他拍板"])
    expect(screen.queryByRole("region", { name })).toBeNull();
  expect(screen.getByRole("region", { name: "待你执行" })).toBeTruthy();
});

test("Needs You is reachable through the hash navigation and preserves project switching", async () => {
  window.location.hash = "#/p/p-1/needs-you";
  const needsYou = vi
    .fn()
    .mockResolvedValue({ decisions: [], human_actions: [], incidents: [] });
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
  await screen.findByText(
    "没有需要你处理的事。Agent 提出拍板或需要你确认合并时会出现在这里。",
  );
  expect(
    screen
      .getByRole("link", { name: "Needs You" })
      .getAttribute("aria-current"),
  ).toBe("page");
  fireEvent.change(screen.getByLabelText("项目"), { target: { value: "p-2" } });
  await waitFor(() => expect(needsYou).toHaveBeenLastCalledWith("p-2"));
  expect(window.location.hash).toBe("#/p/p-2/needs-you");
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
  await screen.findByLabelText("q(1) 原话或补充说明");
  fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
    target: { value: "未提交" },
  });
  act(() => vi.advanceTimersByTime(60000));
  expect(
    screen.getByRole("article", { name: "拍板 q(1)" }).textContent,
  ).toContain("已等待 3 分钟");
  expect(
    (screen.getByLabelText("q(1) 原话或补充说明") as HTMLTextAreaElement).value,
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
    const input =
      kind === "completion" ? "h(1) 执行结果" : "q(1) 原话或补充说明";
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
      await screen.findByRole("article", { name: "拍板 q(1)" }),
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
    await screen.findByRole("article", { name: "拍板 q(1)" }),
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
      "q(1)",
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
  expect(screen.getByText(/自动合并（偏好设置：10 分钟）/)).toBeTruthy();
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
      "q(1)",
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
    await screen.findByRole("article", { name: "拍板 q(1)" });
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
  const notice = await screen.findByRole("article", { name: "拍板落实 q(1)" });
  expect(within(notice).getByText("已选方案：合并")).toBeTruthy();
  expect(within(notice).getByText("影响：更新基线")).toBeTruthy();
  expect(within(notice).queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "按所选拍板" })).toBeNull();
  expect(recordDecision).not.toHaveBeenCalled();
});
