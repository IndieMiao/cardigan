// @vitest-environment jsdom
/**
 * M5.3 card list and board (plan §4 M5.3; development plan §8.7).
 *
 * The four states the plan asks for — loading, error, empty, data — plus the two
 * filters, board grouping and the rule that a status is never colour alone.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  ApiError,
  type CardFilter,
  type CardiganClient,
  type CardPage,
  type CardView,
} from "../api.js";
import { CardListPage } from "./CardListPage.js";

afterEach(cleanup);

const NOW = "2026-01-01T00:00:00.000Z";

const card = (overrides: Partial<CardView> = {}): CardView => ({
  id: "C-1",
  title: "准备发布",
  goal: "把 0.1 发出去",
  acceptance_criteria: ["测试通过"],
  status: "in_progress",
  priority: 1,
  repo: "example/repo",
  base_branch: "main",
  created_at: NOW,
  why: "等你拍板 D-1",
  waiting_on: [{ kind: "decision", ref: "D-1", label: "等你拍板 D-1" }],
  next_owners: [{ kind: "human", ref: "human" }],
  related_cards: [],
  ...overrides,
});

const CARDS: readonly CardView[] = [
  card({ id: "C-1", title: "准备发布", why: "等你拍板 D-1" }),
  card({
    id: "C-2",
    title: "写迁移脚本",
    status: "todo",
    why: "coder 返工中",
    waiting_on: [],
    next_owners: [{ kind: "role", ref: "coder" }],
  }),
  card({
    id: "C-3",
    title: "清理 worktree",
    status: "done",
    why: "已完成",
    waiting_on: [],
    next_owners: [],
  }),
];

function page(filter: CardFilter): CardPage {
  const cards =
    filter === "needs_me"
      ? CARDS.filter((item) => item.next_owners.some((o) => o.kind === "human"))
      : filter === "agent"
        ? CARDS.filter((item) =>
            item.next_owners.some(
              (o) => o.kind === "role" || o.kind === "assignment",
            ),
          )
        : CARDS;
  return {
    project_id: "p-1",
    filter,
    cards,
    counts: { total: CARDS.length, needs_me: 1, agent: 1 },
  };
}

function client(
  cards: (projectId: string, filter: CardFilter) => Promise<CardPage>,
): CardiganClient & { calls: CardFilter[] } {
  const calls: CardFilter[] = [];
  return {
    calls,
    session: async () => ({ authenticated: true, password_configured: true }),
    login: async () => undefined,
    logout: async () => undefined,
    projects: async () => [],
    cards: (projectId, filter) => {
      calls.push(filter);
      return cards(projectId, filter);
    },
  };
}

test("shows a loading state while the cards are on their way", () => {
  const never = new Promise<CardPage>(() => undefined);
  render(
    <CardListPage client={client(() => never)} projectId="p-1" view="board" />,
  );
  expect(screen.getByRole("status").textContent).toContain("正在加载卡片");
});

test("shows the server's error and can retry", async () => {
  let attempt = 0;
  const api = client(async () => {
    attempt += 1;
    if (attempt === 1) throw new ApiError(500, "internal_error", "boom");
    return page("all");
  });
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("请求失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("准备发布")).toBeTruthy();
  expect(attempt).toBe(2);
});

test("an empty project says so, and each filter has its own empty text", async () => {
  const api = client(async (_projectId, filter) => ({
    project_id: "p-1",
    filter,
    cards: [],
    counts: { total: 0, needs_me: 0, agent: 0 },
  }));
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  expect(await screen.findByText("这个项目还没有卡片。")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /等我处理/u }));
  expect(await screen.findByText("没有等你处理的卡片。")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /等 Agent 处理/u }));
  expect(await screen.findByText("没有等 Agent 处理的卡片。")).toBeTruthy();
});

test("the board groups cards by status and links each one", async () => {
  const api = client(async (_projectId, filter) => page(filter));
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const inProgress = await screen.findByRole("region", { name: "进行中" });
  expect(inProgress.textContent).toContain("准备发布");
  expect(inProgress.textContent).not.toContain("写迁移脚本");

  const todo = screen.getByRole("region", { name: "待开始" });
  expect(todo.textContent).toContain("写迁移脚本");

  const done = screen.getByRole("region", { name: "已完成" });
  expect(done.textContent).toContain("清理 worktree");

  // Status is a label, not only a colour (§3.7).
  expect(inProgress.textContent).toContain("进行中");

  const link = screen.getByRole("link", { name: /准备发布/u });
  expect(link.getAttribute("href")).toBe("#/p/p-1/cards/C-1");
  expect(inProgress.textContent).toContain("下一步：你");
  expect(todo.textContent).toContain("下一步：coder");
});

test("the two filters ask the server for their own view", async () => {
  const api = client(async (_projectId, filter) => page(filter));
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  await screen.findByText("准备发布");
  expect(api.calls).toEqual(["all"]);

  fireEvent.click(screen.getByRole("button", { name: /等我处理/u }));
  await waitFor(() => expect(api.calls).toEqual(["all", "needs_me"]));
  const listed = await screen.findByRole("region", { name: "进行中" });
  expect(listed.textContent).toContain("准备发布");

  fireEvent.click(screen.getByRole("button", { name: /等 Agent 处理/u }));
  await waitFor(() => expect(api.calls).toEqual(["all", "needs_me", "agent"]));
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "进行中" }).textContent,
    ).not.toContain("准备发布"),
  );
});

test("the list view prints one row per card with its status", async () => {
  const api = client(async (_projectId, filter) => page(filter));
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  const row = (await screen.findByText("写迁移脚本")).closest("tr");
  expect(row?.textContent).toContain("C-2");
  expect(row?.textContent).toContain("待开始");
  expect(row?.textContent).toContain("coder");
  expect(row?.querySelector("a")?.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-2",
  );
});

test("HTML inside a card title is shown as text, not markup", async () => {
  const hostile = card({
    id: "C-9",
    title: '<img src=x onerror="alert(1)">',
    why: "<script>alert(2)</script>",
    status: "backlog",
  });
  const api = client(async (_projectId, filter) => ({
    project_id: "p-1",
    filter,
    cards: [hostile],
    counts: { total: 1, needs_me: 1, agent: 0 },
  }));
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const column = await screen.findByRole("region", { name: "待整理" });
  expect(column.querySelector("img")).toBeNull();
  expect(column.querySelector("script")).toBeNull();
  expect(column.textContent).toContain('<img src=x onerror="alert(1)">');
});
