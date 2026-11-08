// @vitest-environment jsdom
/** Phase 1.5 §4.3 list filters, columns and existing board behaviour. */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ApiError,
  type CardFilter,
  type CardiganClient,
  type CardListItem,
  type CardPage,
} from "../api.js";
import { parseRoute } from "../route.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardListPage } from "./CardListPage.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

const NOW = "2026-01-01T00:00:00.000Z";

const card = (overrides: Partial<CardListItem> = {}): CardListItem => ({
  id: "C-1",
  title: "准备发布",
  goal: "把 0.1 发出去",
  acceptance_criteria: ["测试通过"],
  status: "in_progress",
  priority: 2,
  repo: "example/repo",
  base_branch: "main",
  created_at: NOW,
  updated_at: "2026-01-03T00:00:00.000Z",
  why: "等你拍板 D-1",
  waiting_on: [{ kind: "decision", ref: "D-1", label: "等你拍板 D-1" }],
  next_owners: [{ kind: "human", ref: "human" }],
  related_cards: [],
  progress: { completed: 2, total: 3 },
  roles: ["coder", "reviewer"],
  ...overrides,
});

const CARDS: readonly CardListItem[] = [
  card({ id: "C-1", title: "准备发布", why: "等你拍板 D-1" }),
  card({
    id: "C-2",
    title: "写迁移脚本",
    status: "todo",
    priority: 3,
    updated_at: "2026-01-02T00:00:00.000Z",
    why: "coder 返工中",
    waiting_on: [],
    next_owners: [{ kind: "role", ref: "coder" }],
    progress: { completed: 0, total: 3 },
    roles: ["coder"],
  }),
  card({
    id: "C-3",
    title: "清理 worktree",
    status: "done",
    priority: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    why: "已完成",
    waiting_on: [],
    next_owners: [],
    progress: { completed: 3, total: 3 },
    roles: [],
  }),
];

function page(filter: CardFilter = "all"): CardPage {
  return {
    project_id: "p-1",
    filter,
    cards: CARDS,
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
    card: async () => {
      throw new Error("the list view must not open a card");
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
    return page();
  });
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("请求失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("准备发布")).toBeTruthy();
  expect(attempt).toBe(2);
});

test("an empty project says so, and active filters have their own empty text", async () => {
  const api = client(async (_projectId, filter) => ({
    project_id: "p-1",
    filter,
    cards: [],
    counts: { total: 0, needs_me: 0, agent: 0 },
  }));
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  expect(
    await screen.findByText(
      "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "状态：全部" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "进行中" }));
  expect(
    await screen.findByText("没有匹配的卡片，请调整筛选条件。"),
  ).toBeTruthy();
});

test("the board groups cards by status and links each one", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const inProgress = await screen.findByRole("region", { name: "进行中" });
  expect(inProgress.textContent).toContain("准备发布");
  expect(inProgress.textContent).not.toContain("写迁移脚本");
  expect(screen.getByRole("region", { name: "待开始" }).textContent).toContain(
    "写迁移脚本",
  );
  expect(screen.getByRole("region", { name: "已完成" }).textContent).toContain(
    "清理 worktree",
  );
  const link = screen.getByRole("link", { name: /准备发布/u });
  expect(link.getAttribute("href")).toBe("#/p/p-1/cards/C-1");
  expect(inProgress.textContent).toContain("下一步：你");
});

test("the list shows the configurable columns, progress, updated time and reason", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  const row = (await screen.findByText("写迁移脚本")).closest("tr");
  if (!row) throw new Error("Missing row");
  expect([...row.querySelectorAll("td")].length).toBe(9);
  expect(row.textContent).toContain("C-2");
  expect(row.textContent).toContain("待开始");
  expect(row.textContent).toContain("coder");
  expect(row.textContent).toContain("0/3");
  expect(row.textContent).toContain("coder 返工中");
  expect(row.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-01-02T00:00:00.000Z",
  );
  expect(row.getAttribute("title")).toBe("coder 返工中");
  expect(row.querySelector("a")?.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-2",
  );
  for (const header of [
    "编号",
    "标题",
    "状态",
    "等待标记",
    "负责角色",
    "进度",
    "更新时间",
    "下一步",
    "原因",
  ])
    expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
});

test("status, next owner, role, search and sort filter the rows and live in the route", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  await screen.findByText("准备发布");
  expect(api.calls).toEqual(["all"]);

  fireEvent.click(screen.getByRole("button", { name: "状态：全部" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "进行中" }));
  await waitFor(() => expect(screen.queryByText("写迁移脚本")).toBeNull());
  expect(screen.getByText("准备发布")).toBeTruthy();
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "cards",
    filters: { view: "list", status: "in_progress" },
  });
  fireEvent.click(screen.getByRole("button", { name: "移除状态筛选" }));

  fireEvent.change(screen.getByLabelText("下一步谁做"), {
    target: { value: "agent" },
  });
  await waitFor(() => expect(screen.queryByText("准备发布")).toBeNull());
  expect(screen.getByText("写迁移脚本")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("下一步谁做"), {
    target: { value: "" },
  });

  fireEvent.change(screen.getByLabelText("角色"), {
    target: { value: "reviewer" },
  });
  await waitFor(() => expect(screen.queryByText("写迁移脚本")).toBeNull());
  expect(screen.getByText("准备发布")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("角色"), {
    target: { value: "" },
  });

  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "C-2" },
  });
  await waitFor(() => expect(screen.queryByText("准备发布")).toBeNull());
  expect(screen.getByText("写迁移脚本")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "" },
  });

  fireEvent.change(screen.getByLabelText("排序"), {
    target: { value: "priority" },
  });
  await waitFor(() => {
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent?.slice(0, 3))).toEqual([
      "C-2",
      "C-1",
      "C-3",
    ]);
  });
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "cards",
    filters: { view: "list", sort: "priority" },
  });
});

test("filters from a copied URL are restored", async () => {
  window.location.hash =
    "#/p/p-1/cards?view=list&status=done&next=none&q=C-3&sort=id";
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  expect(await screen.findByText("清理 worktree")).toBeTruthy();
  expect(screen.queryByText("准备发布")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "状态：已完成" }));
  expect(
    (screen.getByRole("checkbox", { name: "已完成" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test("the display menu hides fields and persists the choice in localStorage", async () => {
  const api = client(async () => page());
  const first = render(
    <CardListPage client={api} projectId="p-1" view="list" />,
  );
  await screen.findByText("准备发布");
  expect(screen.getByRole("columnheader", { name: "编号" })).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: "显示" }), {
    button: 0,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  const number = within(menu)
    .getByText("编号")
    .closest('[role="menuitemcheckbox"]');
  if (number === null) throw new Error("Missing number display item");
  expect(number.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(number);
  await waitFor(() =>
    expect(screen.queryByRole("columnheader", { name: "编号" })).toBeNull(),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    JSON.parse(window.localStorage.getItem("cardigan.cards.display") ?? "{}"),
  ).toMatchObject({
    number: false,
  });
  first.unmount();
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  await screen.findByText("准备发布");
  expect(screen.queryByRole("columnheader", { name: "编号" })).toBeNull();
});

test("invalid stored display settings fall back to the defaults", async () => {
  window.localStorage.setItem("cardigan.cards.display", "{not-json");
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  await screen.findByText("准备发布");
  for (const header of ["编号", "等待标记", "负责角色", "进度", "更新时间"])
    expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
});

test("clicking a card opens the detail drawer on the route and returns focus on close", async () => {
  window.location.hash = "#/p/p-1/cards?view=list&status=in_progress";
  const api = fakeClient({
    cards: async () => page(),
    card: async () => cardDetail(),
  });
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  const link = await screen.findByRole("link", { name: "准备发布" });
  fireEvent.click(link);
  const dialog = await screen.findByRole("dialog", {
    name: "C-1 准备发布",
  });
  expect(dialog.textContent).toContain("把 0.1 发出去");
  await waitFor(() =>
    expect(window.location.hash).toBe(
      "#/p/p-1/cards?view=list&status=in_progress&card=C-1",
    ),
  );
  expect(
    screen.getByRole("link", { name: "在完整页面打开" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
  const clipboard = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboard },
    configurable: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
  await waitFor(() =>
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("card=C-1")),
  );
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(link);
  expect(window.location.hash).toBe(
    "#/p/p-1/cards?view=list&status=in_progress",
  );
});

test("a drawer card in the URL survives refresh and the back link opens the full page", async () => {
  window.location.hash = "#/p/p-1/cards?view=board&card=C-1";
  const api = fakeClient({
    cards: async () => page(),
    card: async () => cardDetail(),
  });
  render(<CardListPage client={api} projectId="p-1" />);
  const dialog = await screen.findByRole("dialog", {
    name: "C-1 准备发布",
  });
  expect(dialog.textContent).toContain("把 0.1 发出去");
  expect(
    screen.getByRole("link", { name: "在完整页面打开" }).getAttribute("href"),
  ).toBe("#/p/p-1/cards/C-1");
});

test("HTML inside a card title is shown as text, not markup", async () => {
  const hostile = card({
    id: "C-9",
    title: '<img src=x onerror="alert(1)">',
    why: "<script>alert(2)</script>",
    status: "backlog",
  });
  const api = client(async () => ({
    project_id: "p-1",
    filter: "all",
    cards: [hostile],
    counts: { total: 1, needs_me: 1, agent: 0 },
  }));
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const column = await screen.findByRole("region", { name: "待整理" });
  expect(column.querySelector("img")).toBeNull();
  expect(column.querySelector("script")).toBeNull();
  expect(column.textContent).toContain('<img src=x onerror="alert(1)">');
});
