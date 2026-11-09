// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../App.js";
import type { CardDetail } from "../api.js";
import { timelineGroups } from "../components/Timeline.js";
import { parseRoute } from "../route.js";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function detail(): CardDetail {
  const base = cardDetail();
  const delivery = base.deliveries[0];
  if (!delivery) throw new Error("Missing fixture delivery");
  return {
    ...base,
    updated_at: "2026-11-08T01:00:00Z",
    attachments: [],
    deliveries: [
      {
        ...delivery,
        id: "D-1",
        status: "superseded",
        test_results: [{ command: "pnpm test", result: "All checks passed" }],
      },
      {
        ...delivery,
        id: "D-2",
        status: "accepted",
        supersedes: "D-1",
        kind: "card_completion",
      },
    ],
    reviews: [
      {
        id: "V-1",
        delivery_id: "D-1",
        work_item_id: "W-2",
        verdict: "reject",
        blocking: true,
        target_sha: "old-sha",
        issues: [
          {
            severity: "major",
            description: "<script>alert(1)</script> must fix",
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
    ],
    decisions: [
      {
        id: "q(1)",
        question: "Choose a strategy",
        status: "resolved",
        blocking: true,
        decider: "human",
        recommended: "A",
        options: [{ key: "A", description: "First", impact: "Simple" }],
        context: "Background",
        resolution: {
          option: "B",
          rationale: "Newer decision",
          raw_quote: "Newer quote",
          at: "2026-11-08T02:00:00Z",
        },
      },
    ],
    timeline: [
      timelineEntry({
        id: "C-1#6",
        event_seq: 6,
        type: "decision_resolved",
        decision_id: "q(1)",
        decision_option: "A",
        author: "human",
        body: "Original quote",
      }),
      timelineEntry({
        id: "C-1#5",
        event_seq: 5,
        type: "decision_request",
        decision_id: "q(1)",
        author_role: "pm",
      }),
      timelineEntry({
        id: "C-1#4",
        event_seq: 4,
        type: "review",
        review_id: "V-1",
        delivery_id: "D-1",
        work_item_id: "W-2",
        author_role: "reviewer",
      }),
      timelineEntry({
        id: "C-1#3",
        event_seq: 3,
        type: "delivery",
        delivery_id: "D-1",
        work_item_id: "W-1",
        body: "Do not parse this as evidence",
      }),
      timelineEntry({
        id: "C-1#2",
        event_seq: 2,
        author_role: "pm",
        body: "PM comment",
      }),
      timelineEntry({
        id: "C-1#1",
        event_seq: 1,
        author: "human",
        body: "Human comment",
      }),
    ],
  };
}
const show = (data = detail(), revision = 0) =>
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => data })}
      projectId="p-1"
      cardId="C-1"
      revision={revision}
    />,
  );

test("U3 separates goal/checklist and sticky summary, with only identity/status/update in the header", async () => {
  show();
  const page = await screen.findByRole("article", { name: "卡片 C-1" });
  const header = page.querySelector(".card-header");
  expect(header?.textContent).toContain("准备发布");
  expect(header?.textContent).toContain("进行中");
  expect(header?.querySelector("time")?.dateTime).toBe("2026-11-08T01:00:00Z");
  expect(header?.textContent).not.toContain("把 0.1 发出去");
  const sidebar = screen.getByRole("complementary", { name: "卡片概况" });
  for (const text of ["进行到哪一步", "下一步该谁做", "被什么阻塞"])
    expect(within(sidebar).getByText(text)).toBeTruthy();
  const purpose = screen.getByRole("region", { name: "目标和验收标准" });
  expect(purpose.textContent).toContain("测试通过");
  expect(purpose.querySelectorAll("li")).toHaveLength(2);
  // A globally accepted completion has no per-criterion mapping: no inferred ticks.
  expect(purpose.textContent).toContain("整体完成申请已通过");
  expect(
    purpose.querySelectorAll('input:checked, [aria-checked="true"]'),
  ).toHaveLength(0);
  expect(purpose.textContent).not.toContain("✓");
  const rows = [...page.querySelectorAll(".timeline-entry")];
  expect(rows.map((r) => r.id)).toEqual(
    [1, 2, 3, 4, 5, 6].map((n) => `entry-C-1#${n}`),
  );
  const commentBox = page.querySelector(".comment-box");
  if (!commentBox) throw new Error("Missing comment form");
  expect(
    rows.at(-1)?.compareDocumentPosition(commentBox) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("U3 structured delivery, review and decision rows use bound versions and original quotes safely", async () => {
  const { container } = show();
  await screen.findByRole("article", { name: "卡片 C-1" });
  const delivery = document.getElementById("entry-C-1#3");
  expect(delivery?.textContent).toContain("pnpm test");
  expect(delivery?.textContent).toContain("All checks passed");
  expect(delivery?.textContent).toContain("已取代");
  const review = document.getElementById("entry-C-1#4");
  expect(review?.textContent).toContain("old-sha");
  expect(review?.textContent).toContain("已驳回");
  expect(review?.textContent).toContain("旧版本结论，已失效");
  expect(review?.textContent).toContain("<script>alert(1)</script> must fix");
  expect(container.querySelector("script")).toBeNull();
  expect(document.getElementById("entry-C-1#5")?.textContent).toContain(
    "影响：Simple",
  );
  const decision = document.getElementById("entry-C-1#6");
  expect(decision?.textContent).toContain("记录的结果：First");
  expect(decision?.textContent).toContain("Original quote");
  expect(decision?.textContent).not.toContain("Newer quote");
});

test("U3 type and speaker filters survive a shared URL, clearing a menu and remount", async () => {
  window.location.hash = "#/p/p-1/cards/C-1?type=comment&author=pm";
  const view = show();
  await screen.findByText("PM comment");
  expect(screen.queryByText("Human comment")).toBeNull();
  expect(document.querySelectorAll(".timeline-entry")).toHaveLength(1);
  await selectMenu(/^发言方：/, "全部");
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "card",
    cardId: "C-1",
    filters: { type: "comment" },
  });
  await screen.findByText("Human comment");
  view.unmount();
  show();
  await screen.findByText("Human comment");
  expect(screen.getByRole("button", { name: "条目类型：评论" })).toBeTruthy();
  await selectMenu(/^条目类型：/, "交接");
  await screen.findByText("没有符合筛选条件的条目。调整筛选后继续查看。");
});

test("U3 combines only consecutive system records and explicit locations reveal filtered collapsed rows", async () => {
  const entries = [1, 2, 3, 4].map((n) =>
    timelineEntry({
      id: `C-1#${n}`,
      event_seq: n,
      type: n === 3 ? "comment" : "status_change",
      author: "system",
      event_type: n === 3 ? "comment_posted" : "assignment_released",
    }),
  );
  expect(timelineGroups(entries).map((g) => g.length)).toEqual([2, 1, 1]);
  window.location.hash = "#/p/p-1/cards/C-1?type=comment&at=entry-C-1%232";
  const scroll = vi.fn();
  vi.stubGlobal("HTMLDetailsElement", window.HTMLDetailsElement);
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(
      <App
        client={fakeClient({
          card: async () => ({ ...cardDetail(), timeline: entries }),
        })}
      />,
    );
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" }),
    );
    const target = document.getElementById("entry-C-1#2");
    expect(target?.closest("details")?.open).toBe(true);
    expect(scroll.mock.contexts.at(-1)).toBe(target);
    expect(window.location.hash).toContain("cards/C-1");
    await selectMenu(/^条目类型：/, "审核");
    await waitFor(() =>
      expect(parseRoute(window.location.hash)).toEqual({
        kind: "card",
        projectId: "p-1",
        cardId: "C-1",
        filters: { type: "review" },
      }),
    );
    expect(document.getElementById("entry-C-1#2")).toBeNull();
  } finally {
    Element.prototype.scrollIntoView = original;
    vi.unstubAllGlobals();
  }
});

test("U3 opening scrolls the page to the latest entry; refresh keeps the reader's position and draft", async () => {
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const data = detail(),
      client = fakeClient({ card: async () => data });
    const view = render(
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
    );
    await screen.findByRole("region", { name: "时间线记录" });
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "end" }));
    expect(scroll.mock.contexts.at(-1)).toBe(
      document.getElementById("entry-C-1#6"),
    );
    const before = scroll.mock.calls.length;
    const input = screen.getByRole("textbox", { name: /评论|内容/ });
    fireEvent.change(input, { target: { value: "Draft survives" } });
    view.rerender(
      <CardDetailPage
        client={client}
        projectId="p-1"
        cardId="C-1"
        revision={1}
      />,
    );
    await act(async () => {});
    expect(scroll.mock.calls.length).toBe(before);
    expect((input as HTMLTextAreaElement).value).toBe("Draft survives");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U5a embedded detail starts at the top but still follows an explicit anchor", async () => {
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const view = render(
      <CardDetailPage
        client={fakeClient({ card: async () => detail() })}
        projectId="p-1"
        cardId="C-1"
        inDrawer
      />,
    );
    await screen.findByRole("region", { name: "时间线记录" });
    expect(scroll).not.toHaveBeenCalled();
    view.unmount();

    render(
      <CardDetailPage
        client={fakeClient({ card: async () => detail() })}
        projectId="p-1"
        cardId="C-1"
        anchor="entry-C-1#6"
        inDrawer
      />,
    );
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" }),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U3 initial page scrolling survives StrictMode and stops after interaction", async () => {
  const callbacks: (() => void)[] = [],
    disconnects: ReturnType<typeof vi.fn>[] = [];
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        callbacks.push(callback);
        disconnects.push(this.disconnect);
      }
      observe() {}
      unobserve() {}
    },
  );
  try {
    render(
      <StrictMode>
        <CardDetailPage
          client={fakeClient({ card: async () => detail() })}
          projectId="p-1"
          cardId="C-1"
        />
      </StrictMode>,
    );
    await screen.findByRole("region", { name: "时间线记录" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const pending = callbacks.at(-1),
      disconnect = disconnects.at(-1),
      initial = scroll.mock.calls.length;
    act(() => pending?.());
    expect(scroll.mock.calls.length).toBe(initial + 1);
    fireEvent.wheel(window);
    expect(disconnect).toHaveBeenCalled();
    act(() => pending?.());
    expect(scroll.mock.calls.length).toBe(initial + 1);
  } finally {
    Element.prototype.scrollIntoView = original;
    vi.unstubAllGlobals();
  }
});

test("U3 a numbered alias scrolls its containing row, not an empty inline anchor", async () => {
  window.location.hash = "#/p/p-1/cards/C-1?at=delivery-D-1";
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(<App client={fakeClient({ card: async () => detail() })} />);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts.at(-1)).toBe(
      document.getElementById("entry-C-1#3"),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U3 the same anchor is repositioned when a route change restores filtered-out rows", async () => {
  window.location.hash = "#/p/p-1/cards/C-1?type=review&at=decision-q(1)";
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(<App client={fakeClient({ card: async () => detail() })} />);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const before = scroll.mock.calls.length;
    act(() => {
      window.location.hash = "#/p/p-1/cards/C-1?at=decision-q(1)";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByText("Human comment");
    await waitFor(() =>
      expect(scroll.mock.calls.length).toBeGreaterThan(before),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("U6d the wheel over the card sidebar reaches the page or the drawer", async () => {
  const css = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css
      .slice(start, css.indexOf("}", start) + 1)
      .replaceAll(/\/\*[\s\S]*?\*\//g, "");
  };
  const sidebar = rule(".card-sidebar");
  // Tall sidebars still scroll on their own in the full page…
  expect(sidebar).toContain("overflow-y: auto;");
  // …but the wheel is never trapped when they fit.
  expect(sidebar).not.toContain("overscroll-behavior:");
  // The drawer body is the only scroll container inside a drawer.
  expect(rule(".card-page-drawer .card-sidebar")).toContain(
    "overflow: visible;",
  );
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail() })}
      projectId="p-1"
      cardId="C-1"
      inDrawer
    />,
  );
  const column = await screen.findByRole("complementary", { name: "卡片概况" });
  expect(column.className).toContain("card-sidebar");
  expect(column.closest(".card-page-drawer")).toBeTruthy();
});
