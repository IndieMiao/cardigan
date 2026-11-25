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
import { card, NOW } from "../testing/fixtures.js";
import { Board } from "./Board.js";

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
