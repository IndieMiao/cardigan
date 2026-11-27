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
import { selectCardTab } from "../testing/card-tabs.js";
import { cardDetail, fakeClient, timelineEntry } from "../testing/fixtures.js";
import { selectMenu } from "../testing/menu.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  document.documentElement.scrollTop = 0;
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
            impact: "data_or_permission",
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
    ],
    decisions: [
      {
        id: "Q-1",
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
        decision_id: "Q-1",
        decision_option: "A",
        author: "human",
        body: "Original quote",
      }),
      timelineEntry({
        id: "C-1#5",
        event_seq: 5,
        type: "decision_request",
        decision_id: "Q-1",
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

test.each([[], ["C-1"], ["C-1", "C-2"]].map((ids) => ({ ids })))(
  "C-133: requested/resolved timeline decisions show impact for $ids",
  async ({ ids }) => {
    const data = detail();
    const decisions = data.decisions.map((decision) => ({
      ...decision,
      card_id: "C-1",
      affected_cards: ids,
      affected_card_views: ids.map((id) => ({
        id,
        title: `标题 ${id}`,
        status: "review",
      })),
    }));
    show({ ...data, decisions, relations: { ...data.relations, decisions } });
    await screen.findByRole("article", { name: "卡片 C-1" });
    const rows = screen.queryAllByRole("list", {
      name: "影响的卡片",
      hidden: true,
    });
    // C-699: the overview's facts no longer repeat a decision's details.
    expect(rows).toHaveLength(ids.includes("C-2") ? 2 : 0);
    for (const row of rows) {
      const links = within(row).getAllByRole("link", { hidden: true });
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute("href")).toBe("#/p/p-1/cards/C-2");
      expect(within(row).getByText("标题 C-2")).toBeTruthy();
      expect(within(row).getByText("审核中")).toBeTruthy();
      expect(row.textContent).not.toContain("C-1");
    }
  },
);

test("U3 separates goal/checklist and sticky summary, with only identity/status/update in the header", async () => {
  show();
  const page = await screen.findByRole("article", { name: "卡片 C-1" });
  const header = page.querySelector(".card-header");
  expect(header?.textContent).toContain("准备发布");
  expect(header?.textContent).toContain("进行中");
  expect(header?.querySelector("time")?.dateTime).toBe("2026-11-08T01:00:00Z");
  expect(header?.textContent).not.toContain("把 0.1 发出去");
  expect(screen.getByRole("region", { name: "目标" }).textContent).toContain(
    "把 0.1 发出去",
  );
  const purpose = screen.getByRole("region", { name: "验收标准" });
  expect(purpose.textContent).toContain("测试通过");
  expect(purpose.querySelectorAll("li")).toHaveLength(2);
  // A globally accepted completion has no per-criterion mapping: no inferred ticks.
  expect(
    purpose.querySelectorAll('input:checked, [aria-checked="true"]'),
  ).toHaveLength(0);
  expect(purpose.textContent).not.toContain("✓");
  const rows = [...page.querySelectorAll(".timeline-entry")];
  expect(rows.map((r) => r.id)).toEqual(
    [6, 5, 4, 3, 2, 1].map((n) => `entry-C-1#${n}`),
  );
  const commentBox = page.querySelector(".comment-box");
  if (!commentBox) throw new Error("Missing comment form");
  expect(
    rows[0]?.compareDocumentPosition(commentBox) &
      Node.DOCUMENT_POSITION_PRECEDING,
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
  expect(review?.textContent).toContain("数据或权限错误");
  expect(review?.textContent).toContain("已驳回");
  expect(review?.textContent).toContain("旧版本结论，已失效");
  expect(review?.textContent).toContain("<script>alert(1)</script> must fix");
  expect(container.querySelector("script")).toBeNull();
  // C-810: the options read by their names; the key and a label prefix are gone.
  expect(
    document.getElementById("entry-C-1#5")?.querySelector('[aria-label="选项"]')
      ?.textContent,
  ).toBe("First推荐Simple");
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
  await selectCardTab(/^时间线/);
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
  await selectCardTab(/^时间线/);
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
  expect(timelineGroups(entries).map((g) => g.length)).toEqual([1, 1, 2]);
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

test("C-205 opening keeps the decision header visible; refresh keeps position and draft", async () => {
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    document.documentElement.scrollTop = 640;
    const data = detail(),
      client = fakeClient({ card: async () => data });
    const view = render(
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
    );
    await selectCardTab(/^时间线/);
    await screen.findByRole("region", { name: "时间线记录" });
    expect(document.documentElement.scrollTop).toBe(0);
    expect(scroll).not.toHaveBeenCalled();
    const before = scroll.mock.calls.length;
    const input = screen.getByRole("textbox", { name: /评论|内容/ });
    fireEvent.change(input, { target: { value: "Draft survives" } });
    document.documentElement.scrollTop = 420;
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
    expect(document.documentElement.scrollTop).toBe(420);
    expect((input as HTMLTextAreaElement).value).toBe("Draft survives");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("C-205 opening a drawer resets only its own scroll container", async () => {
  const root = document.createElement("div");
  root.className = "drawer-body";
  document.body.append(root);
  root.scrollTop = 540;
  document.documentElement.scrollTop = 240;
  try {
    render(
      <StrictMode>
        <CardDetailPage
          client={fakeClient({ card: async () => detail() })}
          projectId="p-1"
          cardId="C-1"
          inDrawer
        />
      </StrictMode>,
      { container: root },
    );
    await selectCardTab(/^时间线/);
    await screen.findByRole("region", { name: "时间线记录" });
    expect(root.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(240);
  } finally {
    root.remove();
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
    await selectCardTab(/^时间线/);
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

test("C-205 explicit anchor scrolling survives StrictMode and stops after interaction", async () => {
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
    document.documentElement.scrollTop = 480;
    render(
      <StrictMode>
        <CardDetailPage
          client={fakeClient({ card: async () => detail() })}
          projectId="p-1"
          cardId="C-1"
          anchor="entry-C-1#6"
        />
      </StrictMode>,
    );
    await selectCardTab(/^时间线/);
    await screen.findByRole("region", { name: "时间线记录" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.documentElement.scrollTop).toBe(480);
    const initial = scroll.mock.calls.length;
    act(() => {
      for (const callback of callbacks) callback();
    });
    expect(scroll.mock.calls.length).toBe(initial + 1);
    fireEvent.wheel(window);
    expect(
      disconnects.some((disconnect) => disconnect.mock.calls.length > 0),
    ).toBe(true);
    act(() => {
      for (const callback of callbacks) callback();
    });
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
  window.location.hash = "#/p/p-1/cards/C-1?type=review&at=decision-Q-1";
  const scroll = vi.fn(),
    original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    render(<App client={fakeClient({ card: async () => detail() })} />);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const before = scroll.mock.calls.length;
    act(() => {
      window.location.hash = "#/p/p-1/cards/C-1?at=decision-Q-1";
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

test("U6d the wheel over the overview's facts column reaches the page or the drawer", async () => {
  const css = readFileSync(
    new NodeURL(
      "../components/layout/CardDetailLayout.module.css",
      import.meta.url,
    ),
    "utf8",
  );
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css
      .slice(start, css.indexOf("}", start) + 1)
      .replaceAll(/\/\*[\s\S]*?\*\//g, "");
  };
  // C-699: the facts column shares the page (or drawer body) scroll container
  // and never traps the wheel.
  for (const selector of [".overview", ".overviewMain", ".overviewFacts"]) {
    expect(rule(selector)).not.toMatch(/overflow|overscroll-behavior/u);
  }
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail() })}
      projectId="p-1"
      cardId="C-1"
      inDrawer
    />,
  );
  const column = await screen.findByRole("complementary", { name: "卡片信息" });
  expect(column.closest(".card-page-drawer")).toBeTruthy();
});
test.each(["loaded", "missing", "failed"] as const)(
  "C-463 the card drawer keeps its final width class and shows a placeholder until the card is %s",
  async (outcome) => {
    const { ApiError } = await import("../api.js");
    const { cardDetailDrawerClassName } = await import(
      "../components/layout/CardDetailLayout.js"
    );
    const read = (path: string) =>
      readFileSync(new NodeURL(path, import.meta.url), "utf8").replaceAll(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
    const layout = read("../components/layout/CardDetailLayout.module.css");
    const start = layout.indexOf(".drawer {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(layout.slice(start, layout.indexOf("}", start))).toContain(
      "width: min(var(--ui-detail-drawer-width), 100vw);",
    );
    expect(read("../components/ui/theme.css")).toContain(
      "--ui-detail-drawer-width: 760px;",
    );
    // Width must not wait for loaded content to match a selector.
    expect(read("../styles.css")).not.toMatch(/\.drawer-content[^{]*:has\(/);
    let settle: (() => void) | undefined;
    window.location.hash = "#/p/p-1/cards?card=C-1";
    render(
      <App
        client={fakeClient({
          card: () =>
            new Promise<CardDetail>((resolve, reject) => {
              settle = () =>
                outcome === "loaded"
                  ? resolve(detail())
                  : reject(
                      outcome === "missing"
                        ? new ApiError(404, "not_found", "not found")
                        : new ApiError(500, "internal", "boom"),
                    );
            }),
        })}
      />,
    );
    const drawer = await screen.findByRole("dialog");
    await waitFor(() => expect(settle).toBeDefined());
    expect(cardDetailDrawerClassName).toBeTruthy();
    expect(drawer.classList).toContain("drawer-content");
    expect(drawer.classList).toContain(cardDetailDrawerClassName);
    expect(drawer.querySelector(".card-page-drawer")).toBeNull();
    // The pending request shows the shared, decorative placeholder in the body.
    const placeholder = drawer.querySelector(".drawer-body [data-ui=skeleton]");
    expect(placeholder).toBeTruthy();
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    const loading = drawer.className;
    await act(async () => settle?.());
    if (outcome === "loaded")
      await waitFor(() =>
        expect(drawer.querySelector(".card-page-drawer")).toBeTruthy(),
      );
    else if (outcome === "missing")
      await within(drawer).findByText(/找不到卡片 C-1/);
    else await within(drawer).findByRole("alert");
    expect(drawer.querySelector("[data-ui=skeleton]")).toBeNull();
    expect(drawer.isConnected).toBe(true);
    expect(drawer.className).toBe(loading);
  },
);
