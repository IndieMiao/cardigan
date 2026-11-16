// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { parseRoute } from "../route.js";
import { card, cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardListPage } from "./CardListPage.js";

const cards: CardListItem[] = Array.from({ length: 35 }, (_, index) => ({
  ...card,
  id: `C-${index + 1}`,
  title: `${index < 15 ? "旧卡" : "新卡"} ${index + 1}`,
  updated_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  status: index < 15 ? "todo" : "in_progress",
  priority: index < 15 ? 4 : 1,
  roles: [index < 15 ? "reviewer" : "coder"],
  waiting_on: [],
  next_owners:
    index < 15
      ? [{ kind: "human", ref: "human" }]
      : [{ kind: "role", ref: "coder" }],
}));
const api = (items = cards) =>
  fakeClient({
    cards: vi.fn(async () => ({
      project_id: "p-1",
      filter: "all",
      cards: items,
      counts: { total: items.length, needs_me: 15, agent: 20 },
    })),
    card: async (_project, id) =>
      cardDetail({ card: cards.find((item) => item.id === id) ?? card }),
  });
const titles = () =>
  [...document.querySelectorAll(".card-table-title")].map(
    (node) => node.textContent,
  );
const descending = (start: number, length: number) =>
  Array.from(
    { length },
    (_, index) => `${start - index <= 15 ? "旧卡" : "新卡"} ${start - index}`,
  );
const paging = () => parseRoute(window.location.hash)?.filters;
const disabled = (name: string) =>
  (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
function route(query: string) {
  act(() => {
    window.history.replaceState(null, "", `#/p/p-1/cards?view=list&${query}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
async function select(name: string, option: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    pointerType: "mouse",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: option, exact: true }),
  );
}
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

test("defaults to the latest ten, pages through all results and disables boundary buttons", async () => {
  const client = api();
  render(<CardListPage client={client} projectId="p-1" view="list" />);
  await screen.findByText("第 1 / 4 页");
  expect(titles()).toEqual(descending(35, 10));
  expect(disabled("上一页")).toBe(true);
  expect(screen.getByText("共 35 张卡片")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 2 / 4 页");
  expect(titles()).toEqual(descending(25, 10));
  expect(paging()).toMatchObject({ page: "2", count: "10" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 3 / 4 页");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("第 4 / 4 页");
  expect(titles()).toEqual(descending(5, 5));
  expect(disabled("下一页")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText("第 3 / 4 页");
  expect(titles()).toEqual(descending(15, 10));
  expect(client.cards).toHaveBeenLastCalledWith(
    "p-1",
    "all",
    expect.objectContaining({ mode: "list", limit: "10", page: "3" }),
  );
});

test("server board pages append, retry the same cursor and patch only changed cards", async () => {
  route("view=board");
  const rows = cards.map((c) => ({
    ...c,
    status: "in_progress",
    next_owners: [],
    roles: [],
  }));
  const changed = rows[14];
  if (!changed) throw new Error("missing fixture");
  let fail = true;
  const read = vi.fn(
    async (
      _project: string,
      _filter: string,
      options?: Readonly<Record<string, string>>,
    ) => {
      if (options?.cursor && fail) {
        fail = false;
        throw new Error("下一页暂时失败");
      }
      const selected = options?.ids
        ? [{ ...changed, title: "Changed card" }]
        : options?.cursor
          ? rows.slice(10, 20)
          : rows.slice(0, 10);
      return {
        project_id: "p-1",
        filter: "all" as const,
        server_filtered: true,
        cards: selected,
        counts: { total: 35, needs_me: 0, agent: 0 },
        total_filtered: 35,
        lanes: {
          in_progress: {
            total: 35,
            next_cursor: options?.cursor ? "page-three" : "page-two",
          },
        },
      };
    },
  );
  const client = fakeClient({ cards: read });
  const view = render(
    <CardListPage client={client} projectId="p-1" view="board" />,
  );
  await screen.findByRole("button", { name: "加载更多进行中卡片" });
  expect(document.querySelectorAll(".board-card")).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "加载更多进行中卡片" }));
  await screen.findByText("下一页暂时失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(document.querySelectorAll(".board-card")).toHaveLength(20),
  );
  expect(read.mock.calls.at(-1)?.[2]).toMatchObject({
    status: "in_progress",
    cursor: "page-two",
    limit: "10",
  });
  view.rerender(
    <CardListPage
      client={client}
      projectId="p-1"
      view="board"
      revision={1}
      changedCards={["C-15"]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
  await screen.findByText("Changed card");
  expect(document.querySelectorAll(".board-card")).toHaveLength(20);
  expect(read.mock.calls.at(-1)?.[2]).toMatchObject({ ids: "C-15" });
  expect(read.mock.calls.at(-1)?.[2]?.cursor).toBeUndefined();
});

test("changing the shared size menu resets to page one and persists 10, 20 or 50", async () => {
  route("page=3&count=10");
  render(<CardListPage client={api()} projectId="p-1" />);
  await screen.findByText("第 3 / 4 页");
  await select("每页：10 张", "20 张");
  await screen.findByText("第 1 / 2 页");
  expect(titles()).toEqual(descending(35, 20));
  expect(paging()).toMatchObject({ page: "1", count: "20" });
  await select("每页：20 张", "50 张");
  await screen.findByText("第 1 / 1 页");
  expect(titles()).toHaveLength(35);
  expect(disabled("下一页")).toBe(true);
  await select("每页：50 张", "10 张");
  await screen.findByText("第 1 / 4 页");
  expect(titles()).toHaveLength(10);
});

test.each(["status", "next", "role", "search", "sort"])(
  "%s applies to all cards before paging and resets to page one",
  async (filter) => {
    route("page=2&count=10");
    render(<CardListPage client={api()} projectId="p-1" />);
    await screen.findByText("第 2 / 4 页");
    if (filter === "status") {
      fireEvent.click(screen.getByRole("button", { name: "状态：全部" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "待开始" }));
      fireEvent.keyDown(document, { key: "Escape" });
    } else if (filter === "next") await select("下一步：全部", "所有者");
    else if (filter === "role") await select("角色：全部", "reviewer");
    else if (filter === "sort") await select("排序：全部", "优先级");
    else
      fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
        target: { value: "旧卡" },
      });
    await waitFor(() => expect(paging()?.page).toBe("1"));
    expect(titles()).toEqual(
      filter === "sort"
        ? Array.from({ length: 10 }, (_, index) => `旧卡 ${index + 1}`)
        : descending(15, 10),
    );
    const total = filter === "sort" ? 35 : 15;
    expect(
      screen.getByRole("heading", { name: `卡片${total} 张卡片` }),
    ).toBeTruthy();
    expect(screen.getByText(`共 ${total} 张卡片`)).toBeTruthy();
    const labels: Record<string, string> = {
      status: "状态",
      next: "下一步谁做",
      role: "角色",
      search: "搜索标题或编号",
      sort: "排序",
    };
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(paging()?.page).toBe("2"));
    fireEvent.click(
      screen.getByRole("button", { name: `移除${labels[filter]}筛选` }),
    );
    await waitFor(() => expect(titles()).toEqual(descending(35, 10)));
    expect(paging()?.page).toBe("1");
  },
);

test("copied URLs, refresh, drawer closing and history navigation preserve the selected page", async () => {
  route("page=2&count=20&sort=id");
  const client = api();
  const first = render(<CardListPage client={client} projectId="p-1" />);
  await screen.findByText("第 2 / 2 页");
  const expected = Array.from(
    { length: 15 },
    (_, index) => `新卡 ${index + 21}`,
  );
  expect(titles()).toEqual(expected);
  first.unmount();
  render(<CardListPage client={client} projectId="p-1" />);
  await screen.findByText("第 2 / 2 页");
  expect(titles()).toEqual(expected);
  fireEvent.click(screen.getByRole("link", { name: "新卡 21" }));
  await screen.findByRole("dialog");
  expect(paging()).toMatchObject({
    card: "C-21",
    page: "2",
    count: "20",
    sort: "id",
  });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(titles()).toEqual(expected);
  route("page=1&count=10");
  await screen.findByText("第 1 / 4 页");
  route("page=2&count=20&sort=id");
  await screen.findByText("第 2 / 2 页");
  expect(titles()).toEqual(expected);
});

test.each([
  "page=-1&count=100",
  "page=nope&count=0",
  "page=1.5&count=NaN",
  "page=Infinity&count=10",
])("invalid parameters fall back safely: %s", async (query) => {
  route(query);
  render(<CardListPage client={api()} projectId="p-1" />);
  await screen.findByText("第 1 / 4 页");
  expect(titles()).toEqual(descending(35, 10));
});

test("live removal and out-of-range URLs clamp to the last available page, including an empty result", async () => {
  route("page=99&count=10");
  const client = api();
  const page = render(<CardListPage client={client} projectId="p-1" />);
  await screen.findByText("第 4 / 4 页");
  expect(titles()).toEqual(descending(5, 5));
  page.rerender(
    <CardListPage client={api(cards.slice(0, 12))} projectId="p-1" />,
  );
  await screen.findByText("第 2 / 2 页");
  expect(titles()).toEqual(descending(2, 2));
  page.rerender(<CardListPage client={api([])} projectId="p-1" />);
  await screen.findByText(
    "这个项目还没有卡片。向 PM 描述目标后，卡片会出现在这里。",
  );
  expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
  expect(disabled("上一页")).toBe(true);
  expect(disabled("下一页")).toBe(true);
});

test("switching to board preserves its independent lane counts and lazy loading", async () => {
  route("page=2&count=20");
  render(<CardListPage client={api()} projectId="p-1" />);
  await screen.findByText("第 2 / 2 页");
  fireEvent.click(screen.getByRole("button", { name: "看板" }));
  await screen.findByRole("region", { name: "进行中" });
  expect(screen.queryByRole("navigation", { name: "卡片分页" })).toBeNull();
  expect(document.querySelectorAll(".card-tile")).toHaveLength(20);
  expect(screen.getByRole("heading", { name: /卡片35 张卡片/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  await screen.findByText("第 2 / 2 页");
  expect(titles()).toEqual(descending(15, 15));
});

test.each(["failed", "in-flight"])(
  "board pagination preserves unapplied revisions after a %s page",
  async (mode) => {
    route("view=board");
    const rows = cards.slice(0, 20).map((c) => ({
      ...c,
      status: "in_progress",
      roles: [],
      next_owners: [],
    }));
    const firstRow = rows[0];
    if (!firstRow) throw new Error("missing fixture");
    const other = {
      ...card,
      id: "C-99",
      title: "Other lane",
      status: "todo",
      roles: [],
      next_owners: [],
    };
    let first = true;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(
      async (
        _p: string,
        _f: string,
        options?: Readonly<Record<string, string>>,
      ) => {
        if (options?.cursor && first) {
          first = false;
          if (mode === "failed") throw new Error("Page failed");
          await blocked;
        }
        return {
          project_id: "p-1",
          filter: "all" as const,
          server_filtered: true,
          cards: options?.ids
            ? [
                { ...firstRow, title: "Changed first card" },
                { ...other, title: "Changed other lane" },
              ]
            : options?.cursor
              ? rows.slice(10)
              : [...rows.slice(0, 10), other],
          counts: { total: 21, needs_me: 0, agent: 0 },
          total_filtered: 21,
          lanes: {
            in_progress: {
              total: 20,
              next_cursor: options?.cursor ? null : "page-two",
            },
            ...(!options?.cursor
              ? { todo: { total: 1, next_cursor: null } }
              : {}),
          },
        };
      },
    );
    const changesSince = vi.fn((applied: number) =>
      applied < 1 ? ["C-1", "C-99"] : [],
    );
    const client = fakeClient({ cards: read });
    const view = render(
      <CardListPage
        client={client}
        projectId="p-1"
        changedCardsSince={changesSince}
      />,
    );
    await screen.findByText(firstRow.title);
    fireEvent.click(screen.getByRole("button", { name: "加载更多进行中卡片" }));
    if (mode === "failed") await screen.findByText("Page failed");
    else await waitFor(() => expect(read.mock.calls).toHaveLength(2));
    view.rerender(
      <CardListPage
        client={client}
        projectId="p-1"
        revision={1}
        changedCardsSince={changesSince}
      />,
    );
    if (mode === "failed")
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {
      release?.();
      await blocked;
    });
    await waitFor(() =>
      expect(document.querySelectorAll(".board-card")).toHaveLength(21),
    );
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await screen.findByText("Changed first card");
    await screen.findByText("Changed other lane");
    expect(document.querySelectorAll(".board-card")).toHaveLength(21);
    expect(read.mock.calls.at(-1)?.[2]).toMatchObject({ ids: "C-1,C-99" });
    expect(read.mock.calls.at(-1)?.[2]?.cursor).toBeUndefined();
    expect(changesSince).toHaveBeenLastCalledWith(0);
    expect(
      screen.queryByRole("button", { name: "加载更多进行中卡片" }),
    ).toBeNull();
  },
);
