// @vitest-environment jsdom
/** C-64: lanes fold and unfold by hand; the human's setting beats the empty-lane default. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card, fakeClient } from "../testing/fixtures.js";
import { useBoardLanes } from "../useBoardLanes.js";
import { CardListPage } from "../views/CardListPage.js";
import { Board, type BoardLanes, laneCollapsed } from "./Board.js";

if (!globalThis.ResizeObserver)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const many: readonly CardListItem[] = Array.from({ length: 12 }, (_, i) => ({
  ...card,
  id: `C-${i + 1}`,
  title: `进行中 ${i + 1}`,
  status: "in_progress",
}));

function Harness({ initial = {} }: { initial?: BoardLanes }) {
  const [lanes, setLanes] = useState(initial);
  return (
    <Board
      cards={many}
      projectId="p-1"
      lanes={lanes}
      onLaneChange={(status, collapsed) =>
        setLanes((old) => ({ ...old, [status]: collapsed }))
      }
      display={DEFAULT_CARD_DISPLAY}
    />
  );
}
test("manual settings override the empty-lane default in both directions", () => {
  expect(laneCollapsed({}, "backlog", 0)).toBe(true);
  expect(laneCollapsed({}, "in_progress", 3)).toBe(false);
  expect(laneCollapsed({ backlog: false }, "backlog", 0)).toBe(false);
  expect(laneCollapsed({ in_progress: true }, "in_progress", 3)).toBe(true);
  // Inherited object keys are not settings.
  expect(laneCollapsed({}, "toString", 0)).toBe(true);
});

test("folding a full lane leaves a strip with icon, label and count and renders no cards", () => {
  render(<Harness />);
  const lane = screen.getByRole("region", { name: "进行中" });
  expect(lane.querySelectorAll(".card-tile")).toHaveLength(10);
  const fold = within(lane).getByRole("button", { name: "折叠进行中列" });
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(fold.querySelector("svg.lane-toggle-icon")).toBeTruthy();
  fireEvent.click(fold);
  expect(lane.className).toContain("board-column-collapsed");
  expect(lane.querySelectorAll(".card-tile")).toHaveLength(0);
  expect(within(lane).queryByRole("button", { name: /加载更多/ })).toBeNull();
  const strip = within(lane).getByRole("button", { name: "展开进行中列" });
  expect(strip.getAttribute("aria-expanded")).toBe("false");
  expect(strip.textContent).toBe("进行中12");
  expect(strip.querySelector(".status-icon")).toBeTruthy();
  expect(strip.querySelector("svg.lane-toggle-icon")).toBeTruthy();
  // aria-controls points at the (hidden) lane body.
  const body = document.getElementById(
    strip.getAttribute("aria-controls") ?? "",
  );
  expect(body?.hidden).toBe(true);
  // Focus follows the toggle so keyboard users stay in place.
  expect(document.activeElement).toBe(strip);
  expect(screen.getByRole("status").textContent).toBe("已折叠 进行中列");
  // Clicking anywhere on the strip expands it again; a mouse click (detail 1)
  // does not move focus, so no tooltip is left open.
  fireEvent.click(strip.querySelector(".board-column-count") as HTMLElement, {
    detail: 1,
  });
  expect(lane.className).not.toContain("board-column-collapsed");
  expect(lane.querySelectorAll(".card-tile")).toHaveLength(10);
  expect(document.activeElement).not.toBe(
    within(lane).getByRole("button", { name: "折叠进行中列" }),
  );
  expect(screen.getByRole("status").textContent).toBe("已展开 进行中列");
});

test("batch progress survives folding and the empty lane the human opened stays open", () => {
  render(<Harness initial={{ backlog: false }} />);
  const lane = screen.getByRole("region", { name: "进行中" });
  fireEvent.click(
    within(lane).getByRole("button", { name: "加载更多进行中卡片" }),
  );
  expect(lane.querySelectorAll(".card-tile")).toHaveLength(12);
  fireEvent.click(within(lane).getByRole("button", { name: "折叠进行中列" }));
  fireEvent.click(within(lane).getByRole("button", { name: "展开进行中列" }));
  expect(lane.querySelectorAll(".card-tile")).toHaveLength(12);
  const backlog = screen.getByRole("region", { name: "待整理" });
  expect(backlog.className).not.toContain("board-column-collapsed");
  expect(within(backlog).getByText("没有卡片")).toBeTruthy();
});

test("toggles are native buttons, so Enter and Space activate them from the keyboard", () => {
  render(<Harness />);
  const fold = screen.getByRole("button", { name: "折叠进行中列" });
  expect(fold.tagName).toBe("BUTTON");
  expect(fold.getAttribute("type")).toBe("button");
  expect(fold.tabIndex).toBe(0);
  const strip = screen.getByRole("button", { name: "展开待整理列" });
  expect(strip.tagName).toBe("BUTTON");
  expect(strip.tabIndex).toBe(0);
});

test("tooltips name the action", async () => {
  render(<Harness />);
  fireEvent.focus(screen.getByRole("button", { name: "折叠进行中列" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain(
    "折叠此列",
  );
});

const page = (cards: readonly CardListItem[]) => ({
  project_id: "p-1",
  filter: "all" as const,
  cards,
  counts: { total: cards.length, needs_me: 0, agent: 0 },
});

test("the saved fold is read from project preferences and a failed save rolls back with a retry", async () => {
  window.location.hash = "#/p/p-1/cards?view=board";
  const setBoardLane = vi
    .fn()
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValue(undefined);
  const client = fakeClient({
    cards: async () => page(many),
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
      board_collapsed_lanes: { in_progress: true },
    }),
    setBoardLane,
  });
  render(<CardListPage client={client} projectId="p-1" view="board" />);
  const strip = await screen.findByRole("button", { name: "展开进行中列" });
  expect(document.querySelectorAll(".card-tile")).toHaveLength(0);
  fireEvent.click(strip);
  await waitFor(() =>
    expect(setBoardLane).toHaveBeenCalledWith(
      "p-1",
      "in_progress",
      false,
      expect.any(String),
    ),
  );
  // The failure restores the saved fold and offers to save again.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("进行中列的折叠设置没有保存");
  await screen.findByRole("button", { name: "展开进行中列" });
  fireEvent.click(within(alert).getByRole("button", { name: "重新保存" }));
  await screen.findByRole("button", { name: "折叠进行中列" });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(setBoardLane).toHaveBeenCalledTimes(2);
});

test("writes are sent in click order", async () => {
  window.location.hash = "#/p/p-1/cards?view=board";
  const order: string[] = [];
  let release: () => void = () => {};
  const client = fakeClient({
    cards: async () => page(many),
    setBoardLane: (_project, lane, collapsed) => {
      order.push(`${lane}:${collapsed}`);
      return order.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    },
  });
  render(<CardListPage client={client} projectId="p-1" view="board" />);
  fireEvent.click(await screen.findByRole("button", { name: "折叠进行中列" }));
  fireEvent.click(screen.getByRole("button", { name: "展开进行中列" }));
  await waitFor(() => expect(order).toEqual(["in_progress:true"]));
  release();
  await waitFor(() =>
    expect(order).toEqual(["in_progress:true", "in_progress:false"]),
  );
});

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("V-205: a stale failure on a lane cannot undo a later successful click", async () => {
  const writes = [deferred(), deferred(), deferred()];
  let saved = false;
  let call = 0;
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
      board_collapsed_lanes: { in_progress: false },
    }),
    setBoardLane: async (_project, _lane, collapsed) => {
      const write = writes[call++];
      if (!write) throw new Error("unexpected write");
      await write.promise;
      saved = collapsed;
    },
  });
  const hook = renderHook(() => useBoardLanes(client, "p-1"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.setLane("in_progress", true));
  act(() => hook.result.current.setLane("in_progress", false));
  act(() => hook.result.current.setLane("in_progress", true));
  expect(hook.result.current.lanes.in_progress).toBe(true);
  await act(async () => writes[0]?.reject(new Error("first request failed")));
  await act(async () => writes[1]?.resolve());
  await act(async () => writes[2]?.resolve());
  await waitFor(() => expect(call).toBe(3));
  expect(saved).toBe(true);
  expect(hook.result.current.lanes.in_progress).toBe(true);
  expect(hook.result.current.error).toBeUndefined();
  expect(hook.result.current.retry).toBeUndefined();
});

test("V-205: when the newest click fails the lane falls back to the last value the server accepted", async () => {
  const writes = [deferred(), deferred()];
  let call = 0;
  const client = fakeClient({
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
    }),
    setBoardLane: async () => {
      const write = writes[call++];
      if (!write) throw new Error("unexpected write");
      await write.promise;
    },
  });
  const hook = renderHook(() => useBoardLanes(client, "p-1"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.setLane("in_progress", true));
  act(() => hook.result.current.setLane("in_progress", false));
  await act(async () => writes[0]?.resolve());
  await act(async () => writes[1]?.reject(new Error("offline")));
  await waitFor(() =>
    expect(hook.result.current.error).toBe(
      "进行中列的折叠设置没有保存：offline",
    ),
  );
  // The server holds the first click, so that is what the lane shows.
  expect(hook.result.current.lanes.in_progress).toBe(true);
  // A new click on the lane clears its stale error.
  act(() => hook.result.current.setLane("in_progress", true));
  expect(hook.result.current.error).toBeUndefined();
});

test("V-205: a failed preference read is reported with a retry that restores the saved lanes", async () => {
  window.location.hash = "#/p/p-1/cards?view=board";
  let fail = true;
  const client = fakeClient({
    cards: async () => page(many),
    preferences: async () => {
      if (fail) throw new Error("read failed");
      return {
        auto_merge_after_minutes: null,
        merge_gate_enabled: false,
        board_collapsed_lanes: { in_progress: true },
      };
    },
  });
  render(<CardListPage client={client} projectId="p-1" view="board" />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("看板折叠设置读取失败，暂按默认显示");
  expect(screen.getByRole("button", { name: "折叠进行中列" })).toBeTruthy();
  fail = false;
  fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "展开进行中列" });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("V-205: a card refresh re-reads the saved lanes", async () => {
  window.location.hash = "#/p/p-1/cards?view=board";
  let lanes: Record<string, boolean> = {};
  const client = fakeClient({
    cards: async () => page(many),
    preferences: async () => ({
      auto_merge_after_minutes: null,
      merge_gate_enabled: false,
      board_collapsed_lanes: lanes,
    }),
  });
  const view = render(
    <CardListPage client={client} projectId="p-1" view="board" />,
  );
  await screen.findByRole("button", { name: "折叠进行中列" });
  lanes = { in_progress: true };
  view.rerender(
    <CardListPage client={client} projectId="p-1" view="board" revision={1} />,
  );
  await screen.findByRole("button", { name: "展开进行中列" });
});
