// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  type ExecutionAssignment,
  HttpCardiganClient,
  type RunView,
  type SnapshotData,
} from "../api.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { ExecutionPage } from "./ExecutionPage.js";
import { SnapshotPage } from "./SnapshotPage.js";

afterEach(() => {
  cleanup();
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
  const human = within(await screen.findByRole("region", { name: "等你处理" })),
    agent = within(screen.getByRole("region", { name: "等 Agent 处理" }));
  expect(human.getByRole("link", { name: /^C-1 / }).getAttribute("href")).toBe(
    "#/p/p-1/cards/C-1",
  );
  expect(human.queryByRole("link", { name: /^C-2 / })).toBeNull();
  expect(agent.getByRole("link", { name: /^C-2 / })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "审核与待合并" }).textContent,
  ).toContain("未命名的 Agent");
  expect(
    screen.getByRole("region", { name: "阻塞事项" }).textContent,
  ).toContain("等待权限");
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
  expect((screen.getByLabelText("筛选") as HTMLSelectElement).value).toBe(
    "working",
  );
  expect(
    await screen.findByRole("button", { name: "展开 A-1 详情" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "展开 A-2 详情" })).toBeNull();
  expect(screen.queryByRole("button", { name: "展开 A-3 详情" })).toBeNull();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "released" },
  });
  expect(
    await screen.findByRole("button", { name: "展开 A-3 详情" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "lost" },
  });
  expect(
    await screen.findByRole("button", { name: "展开 A-2 详情" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "all" },
  });
  expect(
    await screen.findByRole("button", { name: "展开 A-1 详情" }),
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
  const toggle = await screen.findByRole("button", { name: "展开 A-1 详情" });
  const row = toggle.closest("tr");
  expect(row?.textContent).toContain("A-1");
  expect(row?.textContent).toContain("C-1");
  expect(row?.textContent).toContain("W-1");
  expect(row?.textContent).toContain("R-10");
  expect(row?.textContent).toContain("排队中");
  expect(row?.textContent).toContain("运行");
  expect(row?.textContent).toContain("Assignment");
  expect(
    row?.querySelector(".status-active")?.classList.contains("status-subdued"),
  ).toBe(true);
  expect(row?.querySelector(".status-active svg")).toBeNull();
  expect(
    row?.querySelector(".status-idle svg.status-shape-idle"),
  ).not.toBeNull();
  expect(
    row?.querySelector(".status-queued svg.status-shape-pending"),
  ).not.toBeNull();
  expect(screen.getByRole("columnheader", { name: "最近 Run" })).toBeTruthy();
  fireEvent.click(toggle);
  const expanded = await screen.findByRole("button", {
    name: "收起 A-1 详情",
  });
  expect(expanded).toBeTruthy();
  for (const text of [
    "session-fixture",
    "terminal-fixture",
    "/fixture/worktree",
    "agent/work",
    "已签收 seq 12",
  ])
    expect(screen.getByText(text, { exact: false })).toBeTruthy();
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
    await screen.findByRole("button", { name: "展开 A-1 详情" })
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
  fireEvent.click(screen.getByRole("button", { name: "展开 A-1 详情" }));
  expect(
    screen
      .getByRole("region", { name: "A-1 Run 历史" })
      .querySelector(".status-blocked svg.status-shape-error"),
  ).not.toBeNull();
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
    fireEvent.change(screen.getByLabelText("筛选"), {
      target: { value: "all" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "展开 A-1 详情" }),
    );
    const start = screen.queryByRole("button", { name: "复制启动或恢复会话" });
    expect(Boolean(start)).toBe(["idle", "not_provisioned"].includes(state));
    expect(screen.getByRole("button", { name: "复制检查异常" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "处理拍板、清理或失联事项" })
        .getAttribute("href"),
    ).toBe("#/p/p-1/needs-you");
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
    expect(screen.getByText("正在加载…")).toBeTruthy();
    await screen.findByText("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(
      kind === "snapshot"
        ? "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。"
        : "现在没有工作中的 Assignment。切换筛选可查看全部、已释放或失联的 Assignment。",
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
    name: "展开 A-9 详情",
  });
  const row = toggle.closest("tr");
  expect(row?.textContent).toContain("常驻 PM（项目级）");
  expect(row?.textContent).not.toContain("项目级事项常驻");
});

test("execution shows five recent Runs by default and can reveal all with expandable summaries", async () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({
    ...run,
    id: `R-${20 - index}`,
    status: "completed",
    summary: `Run ${20 - index} ${"很长的摘要".repeat(20)}`,
  }));
  render(
    <ExecutionPage
      client={fakeClient({
        execution: async () => ({
          assignments: [assignment],
          runs,
          machines: [],
        }),
      })}
      projectId="p-1"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "展开 A-1 详情" }));
  expect(screen.getByText("显示全部 7 条")).toBeTruthy();
  expect(screen.queryByText(/R-14/)).toBeNull();
  expect(screen.getAllByText("展开摘要").length).toBe(5);
  fireEvent.click(screen.getByRole("button", { name: "显示全部 7 条" }));
  expect(screen.getByText("R-14", { exact: false })).toBeTruthy();
  expect(screen.getAllByText("展开摘要").length).toBe(7);
  fireEvent.click(
    screen.getAllByRole("button", { name: "展开摘要" })[0] as HTMLElement,
  );
  expect(screen.getAllByText("收起摘要").length).toBe(1);
});

test("project view API paths encode project IDs and remain read-only", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response("{}"));
  const client = new HttpCardiganClient(fetcher);
  await client.snapshot("p/a");
  await client.execution("p/a");
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/projects/p%2Fa/snapshot",
    "/api/projects/p%2Fa/execution",
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
  await screen.findByText(
    "目前没有进行中、待审核或阻塞的工作。新进展会出现在这里。",
  );
  expect(document.querySelectorAll("h2")).toHaveLength(0);
});

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
  expect(await screen.findByText("排队中（前面还有 2 个）")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开 A-1 详情" }));
  expect(screen.getAllByText("排队中（前面还有 2 个）")).toHaveLength(2);
});
