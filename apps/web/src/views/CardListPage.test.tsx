// @vitest-environment jsdom
/** Phase 1.5 §4.3 list filters, columns and existing board behaviour. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
import { cardGroupingKey, readCardGrouping } from "../card-display.js";
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

test("C-314: the display menu groups the current card page by status and remembers the project choice", async () => {
  const api = fakeClient({
    cards: async () => ({
      cards: [...CARDS, card({ id: "C-4", title: "第二张进行中的卡片" })],
    }),
  });
  const first = render(
    <CardListPage client={api} projectId="p-1" view="list" />,
  );
  await screen.findByText("准备发布");
  expect(screen.queryByRole("button", { name: /折叠.*分组/ })).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "显示" }), {
    button: 0,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  fireEvent.click(
    within(menu).getByRole("menuitemcheckbox", { name: "分组字段：状态" }),
  );
  expect(await screen.findByText("分组统计当前页")).toBeTruthy();
  expect(window.localStorage.getItem(cardGroupingKey("p-1"))).toBe("status");
  fireEvent.keyDown(document, { key: "Escape" });
  const group = screen.getByRole("rowgroup", { name: "进行中" });
  expect(within(group).getAllByRole("row")).toHaveLength(2);
  const toggle = screen.getByRole("button", { name: "折叠进行中分组" });
  expect(toggle.closest("td")?.colSpan).toBe(
    screen.getAllByRole("columnheader").length,
  );
  fireEvent.click(toggle);
  expect(screen.queryByRole("link", { name: "准备发布" })).toBeNull();
  expect(screen.getByRole("link", { name: "写迁移脚本" })).toBeTruthy();
  first.unmount();
  const again = render(
    <CardListPage client={api} projectId="p-1" view="list" />,
  );
  expect(
    await screen.findByRole("button", { name: "折叠进行中分组" }),
  ).toBeTruthy();
  again.unmount();
  render(<CardListPage client={api} projectId="p-2" view="list" />);
  await screen.findByText("准备发布");
  expect(screen.queryByRole("button", { name: /折叠.*分组/ })).toBeNull();
  localStorage.setItem(cardGroupingKey("p-2"), "invalid");
  expect(readCardGrouping("p-2")).toBe("none");
});

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
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
    }),
    setBoardLane: async () => undefined,
  };
}

test.each(["board", "list"] as const)(
  "P2a-5: %s fades superseded cards and identifies their replacement, not unrelated cards",
  async (view) => {
    const api = client(async () => ({
      ...page(),
      cards: [
        card({
          id: "C-1",
          title: "Old completed card",
          status: "done",
          resolution: "superseded",
          superseded_by: "C-2",
          related_cards: ["C-99", "C-2"],
        }),
        card({
          id: "C-3",
          title: "Old cancelled card",
          status: "cancelled",
          resolution: "superseded",
          superseded_by: "C-4",
        }),
        card({
          id: "C-5",
          title: "Ordinary completed card",
          status: "done",
          resolution: "done",
        }),
      ],
    }));
    render(<CardListPage client={api} projectId="p-1" view={view} />);
    const notice = await screen.findByText("已被 C-2 取代");
    expect(
      notice
        .closest(view === "board" ? ".card-tile" : "tr")
        ?.classList.contains("card-superseded"),
    ).toBe(true);
    expect(
      screen.getByText("已被 C-4 取代").closest(".card-superseded"),
    ).toBeTruthy();
    expect(
      screen.getByText("Ordinary completed card").closest(".card-superseded"),
    ).toBeNull();
    expect(screen.queryByText("已被 C-99 取代")).toBeNull();
    expect(document.querySelectorAll(".card-superseded")).toHaveLength(2);
    expect(document.querySelector("a a")).toBeNull();
  },
);

test("shows a loading state while the cards are on their way", () => {
  const never = new Promise<CardPage>(() => undefined);
  render(
    <CardListPage client={client(() => never)} projectId="p-1" view="board" />,
  );
  expect(screen.getByRole("status").textContent).toBe("");
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

test("U6a only the search box takes the remaining width of the filter row", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  const search = await screen.findByLabelText("搜索标题或编号");
  const grow = document.querySelectorAll(".filter-custom-grow");
  expect(grow).toHaveLength(1);
  expect(grow[0]?.className).toContain("filter-custom");
  expect(grow[0]?.contains(search)).toBe(true);
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const box = css.indexOf(".cards-page .filter-custom-grow {");
  expect(box).toBeGreaterThanOrEqual(0);
  expect(css.slice(box, css.indexOf("}", box) + 1)).toContain(
    "flex: 1 1 220px;",
  );
  const input = css.indexOf(".cards-page .filter-search {");
  expect(css.slice(input, css.indexOf("}", input) + 1)).toContain("flex: 1;");
});

test("the board groups cards by status and links each one", async () => {
  const api = client(async () => {
    const result = page();
    return {
      ...result,
      cards: result.cards.map((card) => ({
        ...card,
        next_owners: card.next_owners.map((owner) =>
          owner.kind === "human"
            ? {
                ...owner,
                member: {
                  id: "M-1",
                  name: "邵杰",
                  title: "所有者",
                  avatar: null,
                },
              }
            : owner,
        ),
      })),
    };
  });
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  expect(screen.getByRole("heading", { name: /卡片.*张卡片/u })).toBeTruthy();
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
  expect(
    within(inProgress).getByRole("link", { name: "下一步：邵杰" }),
  ).toBeTruthy();
});

test("the list shows the configurable columns and progress; the reason stays off by default (U6a)", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  const row = (await screen.findByText("写迁移脚本")).closest("tr");
  if (!row) throw new Error("Missing row");
  expect([...row.querySelectorAll("td")].length).toBe(8);
  expect(row.textContent).toContain("C-2");
  expect(row.textContent).toContain("待开始");
  expect(row.textContent).toContain("coder");
  expect(row.textContent).toContain("0/3");
  expect(row.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-01-02T00:00:00.000Z",
  );
  expect(row.getAttribute("title")).toBe(null);
  expect(row.querySelector("a")?.getAttribute("href")).toBe(
    "#/p/p-1/cards/C-2",
  );
  for (const header of [
    "编号",
    "标题",
    "状态",
    "负责角色",
    "进度",
    "更新时间",
    "下一步",
  ])
    expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
  expect(row.lastElementChild?.textContent).toBe("→");
  expect(screen.getByText("共 3 张卡片")).toBeTruthy();
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

  fireEvent.pointerDown(screen.getByRole("button", { name: "下一步：全部" }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Agent" }));
  await waitFor(() => expect(screen.queryByText("准备发布")).toBeNull());
  expect(screen.getByText("写迁移脚本")).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: "下一步：Agent" }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "全部" }));

  fireEvent.pointerDown(screen.getByRole("button", { name: "角色：全部" }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "reviewer" }));
  await waitFor(() => expect(screen.queryByText("写迁移脚本")).toBeNull());
  expect(screen.getByText("准备发布")).toBeTruthy();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "角色：reviewer" }),
    {
      button: 0,
      pointerType: "mouse",
    },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "全部" }));

  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "C-2" },
  });
  await waitFor(() => expect(screen.queryByText("准备发布")).toBeNull());
  expect(screen.getByText("写迁移脚本")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "" },
  });

  fireEvent.pointerDown(screen.getByRole("button", { name: "排序：全部" }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "优先级" }));
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

test("hiding numbers preserves every priority badge, including after restoring saved preferences", async () => {
  const cards = [...CARDS, card({ id: "C-4", title: "紧急修复", priority: 4 })];
  const api = client(async () => ({ ...page(), cards }));
  const expectPriorities = () => {
    for (const label of ["低", "中", "高", "紧急"])
      expect(
        screen.getByRole("button", { name: `优先级：${label}` }).tabIndex,
      ).toBe(0);
  };
  const first = render(
    <CardListPage client={api} projectId="p-1" view="list" />,
  );
  await screen.findByText("准备发布");
  expectPriorities();
  expect(screen.getByRole("columnheader", { name: "编号" })).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: "显示" }), {
    button: 0,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("显示字段")).toBeTruthy();
  expect(within(menu).getByText("标题始终显示")).toBeTruthy();
  expect(within(menu).getByText("仅保存在此浏览器")).toBeTruthy();
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
  await waitFor(expectPriorities);
  expect(
    JSON.parse(window.localStorage.getItem("cardigan.cards.display") ?? "{}"),
  ).toMatchObject({
    number: false,
  });
  first.unmount();
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  await screen.findByText("准备发布");
  expectPriorities();
  expect(screen.queryByRole("columnheader", { name: "编号" })).toBeNull();
});

test("invalid stored display settings fall back to the defaults", async () => {
  window.localStorage.setItem("cardigan.cards.display", "{not-json");
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="list" />);
  await screen.findByText("准备发布");
  for (const header of ["编号", "负责角色", "进度", "更新时间"])
    expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
});

test("U6a the reason field is off by default while every other field stays on", async () => {
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  await screen.findByText("准备发布");
  // No stored settings: the board tiles do not repeat the reason.
  expect(screen.queryByText(/原因：/u)).toBeNull();
  fireEvent.pointerDown(screen.getByRole("button", { name: "显示" }), {
    button: 0,
    pointerType: "mouse",
  });
  const menu = await screen.findByRole("menu");
  const checked = (label: string) =>
    within(menu)
      .getByText(label)
      .closest('[role="menuitemcheckbox"]')
      ?.getAttribute("aria-checked");
  expect(checked("原因")).toBe("false");
  for (const label of [
    "编号",
    "等待标记",
    "负责角色",
    "进度",
    "更新时间",
    "下一步",
  ])
    expect(checked(label)).toBe("true");
});

test("stored display settings keep the user's own choice for the reason field", async () => {
  window.localStorage.setItem(
    "cardigan.cards.display",
    JSON.stringify({ reason: true }),
  );
  const api = client(async () => page());
  render(<CardListPage client={api} projectId="p-1" view="board" />);
  await screen.findByText("准备发布");
  expect(screen.getAllByRole("link", { name: /^原因：/ })).toHaveLength(3);
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
  expect(await within(dialog).findByText("把 0.1 发出去")).toBeTruthy();
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
  expect(await within(dialog).findByText("把 0.1 发出去")).toBeTruthy();
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
