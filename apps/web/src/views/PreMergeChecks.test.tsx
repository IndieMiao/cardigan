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
import type {
  CardDetail,
  NeedsDecision,
  NeedsPage,
  PreMergeCheckView,
} from "../api.js";
import { PRE_MERGE_COPY as COPY } from "../pre-merge-copy.js";
import { cardDetail, fakeClient } from "../testing/fixtures.js";
import { CardDetailPage } from "./CardDetailPage.js";
import { NeedsYouPage } from "./NeedsYouPage.js";

afterEach(cleanup);

const check = (
  label: string,
  status: PreMergeCheckView["status"],
  note: string | null = null,
): PreMergeCheckView => ({
  label,
  status,
  note,
  updated_at: "2026-11-12T00:00:00Z",
});
const merge = (checks: readonly PreMergeCheckView[]): NeedsDecision => ({
  id: "Q-7",
  question: "Merge C-1 into main?",
  context: "",
  why: "确认合并",
  status: "open",
  blocking: true,
  decider: "human",
  card_id: "C-1",
  affected_cards: ["C-1"],
  options: [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: "hold", description: "暂缓", impact: "等待" },
  ],
  recommended: "merge",
  waited_ms: 0,
  trigger: "merge_confirmation",
  category: "general",
  assignment_id: null,
  related_cards: [{ id: "C-1", title: "权限卡" }],
  merge_confirmation: {
    completion: {
      id: "D-9",
      work_item_id: "W-1",
      summary: "完成",
      subject: { kind: "git_head", value: "a".repeat(40) },
    },
    deliveries: [],
    reviews: [],
    known_gaps: [],
    pre_merge_checks: checks,
  },
});
const needs = (q: NeedsDecision): NeedsPage => ({
  decisions: [q],
  human_actions: [],
  incidents: [],
});
const pending = [
  check("独立安全审核", "pending"),
  check("截图核对", "failed", "按钮颜色不对"),
];
const passed = [check("独立安全审核", "passed"), check("截图核对", "passed")];

test("C-160: Needs You warns while checks are open and asks again before confirming", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(pending)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: COPY.region });
  expect(
    within(status).getByText(COPY.waitingTitle(["独立安全审核", "截图核对"])),
  ).toBeTruthy();
  expect(
    within(status).getByText(new RegExp(COPY.status.pending)),
  ).toBeTruthy();
  expect(within(status).getByText(new RegExp(COPY.status.failed))).toBeTruthy();
  expect(within(status).getByText(/按钮颜色不对/)).toBeTruthy();
  expect(screen.queryByText(COPY.readyTitle)).toBeNull();

  const confirm = screen.getByRole("button", { name: "确认合并", exact: true });
  expect(confirm.hasAttribute("disabled")).toBe(false);
  fireEvent.click(confirm);
  const dialog = await screen.findByRole("alertdialog", {
    name: COPY.confirmTitle(2),
  });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  // Q-275: "hold off" is the primary button, "merge anyway" the secondary one.
  expect(
    within(dialog)
      .getByRole("button", { name: COPY.confirmCancel })
      .classList.contains("quiet"),
  ).toBe(false);
  expect(
    within(dialog)
      .getByRole("button", { name: COPY.confirmAnyway })
      .classList.contains("quiet"),
  ).toBe(true);
  expect(recordDecision).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: COPY.confirmCancel }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(recordDecision).not.toHaveBeenCalled();

  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  fireEvent.click(
    within(
      await screen.findByRole("alertdialog", { name: COPY.confirmTitle(2) }),
    ).getByRole("button", { name: COPY.confirmAnyway }),
  );
  await waitFor(() =>
    expect(recordDecision).toHaveBeenCalledWith(
      "p-1",
      "Q-7",
      "merge",
      "",
      expect.any(String),
    ),
  );
});

test("C-160: once every check passes the warning is gone and numbered steps appear", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(passed)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: COPY.region });
  expect(within(status).getByText(COPY.readyTitle)).toBeTruthy();
  expect(within(status).getAllByRole("listitem").length).toBeGreaterThan(2);
  expect(
    within(status).getByText(COPY.readySteps(false)[2] as string),
  ).toBeTruthy();
  expect(screen.queryByText(/请先不要确认/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(recordDecision).toHaveBeenCalled());
});

test("C-160: no checks means no extra prompt", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({ needsYou: async () => needs(merge([])) })}
      projectId="p-1"
    />,
  );
  await screen.findByRole("button", { name: "确认合并", exact: true });
  expect(screen.queryByRole("status", { name: COPY.region })).toBeNull();
});

test("C-160: card detail shows the same waiting prompt and second confirmation", async () => {
  const base = cardDetail();
  const q = merge(pending);
  const detail: CardDetail = {
    ...base,
    card: { ...base.card, status: "awaiting_merge" },
    decisions: [q],
    merge_confirmations: [q],
  };
  const recordDecision = vi.fn(async () => undefined);
  render(
    <CardDetailPage
      client={fakeClient({ card: async () => detail, recordDecision })}
      projectId="p-1"
      cardId="C-1"
    />,
  );
  const region = within(
    await screen.findByRole("region", { name: "合并处理" }),
  );
  expect(
    region.getByText(COPY.waitingTitle(["独立安全审核", "截图核对"])),
  ).toBeTruthy();
  fireEvent.click(
    region.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(recordDecision).not.toHaveBeenCalled();
});

test("C-160: the confirmation dialog takes focus, closes on Escape and returns focus", async () => {
  const recordDecision = vi.fn(async () => undefined);
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () => needs(merge(pending)),
        recordDecision,
      })}
      projectId="p-1"
    />,
  );
  const confirm = await screen.findByRole("button", {
    name: "确认合并",
    exact: true,
  });
  confirm.focus();
  fireEvent.click(confirm);
  const dialog = await screen.findByRole("alertdialog", {
    name: COPY.confirmTitle(2),
  });
  // Focus moves into the dialog, onto the safe choice.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: COPY.confirmCancel }),
    ),
  );
  fireEvent.keyDown(document.activeElement as Element, {
    key: "Escape",
    code: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(confirm));
  expect(recordDecision).not.toHaveBeenCalled();
});

test("C-160: a conclusion for an older version shows as pending and still asks again", async () => {
  render(
    <NeedsYouPage
      client={fakeClient({
        needsYou: async () =>
          needs(
            merge([
              {
                ...check("独立安全审核", "pending", "已审核 a 版本"),
                stale: true,
              },
            ]),
          ),
      })}
      projectId="p-1"
    />,
  );
  const status = await screen.findByRole("status", { name: COPY.region });
  expect(
    within(status).getByText(COPY.waitingTitle(["独立安全审核"])),
  ).toBeTruthy();
  expect(within(status).getByText(new RegExp(COPY.staleNote))).toBeTruthy();
  expect(screen.queryByText(COPY.readyTitle)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "确认合并", exact: true }),
  );
  expect(
    await screen.findByRole("alertdialog", { name: COPY.confirmTitle(1) }),
  ).toBeTruthy();
});
