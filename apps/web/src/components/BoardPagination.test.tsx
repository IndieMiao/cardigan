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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { CardListPage } from "../views/CardListPage.js";

const cards: CardListItem[] = Array.from({ length: 25 }, (_, index) => ({
  ...card,
  id: `C-${index + 1}`,
  title: `卡片 ${index + 1}`,
  priority: index === 4 ? 100 : 0,
  updated_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
  roles: ["coder"],
  next_owners: [{ kind: "role", ref: "coder" }],
  waiting_on: [],
}));
const done = cards.slice(0, 12).map((item, index) => ({
  ...item,
  id: `C-${index + 30}`,
  status: "done" as const,
}));
const client = fakeClient({
  cards: async () => ({
    project_id: "p-1",
    filter: "all",
    cards: [...cards, ...done],
    counts: { total: 37, needs_me: 0, agent: 25 },
  }),
});
const observations: {
  root: Element | Document | null | undefined;
  margin: string | undefined;
  target: Element;
  emit: (visible: boolean) => void;
  disconnected: boolean;
}[] = [];
beforeEach(() => {
  observations.length = 0;
  window.localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private observation: (typeof observations)[number] | undefined;
      constructor(
        private callback: IntersectionObserverCallback,
        private options: IntersectionObserverInit,
      ) {}
      observe(target: Element) {
        this.observation = {
          root: this.options.root,
          margin: this.options.rootMargin,
          target,
          disconnected: false,
          emit: (visible) =>
            this.callback(
              [
                {
                  target,
                  isIntersecting: visible,
                } as IntersectionObserverEntry,
              ],
              this as unknown as IntersectionObserver,
            ),
        };
        observations.push(this.observation);
      }
      disconnect() {
        if (this.observation) this.observation.disconnected = true;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});
async function start() {
  const page = render(<CardListPage client={client} projectId="p-1" />);
  const column = await screen.findByRole("region", { name: "进行中" });
  return { page, column };
}
function links(column: HTMLElement) {
  return within(column)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
}
function observation(label = "进行中") {
  // The lane DOM can appear before its useEffect registers the observer.
  return waitFor(() => {
    const root = screen.getByRole("region", { name: `${label}卡片` });
    const current = observations.findLast(
      (item) => !item.disconnected && item.root === root,
    );
    if (!current) throw new Error(`Missing observer for ${label}`);
    return current;
  });
}

test("each lane starts with the newest 10 cards and its heading shows the full count", async () => {
  const { column } = await start();
  expect(links(column)).toEqual(
    Array.from({ length: 10 }, (_, index) => `#/p/p-1/cards/C-${25 - index}`),
  );
  expect(within(column).getByRole("heading").textContent).toBe("进行中25");
  expect(links(screen.getByRole("region", { name: "已完成" }))).toHaveLength(
    10,
  );
  const root = screen.getByRole("region", { name: "进行中卡片" });
  expect(root.contains(within(column).getByRole("heading"))).toBe(false);
  const current = await observation();
  expect(current.root).toBe(root);
  expect(current.margin).toBe("0px 0px 100px 0px");
  expect(column.querySelector(".board-lane-total")).toBeNull();
});

test("approaching the lane bottom adds one batch, then the remainder and total, without loading other lanes", async () => {
  const { page, column } = await start();
  const first = await observation();
  act(() => first.emit(false));
  expect(links(column)).toHaveLength(10);
  act(() => first.emit(true));
  expect(links(column)).toHaveLength(20);
  expect(first.disconnected).toBe(true);
  act(() => first.emit(true)); // A queued callback from the old observer is ignored.
  expect(links(column)).toHaveLength(20);
  expect(links(screen.getByRole("region", { name: "已完成" }))).toHaveLength(
    10,
  );
  const next = await observation();
  act(() => next.emit(true));
  expect(links(column)).toHaveLength(25);
  expect(within(column).getByText("已显示全部 25 张")).toBeTruthy();
  expect(within(column).queryByRole("button", { name: /加载更多/ })).toBeNull();
  expect(within(column).getByRole("heading").textContent).toBe("进行中25");
  page.unmount();
  expect(observations.every((item) => item.disconnected)).toBe(true);
});

test.each([
  ["q", "卡片"],
  ["status", "in_progress"],
  ["role", "coder"],
  ["next", "agent"],
  ["overview", "progress"],
  ["sort", "id"],
  ["sort", "priority"],
])(
  "changing %s=%s resets batches and scrolling even when the matched lane stays the same",
  async (key, value) => {
    const { column } = await start();
    const first = await observation();
    act(() => first.emit(true));
    expect(links(column)).toHaveLength(20);
    const old = await observation();
    const oldRoot = screen.getByRole("region", { name: "进行中卡片" });
    oldRoot.scrollTop = 500;
    act(() => {
      window.location.hash = `#/p/p-1/cards?view=board&${key}=${encodeURIComponent(value)}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(links(column)).toHaveLength(10));
    expect(screen.getByRole("region", { name: "进行中卡片" }).scrollTop).toBe(
      0,
    );
    expect(oldRoot.isConnected).toBe(false);
    expect(old.disconnected).toBe(true);
    const firstId = value === "id" ? 1 : value === "priority" ? 5 : 25;
    expect(links(column)[0]).toBe(`#/p/p-1/cards/C-${firstId}`);
    act(() => old.emit(true));
    expect(links(column)).toHaveLength(10);
    const current = await observation();
    expect(current.target).toBe(
      within(column).getByRole("button", { name: "加载更多进行中卡片" }),
    );
    act(() => current.emit(true));
    expect(links(column)).toHaveLength(20);
  },
);

test("narrowing the search updates total counts, and clearing it restarts at 10", async () => {
  const { column } = await start();
  const first = await observation();
  act(() => first.emit(true));
  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "C-2" },
  });
  await waitFor(() => expect(links(column)).toHaveLength(7));
  expect(within(column).getByRole("heading").textContent).toBe("进行中7");
  expect(within(column).getByText("已显示全部 7 张")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
    target: { value: "" },
  });
  await waitFor(() => expect(links(column)).toHaveLength(10));
});

test("live refresh and unrelated route changes keep loaded cards and the scroll root", async () => {
  const { page, column } = await start();
  const first = await observation();
  act(() => first.emit(true));
  const root = screen.getByRole("region", { name: "进行中卡片" });
  root.scrollTop = 300;
  page.rerender(<CardListPage client={client} projectId="p-1" revision={1} />);
  act(() => {
    window.location.hash = "#/p/p-1/cards?view=board&expanded=backlog";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await screen.findByRole("button", { name: "收起待整理空列" });
  expect(links(column)).toHaveLength(20);
  expect(screen.getByRole("region", { name: "进行中卡片" })).toBe(root);
  expect(root.scrollTop).toBe(300);
});

test("the load-more button also works without IntersectionObserver", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const { column } = await start();
  fireEvent.click(
    within(column).getByRole("button", { name: "加载更多进行中卡片" }),
  );
  expect(links(column)).toHaveLength(20);
  fireEvent.click(
    within(column).getByRole("button", { name: "加载更多进行中卡片" }),
  );
  expect(within(column).getByText("已显示全部 25 张")).toBeTruthy();
});
