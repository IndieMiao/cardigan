// @vitest-environment jsdom
/**
 * C-615: another card's attachment named on an older timeline page is a chip
 * whether the page was reached by paging or kept across a refresh, and turns
 * back into text once the server stops returning it.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  CardDetail,
  CardReadOptions,
  ReferencedAttachment,
} from "../api.js";
import { selectCardTab } from "../testing/card-tabs.js";
import {
  attachment,
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

const observers: { emit: (visible: boolean) => void; off: boolean }[] = [];
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private entry = { emit: (_: boolean) => {}, off: false };
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.entry = {
          off: false,
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
        observers.push(this.entry);
      }
      disconnect() {
        this.entry.off = true;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reachBottom = () =>
  act(() => {
    for (const o of observers.filter((o) => !o.off)) o.emit(true);
  });

const foreign: ReferencedAttachment = {
  ...attachment({
    id: "attachment-77",
    original_filename: "数值表.json",
    mime: "application/json",
    inline: false,
    thumbnail_path: null,
    attach_to: { kind: "timeline_entry", id: "C-9#1" },
    download_path: "/api/projects/p-1/attachments/attachment-77",
  }),
  card_id: "C-9",
};

/** 25 entries; only entry 3 (second page) names the other card's file. */
function server() {
  let readable = true;
  const entries = Array.from({ length: 25 }, (_, i) =>
    timelineEntry({
      id: `C-1#${25 - i}`,
      event_seq: 25 - i,
      body: 25 - i === 3 ? "数值沿用 attachment-77" : `Entry ${25 - i}`,
    }),
  );
  const card = vi.fn(
    async (_p: string, _c: string, options?: CardReadOptions) => {
      const all = entries.filter(
        (e) => !options?.before || e.event_seq < Number(options.before),
      );
      const timeline = all.slice(0, 20);
      return cardDetail({
        timeline,
        attachments: [],
        // Like the server: only the page's own bodies, only while readable.
        referenced_attachments:
          readable && timeline.some((e) => e.body.includes(foreign.id))
            ? [foreign]
            : [],
        timeline_next_cursor:
          all.length > timeline.length
            ? String(timeline.at(-1)?.event_seq)
            : null,
        counts: { ...cardDetail().counts, timeline: entries.length },
      }) satisfies CardDetail;
    },
  );
  const attachmentRefs = vi.fn(
    async (_p: string, _c: string, ids: readonly string[]) => ({
      attachments: readable ? [foreign].filter((a) => ids.includes(a.id)) : [],
    }),
  );
  return {
    client: fakeClient({ card, attachmentRefs }),
    attachmentRefs,
    revoke: () => {
      readable = false;
    },
  };
}

const chip = () =>
  document.querySelector<HTMLAnchorElement>(
    '#entry-C-1\\#3 a[data-attachment-ref="attachment-77"]',
  );

test("an older page's other-card attachment is a chip after paging and after a refresh, and text once unreadable", async () => {
  const { client, attachmentRefs, revoke } = server();
  const view = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 25 条");
  reachBottom();
  await screen.findByText("已加载 25 / 25 条");
  // The older page brought the metadata along: no separate read.
  await waitFor(() => expect(chip()?.textContent).toContain("数值表.json"));
  expect(attachmentRefs).not.toHaveBeenCalled();

  // A refresh replaces the head page; the kept older rows read their numbers.
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={1}
    />,
  );
  await waitFor(() =>
    expect(attachmentRefs).toHaveBeenCalledWith("p-1", "C-1", [foreign.id]),
  );
  await waitFor(() => expect(chip()).toBeTruthy());
  expect(chip()?.getAttribute("href")).toBe(foreign.download_path);

  // Access withdrawn: the next refresh asks again and the number is text.
  revoke();
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={2}
    />,
  );
  await waitFor(() => expect(attachmentRefs).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(chip()).toBeNull());
  expect(document.querySelector('[id="entry-C-1#3"]')?.textContent).toContain(
    "attachment-77",
  );
});

test("a newer comment ending in an open code block leaves an older comment's chip alone", async () => {
  const entries = [
    timelineEntry({
      id: "C-1#2",
      event_seq: 2,
      body: "构建日志：\n```text\nBuild succeeded",
    }),
    timelineEntry({
      id: "C-1#1",
      event_seq: 1,
      body: "数值沿用 attachment-77",
    }),
  ];
  const attachmentRefs = vi.fn(
    async (_p: string, _c: string, ids: readonly string[]) => ({
      attachments: [foreign].filter((a) => ids.includes(a.id)),
    }),
  );
  const client = fakeClient({
    card: async () =>
      cardDetail({
        timeline: entries,
        attachments: [],
        referenced_attachments: [],
        timeline_next_cursor: null,
        counts: { ...cardDetail().counts, timeline: entries.length },
      }),
    attachmentRefs,
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await waitFor(() =>
    expect(attachmentRefs).toHaveBeenCalledWith("p-1", "C-1", [foreign.id]),
  );
  await waitFor(() =>
    expect(
      document.querySelector(
        '[id="entry-C-1#1"] a[data-attachment-ref="attachment-77"]',
      ),
    ).toBeTruthy(),
  );
});

test("an event on the source card refreshes the page and a withdrawn chip turns to text at once", async () => {
  let readable = true;
  const entries = [
    timelineEntry({
      id: "C-1#1",
      event_seq: 1,
      body: "数值沿用 attachment-77",
    }),
  ];
  const card = vi.fn(async () =>
    cardDetail({
      timeline: entries,
      attachments: [],
      referenced_attachments: readable ? [foreign] : [],
      timeline_next_cursor: null,
      counts: { ...cardDetail().counts, timeline: entries.length },
    }),
  );
  const client = fakeClient({ card });
  // The shared project stream: only C-9's (the file's card's) events change.
  let sourceRevision = 0;
  const followed: string[][] = [];
  const cardRevision = (_id: string, affected: readonly string[]) => {
    followed.push([...affected]);
    return affected.includes("C-9") ? sourceRevision : 0;
  };
  const view = render(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      cardRevision={cardRevision}
    />,
  );
  await selectCardTab(/^时间线/);
  await waitFor(() =>
    expect(
      document.querySelector('a[data-attachment-ref="attachment-77"]'),
    ).toBeTruthy(),
  );
  // The page follows the card the chip's file belongs to.
  await waitFor(() => expect(followed.at(-1)).toContain("C-9"));
  const reads = card.mock.calls.length;
  // C-9 turns sensitive: the server stops returning it and C-9's stream moves.
  readable = false;
  sourceRevision = 1;
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      cardRevision={(id, affected) => cardRevision(id, affected)}
    />,
  );
  await waitFor(() => expect(card.mock.calls.length).toBeGreaterThan(reads));
  await waitFor(() =>
    expect(
      document.querySelector('a[data-attachment-ref="attachment-77"]'),
    ).toBeNull(),
  );
});

test("a refresh while the source card's stream is ahead reads once and settles (V-3096)", async () => {
  const { client, attachmentRefs } = server();
  const card = vi.mocked(client.card);
  // C-9 had events after the page opened: following it lifts the revision.
  let base = 0;
  const cardRevision = (_id: string, affected: readonly string[]) =>
    Math.max(base, affected.includes("C-9") ? 5 : 0);
  const view = render(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      cardRevision={cardRevision}
    />,
  );
  await selectCardTab(/^时间线/);
  await screen.findByText("已加载 20 / 25 条");
  reachBottom();
  await screen.findByText("已加载 25 / 25 条");
  await waitFor(() => expect(chip()).toBeTruthy());
  // C-1's own event (3 < 5) refreshes the head page; the kept older rows
  // read their numbers again while C-9 stays followed.
  base = 3;
  view.rerender(
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      cardRevision={(id, affected) => cardRevision(id, affected)}
    />,
  );
  await waitFor(() => expect(chip()).toBeTruthy());
  await act(() => new Promise((done) => setTimeout(done, 300)));
  const settled = {
    card: card.mock.calls.length,
    refs: attachmentRefs.mock.calls.length,
  };
  await act(() => new Promise((done) => setTimeout(done, 300)));
  expect(card.mock.calls.length).toBe(settled.card);
  expect(attachmentRefs.mock.calls.length).toBe(settled.refs);
  expect(attachmentRefs.mock.calls.length).toBeLessThanOrEqual(2);
  expect(chip()?.textContent).toContain("数值表.json");
});

test("numbers no attachment can have are not asked for, and batches of 100 fail on their own", async () => {
  const valid = Array.from({ length: 150 }, (_, i) => `attachment-${1000 + i}`);
  const body = [...valid, "attachment-12345678901234567"].join(" ");
  const entries = [timelineEntry({ id: "C-1#1", event_seq: 1, body })];
  const calls: (readonly string[])[] = [];
  const attachmentRefs = vi.fn(
    async (_p: string, _c: string, ids: readonly string[]) => {
      calls.push(ids);
      // The first batch fails; the second answers for its own numbers.
      if (calls.length === 1) throw new Error("400");
      return {
        attachments: ids.includes("attachment-1149")
          ? [{ ...foreign, id: "attachment-1149" }]
          : [],
      };
    },
  );
  const client = fakeClient({
    card: async () =>
      cardDetail({
        timeline: entries,
        attachments: [],
        referenced_attachments: [],
        timeline_next_cursor: null,
        counts: { ...cardDetail().counts, timeline: 1 },
      }),
    attachmentRefs,
  });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  await selectCardTab(/^时间线/);
  await waitFor(() =>
    expect(
      document.querySelector('a[data-attachment-ref="attachment-1149"]'),
    ).toBeTruthy(),
  );
  expect(calls.map((ids) => ids.length)).toEqual([100, 50]);
  expect(calls.flat()).not.toContain("attachment-12345678901234567");
  expect(
    document.querySelector('a[data-attachment-ref="attachment-1000"]'),
  ).toBeNull();
});
