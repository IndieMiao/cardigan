// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { selectCardTab } from "../testing/card-tabs.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";

afterEach(cleanup);

test("renders the head without waiting on panels, then requests just the selected panel", async () => {
  const full = cardDetail();
  const head = {
    ...full,
    work_items: [],
    reviews: [],
    deliveries: [],
    review_matrix: [],
    attachments: [],
    overview: {
      work_count: 2,
      attachment_count: 1,
      waiting_delivery: [],
      conclusion_reviews: [],
    },
  };
  const card = vi.fn(async () => head);
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
