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
import { NeedsYouPage } from "./NeedsYouPage.js";

const q = (overrides: Partial<NeedsDecision> = {}): NeedsDecision => ({
  id: "q(1)",
  question: "要发布吗？",
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

test("groups blocking and risky decisions ahead of ordinary batches and separates human actions", async () => {
  const data = page([
    q({ id: "q(2)", blocking: false }),
    q(),
    q({ id: "q(3)", blocking: false, category: "permission", why: "权限确认" }),
  ]);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => data })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("article", { name: "拍板 q(1)" });
  const urgent = within(screen.getByRole("region", { name: "优先拍板" }));
  expect(urgent.queryByRole("article", { name: "拍板 q(2)" })).toBeNull();
  expect(urgent.getByRole("article", { name: "拍板 q(3)" })).toBeTruthy();
  const batch = screen.getByText("其他拍板（1）").closest("details");
  expect(batch?.open).toBe(false);
  expect(
    within(screen.getByRole("article", { name: "拍板 q(1)" })).getByText(
      /已等待 2 分钟/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "待你执行" }).textContent,
  ).toContain("连接结果");
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
    fireEvent.change(screen.getByLabelText("q(1) 原话或补充说明"), {
      target: { value: "  我选这个  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "记录决定" }));
    await screen.findByText("目前没有需要你处理的事项。");
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "q(1)",
      option,
      "  我选这个  ",
    );
    expect(needsYou).toHaveBeenCalledTimes(2);
  },
);

test.each([
  ["要求补充信息", "request_information"],
  ["请 PM 解释后果", "explain"],
] as const)("%s calls the decision-comment action", async (label, action) => {
  const decisionComment = vi.fn().mockResolvedValue(undefined);
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => page(), decisionComment })}
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
  expect(completeAction).toHaveBeenLastCalledWith("p-1", "h(1)", "设备已连接");
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
  await screen.findByText("目前没有需要你处理的事项。");
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
            },
          ],
        }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByText("失联，需要你检查");
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
  await screen.findByText("目前没有需要你处理的事项。");
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
      client={fakeClient({ needsYou: async () => page() })}
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
