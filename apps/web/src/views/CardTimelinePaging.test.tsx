// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CardDetail, CardReadOptions } from "../api.js";
import { selectCardTab } from "../testing/card-tabs.js";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "./CardDetailPage.js";

const observers: {
  root: Element | Document | null | undefined;
  margin: string | undefined;
  target: Element;
  emit: (visible: boolean) => void;
  disconnected: boolean;
}[] = [];
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private observation: (typeof observers)[number] | undefined;
      constructor(
        private callback: IntersectionObserverCallback,
        private options: IntersectionObserverInit,
      ) {}
      observe(target: Element) {
        const observation = {
          root: this.options.root,
          margin: this.options.rootMargin,
          target,
          disconnected: false,
          emit: (visible: boolean) =>
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
        this.observation = observation;
        observers.push(observation);
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
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const live = () => observers.filter((o) => !o.disconnected);
/** Scroll the sentinel into view: every observer still armed sees it. */
const reachBottom = () =>
  act(() => {
    for (const observer of live()) observer.emit(true);
  });
const rows = () =>
  [...document.querySelectorAll(".timeline-entry")].map((row) => row.id);

/** A cursor-paged server over `count` entries, newest first. */
function server(initial: number) {
  let count = initial;
  const entries = () =>
    Array.from({ length: count }, (_, i) =>
      timelineEntry({
        id: `C-1#${count - i}`,
        event_seq: count - i,
        body: `Entry ${count - i}`,
        type: (count - i) % 2 ? "comment" : "review",
      }),
    );
  const page = (options?: CardReadOptions): CardDetail => {
    const all = entries().filter(
      (e) =>
        (!options?.type || e.type === options.type) &&
        (!options?.before || e.event_seq < Number(options.before)),
    );
    const selected = all.slice(0, options?.limit ?? 20);
    return cardDetail({
      timeline: selected,
      timeline_next_cursor:
        all.length > selected.length
          ? String(selected.at(-1)?.event_seq)
          : null,
      counts: { ...cardDetail().counts, timeline: count },
    });
  };
  const card = vi.fn(
    async (_p: string, _c: string, options?: CardReadOptions) => page(options),
  );
  return {
    card,
    page,
    client: fakeClient({ card }),
    add: (n: number) => {
      count += n;
    },
  };
}
const olderCalls = (card: ReturnType<typeof server>["card"]) =>
  card.mock.calls.filter((call) => call[2]?.before);

test("the bottom sentinel loads each older page until the earliest record, then stops", async () => {
  const { client, card } = server(45);
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 45 条");
  expect(live()).toHaveLength(1);
  expect(live()[0]?.root).toBeNull();
  expect(live()[0]?.margin).toBe("0px 0px 200px 0px");
  reachBottom();
  await screen.findByText("已加载 40 / 45 条");
  expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
    limit: 20,
    before: "26",
  });
  reachBottom();
  await screen.findByText("已加载 45 / 45 条");
  expect(rows()).toEqual(
    Array.from({ length: 45 }, (_, i) => `entry-C-1#${45 - i}`),
  );
  expect(screen.getByText("已到最早的记录")).toBeTruthy();
  expect(live()).toHaveLength(0);
  const reads = card.mock.calls.length;
  reachBottom();
  expect(card.mock.calls.length).toBe(reads);
});

test("one older page is requested at a time, however often the sentinel fires", async () => {
  const { client, card, page } = server(60);
  let release: (() => void) | undefined;
  card.mockImplementation(async (_p, _c, options) => {
    if (options?.before)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return page(options);
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 60 条");
  const sentinel = live()[0];
  act(() => {
    sentinel?.emit(true);
    sentinel?.emit(true);
  });
  expect(
    screen
      .getByRole("button", { name: "正在加载更早的记录…" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  reachBottom();
  expect(live()).toHaveLength(0);
  expect(olderCalls(card)).toHaveLength(1);
  // The row stays focusable while loading but a click cannot double up.
  fireEvent.click(screen.getByRole("button", { name: "正在加载更早的记录…" }));
  expect(olderCalls(card)).toHaveLength(1);
  await act(async () => release?.());
  await screen.findByText("已加载 40 / 60 条");
  expect(new Set(rows()).size).toBe(40);
  // Re-armed after the page settles; a still-visible sentinel keeps going.
  expect(live()).toHaveLength(1);
});

test("a page that lands before the loading row renders still re-arms the sentinel", async () => {
  const { client } = server(45);
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 45 条");
  // A browser callback outside React: the instant page and the loading state
  // are batched into one render, so "loading" never shows.
  live()[0]?.emit(true);
  await screen.findByText("已加载 40 / 45 条");
  await waitFor(() => expect(live()).toHaveLength(1));
  live()[0]?.emit(true);
  await screen.findByText("已到最早的记录");
});

test("a failed page shows a retry row at the bottom and does not retry by itself", async () => {
  const { client, card, page } = server(30);
  let fail = true;
  card.mockImplementation(async (_p, _c, options) => {
    if (options?.before && fail) throw new Error("网络中断");
    return page(options);
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 30 条");
  reachBottom();
  const alert = await screen.findByText(/^未能加载更早的记录：/);
  expect(alert.textContent).toContain("网络中断");
  expect(alert.closest("[aria-live=polite]")).toBeTruthy();
  expect(live()).toHaveLength(0);
  reachBottom();
  expect(olderCalls(card)).toHaveLength(1);
  expect(rows()).toHaveLength(20);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("已加载 30 / 30 条");
  expect(olderCalls(card)).toHaveLength(2);
  expect(screen.queryByText(/^未能加载更早的记录/)).toBeNull();
  expect(screen.getByText("已到最早的记录")).toBeTruthy();
});

test("changing a filter drops the page in flight and restarts paging from the filtered head", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  const { client, card, page } = server(80);
  let release: (() => void) | undefined;
  card.mockImplementation(async (_p, _c, options) => {
    if (options?.before && !options.type)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return page(options);
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 80 条");
  reachBottom();
  expect(
    screen
      .getByRole("button", { name: "正在加载更早的记录…" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await selectMenu(/^条目类型：/, "审核");
  await waitFor(() =>
    expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
      limit: 20,
      type: "review",
    }),
  );
  await waitFor(() =>
    expect(rows()).toEqual(
      Array.from({ length: 20 }, (_, i) => `entry-C-1#${80 - 2 * i}`),
    ),
  );
  expect(screen.queryByText("正在加载更早的记录…")).toBeNull();
  // The unfiltered page lands late and is ignored.
  await act(async () => release?.());
  expect(rows()).toHaveLength(20);
  expect(rows().every((id) => Number(id.split("#")[1]) % 2 === 0)).toBe(true);
  reachBottom();
  await waitFor(() => expect(rows()).toHaveLength(40));
  expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
    limit: 20,
    type: "review",
    before: "42",
  });
  expect(screen.getByText("已到最早的记录")).toBeTruthy();
});

test("returning to a filter joins its pending older page instead of requesting it again", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  const { client, card, page } = server(80);
  const held: (() => void)[] = [];
  card.mockImplementation(async (_p, _c, options) => {
    if (options?.before && !options.type)
      await new Promise<void>((resolve) => held.push(resolve));
    return page(options);
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 80 条");
  reachBottom();
  expect(olderCalls(card)).toHaveLength(1);
  await selectMenu(/^条目类型：/, "审核");
  await waitFor(() =>
    expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
      limit: 20,
      type: "review",
    }),
  );
  await selectMenu(/^条目类型：/, "全部");
  await waitFor(() =>
    expect(card).toHaveBeenLastCalledWith("p-1", "C-1", { limit: 20 }),
  );
  await waitFor(() => expect(live()).toHaveLength(1));
  reachBottom();
  // The same page (no filter, before=61) is still pending: joined, not re-sent.
  expect(
    olderCalls(card).filter(
      (call) => !call[2]?.type && call[2]?.before === "61",
    ),
  ).toHaveLength(1);
  expect(held).toHaveLength(1);
  await act(async () => {
    for (const release of held) release();
  });
  await screen.findByText("已加载 40 / 80 条");
  expect(rows()).toEqual(
    Array.from({ length: 40 }, (_, i) => `entry-C-1#${80 - i}`),
  );
});

test("a failed head for a new filter keeps paging off until its retry succeeds", async () => {
  window.location.hash = "#/p/p-1/cards/C-1";
  const { client, card, page } = server(80);
  let failHead = true;
  card.mockImplementation(async (_p, _c, options) => {
    if (options?.type && !options.before && failHead)
      throw new Error("首页失败");
    return page(options);
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 80 条");
  await selectMenu(/^条目类型：/, "审核");
  const retry = await screen.findByRole("button", { name: "重试" });
  // The old snapshot is still shown, but its cursor is not paged.
  expect(screen.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
  expect(live()).toHaveLength(0);
  reachBottom();
  reachBottom();
  expect(olderCalls(card)).toHaveLength(0);
  const observers = live().length;
  expect(observers).toBe(0);
  failHead = false;
  fireEvent.click(retry);
  await waitFor(() =>
    expect(rows()).toEqual(
      Array.from({ length: 20 }, (_, i) => `entry-C-1#${80 - 2 * i}`),
    ),
  );
  await waitFor(() => expect(live()).toHaveLength(1));
  reachBottom();
  await waitFor(() => expect(rows()).toHaveLength(40));
  expect(olderCalls(card).map((call) => call[2])).toEqual([
    { limit: 20, type: "review", before: "42" },
  ]);
});

test("a live refresh during a page load keeps new and older entries without duplicates", async () => {
  const { client, card, page, add } = server(40);
  let release: (() => void) | undefined;
  card.mockImplementation(async (_p, _c, options) => {
    const result = page(options);
    if (options?.before)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return result;
  });
  const view = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 40 条");
  reachBottom();
  add(3);
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  await screen.findByText("已加载 23 / 43 条");
  await act(async () => release?.());
  await screen.findByText("已加载 43 / 43 条");
  expect(rows()).toEqual(
    Array.from({ length: 43 }, (_, i) => `entry-C-1#${43 - i}`),
  );
  expect(screen.getByText("已到最早的记录")).toBeTruthy();
});

test("the drawer observes its own scroll container", async () => {
  const { client } = server(30);
  render(
    <div className="drawer-body" data-testid="drawer">
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" inDrawer />
    </div>,
  );
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 30 条");
  expect(live()[0]?.root).toBe(screen.getByTestId("drawer"));
  reachBottom();
  await screen.findByText("已加载 30 / 30 条");
});

test("an empty timeline shows no pager row", async () => {
  const client = fakeClient({
    card: async () =>
      cardDetail({
        timeline: [],
        timeline_next_cursor: null,
        counts: { ...cardDetail().counts, timeline: 0 },
      }),
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 0 / 0 条");
  expect(screen.queryByText("已到最早的记录")).toBeNull();
  expect(live()).toHaveLength(0);
});
