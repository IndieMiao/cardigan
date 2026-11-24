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
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card, cardDetail, fakeClient, NOW } from "../testing/fixtures.js";
import { Board } from "./Board.js";
import { CardHoldActions } from "./CardHold.js";
import { CardStatusLine } from "./CardStatusLine.js";

if (!globalThis.ResizeObserver) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

afterEach(cleanup);
const required = <T,>(value: T | null): T => {
  if (value === null) throw new Error("Missing fixture element");
  return value;
};
const hold = {
  reason: "等待现场".repeat(30),
  resume_condition: "现场证据已核对",
  set_by: "human" as const,
  set_at: NOW,
};

test("board subtracts held cards from the main count and groups them below active work", async () => {
  render(
    <Board
      projectId="p-1"
      cards={[
        { ...card, status: "review", why: "正在审核" },
        { ...card, id: "C-2", title: "暂停工作", status: "review", hold },
      ]}
      lanes={{}}
      onLaneChange={vi.fn()}
      display={DEFAULT_CARD_DISPLAY}
    />,
  );
  const lane = screen.getByRole("region", { name: "审核中", exact: true });
  expect(lane.querySelector(".board-column-count")?.textContent).toBe("1");
  const group = required(
    within(lane).getByText("已暂停 · 1 张").closest("details"),
  );
  expect(group.open).toBe(false);
  fireEvent.click(within(group).getByText("已暂停 · 1 张"));
  expect(group.open).toBe(true);
  expect(within(group).queryByText(`原因：${hold.reason}`)).toBeNull();
  act(() => within(group).getByRole("button", { name: "已暂停" }).focus());
  const tip = await screen.findByRole("tooltip");
  expect(within(tip).getByText(`原因：${hold.reason}`)).toBeTruthy();
  expect(
    within(tip).getByText(`恢复条件：${hold.resume_condition}`),
  ).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  act(() =>
    within(lane).getAllByRole("button", { name: "审核中" })[0]?.focus(),
  );
  expect(
    within(await screen.findByRole("tooltip")).getByText("正在审核"),
  ).toBeTruthy();
});

test("server lane totals count all held cards beyond the loaded page", () => {
  render(
    <Board
      projectId="p-1"
      cards={[{ ...card, status: "review", hold }]}
      lanes={{}}
      onLaneChange={vi.fn()}
      display={DEFAULT_CARD_DISPLAY}
      remote={{
        lanes: { review: { total: 12, held_total: 8, next_cursor: "next" } },
        pending: false,
        load: vi.fn(),
      }}
    />,
  );
  const lane = screen.getByRole("region", { name: "审核中", exact: true });
  expect(lane.querySelector(".board-column-count")?.textContent).toBe("4");
  expect(within(lane).getByText("已暂停 · 8 张")).toBeTruthy();
});

test("C-700: hold actions only resume a paused card; pausing lives in the ⋯ menu", async () => {
  const updateCard = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValue(undefined);
  const onSaved = vi.fn();
  const client = fakeClient({ updateCard });
  const view = render(
    <CardHoldActions
      card={card}
      client={client}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <CardHoldActions
      card={{ ...card, hold }}
      client={client}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  expect(screen.queryByRole("button", { name: "暂停卡片" })).toBeNull();
  expect(screen.queryByRole("button", { name: "修改暂停信息" })).toBeNull();
  const resume = screen.getByRole("button", { name: "解除暂停" });
  fireEvent.click(resume);
  await waitFor(() => expect(resume.hasAttribute("disabled")).toBe(false));
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  // A retry after an uncertain failure reuses the idempotency key.
  expect(updateCard.mock.calls[0]).toEqual(updateCard.mock.calls[1]);
  expect(updateCard.mock.calls[0]?.[2]).toEqual({ hold: null });
});

test("held detail status points to the full explanation without repeating its prose", () => {
  const held = {
    ...card,
    hold,
    waiting_on: [
      {
        kind: "blocked" as const,
        ref: card.id,
        label: `已暂停：${hold.reason}`,
      },
    ],
  };
  render(
    <>
      <CardStatusLine detail={cardDetail({ card: held })} />
      <CardHoldActions
        card={held}
        client={fakeClient()}
        projectId="p-1"
        onSaved={vi.fn()}
      />
    </>,
  );
  expect(screen.getByText("已暂停，见下方说明")).toBeTruthy();
  expect(screen.getAllByText(`原因：${hold.reason}`)).toHaveLength(1);
  expect(document.querySelector(".merge-exception")).toBeNull();
});

test.each(["done", "cancelled"] as const)(
  "a closed paused card (%s) shows the pause without a resume action",
  (status) => {
    render(
      <CardHoldActions
        card={{ ...card, status, hold }}
        client={fakeClient()}
        projectId="p-1"
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText(`恢复条件：${hold.resume_condition}`)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  },
);
