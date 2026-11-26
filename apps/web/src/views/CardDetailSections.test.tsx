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
import { afterEach, expect, test, vi } from "vitest";
import { selectCardTab } from "../testing/card-tabs.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(cleanup);

function overview(full = cardDetail()) {
  return {
    ...full,
    work_items: [],
    reviews: [],
    deliveries: [],
    review_matrix: [],
    attachments: [],
    overview: {
      work_count: 2,
      completed_work_count: 0,
      verifiers: [
        {
          id: "W-2",
          role_id: "reviewer",
          completion_criteria: ["确认结果"],
          verdict: null,
        },
      ],
      attachment_count: 1,
      waiting_delivery: [],
      conclusion_reviews: [],
    },
  };
}

test("renders the head without waiting on panels, then requests just the selected panel", async () => {
  const full = cardDetail();
  const card = vi.fn(async () => overview(full));
  const cardPanel = vi.fn(
    async (_project: string, _id: string, panel: string) =>
      panel === "attachments"
        ? { attachments: full.attachments }
        : { work_items: full.work_items },
  );
  render(
    <CardDetailPage
      client={fakeClient({ card, cardPanel })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await screen.findByRole("tab", { name: /工作项（2）/ });
  expect(card).toHaveBeenCalledWith("p-1", "C-1", {
    limit: 20,
    section: "overview",
  });
  // C-699: the overview read alone fills the facts column.
  const facts = screen.getByRole("complementary", { name: "卡片信息" });
  const value = (label: string) =>
    within(facts).getByText(label, { selector: "dt" }).nextElementSibling
      ?.textContent;
  expect(value("工作项")).toBe("0/2 完成");
  // A server without verifier titles falls back to the role.
  expect(value("验收")).toMatch(/W-2.*reviewer.*未结论/u);
  expect(cardPanel).not.toHaveBeenCalled();
  await selectCardTab(/^工作项/);
  await screen.findByText("已完成 0/2");
  expect(cardPanel.mock.calls.map((call) => call[2])).toEqual(["work"]);
  await selectCardTab(/^附件/);
  await waitFor(() =>
    expect(document.getElementById("attachment-F-1")).not.toBeNull(),
  );
  expect(cardPanel.mock.calls.map((call) => call[2])).toEqual([
    "work",
    "attachments",
  ]);
});

test("finishing a work update after switching tabs leaves the attachments visible", async () => {
  const full = cardDetail();
  const pending = Promise.withResolvers<void>();
  const setManualAssign = vi.fn(() => pending.promise);
  const cardPanel = vi.fn(async (_p: string, _id: string, section: string) =>
    section === "work"
      ? { work_items: full.work_items }
      : { attachments: full.attachments },
  );
  render(
    <CardDetailPage
      client={fakeClient({
        card: async () => overview(full),
        cardPanel,
        setManualAssign,
      })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await selectCardTab(/^工作项/);
  const summary = (await screen.findByText("W-1")).closest("summary");
  const row = summary?.closest("details");
  if (!row || !summary) throw new Error("Missing work item");
  fireEvent.click(summary);
  fireEvent.click(within(row).getByRole("checkbox"));
  expect(setManualAssign).toHaveBeenCalledOnce();
  await selectCardTab(/^附件/);
  await waitFor(() =>
    expect(document.getElementById("attachment-F-1")).not.toBeNull(),
  );
  await act(async () => pending.resolve());
  expect(
    screen.getByRole("tab", { name: /^附件/, selected: true }),
  ).toBeTruthy();
  expect(document.getElementById("attachment-F-1")).not.toBeNull();
  expect(cardPanel.mock.calls.map((call) => call[2])).toEqual([
    "work",
    "attachments",
  ]);
  await selectCardTab(/^工作项/);
  await screen.findByText("已完成 0/2");
  expect(cardPanel.mock.calls.map((call) => call[2])).toEqual([
    "work",
    "attachments",
    "work",
  ]);
});

test("a delayed or failed timeline lookup leaves the first page readable and retry fills in attachments", async () => {
  const full = cardDetail();
  const pending = Promise.withResolvers<{
    attachments: typeof full.attachments;
  }>();
  const cardPanel = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ attachments: full.attachments });
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => overview(full), cardPanel })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  await selectCardTab(/^时间线/);
  const comment = () => document.getElementById("entry-C-1#2");
  expect(comment()?.textContent).toContain(full.timeline[0]?.body);
  expect(comment()?.querySelector("img")).toBeNull();
  await act(async () => pending.reject(new Error("附件暂时不可用")));
  const retry = await screen.findByRole("button", { name: "重试" });
  expect(comment()?.textContent).toContain(full.timeline[0]?.body);
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      comment()?.querySelector('img[src$="/F-1/thumbnail"]'),
    ).not.toBeNull(),
  );
  expect(cardPanel).toHaveBeenCalledTimes(2);
});

test("C-775: a hidden tab stops reading the open panel and reads it once when shown", async () => {
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const full = cardDetail();
  const card = vi.fn(async () => overview(full));
  const cardPanel = vi.fn(async () => ({ work_items: full.work_items }));
  const client = fakeClient({ card, cardPanel });
  const page = (revision: number) => (
    <CardDetailPage
      client={client}
      projectId="p-1"
      cardId="C-1"
      revision={revision}
    />
  );
  const { rerender } = render(page(0));
  await selectCardTab(/^工作项/);
  await screen.findByText("已完成 0/2");
  expect(cardPanel).toHaveBeenCalledTimes(1);
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  rerender(page(1));
  rerender(page(2));
  await act(async () => {});
  expect(cardPanel).toHaveBeenCalledTimes(1);
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(cardPanel).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(cardPanel).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});
