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
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card, fakeClient, NOW } from "../testing/fixtures.js";
import { Board } from "./Board.js";
import { CardHoldActions } from "./CardHold.js";

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

test("board subtracts held cards from the main count and groups them below active work", () => {
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
  expect(within(group).getByText(`原因：${hold.reason}`)).toBeTruthy();
  expect(
    within(group).getByText(`恢复条件：${hold.resume_condition}`),
  ).toBeTruthy();
  expect(within(lane).getByText("正在审核")).toBeTruthy();
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

test("hold form requires both fields, preserves idempotency on retry and restores focus", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: "暂停卡片" }));
  expect(document.activeElement).toBe(screen.getByLabelText("暂停原因"));
  fireEvent.submit(required(screen.getByLabelText("暂停原因").closest("form")));
  expect(updateCard).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("暂停原因"), {
    target: { value: "等待现场" },
  });
  fireEvent.change(screen.getByLabelText("恢复条件"), {
    target: { value: "证据齐备" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存暂停信息" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "保存暂停信息" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存暂停信息" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(updateCard.mock.calls[0]).toEqual(updateCard.mock.calls[1]);
  expect(updateCard.mock.calls[0]?.[2]).toEqual({
    hold: { reason: "等待现场", resume_condition: "证据齐备" },
  });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "暂停卡片" }),
  );
  view.rerender(
    <CardHoldActions
      card={{ ...card, hold }}
      client={client}
      projectId="p-1"
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "解除暂停" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(updateCard.mock.calls[2]?.[2]).toEqual({ hold: null });
});
