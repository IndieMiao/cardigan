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
import { App } from "../App.js";
import { type CardReadOptions, HttpCardiganClient } from "../api.js";
import { selectCardTab } from "../testing/card-tabs.js";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function history() {
  const base = cardDetail(),
    entries = Array.from({ length: 65 }, (_, n) =>
      timelineEntry({
        id: `C-1#${n + 1}`,
        event_seq: n + 1,
        body: `Original comment ${n + 1}`,
      }),
    ).reverse();
  const card = vi.fn(
    async (_p: string, _c: string, options?: CardReadOptions) => ({
      ...base,
      attachments: [],
      timeline: entries.slice(
        0,
        Math.max(
          options?.limit ?? 200,
          options?.at
            ? entries.findIndex((e) => `entry-${e.id}` === options.at) + 1
            : 0,
        ),
      ),
      counts: { ...base.counts, timeline: 65 },
    }),
  );
  return { client: fakeClient({ card }), card };
}
test("U3 starts with 20 page-flow records, loads older records and keeps the comment draft", async () => {
  const { client, card } = history();
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await screen.findByText("Original comment 65");
  expect(document.querySelectorAll(".timeline-entry")).toHaveLength(20);
  expect(document.querySelector(".timeline-entry")?.id).toBe("entry-C-1#65");
  expect(screen.getByText("已加载 20 / 65 条")).toBeTruthy();
  expect(card).toHaveBeenLastCalledWith("p-1", "C-1", { limit: 20 });
  expect(document.querySelector(".timeline-scroll")).toBeNull();
  const input = screen.getByRole("textbox", { name: /评论|内容/ });
  fireEvent.change(input, { target: { value: "Keep my draft" } });
  await selectCardTab(/^时间线/);
  fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
  await waitFor(() =>
    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(40),
  );
  expect((input as HTMLTextAreaElement).value).toBe("Keep my draft");
  expect(
    [...document.querySelectorAll(".timeline-entry")].map((row) => row.id),
  ).toEqual(Array.from({ length: 40 }, (_, n) => `entry-C-1#${65 - n}`));
  expect(screen.getByText("已加载 40 / 65 条")).toBeTruthy();
});

test("U3 history size survives route changes and remounting", async () => {
  const { client } = history();
  const page = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await selectCardTab(/^时间线/);
  await screen.findByText("Original comment 65");
  await selectMenu(/^每次加载：/, "50 条");
  await waitFor(() =>
    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(50),
  );
  expect(window.location.hash).toContain("count=50");
  page.unmount();
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await screen.findByText("Original comment 16");
  expect(document.querySelectorAll(".timeline-entry")).toHaveLength(50);
});
test("U3 a copied old anchor loads its record automatically before scrolling the row", async () => {
  window.location.hash = "#/p/p-1/cards/C-1?at=entry-C-1%231";
  const { client, card } = history(),
    scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(<App client={client} />);
    await screen.findByText("Original comment 1");
    expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
      limit: 20,
      at: "entry-C-1#1",
    });
    await waitFor(() =>
      expect(scroll.mock.contexts.at(-1)).toBe(
        document.getElementById("entry-C-1#1"),
      ),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test.each(
  [false, true].flatMap((inDrawer) => [
    {
      inDrawer,
      anchor: "decision-Q-1",
      request: { type: "decision_request", decision_id: "Q-1" },
      result: { type: "decision_resolved", decision_id: "Q-1" },
    },
    {
      inDrawer,
      anchor: "human-action-H-1",
      request: { type: "human_action", human_action_id: "H-1" },
      result: { type: "human_action", human_action_id: "H-1" },
    },
  ]),
)(
  "$anchor loads and locates its original request despite newer results and filters (drawer=$inDrawer)",
  async ({ inDrawer, anchor, request, result }) => {
    window.location.hash = "#/p/p-1/cards/C-1?type=comment&author=human";
    const entries = [
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        body: "Original request",
        ...request,
      }),
      ...Array.from({ length: 21 }, (_, n) =>
        timelineEntry({
          id: `C-1#${n + 2}`,
          event_seq: n + 2,
          author: "human",
          body: `Comment ${n + 2}`,
        }),
      ),
      timelineEntry({
        id: "C-1#23",
        event_seq: 23,
        body: "Later result",
        ...result,
      }),
    ].reverse();
    const card = vi.fn(
      async (_project: string, _card: string, options?: CardReadOptions) =>
        cardDetail({
          // The server extends an entity anchor's read window through its earliest
          // event, even when a completion/result is already in the latest page.
          timeline: entries.slice(
            0,
            options?.at === anchor ? entries.length : (options?.limit ?? 20),
          ),
          counts: { ...cardDetail().counts, timeline: entries.length },
        }),
    );
    const props = {
      client: fakeClient({ card }),
      projectId: "p-1",
      cardId: "C-1",
      inDrawer,
    };
    const scroll = vi.fn(),
      original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const view = render(<CardDetailPage {...props} />);
      await screen.findByText("已加载 20 / 23 条");
      expect(screen.queryByText("Original request")).toBeNull();
      view.rerender(<CardDetailPage {...props} anchor={anchor} />);
      await screen.findByText("Original request");
      expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
        limit: 20,
        at: anchor,
        type: "comment",
        author: "human",
      });
      await waitFor(() =>
        expect(scroll.mock.contexts.at(-1)).toBe(
          document.getElementById("entry-C-1#1"),
        ),
      );
      expect(
        document.getElementById(anchor)?.closest(".timeline-entry")?.id,
      ).toBe("entry-C-1#1");
      expect(document.querySelectorAll(`[id="${anchor}"]`)).toHaveLength(1);
      const rows = [...document.querySelectorAll(".timeline-entry")];
      expect(rows[0]?.id).toBe("entry-C-1#23");
      expect(rows.at(-1)?.id).toBe("entry-C-1#1");
      // An explicit entry link still targets the later result, not its request.
      view.rerender(<CardDetailPage {...props} anchor="entry-C-1#23" />);
      await waitFor(() =>
        expect(scroll.mock.contexts.at(-1)).toBe(
          document.getElementById("entry-C-1#23"),
        ),
      );
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  },
);

test.each([false, true])(
  "posting locates the returned comment above older records despite filters and a previous anchor (drawer=%s)",
  async (inDrawer) => {
    window.location.hash = "#/p/p-1/cards/C-1?type=review&at=entry-C-1%231";
    const entries = [
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        type: "review",
        body: "Old review",
      }),
    ];
    const card = vi.fn(
      async (_project: string, _card: string, _options?: CardReadOptions) =>
        cardDetail({
          timeline: [...entries],
          counts: {
            open_decisions: 0,
            deliveries: 1,
            reviews: 0,
            timeline: entries.length,
          },
        }),
    );
    const client = fakeClient({
      card,
      addComment: async (_project, _card, input) => {
        const posted = timelineEntry({
          id: "C-1#66",
          event_seq: 66,
          author: "human",
          body: input.body,
        });
        // Another event may arrive while refreshing; locate the returned ID, not simply the first row.
        entries.push(
          posted,
          timelineEntry({
            id: "C-1#67",
            event_seq: 67,
            type: "review",
            body: "Concurrent review",
          }),
        );
        return posted;
      },
    });
    const scroll = vi.fn(),
      original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const props = {
        client,
        projectId: "p-1",
        cardId: "C-1",
        inDrawer,
        anchor: "entry-C-1#1",
      };
      const view = render(
        <div className={inDrawer ? "drawer-body" : undefined}>
          <CardDetailPage {...props} />
        </div>,
      );
      await screen.findByText("Old review");
      const input = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Posted comment" } });
      fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
      await screen.findByText("Posted comment");
      await waitFor(() =>
        expect(scroll.mock.contexts.at(-1)).toBe(
          document.getElementById("entry-C-1#66"),
        ),
      );
      expect(card).toHaveBeenLastCalledWith("p-1", "C-1", {
        limit: 20,
        at: "entry-C-1#66",
        type: "review",
      });
      const rows = [...document.querySelectorAll(".timeline-entry")];
      expect(rows.map((row) => row.id)).toEqual([
        "entry-C-1#67",
        "entry-C-1#66",
        "entry-C-1#1",
      ]);
      const box = screen.getByRole("region", { name: "写评论" });
      expect(
        screen
          .getByRole("group", { name: "时间线筛选与加载" })
          .compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        box.compareDocumentPosition(rows[0] as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(input.value).toBe("");
      expect(input.rows).toBe(2);
      expect(screen.getByText("已加载 3 / 3 条")).toBeTruthy();
      if (!inDrawer)
        expect(window.location.hash).toContain("at=entry-C-1%2366");
      scroll.mockClear();
      const reads = card.mock.calls.length;
      view.rerender(
        <div className={inDrawer ? "drawer-body" : undefined}>
          <CardDetailPage {...props} revision={1} />
        </div>,
      );
      await waitFor(() =>
        expect(card.mock.calls.length).toBeGreaterThan(reads),
      );
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  },
);
test("U3 merge confirmation uses Chinese question and option labels and work-item markers have their own column", async () => {
  const base = cardDetail();
  render(
    <CardDetailPage
      projectId="p-1"
      cardId="C-1"
      client={fakeClient({
        card: async () => ({
          ...base,
          decisions: [
            {
              id: "Q-1",
              trigger: "merge_confirmation",
              question: "Merge C-1 into main?",
              status: "resolved",
              blocking: true,
              decider: "human",
              recommended: "merge",
              options: [
                { key: "merge", description: "Merge", impact: "Approved" },
              ],
            },
          ],
          timeline: [
            timelineEntry({
              type: "decision_resolved",
              decision_id: "Q-1",
              decision_option: "merge",
              body: "User quote",
            }),
          ],
        }),
      })}
    />,
  );
  await screen.findByText("确认把 C-1 合并到 main？");
  await selectCardTab(/^时间线/);
  expect(
    screen.getByRole("heading", { name: "Q-1 拍板 确认合并" }),
  ).toBeTruthy();
  await selectCardTab(/^工作项/);
  const item = within(screen.getByRole("region", { name: "工作项" }))
    .getByText("写迁移脚本")
    .closest("summary");
  expect(item?.querySelector(".work-item-caption .id-tag")).toBeTruthy();
});
test("U3 card client encodes history limits and anchors in its read URL", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  await new HttpCardiganClient(fetcher).card("p/a", "C-1", {
    limit: 40,
    at: "entry-C-1#98",
  });
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "/api/projects/p%2Fa/cards/C-1?limit=40&at=entry-C-1%2398",
  );
  expect(init?.method).toBe("GET");
});

test("cursor timeline appends a bounded page and live refresh keeps older entries", async () => {
  const entries = Array.from({ length: 40 }, (_, i) =>
    timelineEntry({
      id: `C-1#${40 - i}`,
      event_seq: 40 - i,
      body: `Cursor comment ${40 - i}`,
    }),
  );
  const read = vi.fn(
    async (_project: string, _card: string, options?: CardReadOptions) =>
      cardDetail({
        timeline: options?.before ? entries.slice(20) : entries.slice(0, 20),
        timeline_next_cursor: options?.before ? null : "older-page",
        counts: { ...cardDetail().counts, timeline: 40 },
      }),
  );
  const client = fakeClient({ card: read });
  const view = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await screen.findByText("已加载 20 / 40 条");
  await selectCardTab(/^时间线/);
  fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
  await screen.findByText("已加载 40 / 40 条");
  expect(read).toHaveBeenLastCalledWith("p-1", "C-1", {
    limit: 20,
    before: "older-page",
  });
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith("p-1", "C-1", { limit: 20 }),
  );
  expect(screen.getByText("已加载 40 / 40 条")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
});

test.each([10, 40])(
  "refresh across a full page keeps every entry reachable (initial=%s)",
  async (initial) => {
    let count = initial;
    const read = vi.fn(
      async (_p: string, _c: string, options?: CardReadOptions) => {
        const rows = Array.from({ length: count }, (_, i) =>
          timelineEntry({
            id: `C-1#${count - i}`,
            event_seq: count - i,
            body: `New entry ${count - i}`,
          }),
        ).filter(
          (e) => !options?.before || e.event_seq < Number(options.before),
        );
        const selected = rows.slice(0, options?.limit ?? 20);
        return cardDetail({
          timeline: selected,
          timeline_next_cursor:
            rows.length > selected.length
              ? String(selected.at(-1)?.event_seq)
              : null,
          counts: { ...cardDetail().counts, timeline: count },
        });
      },
    );
    const client = fakeClient({ card: read });
    const view = render(
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
    );
    await screen.findByText(`已加载 ${Math.min(initial, 20)} / ${initial} 条`);
    const draft = screen.getByLabelText("评论正文") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    count += 25;
    view.rerender(
      <CardDetailPage
        client={client}
        projectId="p-1"
        cardId="C-1"
        revision={1}
      />,
    );
    await screen.findByText(`已加载 20 / ${count} 条`);
    for (let loaded = 20; loaded < count; loaded += 20) {
      await selectCardTab(/^时间线/);
      fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
      await screen.findByText(
        `已加载 ${Math.min(loaded + 20, count)} / ${count} 条`,
      );
    }
    expect(screen.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
    expect(
      [...document.querySelectorAll(".timeline-entry")].map((e) => e.id),
    ).toEqual(
      Array.from({ length: count }, (_, i) => `entry-C-1#${count - i}`),
    );
    expect(draft.value).toBe("Keep my draft");
    expect(read.mock.calls.every((call) => call[2]?.limit === 20)).toBe(true);
  },
);
