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
  ).toContain("未命名的 未知角色");
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
    await screen.findByRole("button", { name: "查看 A-1 详情" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "查看 A-2 详情" })).toBeNull();
  expect(screen.queryByRole("button", { name: "查看 A-3 详情" })).toBeNull();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "released" },
  });
  expect(
    await screen.findByRole("button", { name: "查看 A-3 详情" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "lost" },
  });
  expect(
    await screen.findByRole("button", { name: "查看 A-2 详情" }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("筛选"), {
    target: { value: "all" },
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
  const drawer = await screen.findByRole("dialog", { name: "A-1 详情" });
  for (const text of [
    "session-fixture",
    "terminal-fixture",
    "/fixture/worktree",
    "agent/work",
  ])
    expect(within(drawer).getByText(text, { exact: false })).toBeTruthy();
  fireEvent.click(
    within(drawer).getByRole("button", {
      name: /已签收 1 张卡片，最新 seq 12/,
    }),
  );
  expect(within(drawer).getByText("已签收 seq 12")).toBeTruthy();
  expect(await within(drawer).findByText("R-9", { exact: false })).toBeTruthy();
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
  const command = "cardigan assignment attach 'A-1' --project 'p-1'";
  expect(screen.getByText(command)).toBeTruthy();
  const observe = screen.getByRole("button", {
    name: "复制在 Herdr 中打开（只看不动）",
  });
  const summary = screen.getByText("需要接管输入？");
  const details = summary.closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(observe.closest("details")).toBeNull();
  expect(
    screen.getByRole("button", { name: "复制接管输入" }).closest("details"),
  ).toBe(details);
  expect(screen.queryByText("deploy/install-cli.sh")).toBeNull();
  fireEvent.click(observe);
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(command));

  fireEvent.click(summary);
  expect(details.open).toBe(true);
  const warning = within(details).getByText(
    "你的输入会直接发给正在工作的 Agent，可能打断它",
  );
  const interactiveCommand = within(details).getByText(
    `${command} --interactive`,
  );
  expect(warning.tagName).toBe("STRONG");
  expect(
    warning.compareDocumentPosition(interactiveCommand) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(
    within(details).getByRole("button", { name: "复制接管输入" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(`${command} --interactive`),
  );
  expect(writeText).toHaveBeenCalledTimes(2);
  fireEvent.click(summary);
  expect(details.open).toBe(false);
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
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "A-1 Run 历史" })
        .querySelector(".status-blocked svg.status-shape-error"),
    ).not.toBeNull(),
  );
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
      await screen.findByRole("button", { name: "查看 A-1 详情" }),
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
    expect(screen.queryByText("正在加载…")).toBeNull();
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
    name: "查看 A-9 详情",
  });
  const row = toggle.closest("tr");
  expect(row?.textContent).toContain("常驻 PM（项目级）");
  expect(row?.textContent).not.toContain("项目级事项常驻");
});

test("C-75: the drawer shows ten recent Runs and pages ten more from the server, with expandable summaries", async () => {
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
  const history = await screen.findByRole("region", { name: "A-1 Run 历史" });
  await within(history).findByText("R-21", { exact: false });
  expect(within(history).queryByText("R-20", { exact: false })).toBeNull();
  expect(within(history).getAllByText("展开摘要")).toHaveLength(10);
  expect(within(history).queryByText(/显示全部/)).toBeNull();
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1");

  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await within(history).findByText("R-11", { exact: false });
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1", "R-21");
  expect(within(history).getAllByText("展开摘要")).toHaveLength(20);

  fireEvent.click(within(history).getByRole("button", { name: "显示更多" }));
  await within(history).findByText("R-8", { exact: false });
  expect(executionRuns).toHaveBeenLastCalledWith("p-1", "A-1", "R-11");
  expect(within(history).getAllByText("展开摘要")).toHaveLength(23);
  expect(
    within(history).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  fireEvent.click(
    within(history).getAllByRole("button", {
      name: "展开摘要",
    })[0] as HTMLElement,
  );
  expect(within(history).getAllByText("收起摘要")).toHaveLength(1);
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
  expect(first.textContent).toBe("详情");
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
  expect(await screen.findByRole("dialog", { name: "A-1 详情" })).toBeTruthy();
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
  const replaced = await screen.findByRole("dialog", { name: "A-2 详情" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(replaced).getByText("session-second")).toBeTruthy();
  await settle();
  expect(screen.getByRole("dialog", { name: "A-2 详情" })).toBe(replaced);

  fireEvent.keyDown(replaced, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(other));

  press(first);
  const drawer = await screen.findByRole("dialog", { name: "A-1 详情" });
  press(within(drawer).getByRole("button", { name: "关闭抽屉" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(first));

  // The dimming overlay lets clicks through, so clicking the dimmed page
  // outside the rows is an outside click that closes the drawer.
  press(other);
  await screen.findByRole("dialog", { name: "A-2 详情" });
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
  const history = await screen.findByRole("region", { name: "A-1 Run 历史" });
  const ids = () =>
    [...history.querySelectorAll(".execution-runs li")].map(
      (li) => /R-\d+/.exec(li.textContent ?? "")?.[0],
    );
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

test("C-75: ACK cursors fold into one line and expand to the ten newest with 显示更多", async () => {
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
  const section = await screen.findByRole("region", { name: "A-1 ACK 游标" });
  const fold = within(section).getByRole("button", {
    name: "已签收 23 张卡片，最新 seq 230",
  });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(within(section).queryByText(/已签收 seq/)).toBeNull();

  fireEvent.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  const shown = () =>
    within(section)
      .getAllByText(/^已签收 seq/)
      .map((node) => node.textContent);
  expect(shown()).toEqual(
    Array.from({ length: 10 }, (_, i) => `已签收 seq ${230 - i * 10}`),
  );
  fireEvent.click(within(section).getByRole("button", { name: "显示更多" }));
  expect(shown()).toHaveLength(20);
  fireEvent.click(within(section).getByRole("button", { name: "显示更多" }));
  expect(shown()).toHaveLength(23);
  expect(
    within(section).queryByRole("button", { name: "显示更多" }),
  ).toBeNull();

  fireEvent.click(fold);
  expect(within(section).queryByText(/已签收 seq/)).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: "查看 A-1 详情" }));
  await waitFor(() =>
    expect(screen.getAllByText("排队中（前面还有 2 个）")).toHaveLength(2),
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
  expect(await screen.findByText("等待运行环境恢复")).toBeTruthy();
  expect(screen.queryByText(/排队中（前面还有/)).toBeNull();
});
