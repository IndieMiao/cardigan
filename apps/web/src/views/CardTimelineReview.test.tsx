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
test("U3 starts with 20 page-flow records, loads older records, changes count and keeps the comment draft", async () => {
  const { client, card } = history();
  const page = render(
    <CardDetailPage client={client} projectId="p-1" cardId="C-1" />,
  );
  await screen.findByText("Original comment 65");
  expect(document.querySelectorAll(".timeline-entry")).toHaveLength(20);
  expect(card).toHaveBeenLastCalledWith("p-1", "C-1", { limit: 20 });
  expect(document.querySelector(".timeline-scroll")).toBeNull();
  const input = screen.getByRole("textbox", { name: /评论|内容/ });
  fireEvent.change(input, { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "加载更早的记录" }));
  await waitFor(() =>
    expect(document.querySelectorAll(".timeline-entry")).toHaveLength(40),
  );
  expect((input as HTMLTextAreaElement).value).toBe("Keep my draft");
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
              id: "q(1)",
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
              decision_id: "q(1)",
              decision_option: "merge",
              body: "User quote",
            }),
          ],
        }),
      })}
    />,
  );
  await screen.findByText("确认把 C-1 合并到 main？");
  expect(
    screen.getByRole("heading", { name: "拍板 q(1) 确认合并" }),
  ).toBeTruthy();
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
