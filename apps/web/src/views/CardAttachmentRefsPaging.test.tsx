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
