// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card } from "../testing/fixtures.js";
import { Board } from "./Board.js";

afterEach(cleanup);

if (!globalThis.ResizeObserver)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

function pointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & {
    pointerId?: number;
    pointerType?: string;
    isPrimary?: boolean;
  } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
    clientX: 300,
    clientY: 100,
    ...init,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
    isPrimary: { value: init.isPrimary ?? true },
  });
  fireEvent(target, event);
  return event;
}

function setup() {
  const onOpenCard = vi.fn();
  const onLaneChange = vi.fn();
  const view = render(
    <Board
      cards={Array.from({ length: 12 }, (_, i) => ({
        ...card,
        id: `C-${i + 1}`,
        status: "in_progress" as const,
      }))}
      projectId="p-1"
      lanes={{}}
      onLaneChange={onLaneChange}
      onOpenCard={onOpenCard}
      display={DEFAULT_CARD_DISPLAY}
    />,
  );
  const board = screen.getByRole("region", { name: "看板" });
  Object.defineProperties(board, {
    clientWidth: { configurable: true, value: 800 },
    scrollWidth: { value: 2400 },
    clientHeight: { value: 600 },
  });
  board.scrollLeft = 200;
  const captured = new Set<number>();
  board.setPointerCapture = vi.fn((id: number) => captured.add(id));
  board.hasPointerCapture = (id: number) => captured.has(id);
  board.releasePointerCapture = vi.fn((id: number) => captured.delete(id));
  const lane = screen.getByRole("region", { name: "进行中卡片" });
  const link = board.querySelector(".card-tile-link") as HTMLAnchorElement;
  return { ...view, board, lane, link, onOpenCard, onLaneChange };
}

test.each(["gap", "lane", "heading"])(
  "pans from %s after the threshold, clamps to either end and stops on release",
  (area) => {
    const { board, lane } = setup();
    const target =
      area === "gap"
        ? board
        : area === "lane"
          ? lane
          : (lane.parentElement?.querySelector("h3") as HTMLElement);
    expect(pointer(target, "pointerdown").defaultPrevented).toBe(false);
    expect(board.classList.contains("board-pan-ready")).toBe(true);
    pointer(window, "pointermove", { clientX: 295 });
    expect(board.scrollLeft).toBe(200);
    expect(board.setPointerCapture).not.toHaveBeenCalled();
    expect(
      pointer(window, "pointermove", { clientX: 240 }).defaultPrevented,
    ).toBe(true);
    expect(board.scrollLeft).toBe(260);
    expect(board.classList.contains("board-panning")).toBe(true);
    expect(board.setPointerCapture).toHaveBeenCalledWith(1);
    pointer(window, "pointermove", { clientX: -3000 });
    expect(board.scrollLeft).toBe(1600);
    pointer(window, "pointermove", { clientX: 3000 });
    expect(board.scrollLeft).toBe(0);
    pointer(window, "pointerup");
    expect(board.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(board.className).toBe("board");
    pointer(window, "pointermove", { clientX: 100 });
    expect(board.scrollLeft).toBe(0);
  },
);

test.each([
  ".board-card",
  ".card-title",
  ".card-tile-link",
  ".lane-fold svg",
  ".lane-strip span",
  ".board-load-more",
])("does not pan when pressed on %s", (selector) => {
  const { board } = setup();
  const target = board.querySelector(selector) as HTMLElement;
  expect(target).toBeTruthy();
  expect(pointer(target, "pointerdown").defaultPrevented).toBe(false);
  pointer(window, "pointermove", { clientX: 100 });
  pointer(window, "pointerup");
  expect(board.scrollLeft).toBe(200);
  expect(board.className).toBe("board");
  expect(board.setPointerCapture).not.toHaveBeenCalled();
});

test.each(["input", "textarea", "select", "button", "a", "div"])(
  "preserves native %s and editable controls",
  (tag) => {
    const { board, lane } = setup();
    const control = document.createElement(tag);
    if (tag === "div") control.setAttribute("contenteditable", "true");
    lane.append(control);
    expect(pointer(control, "pointerdown").defaultPrevented).toBe(false);
    expect(
      pointer(window, "pointermove", { clientX: 100 }).defaultPrevented,
    ).toBe(false);
    expect(board.scrollLeft).toBe(200);
  },
);

test("suppresses the drag click but preserves keyboard activation and the next card click", () => {
  const { board, lane, link, onOpenCard } = setup();
  pointer(lane, "pointerdown");
  pointer(window, "pointermove", { clientX: 100 });
  pointer(window, "pointerup");
  fireEvent.click(link, { detail: 1 });
  expect(onOpenCard).not.toHaveBeenCalled();
  fireEvent.click(link, { detail: 0 });
  expect(onOpenCard).toHaveBeenCalledTimes(1);
  pointer(link, "pointerdown");
  pointer(window, "pointerup");
  fireEvent.click(link, { detail: 1 });
  expect(onOpenCard).toHaveBeenCalledTimes(2);
  expect(board.scrollLeft).toBe(400);
});

test("a below-threshold gesture keeps clicks, controls and lane focus available", () => {
  const { lane, link, onOpenCard, onLaneChange } = setup();
  pointer(lane, "pointerdown");
  pointer(window, "pointermove", { clientX: 297 });
  pointer(window, "pointerup");
  fireEvent.click(link, { detail: 1 });
  expect(onOpenCard).toHaveBeenCalledTimes(1);
  lane.focus();
  expect(document.activeElement).toBe(lane);
  fireEvent.click(screen.getByRole("button", { name: "折叠进行中列" }));
  expect(onLaneChange).toHaveBeenCalledWith("in_progress", true);
});

test.each([
  { pointerType: "touch" },
  { pointerType: "pen" },
  { button: 1 },
  { button: 2 },
  { isPrimary: false },
  { clientY: 601 },
])(
  "leaves non-primary mouse/touch/pen/scrollbar gestures native: %j",
  (init) => {
    const { board } = setup();
    expect(pointer(board, "pointerdown", init).defaultPrevented).toBe(false);
    expect(
      pointer(window, "pointermove", { ...init, clientX: 100 })
        .defaultPrevented,
    ).toBe(false);
    expect(board.scrollLeft).toBe(200);
    expect(board.className).toBe("board");
  },
);

test.each(["pointercancel", "lostpointercapture", "blur", "released buttons"])(
  "stops panning after %s and allows the next gesture",
  (end) => {
    const { board } = setup();
    pointer(board, "pointerdown");
    pointer(window, "pointermove", { clientX: 240 });
    if (end === "blur") fireEvent.blur(window);
    else if (end === "released buttons")
      pointer(window, "pointermove", { buttons: 0 });
    else pointer(board, end);
    pointer(window, "pointermove", { clientX: 100 });
    expect(board.scrollLeft).toBe(260);
    expect(board.className).toBe("board");
    pointer(board, "pointerdown");
    pointer(window, "pointermove", { clientX: 200 });
    expect(board.scrollLeft).toBe(360);
  },
);

test("ignores other pointers and does not pan a board without horizontal overflow", () => {
  const { board } = setup();
  pointer(board, "pointerdown");
  pointer(window, "pointermove", { pointerId: 2, clientX: 100 });
  pointer(window, "pointerup", { pointerId: 2 });
  expect(board.scrollLeft).toBe(200);
  pointer(window, "pointerup");
  Object.defineProperty(board, "clientWidth", { value: 2400 });
  pointer(board, "pointerdown");
  pointer(window, "pointermove", { clientX: 100 });
  expect(board.scrollLeft).toBe(200);
  expect(board.className).toBe("board");
});

test("a focusable page ancestor does not make board whitespace interactive", () => {
  const { board, container } = setup();
  // App's main content is a focusable skip-link destination.
  container.tabIndex = -1;
  pointer(board, "pointerdown");
  pointer(window, "pointermove", { clientX: 240 });
  expect(board.scrollLeft).toBe(260);
});

test("unmount releases capture and removes window listeners during a drag", () => {
  const { board, unmount } = setup();
  pointer(board, "pointerdown");
  pointer(window, "pointermove", { clientX: 240 });
  unmount();
  expect(board.releasePointerCapture).toHaveBeenCalledWith(1);
  pointer(window, "pointermove", { clientX: 100 });
  expect(board.scrollLeft).toBe(260);
});
