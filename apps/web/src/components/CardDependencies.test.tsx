// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { routeHash } from "../route.js";
import { card, fakeClient, NOW } from "../testing/fixtures.js";
import { CardDependencies } from "./CardDependencies.js";

const client = fakeClient();

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
test("dependency links retain full titles, textual terminal states and distinguish early completion waits", () => {
  render(
    <CardDependencies
      projectId="p-1"
      client={client}
      card={{
        ...card,
        early_start: {
          reason: "Parallel",
          set_by: "human",
          set_at: "2026-01-01",
        },
        dependency: {
          predecessors: [
            { id: "C-2", title: "已完成前置", status: "done", satisfied: true },
            {
              id: "C-3333333333",
              title: "长标题".repeat(50),
              status: "cancelled",
              resolution: "superseded",
              satisfied: false,
            },
          ],
          successors: [
            { id: "C-4", title: "后续", status: "backlog", satisfied: false },
          ],
          waiting_on: ["C-3333333333"],
          critical_path_length: 2,
        },
      }}
    />,
  );
  const region = screen.getByRole("region", { name: "卡片依赖" });
  expect(
    within(region).getByText("提前开工 · 完成仍等 C-3333333333"),
  ).toBeDefined();
  expect(within(region).getByText("最长未完成链：2 张")).toBeDefined();
  expect(within(region).getByText("已取代")).toBeDefined();
  expect(within(region).getByText("已完成")).toBeDefined();
  // Nodes open a popover in place; none of them is a link away.
  expect(within(region).queryAllByRole("link")).toHaveLength(0);
  const nodes = within(region).getAllByRole("button");
  expect(nodes).toHaveLength(3);
  expect(nodes[0]?.textContent).toContain("C-2");
  expect(nodes[1]?.textContent).toContain("长标题".repeat(50));
  nodes[2]?.focus();
  expect(document.activeElement).toBe(nodes[2]);
  // The node keeps its 标题 · 状态 hint; no native “卡片” title on top.
  expect(region.querySelectorAll("[data-node] [title]")).toHaveLength(0);
  // The open card is the highlighted node, not a link to itself.
  const current = region.querySelector('[aria-current="page"]');
  expect(current?.textContent).toContain(card.id);
  expect(current?.closest("a")).toBeNull();
  expect(region.querySelectorAll("[data-edge]")).toHaveLength(3);
});

test("no dependency has no new empty section", () => {
  render(<CardDependencies projectId="p-1" client={client} card={card} />);
  expect(screen.queryByRole("region", { name: "卡片依赖" })).toBeNull();
});

test("the detail graph shows the whole chain and marks 待核", () => {
  render(
    <CardDependencies
      projectId="p-1"
      client={client}
      card={{
        ...card,
        dependency: {
          predecessors: [
            { id: "C-2", title: "直接前置", status: "done", satisfied: false },
          ],
          successors: [
            { id: "C-4", title: "直接后续", status: "todo", satisfied: false },
          ],
          waiting_on: ["C-2"],
          critical_path_length: 3,
          graph: {
            nodes: [
              { id: "C-0", title: "源头", status: "done", satisfied: true },
              {
                id: "C-2",
                title: "直接前置",
                status: "done",
                satisfied: false,
              },
              { ...card, satisfied: false },
              {
                id: "C-4",
                title: "直接后续",
                status: "todo",
                satisfied: false,
              },
              { id: "C-5", title: "末端", status: "backlog", satisfied: false },
            ],
            edges: [
              { from: "C-0", to: "C-2" },
              { from: "C-2", to: card.id },
              { from: card.id, to: "C-4" },
              { from: "C-4", to: "C-5" },
            ],
          },
        },
      }}
    />,
  );
  const region = screen.getByRole("region", { name: "卡片依赖" });
  expect(within(region).getByText("等 C-2")).toBeDefined();
  expect(within(region).getByText("最长未完成链：3 张")).toBeDefined();
  const graph = within(region).getByRole("list", { name: "依赖关系图" });
  expect(within(graph).getAllByRole("listitem")).toHaveLength(5);
  expect(within(graph).getByText("已完成（待核）")).toBeDefined();
  expect(
    [...region.querySelectorAll("[data-edge]")].map((edge) =>
      edge.getAttribute("data-edge"),
    ),
  ).toEqual(["C-0>C-2", "C-2>C-1", "C-1>C-4", "C-4>C-5"]);
});

test("a shortcut edge runs through its own waypoint and every node reads out its direct links", () => {
  render(
    <CardDependencies
      projectId="p-1"
      client={client}
      card={{
        ...card,
        dependency: {
          predecessors: [
            { id: "C-2", title: "中间", status: "todo", satisfied: false },
          ],
          successors: [],
          waiting_on: ["C-2"],
          critical_path_length: 2,
          graph: {
            nodes: [
              { id: "C-0", title: "源头", status: "todo", satisfied: false },
              { id: "C-2", title: "中间", status: "todo", satisfied: false },
              { ...card, satisfied: false },
            ],
            edges: [
              { from: "C-0", to: "C-2" },
              { from: "C-2", to: card.id },
              { from: "C-0", to: card.id },
            ],
          },
        },
      }}
    />,
  );
  const region = screen.getByRole("region", { name: "卡片依赖" });
  const graph = within(region).getByRole("list", { name: "依赖关系图" });
  // The waypoint is an empty, hidden cell: not a node a reader meets.
  expect(within(graph).getAllByRole("listitem")).toHaveLength(3);
  const waypoints = region.querySelectorAll("[data-waypoint]");
  expect(waypoints).toHaveLength(1);
  expect(waypoints[0]?.getAttribute("aria-hidden")).toBe("true");
  expect(waypoints[0]?.textContent).toBe("");
  expect(region.querySelectorAll("[data-edge]")).toHaveLength(3);
  const description = (element: Element | null | undefined) =>
    document.getElementById(element?.getAttribute("aria-describedby") ?? "")
      ?.textContent;
  expect(description(within(graph).getByRole("button", { name: /C-0/ }))).toBe(
    `后续 C-2、${card.id}`,
  );
  expect(description(within(graph).getByRole("button", { name: /C-2/ }))).toBe(
    `前置 C-0；后续 ${card.id}`,
  );
  expect(description(region.querySelector('[aria-current="page"]'))).toBe(
    "前置 C-2、C-0",
  );
});

const chain = {
  ...card,
  dependency: {
    predecessors: [
      { id: "C-2", title: "上游", status: "todo", satisfied: false },
    ],
    successors: [
      { id: "C-4", title: "下游", status: "todo", satisfied: false },
    ],
    waiting_on: ["C-2"],
    critical_path_length: 3,
    graph: {
      nodes: [
        { id: "C-0", title: "源头", status: "done", satisfied: true },
        { id: "C-2", title: "上游", status: "todo", satisfied: false },
        { ...card, satisfied: false },
        { id: "C-4", title: "下游", status: "todo", satisfied: false },
        {
          id: "C-5",
          title: `末端${"很长的标题".repeat(20)}`,
          status: "backlog",
          satisfied: false,
        },
      ],
      edges: [
        { from: "C-0", to: "C-2" },
        { from: "C-2", to: card.id },
        { from: card.id, to: "C-4" },
        { from: "C-4", to: "C-5" },
      ],
    },
  },
};

const summary = (id: string, extra: Partial<CardListItem> = {}) => ({
  ...card,
  id,
  title: `${id} 的标题`,
  priority: 3,
  updated_at: NOW,
  next_owners: [
    {
      kind: "assignment" as const,
      ref: "A-7",
      employee: {
        id: "E-7",
        name: "林黛玉",
        title: "后端工程师",
        avatar: null,
      },
    },
  ],
  produce_owners: [],
  work_items: [
    { id: "W-1", title: "后端开发", status: "in_progress" },
    { id: "W-2", title: "代码审核", status: "todo" },
    { id: "W-3", title: "旧验收", status: "passed" },
  ],
  ...extra,
});

function renderChain(cards = vi.fn(), graphCard: typeof card = chain) {
  cards.mockImplementation(
    async (_project: string, filter: string, options: { ids: string }) => ({
      project_id: "p-1",
      filter,
      cards: [summary(options.ids)],
      counts: { total: 1, needs_me: 0, agent: 0 },
    }),
  );
  render(
    <CardDependencies
      projectId="p-1"
      client={fakeClient({ cards })}
      card={graphCard}
    />,
  );
  const graph = screen.getByRole("list", { name: "依赖关系图" });
  const node = (id: string) =>
    within(graph).getByRole("button", { name: new RegExp(`^${id}(?!\\d)`) });
  return { cards, graph, node };
}

test("clicking a node opens its facts in place instead of navigating", async () => {
  const { cards, node } = renderChain();
  window.location.hash = "#/p/p-1/cards/C-1";
  fireEvent.click(node("C-5"));
  const peek = await screen.findByRole("dialog", { name: "卡片 C-5" });
  expect(window.location.hash).toBe("#/p/p-1/cards/C-1");
  expect(cards).toHaveBeenCalledWith(
    "p-1",
    "all",
    { ids: "C-5" },
    expect.any(AbortSignal),
  );
  expect(within(peek).getByText("待整理")).toBeDefined();
  expect(within(peek).getByText("间接后续")).toBeDefined();
  expect(await within(peek).findByText("C-5 的标题")).toBeDefined();
  expect(within(peek).getByText("高")).toBeDefined();
  expect(within(peek).getByText("林黛玉")).toBeDefined();
  // Only work under way: not the one waiting to start or the passed one.
  expect(within(peek).getByText("后端开发")).toBeDefined();
  expect(within(peek).queryByText("代码审核")).toBeNull();
  expect(within(peek).queryByText("旧验收")).toBeNull();
  expect(within(peek).getByText("更新于")).toBeDefined();
  expect(node("C-5").getAttribute("aria-expanded")).toBe("true");
});

test("relations say which prerequisites still block the open card", async () => {
  const { node } = renderChain();
  fireEvent.click(node("C-2"));
  expect(
    within(await screen.findByRole("dialog", { name: "卡片 C-2" })).getByText(
      "直接前置，仍挡着当前卡",
    ),
  ).toBeDefined();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(node("C-0"));
  expect(
    within(await screen.findByRole("dialog", { name: "卡片 C-0" })).getByText(
      "间接前置，已不挡",
    ),
  ).toBeDefined();
});

test("an unmet chain keeps blocking even through a cancelled card", async () => {
  // C-3 was cancelled, which never meets a dependency: C-2 still waits on it
  // and the open card still waits on C-2. C-8 is behind a met card.
  const blocked = {
    ...card,
    dependency: {
      predecessors: [
        { id: "C-2", title: "上游", status: "todo", satisfied: false },
        { id: "C-9", title: "已完成", status: "done", satisfied: true },
      ],
      successors: [],
      waiting_on: ["C-2"],
      critical_path_length: 3,
      graph: {
        nodes: [
          { id: "C-3", title: "已取消", status: "cancelled", satisfied: false },
          { id: "C-2", title: "上游", status: "todo", satisfied: false },
          { id: "C-8", title: "旁支", status: "todo", satisfied: false },
          { id: "C-9", title: "已完成", status: "done", satisfied: true },
          { ...card, satisfied: false },
        ],
        edges: [
          { from: "C-3", to: "C-2" },
          { from: "C-2", to: card.id },
          { from: "C-8", to: "C-9" },
          { from: "C-9", to: card.id },
        ],
      },
    },
  };
  const { node } = renderChain(vi.fn(), blocked);
  const relation = async (id: string) => {
    fireEvent.click(node(id));
    const peek = await screen.findByRole("dialog", { name: `卡片 ${id}` });
    const text = within(peek).getByText(/前置/).textContent;
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return text;
  };
  expect(await relation("C-3")).toBe("间接前置，仍挡着当前卡");
  expect(await relation("C-2")).toBe("直接前置，仍挡着当前卡");
  expect(await relation("C-8")).toBe("间接前置，已不挡");
  expect(await relation("C-9")).toBe("直接前置，已不挡");
});

test("the owner is whoever handles the card now, not only its producer", async () => {
  const cards = vi.fn();
  const { node } = renderChain(cards);
  // Under review: the producer has delivered, a reviewer holds it.
  cards.mockResolvedValue({
    project_id: "p-1",
    filter: "all",
    cards: [
      summary("C-4", {
        status: "review",
        produce_owners: [
          {
            employee: {
              id: "E-14",
              name: "薛宝钗",
              title: "前端工程师",
              avatar: null,
            },
          },
        ],
        next_owners: [
          {
            kind: "assignment",
            ref: "A-9",
            employee: {
              id: "E-3",
              name: "妙玉",
              title: "代码审核",
              avatar: null,
            },
          },
        ],
        work_items: [{ id: "W-2", title: "代码审核", status: "in_progress" }],
      }),
    ],
    counts: { total: 1, needs_me: 0, agent: 0 },
  });
  fireEvent.click(node("C-4"));
  const peek = await screen.findByRole("dialog", { name: "卡片 C-4" });
  expect(await within(peek).findByText("妙玉")).toBeDefined();
  expect(within(peek).queryByText("薛宝钗")).toBeNull();
  expect(within(peek).queryByText("无人负责")).toBeNull();
});

test("no owner reads 无人负责 and nothing under way reads 无进行中", async () => {
  const cards = vi.fn();
  const { node } = renderChain(cards);
  cards.mockResolvedValue({
    project_id: "p-1",
    filter: "all",
    cards: [summary("C-4", { next_owners: [], work_items: [] })],
    counts: { total: 1, needs_me: 0, agent: 0 },
  });
  fireEvent.click(node("C-4"));
  const peek = await screen.findByRole("dialog", { name: "卡片 C-4" });
  expect(await within(peek).findByText("无人负责")).toBeDefined();
  expect(within(peek).getByText("无进行中")).toBeDefined();
  expect(within(peek).getByText("直接后续")).toBeDefined();
});

test("Escape closes the popover and only one is open at a time", async () => {
  const { node } = renderChain();
  fireEvent.click(node("C-4"));
  await screen.findByRole("dialog", { name: "卡片 C-4" });
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(node("C-4"));
  fireEvent.click(node("C-4"));
  await screen.findByRole("dialog", { name: "卡片 C-4" });
  // Radix starts listening for outside presses a tick after opening. A touch
  // press dismisses on the click after the new node opened; keep the new one.
  await new Promise((resolve) => setTimeout(resolve, 10));
  fireEvent.pointerDown(node("C-5"), { button: 0, pointerType: "touch" });
  fireEvent.click(node("C-5"));
  await screen.findByRole("dialog", { name: "卡片 C-5" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("clicking another node while one is open moves to it and stays", async () => {
  const { node } = renderChain();
  fireEvent.click(node("C-4"));
  await screen.findByRole("dialog", { name: "卡片 C-4" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A mouse press defers the outside dismiss to its click. In a browser the
  // new node opens and closes the old one before that; the old one's focus
  // return must not pull focus back (see CardPeekLayout.test.tsx).
  pointer(node("C-5"), "pointerdown");
  node("C-5").focus();
  pointer(window, "pointerup", { buttons: 0 });
  fireEvent.click(node("C-5"), { detail: 1 });
  const peek = await screen.findByRole("dialog", { name: "卡片 C-5" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getAllByRole("dialog")).toEqual([peek]);
  expect(peek.contains(document.activeElement)).toBe(true);
  expect(node("C-4").getAttribute("aria-expanded")).toBe("false");
});

test("an outside press closes the popover", async () => {
  const { node } = renderChain();
  fireEvent.click(node("C-4"));
  await screen.findByRole("dialog", { name: "卡片 C-4" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
  fireEvent.click(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("only 打开卡片 navigates, and it closes the popover", async () => {
  const { node } = renderChain();
  fireEvent.click(node("C-5"));
  const peek = await screen.findByRole("dialog", { name: "卡片 C-5" });
  const open = within(peek).getByRole("link", { name: "打开卡片" });
  expect(open.getAttribute("href")).toBe(
    routeHash({ kind: "card", projectId: "p-1", cardId: "C-5" }),
  );
  fireEvent.click(open);
  await waitFor(() =>
    expect(window.location.hash).toBe(
      routeHash({ kind: "card", projectId: "p-1", cardId: "C-5" }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a failed read keeps the known facts and offers a retry", async () => {
  const cards = vi.fn();
  const { node } = renderChain(cards);
  cards.mockRejectedValueOnce(new Error("网络断开"));
  fireEvent.click(node("C-4"));
  const peek = await screen.findByRole("dialog", { name: "卡片 C-4" });
  expect((await within(peek).findByRole("alert")).textContent).toContain(
    "网络断开",
  );
  expect(within(peek).getByText("直接后续")).toBeDefined();
  fireEvent.click(within(peek).getByRole("button", { name: "重试" }));
  expect(await within(peek).findByText("林黛玉")).toBeDefined();
  expect(cards).toHaveBeenCalledTimes(2);
});

function pointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { pointerType?: string } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 20,
    ...init,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
    isPrimary: { value: true },
  });
  fireEvent(target, event);
  return event;
}

function wide(graph: HTMLElement) {
  const scroller = graph.parentElement?.parentElement as HTMLElement;
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 120 },
    scrollHeight: { configurable: true, value: 120 },
  });
  scroller.scrollLeft = 400;
  const captured = new Set<number>();
  scroller.setPointerCapture = vi.fn((id: number) => captured.add(id));
  scroller.hasPointerCapture = (id: number) => captured.has(id);
  scroller.releasePointerCapture = vi.fn((id: number) => captured.delete(id));
  return scroller;
}

test("dragging a node pans the view and does not open it", async () => {
  const { graph, node, cards } = renderChain();
  const scroller = wide(graph);
  pointer(node("C-4"), "pointerdown");
  pointer(window, "pointermove", { clientX: 103, clientY: 21 });
  expect(scroller.scrollLeft).toBe(400);
  const move = pointer(window, "pointermove", { clientX: 160 });
  expect(move.defaultPrevented).toBe(true);
  expect(scroller.scrollLeft).toBe(340);
  pointer(window, "pointerup", { buttons: 0, clientX: 160 });
  fireEvent.click(node("C-4"), { detail: 1 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(cards).not.toHaveBeenCalled();
  // The next plain click opens it again.
  pointer(node("C-4"), "pointerdown");
  pointer(window, "pointerup", { buttons: 0 });
  fireEvent.click(node("C-4"), { detail: 1 });
  expect(await screen.findByRole("dialog", { name: "卡片 C-4" })).toBeDefined();
});

test("a press within 4px still opens the node; empty space drags too", async () => {
  const { graph, node } = renderChain();
  const scroller = wide(graph);
  pointer(graph, "pointerdown");
  pointer(window, "pointermove", { clientX: 40 });
  expect(scroller.scrollLeft).toBe(460);
  pointer(window, "pointerup", { buttons: 0, clientX: 40 });
  pointer(node("C-2"), "pointerdown");
  pointer(window, "pointermove", { clientX: 102, clientY: 23 });
  pointer(window, "pointerup", { buttons: 0, clientX: 102, clientY: 23 });
  fireEvent.click(node("C-2"), { detail: 1 });
  expect(await screen.findByRole("dialog", { name: "卡片 C-2" })).toBeDefined();
  expect(scroller.scrollLeft).toBe(460);
});

test("a drag in a graph that fits does not count as a click", async () => {
  const { graph, node, cards } = renderChain();
  // No overflow on either axis: nothing to pan, but still a drag.
  const scroller = wide(graph);
  Object.defineProperty(scroller, "scrollWidth", {
    configurable: true,
    value: 300,
  });
  scroller.scrollLeft = 0;
  pointer(node("C-4"), "pointerdown");
  const move = pointer(window, "pointermove", { clientX: 120 });
  expect(move.defaultPrevented).toBe(true);
  expect(scroller.scrollLeft).toBe(0);
  pointer(window, "pointerup", { buttons: 0, clientX: 120 });
  fireEvent.click(node("C-4"), { detail: 1 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(cards).not.toHaveBeenCalled();
  pointer(node("C-4"), "pointerdown");
  pointer(window, "pointerup", { buttons: 0 });
  fireEvent.click(node("C-4"), { detail: 1 });
  expect(await screen.findByRole("dialog", { name: "卡片 C-4" })).toBeDefined();
});

test("a graph taller than its view pans vertically by drag and keys", () => {
  const { graph, node } = renderChain();
  const scroller = wide(graph);
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: 1200 },
    scrollHeight: { configurable: true, value: 600 },
  });
  scroller.scrollLeft = 0;
  scroller.scrollTop = 100;
  pointer(node("C-4"), "pointerdown");
  pointer(window, "pointermove", { clientY: 80 });
  expect(scroller.scrollTop).toBe(40);
  expect(scroller.scrollLeft).toBe(0);
  pointer(window, "pointerup", { buttons: 0, clientY: 80 });
  fireEvent.keyDown(node("C-4"), { key: "ArrowDown" });
  expect(scroller.scrollTop).toBe(80);
  fireEvent.keyDown(node("C-4"), { key: "ArrowUp" });
  fireEvent.keyDown(node("C-4"), { key: "ArrowUp" });
  expect(scroller.scrollTop).toBe(0);
  expect(fireEvent.keyDown(node("C-4"), { key: "ArrowUp" })).toBe(true);
});

test("touch keeps native scrolling and arrow keys pan from a focused node", () => {
  const { graph, node } = renderChain();
  const scroller = wide(graph);
  pointer(node("C-4"), "pointerdown", { pointerType: "touch" });
  const touch = pointer(window, "pointermove", {
    clientX: 200,
    pointerType: "touch",
  });
  expect(touch.defaultPrevented).toBe(false);
  expect(scroller.scrollLeft).toBe(400);
  node("C-4").focus();
  fireEvent.keyDown(node("C-4"), { key: "ArrowRight" });
  expect(scroller.scrollLeft).toBe(440);
  fireEvent.keyDown(node("C-4"), { key: "ArrowLeft" });
  fireEvent.keyDown(node("C-4"), { key: "ArrowLeft" });
  expect(scroller.scrollLeft).toBe(360);
  // At the edge the key falls through to the page.
  scroller.scrollLeft = 0;
  expect(fireEvent.keyDown(node("C-4"), { key: "ArrowLeft" })).toBe(true);
  // Vertical keys only pan a graph taller than its view.
  expect(fireEvent.keyDown(node("C-4"), { key: "ArrowDown" })).toBe(true);
});
