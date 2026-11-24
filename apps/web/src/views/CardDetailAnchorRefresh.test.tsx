// @vitest-environment jsdom

import type { TimelineEntryId } from "@cardigan/domain";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CardDetail } from "../api.js";
import { selectCardTab } from "../testing/card-tabs.js";
import {
  card,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

// C-581: answering a question group while the URL still points at an earlier
// comment must not pull the page back to that comment.

const group = "C-1#9" as TimelineEntryId;
const anchor = "entry-C-1#8";

function storyDetail(extra: CardDetail["timeline"] = []): CardDetail {
  return cardDetail({
    card: {
      ...card,
      story: {
        discussion_rounds: 1,
        question_groups: [
          {
            id: group,
            questions: [1, 2, 3, 4, 5, 6].map((n) => ({
              question: `第 ${n} 个问题？`,
              recommended: `推荐 ${n}`,
              impact: `影响 ${n}`,
            })),
          },
        ],
      },
    },
    timeline: [
      ...extra,
      timelineEntry({
        id: group,
        event_seq: 9,
        body: "问题清单",
        author: "assignment:A-2",
      }),
      timelineEntry({
        id: "C-1#8" as TimelineEntryId,
        event_seq: 8,
        body: "动态地图与地块美术规范说明",
        author: "human",
      }),
    ],
    counts: {
      timeline: 2 + extra.length,
      deliveries: 1,
      reviews: 0,
      open_decisions: 0,
    },
  });
}

/** Reads span at least one render, like a real request (pending true → false). */
async function read(extra: CardDetail["timeline"] = []) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return storyDetail(extra);
}

/** Wait until in-flight reads have landed and rendered. */
const landed = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 30)));

let scroll: ReturnType<typeof vi.fn>;
let original: typeof Element.prototype.scrollIntoView;
let observers: { callback: () => void; live: boolean }[];

beforeEach(() => {
  scroll = vi.fn();
  original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  observers = [];
  // Browsers report every observed element once on observe(), then on resize.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly entry: { callback: () => void; live: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, live: false };
        observers.push(this.entry);
      }
      observe() {
        this.entry.live = true;
        this.entry.callback();
      }
      unobserve() {}
      disconnect() {
        this.entry.live = false;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = original;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.scrollTop = 0;
});

/** Layout keeps changing while a reader types (images, growing fields). */
const relayout = () =>
  act(() => {
    for (const observer of observers) if (observer.live) observer.callback();
  });

async function openAtAnchor(client = fakeClient({ card: () => read() })) {
  const props = { client, projectId: "p-1", cardId: "C-1", anchor };
  const view = render(<CardDetailPage {...props} />);
  await screen.findByRole("region", { name: "时间线记录" });
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  expect(scroll.mock.contexts.at(-1)).toBe(
    document.getElementById(anchor)?.closest(".timeline-entry"),
  );
  // The reader scrolls up to the question group, away from the anchor.
  fireEvent.wheel(window);
  document.documentElement.scrollTop = 320;
  const before = scroll.mock.calls.length;
  const input = screen.getByRole("textbox", { name: "第 4 题回答" });
  return { view, props, input, before };
}

test("C-581 typing in question 4 while a live refresh lands keeps position, focus and draft", async () => {
  const { view, props, input, before } = await openAtAnchor();
  input.focus();
  fireEvent.keyDown(input, { key: "a" });
  fireEvent.change(input, { target: { value: "两列" } });
  view.rerender(<CardDetailPage {...props} revision={1} />);
  await landed();
  relayout();
  fireEvent.keyDown(input, { key: "b" });
  fireEvent.change(input, { target: { value: "两列布局" } });
  relayout();
  expect(scroll.mock.calls.length).toBe(before);
  expect(document.documentElement.scrollTop).toBe(320);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("两列布局");
});

test("C-581 submitting the checklist (C-715) and accepting the group reload without jumping to the anchor", async () => {
  let answered = false;
  const addComment = vi.fn(async () => {
    answered = true;
    return { id: "C-1#10" };
  });
  const client = fakeClient({
    addComment,
    card: () =>
      read(
        answered
          ? [
              timelineEntry({
                id: "C-1#10" as TimelineEntryId,
                event_seq: 10,
                body: "提交回答",
                author: "human",
              }),
            ]
          : [],
      ),
  });
  const { view, input, before } = await openAtAnchor(client);
  // Clicking the button needs no pointer or key event to stay put.
  fireEvent.change(input, { target: { value: "两列" } });
  fireEvent.click(screen.getByRole("button", { name: "提交" }));
  await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
  await screen.findByText("提交回答");
  await landed();
  relayout();
  expect(scroll.mock.calls.length).toBe(before);
  expect(document.documentElement.scrollTop).toBe(320);
  // A second checklist with nothing typed: accepting it reloads in place too.
  view.unmount();
  answered = false;
  const next = await openAtAnchor(client);
  fireEvent.click(screen.getByRole("button", { name: "整组按默认" }));
  await waitFor(() => expect(addComment).toHaveBeenCalledTimes(2));
  await landed();
  relayout();
  expect(scroll.mock.calls.length).toBe(next.before);
  expect(document.documentElement.scrollTop).toBe(320);
});

test("C-581 a refresh without any interaction ends the anchor follow; new entries do not steal focus", async () => {
  let extra: CardDetail["timeline"] = [];
  const client = fakeClient({ card: () => read(extra) });
  const props = { client, projectId: "p-1", cardId: "C-1", anchor };
  const view = render(<CardDetailPage {...props} />);
  await screen.findByRole("region", { name: "时间线记录" });
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  const input = screen.getByRole("textbox", { name: "第 4 题回答" });
  input.focus();
  const before = scroll.mock.calls.length;
  extra = [
    timelineEntry({
      id: "C-1#11" as TimelineEntryId,
      event_seq: 11,
      body: "新动态",
    }),
  ];
  view.rerender(<CardDetailPage {...props} revision={1} />);
  await screen.findByText("新动态");
  relayout();
  expect(scroll.mock.calls.length).toBe(before);
  expect(document.activeElement).toBe(input);
});

test("C-581 a refresh does not pull the reader back to the anchor's tab; a new anchor still scrolls", async () => {
  const { view, props } = await openAtAnchor();
  await selectCardTab(/^概览/);
  expect(
    screen.getByRole("tab", { name: /^概览/ }).getAttribute("aria-selected"),
  ).toBe("true");
  view.rerender(<CardDetailPage {...props} revision={1} />);
  await landed();
  expect(
    screen.getByRole("tab", { name: /^概览/ }).getAttribute("aria-selected"),
  ).toBe("true");
  const before = scroll.mock.calls.length;
  view.rerender(
    <CardDetailPage {...props} anchor="entry-C-1#9" revision={1} />,
  );
  await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(before));
  expect(scroll.mock.contexts.at(-1)).toBe(
    document.getElementById("entry-C-1#9")?.closest(".timeline-entry"),
  );
});

test("C-581 returning to an earlier anchor (A → B → A) positions it again; refreshes of that visit stay put", async () => {
  const { view, props } = await openAtAnchor();
  const rowOf = (id: string) =>
    document.getElementById(id)?.closest(".timeline-entry");
  // A's visit is settled by the wheel and a refresh.
  view.rerender(<CardDetailPage {...props} revision={1} />);
  await landed();
  const atB = scroll.mock.calls.length;
  view.rerender(
    <CardDetailPage {...props} anchor="entry-C-1#9" revision={1} />,
  );
  await landed();
  await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(atB));
  expect(scroll.mock.contexts.at(-1)).toBe(rowOf("entry-C-1#9"));
  // Back to A without touching B (browser back): a new visit of A.
  const backToA = scroll.mock.calls.length;
  view.rerender(<CardDetailPage {...props} revision={1} />);
  await landed();
  await waitFor(() =>
    expect(scroll.mock.calls.length).toBeGreaterThan(backToA),
  );
  expect(scroll.mock.contexts.at(-1)).toBe(rowOf(anchor));
  fireEvent.wheel(window);
  const settledA = scroll.mock.calls.length;
  view.rerender(<CardDetailPage {...props} revision={2} />);
  await landed();
  relayout();
  expect(scroll.mock.calls.length).toBe(settledA);
});
