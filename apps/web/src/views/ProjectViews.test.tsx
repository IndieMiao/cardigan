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
import {
  type ExecutionAssignment,
  HttpCardiganClient,
  type RunView,
  type SnapshotData,
} from "../api.js";
import { changeControl } from "../testing/controls.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";
import { SnapshotPage } from "./SnapshotPage.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
const assignment: ExecutionAssignment = {
  id: "A-1",
  role_id: "coder",
  role_version: 2,
  status: "active",
  runtime_state: "idle",
  machine_id: "local",
  standing_mode: null,
  card_id: "C-1",
  card_status: "in_progress",
  work_item_id: "W-1",
  worktree_path: "/fixture/worktree",
  branch: "agent/work",
  session_ref: "session-fixture",
  runtime_ref: { terminal_ref: "terminal-fixture", runtime_machine: "local" },
  last_mcp_activity_at: null,
  cursors: [{ card_id: "C-1", acked_seq: 12 }],
};
const run: RunView = {
  id: "R-10",
  assignment_id: "A-1",
  status: "queued",
  kind: "fix",
  model: "fixture-model",
  role_version: 2,
  agent_cli_version: "1.0",
  summary: "Resolve the conflict",
};
/** C-702: the drawer's folded 命令行 section, opened. */
const openCommands = (drawer: HTMLElement = document.body) => {
  const fold = within(drawer).getByRole("button", { name: /^命令行/ });
  if (fold.getAttribute("aria-expanded") !== "true") fireEvent.click(fold);
  return fold;
};
/** C-702: the 执行记录 section (its heading carries the count). */
const runRecords = () => screen.findByRole("region", { name: /^执行记录/ });
const recordIds = (history: HTMLElement) =>
  [...history.querySelectorAll("[data-ui=detail-history] > li")].map(
    (li) => /R-\d+/.exec(li.textContent ?? "")?.[0],
  );

test("snapshot separates human/agent waits, shows next owners, blocked work and recent deliveries", async () => {
  const review = {
    ...card,
    id: "C-2",
    title: "审核卡片",
    status: "review" as const,
    next_owners: [{ kind: "assignment" as const, ref: "A-2" }],
  };
  const data: SnapshotData = {
    cards: [card, review],
    in_progress: [card],
    in_review: [review],
    waiting: { human: [card.id], agent: [review.id] },
    blocked: [{ card_id: card.id, work_item_id: "W-1", label: "等待权限" }],
    recent_deliveries: [
      {
        id: "D-1",
        card_id: review.id,
        summary: "审核版本",
        status: "submitted",
      },
    ],
  };
  render(
    <SnapshotPage
      client={fakeClient({ snapshot: async () => data })}
      projectId="p-1"
    />,
  );
  const human = within(
      await screen.findByRole("rowgroup", { name: "等你处理" }),
    ),
    agent = within(screen.getByRole("rowgroup", { name: "等 Agent 处理" }));
  expect(human.getByRole("link", { name: /^C-1 / }).getAttribute("href")).toBe(
    "#/p/p-1/cards/C-1",
  );
  expect(human.queryByRole("link", { name: /^C-2 / })).toBeNull();
  expect(agent.getByRole("link", { name: /^C-2 / })).toBeTruthy();
  expect(
    screen.getByRole("rowgroup", { name: "审核与待合并" }).textContent,
  ).toContain("未命名的 未知角色");
  expect(screen.getByRole("rowgroup", { name: "阻塞" }).textContent).toContain(
    "等待权限",
  );
  expect(
    screen.getByRole("region", { name: "最近交付" }).textContent,
  ).toContain("待审核");
});

test("execution defaults to working and switches between all, working, released and lost", async () => {
  const lost = { ...assignment, id: "A-2", runtime_state: "lost" },
    released = { ...assignment, id: "A-3", status: "released" };
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment, lost, released],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  expect(screen.getByRole("combobox", { name: /^筛选：/ }).textContent).toBe(
    "筛选：工作中",
  );
  expect(
    await screen.findByRole("button", { name: "查看 A-1 详情" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "查看 A-2 详情" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看 A-3 详情" })).toBeNull();
  changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
    target: { value: "released" },
  });
  expect(
    await screen.findByRole("button", { name: "查看 A-3 详情" }),
  ).toBeTruthy();
  changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
    target: { value: "lost" },
  });
  expect(
    await screen.findByRole("button", { name: "查看 A-2 详情" }),
  ).toBeTruthy();
  changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
    target: { value: "" },
  });
  expect(
    await screen.findByRole("button", { name: "查看 A-1 详情" }),
  ).toBeTruthy();
});

test("execution shows working assignments in a table and expands the newest Run, cursor and commands", async () => {
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs: [
            run,
            {
              ...run,
              id: "R-9",
              status: "completed",
              started_at: "2026-01-01T00:00:00Z",
            },
          ],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  const toggle = await screen.findByRole("button", { name: "查看 A-1 详情" });
  const row = toggle.closest("tr");
  expect(row?.textContent).toContain("A-1");
  expect(row?.textContent).toContain("C-1");
  expect(row?.textContent).toContain("W-1");
  // C-207: the Run id moves to the drawer; the queue position stays visible.
  expect(row?.textContent).not.toContain("R-10");
  expect(row?.textContent).toContain("排队中");
  // C-207: the normal "active" Assignment status is not repeated per row.
  expect(row?.querySelector(".status-active")).toBeNull();
  expect(row?.textContent).not.toContain("有效");
  expect(
    row?.querySelector(".status-idle svg.status-shape-idle"),
  ).not.toBeNull();
  expect(
    row?.querySelector(".status-queued svg.status-shape-pending"),
  ).not.toBeNull();
  expect(screen.getByRole("columnheader", { name: "运行配置" })).toBeTruthy();
  fireEvent.click(toggle);
  // C-702: the title is the Assignment id and who works on it.
  const drawer = await screen.findByRole("dialog", { name: "A-1 coder" });
  for (const text of [
    "session-fixture",
    "terminal-fixture",
    "/fixture/worktree",
    "agent/work",
  ])
    expect(within(drawer).getByText(text, { exact: false })).toBeTruthy();
  // C-702: every field label is Chinese (C-687 §2.1).
  const labels = [...drawer.querySelectorAll("dt")].map((dt) => dt.textContent);
  expect(labels).toEqual([
    "运行工具",
    "模型",
    "上下文",
    "机器",
    "会话",
    "终端",
    "分支",
    "工作目录",
    "签收",
  ]);
  expect(drawer.textContent).not.toMatch(
    /Assignment|Harness|Session|Worktree|effort|ACK|seq|Run 历史/,
  );
  fireEvent.click(
    within(drawer).getByRole("button", {
      name: /1 张卡片，最新序号 12/,
    }),
  );
  expect(within(drawer).getByText("已签收序号 12")).toBeTruthy();
  expect(await within(drawer).findByText("R-9", { exact: false })).toBeTruthy();
  // The commands stay folded until asked for.
  expect(
    screen.queryByText("cardigan inbox --assignment 'A-1' --project 'p-1'"),
  ).toBeNull();
  expect(openCommands(drawer).textContent).toBe("命令行（6）");
  expect(
    screen.queryByRole("button", { name: "复制启动或恢复会话" }),
  ).toBeNull();
  expect(
    screen.getByText("cardigan inbox --assignment 'A-1' --project 'p-1'"),
  ).toBeTruthy();
  expect(
    screen.getByText("cardigan assignment stop 'A-1' --project 'p-1'"),
  ).toBeTruthy();
});

test("execution copies observe by default and reveals warned interactive access only on expansion", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const drawer = await screen.findByRole("dialog", { name: "A-1 coder" });
  const command = "cardigan assignment attach 'A-1' --project 'p-1'";
  // C-702: both attach commands live only in the folded 命令行 section.
  expect(within(drawer).queryByText(command)).toBeNull();
  expect(
    within(drawer).queryByText("接管会直接向 Agent 终端输入，可能打断它。"),
  ).toBeNull();
  const fold = openCommands(drawer);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(within(drawer).getByText(command)).toBeTruthy();
  const observe = within(drawer).getByRole("button", {
    name: "复制在 Herdr 中查看（只看）",
  });
  expect(screen.queryByText("deploy/install-cli.sh")).toBeNull();
  fireEvent.click(observe);
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(command));

  const warning = within(drawer).getByText(
    "接管会直接向 Agent 终端输入，可能打断它。",
  );
  const interactiveCommand = within(drawer).getByText(
    `${command} --interactive`,
  );
  expect(warning.tagName).toBe("STRONG");
  expect(
    warning.compareDocumentPosition(interactiveCommand) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "复制接管输入" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(`${command} --interactive`),
  );
  expect(writeText).toHaveBeenCalledTimes(2);
  // The worktree path copies from its own icon button.
  fireEvent.click(within(drawer).getByRole("button", { name: "复制工作目录" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith("/fixture/worktree"),
  );
  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(within(drawer).queryByText(command)).toBeNull();
});

test("execution keeps suspended assignments, lost runtimes and blocked Run outcomes prominent", async () => {
  window.location.hash = "#/p/p-1/execution?view=all";
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [
            { ...assignment, status: "suspended", runtime_state: "lost" },
          ],
          runs: [{ ...run, status: "completed", outcome: "blocked" }],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  const row = (
    await screen.findByRole("button", { name: "查看 A-1 详情" })
  ).closest("tr");
  expect(
    row?.querySelector(".status-suspended svg.status-shape-paused"),
  ).not.toBeNull();
  expect(
    row?.querySelector(".status-lost svg.status-shape-error"),
  ).not.toBeNull();
  expect(
    row?.querySelector(".status-blocked svg.status-shape-error"),
  ).not.toBeNull();
  expect(row?.querySelector(".status-subdued")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  await waitFor(() =>
    expect(
      history.querySelector(".status-blocked svg.status-shape-error"),
    ).not.toBeNull(),
  );
  // A paused Assignment says so first, even with a lost runtime.
  expect(
    within(screen.getByRole("region", { name: "当前" })).getByRole("heading")
      .textContent,
  ).toBe("已暂停");
});

test.each([
  "not_provisioned",
  "idle",
  "running",
  "unknown",
  "lost",
  "released",
])(
  "execution %s offers only applicable commands and keeps state text visible",
  async (state) => {
    const a = {
      ...assignment,
      runtime_state: state,
      status: state === "released" ? "released" : "active",
      runtime_ref: state === "not_provisioned" ? null : assignment.runtime_ref,
    };
    const runs = state === "running" ? [{ ...run, status: "running" }] : [];
    render(
      <ExecutionPage
        client={fakeClient({
          execution: async () => ({ assignments: [a], runs, machines: [] }),
        })}
        projectId="p-1"
      />,
    );
    changeControl(screen.getByRole("combobox", { name: /^筛选：/ }), {
      target: { value: "" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "查看 A-1 详情" }),
    );
    // C-702: the panel says where the Assignment stands (C-687 §3.3).
    const current = screen.getByRole("region", { name: "当前" });
    const titles = {
      not_provisioned: "尚未启动会话",
      idle: "空闲，等新消息",
      running: "正在执行",
      unknown: "会话失联",
      lost: "会话失联",
      released: "已释放",
    };
    expect(within(current).getByRole("heading").textContent).toMatch(
      new RegExp(`^${titles[state as keyof typeof titles]}`),
    );
    const lost = ["lost", "unknown"].includes(state);
    expect(current.hasAttribute("data-mine")).toBe(lost);
    // 处理拍板… is a panel button only while the session is lost.
    const needsYou = within(current).queryByRole("link", {
      name: "到 Needs You 处理",
    });
    expect(Boolean(needsYou)).toBe(lost);
    if (needsYou)
      expect(needsYou.getAttribute("href")).toBe("#/p/p-1/needs-you");
    expect(screen.queryByText("处理拍板、清理或失联事项")).toBeNull();
    // The panel copies the start command where the CLI offers it.
    expect(
      Boolean(within(current).queryByRole("button", { name: "复制启动命令" })),
    ).toBe(["idle", "not_provisioned"].includes(state));
    openCommands();
    const start = screen.queryByRole("button", { name: "复制启动或恢复会话" });
    expect(Boolean(start)).toBe(["idle", "not_provisioned"].includes(state));
    expect(screen.getByRole("button", { name: "复制检查异常" })).toBeTruthy();
    const labels = {
      not_provisioned: "未启动",
      idle: "空闲",
      running: "运行中",
      unknown: "状态未知",
      lost: "失联",
      released: "已释放",
    };
    expect(
      screen.getAllByText(labels[state as keyof typeof labels]).length,
    ).toBeGreaterThan(0);
  },
);

test("C-702: the 当前 panel and ⋯ menu offer only existing actions for running, maintenance and released Assignments", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const now = Date.parse("2026-01-01T01:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  const running = {
    ...assignment,
    runtime_state: "running",
    card_title: "Fixture card",
  };
  const maintained = {
    ...assignment,
    id: "A-2",
    session_maintenance: {
      reason: "terminal_busy" as const,
      candidate: false,
      threshold_minutes: 30,
      evaluated_at: "2026-01-01T00:59:00Z",
      since: "2026-01-01T00:30:00Z",
    },
  };
  const released = {
    ...assignment,
    id: "A-3",
    status: "released",
    runtime_state: "released",
    runtime_ref: null,
    card_status: "done",
  };
  window.location.hash = "#/p/p-1/execution?view=all";
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [running, maintained, released],
          runs: [
            {
              ...run,
              status: "running",
              started_at: "2026-01-01T00:16:00Z",
              context_usage: {
                used_ratio: 0.62,
                window_tokens: 200_000,
                used_tokens: 124_000,
                level: null,
                updated_at: "2026-01-01T00:59:00Z",
              },
            },
          ],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  let current = screen.getByRole("region", { name: "当前" });
  expect(within(current).getByRole("heading").textContent).toBe(
    "正在执行R-10 合并修复",
  );
  expect(current.textContent).toContain("已运行 44 分钟");
  expect(current.textContent).toContain("上下文 62%");
  // No new write interface here (C-703): no emphasis button, no stop.
  expect(current.querySelector(".ui-button-emphasis")).toBeNull();
  expect(within(current).queryByRole("button", { name: /停止/ })).toBeNull();
  fireEvent.click(
    within(current).getByRole("button", { name: "复制接入命令" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "cardigan assignment attach 'A-1' --project 'p-1'",
    ),
  );
  const status = screen.getByRole("region", { name: "执行状态" });
  expect(
    within(status).getByRole("link", { name: /C-1/ }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
  expect(status.textContent).toContain("Fixture card");
  expect(
    within(screen.getByRole("dialog", { name: "A-1 coder" }))
      .getByRole("meter", { name: "上下文已用 62.00%" })
      .closest("dd")?.textContent,
  ).toBe("62% 124K / 200K");
  const trigger = within(status).getByRole("button", { name: "更多执行操作" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu", { name: "更多执行操作" });
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent),
  ).toEqual(["复制接入命令", "在 Needs You 中查看"]);
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "在 Needs You 中查看" }),
  );
  await waitFor(() => expect(window.location.hash).toBe("#/p/p-1/needs-you"));
  window.location.hash = "#/p/p-1/execution?view=all";

  fireEvent.click(screen.getByRole("button", { name: "查看 A-2 详情" }));
  await screen.findByRole("dialog", { name: "A-2 coder" });
  current = screen.getByRole("region", { name: "当前" });
  expect(within(current).getByRole("heading").textContent).toBe(
    "会话维护中：等待终端结束工作",
  );
  expect(current.hasAttribute("data-mine")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "查看 A-3 详情" }));
  await screen.findByRole("dialog", { name: "A-3 coder" });
  current = screen.getByRole("region", { name: "当前" });
  expect(within(current).getByRole("heading").textContent).toBe("已释放");
  expect(current.textContent).toContain("卡片已完成");
  expect(
    within(current)
      .getByRole("link", { name: "打开卡片" })
      .getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
  expect(
    within(current).queryByRole("button", { name: "复制接入命令" }),
  ).toBeNull();
});

test.each(["snapshot", "execution"] as const)(
  "%s covers initial loading, failure, retry and empty state",
  async (kind) => {
    const defaults = fakeClient(),
      load = vi
        .fn()
        .mockRejectedValueOnce(new Error("读取失败"))
        .mockResolvedValue(await defaults[kind]("p-1"));
    const client = fakeClient({ [kind]: load }),
      Component = kind === "snapshot" ? SnapshotPage : ExecutionPage;
    render(<Component client={client} projectId="p-1" />);
    expect(screen.queryByText("正在加载…")).toBeNull();
    await screen.findByText("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(
      kind === "snapshot" ? "没有卡片" : "没有匹配的执行记录",
    );
  },
);

test("execution labels a standing PM as project-level and keeps the card/work item words apart", async () => {
  const standing = {
    ...assignment,
    id: "A-9",
    role_id: "pm",
    standing_mode: "ops",
    card_id: null,
    card_status: null,
    work_item_id: null,
  };
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [standing],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  const toggle = await screen.findByRole("button", {
    name: "查看 A-9 详情",
  });
  const row = toggle.closest("tr");
  expect(row?.textContent).toContain("常驻 PM · 后台");
  expect(row?.textContent).not.toContain("项目级事项常驻");
});

test("C-75: the drawer shows ten recent Runs and pages ten more from the server, one line each with the full summary on hover", async () => {
  const runs = Array.from({ length: 23 }, (_, index) => ({
    ...run,
    id: `R-${30 - index}`,
    status: "completed",
    summary: `Run ${30 - index} ${"很长的摘要".repeat(20)}`,
  }));
  const executionRuns = vi.fn(
    async (_projectId: string, _assignmentId: string, before?: string) => {
      const start =
        before === undefined ? 0 : runs.findIndex((r) => r.id === before) + 1;
      const page = runs.slice(start, start + 10);
      return {
        runs: page,
        total: runs.length,
        next_cursor:
          start + page.length < runs.length ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs,
          machines: [],
        }),
        executionRuns,
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  await within(history).findByText("R-21", { exact: false });
  expect(within(history).queryByText("R-20", { exact: false })).toBeNull();
  expect(recordIds(history)).toHaveLength(10);
  expect(within(history).getByRole("heading").textContent).toBe(
    "执行记录（23）",
  );
  expect(within(history).queryByText(/显示全部/)).toBeNull();
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1");

  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await within(history).findByText("R-11", { exact: false });
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1", "R-21");
  expect(recordIds(history)).toHaveLength(20);

  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await within(history).findByText("R-8", { exact: false });
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1", "R-11");
  expect(recordIds(history)).toHaveLength(23);
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  // C-702: one line per Run; the whole summary is reachable by keyboard.
  const summary = within(history).getByText(runs[0]?.summary ?? "");
  expect(summary.tabIndex).toBe(0);
  expect(within(history).queryByText("展开全文")).toBeNull();
  fireEvent.focus(summary);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    runs[0]?.summary,
  );
});

test("C-702: a Run without a summary shows —, and its machine only when it differs", async () => {
  const runs = [
    {
      ...run,
      id: "R-3",
      status: "completed",
      summary: "",
      recovery_runtime: { machine_id: "local", runtime_machine: "local" },
    },
    {
      ...run,
      id: "R-2",
      status: "completed",
      summary: "other host",
      recovery_runtime: { machine_id: "mac-mini", runtime_machine: "mac-mini" },
    },
  ];
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs,
          machines: [],
        }),
        executionRuns: async () => ({ runs, total: 2, next_cursor: null }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  await waitFor(() => expect(recordIds(history)).toEqual(["R-3", "R-2"]));
  const [same, other] = [
    ...history.querySelectorAll("[data-ui=detail-history] > li"),
  ] as HTMLElement[];
  expect(same?.textContent).toContain("—");
  expect(within(same as HTMLElement).queryByLabelText(/^机器：/)).toBeNull();
  expect(
    within(other as HTMLElement).getByLabelText("机器：mac-mini"),
  ).toBeTruthy();
});

test("C-75: one detail drawer at a time; another row stays clickable and replaces it; Esc, the close icon and outside clicks close it and return focus", async () => {
  const second = { ...assignment, id: "A-2", session_ref: "session-second" };
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment, second],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  const first = await screen.findByRole("button", { name: "查看 A-1 详情" });
  // C-106: the Assignment id is the trigger; the 详情 button is gone.
  expect(first.textContent).toBe("A-1");
  expect(
    [...document.querySelectorAll(".execution-table button")].some(
      (button) => button.textContent === "详情",
    ),
  ).toBe(false);
  const rowsBefore = document.querySelectorAll(".execution-table tr").length;
  /** Click like a pointer would: Radix dismisses on pointerdown outside. */
  const press = (element: Element) => {
    fireEvent.pointerDown(element);
    fireEvent.mouseDown(element);
    fireEvent.pointerUp(element);
    fireEvent.mouseUp(element);
    fireEvent.click(element);
  };
  // Radix arms its outside-pointer listener on the next tick after opening.
  const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

  press(first);
  expect(await screen.findByRole("dialog", { name: "A-1 coder" })).toBeTruthy();
  await settle();
  // The row does not expand or push the rows below it.
  expect(document.querySelectorAll(".execution-table tr")).toHaveLength(
    rowsBefore,
  );
  // The page behind stays usable: no pointer blocking, no aria-hidden, so the
  // other row's 详情 is still reachable by role and takes focus.
  expect(document.body.style.pointerEvents).not.toBe("none");
  const other = screen.getByRole("button", { name: "查看 A-2 详情" });
  expect(other.closest("[aria-hidden='true']")).toBeNull();
  other.focus();
  expect(document.activeElement).toBe(other);
  press(other);
  const replaced = await screen.findByRole("dialog", { name: "A-2 coder" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(replaced).getByText("session-second")).toBeTruthy();
  await settle();
  expect(screen.getByRole("dialog", { name: "A-2 coder" })).toBe(replaced);

  fireEvent.keyDown(replaced, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(other));

  press(first);
  const drawer = await screen.findByRole("dialog", { name: "A-1 coder" });
  press(within(drawer).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(first));

  // The dimming overlay lets clicks through, so clicking the dimmed page
  // outside the rows is an outside click that closes the drawer.
  press(other);
  await screen.findByRole("dialog", { name: "A-2 coder" });
  await settle();
  expect(
    document
      .querySelector(".drawer-overlay")
      ?.classList.contains("drawer-overlay-passthrough"),
  ).toBe(true);
  press(screen.getByRole("heading", { name: "执行视图" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(other));
});

test("C-75: a live refresh with more new Runs than one page leaves no gap in the history", async () => {
  const make = (n: number) => ({
    ...run,
    id: `R-${n}`,
    status: "completed",
    summary: `run ${n}`,
  });
  let runs = Array.from({ length: 20 }, (_, i) => make(20 - i));
  const client = fakeClient({
    execution: async () => ({ assignments: [assignment], runs, machines: [] }),
  });
  const { rerender } = render(
    <ExecutionPage client={client} projectId="p-1" revision={0} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  const ids = () => recordIds(history);
  await within(history).findByText("R-11", { exact: false });
  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await waitFor(() => expect(ids()).toHaveLength(20));
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  // Eleven new Runs while the page was away: more than one page.
  runs = Array.from({ length: 31 }, (_, i) => make(31 - i));
  rerender(<ExecutionPage client={client} projectId="p-1" revision={1} />);
  await within(history).findByText("R-31", { exact: false });
  // Restarted from the new first page; the rest loads in order, no gap.
  expect(ids()).toEqual(Array.from({ length: 10 }, (_, i) => `R-${31 - i}`));
  for (const length of [20, 30, 31]) {
    fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
    await waitFor(() => expect(ids()).toHaveLength(length));
  }
  expect(ids()).toEqual(Array.from({ length: 31 }, (_, i) => `R-${31 - i}`));
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  // A few new Runs (less than a page) keep the loaded pages, still gap-free.
  runs = Array.from({ length: 33 }, (_, i) => make(33 - i));
  rerender(<ExecutionPage client={client} projectId="p-1" revision={2} />);
  await within(history).findByText("R-33", { exact: false });
  expect(ids()).toEqual(Array.from({ length: 33 }, (_, i) => `R-${33 - i}`));
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();
});

test("C-75: a 显示更多 response that arrives after a refresh restarted the history is dropped, leaving no gap", async () => {
  const make = (n: number) => ({
    ...run,
    id: `R-${n}`,
    status: "completed",
    summary: `run ${n}`,
  });
  const page = (all: ReturnType<typeof make>[], before?: string) => {
    const start =
      before === undefined ? 0 : all.findIndex((r) => r.id === before) + 1;
    const runs = all.slice(start, start + 10);
    return {
      runs,
      total: all.length,
      next_cursor:
        start + runs.length < all.length ? (runs.at(-1)?.id ?? null) : null,
    };
  };
  let all = Array.from({ length: 20 }, (_, i) => make(20 - i));
  let releaseOld: (() => void) | undefined;
  const executionRuns = vi.fn(
    async (_projectId: string, _assignmentId: string, before?: string) => {
      const snapshot = all;
      // Hold the first 显示更多 (before=R-11) until the test releases it.
      if (before === "R-11" && releaseOld === undefined)
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      return page(snapshot, before);
    },
  );
  const client = fakeClient({
    execution: async () => ({
      assignments: [assignment],
      runs: all,
      machines: [],
    }),
    executionRuns,
  });
  const { rerender } = render(
    <ExecutionPage client={client} projectId="p-1" revision={0} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  const ids = () => recordIds(history);
  await waitFor(() => expect(ids()).toHaveLength(10));
  // ① 显示更多 is in flight (R-10…R-1 against the old data) …
  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await waitFor(() => expect(releaseOld).toBeDefined());
  // ② … when eleven new Runs arrive and the refresh restarts the history.
  all = Array.from({ length: 31 }, (_, i) => make(31 - i));
  rerender(<ExecutionPage client={client} projectId="p-1" revision={1} />);
  await within(history).findByText("R-31", { exact: false });
  expect(ids()).toEqual(Array.from({ length: 10 }, (_, i) => `R-${31 - i}`));
  // ③ The stale page lands late and must not be glued on.
  await act(async () => {
    releaseOld?.();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(ids()).toEqual(Array.from({ length: 10 }, (_, i) => `R-${31 - i}`));
  expect(within(history).getByRole("heading").textContent).toBe(
    "执行记录（31）",
  );
  // The new chain still reads everything in order.
  for (const length of [20, 30, 31]) {
    fireEvent.click(
      await within(history).findByRole("button", { name: "显示更多" }),
    );
    await waitFor(() => expect(ids()).toHaveLength(length));
  }
  expect(ids()).toEqual(Array.from({ length: 31 }, (_, i) => `R-${31 - i}`));
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();
});

test("C-75: 签收 folds into one line and expands to the ten newest with 显示更多", async () => {
  const cursors = Array.from({ length: 23 }, (_, index) => ({
    card_id: `C-${index + 1}`,
    acked_seq: (index + 1) * 10,
  }));
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [{ ...assignment, cursors }],
          runs: [],
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "查看 A-1 详情" }));
  // C-702: 签收 is a fact of the 会话维护 group.
  const section = await screen.findByRole("region", { name: "会话维护" });
  const fold = within(section).getByRole("button", {
    name: "23 张卡片，最新序号 230",
  });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(within(section).queryByText(/已签收序号/)).toBeNull();

  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  const shown = () =>
    within(section)
      .getAllByText(/^已签收序号/)
      .map((node) => node.textContent);
  expect(shown()).toEqual(
    Array.from({ length: 10 }, (_, i) => `已签收序号 ${230 - i * 10}`),
  );
  fireEvent.click(within(section).getByRole("button", { name: "显示更多" }));
  expect(shown()).toHaveLength(20);
  fireEvent.click(within(section).getByRole("button", { name: "显示更多" }));
  expect(shown()).toHaveLength(23);
  expect(
    within(section).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  fireEvent.click(fold);
  expect(within(section).queryByText(/已签收序号/)).toBeNull();
});

test("project view API paths encode project IDs and remain read-only", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("{}"));
  const client = new HttpCardiganClient(fetcher);
  await client.snapshot("p/a");
  await client.execution("p/a");
  await client.executionRuns("p/a", "A/1");
  await client.executionRuns("p/a", "A-1", "R-9");
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/projects/p%2Fa/snapshot",
    "/api/projects/p%2Fa/execution",
    "/api/projects/p%2Fa/execution/assignments/A%2F1/runs",
    "/api/projects/p%2Fa/execution/assignments/A-1/runs?before=R-9",
  ]);
  for (const [, init] of fetcher.mock.calls)
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
});

test("U1 a project with only inactive cards explains its empty snapshot without zero-count sections", async () => {
  const base = await fakeClient().snapshot("p-1");
  render(
    <SnapshotPage
      client={fakeClient({
        snapshot: async () => ({
          ...base,
          cards: [{ ...card, status: "cancelled" }],
        }),
      })}
      projectId="p-1"
    />,
  );
  await screen.findByText("没有进行中的工作");
  expect(screen.queryAllByRole("table")).toHaveLength(0);
});

test.each([null, assignment.runtime_ref])(
  "execution keeps external Office out of terminal commands (ref=%j)",
  async (runtime_ref) => {
    render(
      <ExecutionPage
        projectId="p-1"
        client={fakeClient({
          execution: async () => ({
            assignments: [
              {
                ...assignment,
                role_id: "pm",
                standing_mode: "office",
                external: true,
                runtime_ref,
                runtime_state: "not_provisioned",
                work_item_id: null,
                card_id: null,
              },
            ],
            runs: [],
            machines: [],
          }),
        })}
      />,
    );
    const row = (
      await screen.findByRole("button", { name: "查看 A-1 详情" })
    ).closest("tr");
    expect(row?.textContent).toContain("外接身份");
    expect(row?.textContent).not.toContain("由对接的 Agent 自行拉取");
    const status = screen.getByRole("button", { name: "A-1 状态详情" });
    fireEvent.focus(status);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "由对接的 Agent 自行拉取",
    );
    fireEvent.keyDown(status, { key: "Escape" });
    fireEvent.blur(status);
    expect(row?.querySelector("[data-column=context]")?.textContent).toBe("—");
    expect(screen.queryByText("已暂停")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看 A-1 详情" }));
    const drawer = await screen.findByRole("dialog", {
      name: "A-1 常驻 PM · 前台",
    });
    expect(
      within(screen.getByRole("region", { name: "当前" })).getByRole("heading")
        .textContent,
    ).toBe("由对接的 Agent 自行拉取");
    expect(
      within(screen.getByRole("region", { name: "执行状态" })).getByText(
        "外接身份",
      ),
    ).toBeTruthy();
    openCommands(drawer);
    expect(
      screen.queryByRole("button", { name: "复制启动或恢复会话" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "复制在 Herdr 中查看（只看）" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "复制接入命令" })).toBeNull();
    expect(screen.queryByText(/cardigan assignment attach/)).toBeNull();
    expect(screen.queryByText(/接管会直接向 Agent 终端输入/)).toBeNull();
    expect(screen.getByRole("button", { name: "复制查看收件箱" })).toBeTruthy();
  },
);

test("execution includes unprovisioned queued work in the default view and shows its global position", async () => {
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => ({
          machines: [],
          assignments: [
            {
              ...assignment,
              runtime_ref: null,
              runtime_state: "not_provisioned",
              queue_ahead: 2,
            },
          ],
          runs: [{ ...run, queue_ahead: 2 }],
        }),
      })}
    />,
  );
  const status = await screen.findByRole("button", { name: "A-1 状态详情" });
  expect(screen.queryByText("排队中（前面还有 2 个）")).toBeNull();
  fireEvent.focus(status);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "排队中（前面还有 2 个）",
  );
  fireEvent.keyDown(status, { key: "Escape" });
  fireEvent.blur(status);
  fireEvent.click(screen.getByRole("button", { name: "查看 A-1 详情" }));
  const history = await runRecords();
  const queued = await within(history).findByRole("button", { name: "排队中" });
  fireEvent.focus(queued);
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "排队中（前面还有 2 个）",
  );
});

test("execution distinguishes an unavailable runtime from capacity waiting", async () => {
  render(
    <ExecutionPage
      projectId="p-1"
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          machines: [],
          runs: [{ ...run, queue_reason: "runtime_unavailable" }],
        }),
      })}
    />,
  );
  const status = await screen.findByRole("button", { name: "A-1 状态详情" });
  expect(screen.queryByText("等待运行环境恢复")).toBeNull();
  fireEvent.focus(status);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("等待运行环境恢复");
  expect(tooltip.textContent).not.toContain("排队中（前面还有");
});
