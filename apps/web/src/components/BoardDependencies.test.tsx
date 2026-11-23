// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CardListItem, CardStatus, DependencyCard } from "../api.js";
import { connectorPath, LINE_ARROW } from "../board-dependency-lines.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card } from "../testing/fixtures.js";
import { Board, type BoardLanes } from "./Board.js";

if (!globalThis.ResizeObserver)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

type Rect = { left: number; top: number; right: number; bottom: number };
/** Synthetic layout: card id → viewport box; everything else is the board. */
let rects: Record<string, Rect>;
let lane: Rect;
const BOARD: Rect = { left: 0, top: 0, right: 1400, bottom: 900 };
const STRIP: Rect = { left: 1300, top: 0, right: 1340, bottom: 900 };
const COUNT: Rect = { left: 1316, top: 40, right: 1324, bottom: 60 };

beforeEach(() => {
  lane = { left: 0, top: 40, right: 1400, bottom: 900 };
  rects = {
    "C-1": { left: 0, top: 100, right: 326, bottom: 200 },
    "C-2": { left: 350, top: 100, right: 676, bottom: 200 },
    "C-3": { left: 700, top: 300, right: 1026, bottom: 400 },
    "C-4": { left: 350, top: 220, right: 676, bottom: 320 },
    "C-5": { left: 350, top: 500, right: 676, bottom: 600 },
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const element = this as HTMLElement;
      const box = element.dataset.cardId
        ? rects[element.dataset.cardId]
        : element.classList.contains("board-lane-cards")
          ? lane
          : element.classList.contains("column-toggle")
            ? STRIP
            : element.classList.contains("board-column-count")
              ? COUNT
              : BOARD;
      const { left, top, right, bottom } = box ?? {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      };
      return {
        left,
        top,
        right,
        bottom,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ref = (id: string, status = "todo"): DependencyCard => ({
  id,
  title: id,
  status,
  satisfied: false,
});
function tile(
  id: string,
  status: CardStatus,
  predecessors: string[] = [],
  successors: string[] = [],
): CardListItem {
  return {
    ...card,
    id,
    title: `卡片 ${id}`,
    status,
    waiting_on: [],
    ...(predecessors.length || successors.length
      ? {
          dependency: {
            predecessors: predecessors.map((p) => ref(p)),
            successors: successors.map((s) => ref(s)),
            waiting_on: [],
            critical_path_length: 0,
          },
        }
      : {}),
  };
}

const CARDS = [
  tile("C-1", "todo", [], ["C-2"]),
  // C-9 is filtered out of the board; C-6 sits in the folded "done" lane.
  tile("C-2", "in_progress", ["C-1", "C-9"], ["C-3", "C-6", "C-5"]),
  tile("C-3", "review", ["C-2"]),
  tile("C-4", "in_progress"),
  tile("C-5", "in_progress", ["C-2"]),
  tile("C-6", "done", ["C-2"]),
];

function setup(cards = CARDS, lanes: BoardLanes = { done: true }) {
  const props = {
    projectId: "p-1",
    onLaneChange: () => {},
    display: DEFAULT_CARD_DISPLAY,
  };
  const view = render(<Board {...props} cards={cards} lanes={lanes} />);
  const board = screen.getByRole("region", { name: "看板" });
  const linkOf = (id: string) =>
    board.querySelector(
      `[data-card-id="${id}"] .card-tile-link`,
    ) as HTMLElement;
  const rerender = (next: BoardLanes) =>
    view.rerender(<Board {...props} cards={cards} lanes={next} />);
  return { ...view, board, linkOf, rerender };
}

function hover(target: Element, pointerType = "mouse") {
  const event = new MouseEvent("pointerover", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}
const svg = (container: HTMLElement) =>
  container.querySelector("[data-board-dependencies]");
const edges = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-edge]")].map((e) =>
    e.getAttribute("data-edge"),
  );
const related = (board: HTMLElement) =>
  [...board.querySelectorAll("[data-dependency-related]")].map(
    (e) => (e as HTMLElement).dataset.cardId,
  );

test("the board draws no dependency lines by default", () => {
  const { container, board } = setup();
  expect(svg(container)).toBeNull();
  expect(related(board)).toEqual([]);
});

test("hovering a card draws lines to visible prerequisites and dependents, leaving clears them", () => {
  const { container, board, linkOf } = setup();
  hover(linkOf("C-2"));
  const lines = svg(container);
  expect(lines?.getAttribute("aria-hidden")).toBe("true");
  // C-9 is not on the board; C-6 points at the folded lane's strip.
  expect(edges(container)).toEqual([
    "C-1>C-2",
    "C-2>C-3",
    "C-2>C-6",
    "C-2>C-5",
  ]);
  expect(related(board).sort()).toEqual(["C-1", "C-3", "C-5"]);
  // The board paints over the lines: they sit before it in the frame.
  expect(lines?.nextElementSibling).toBe(board);
  const d = (key: string) =>
    container.querySelector(`[data-edge="${key}"]`)?.getAttribute("d");
  expect(d("C-1>C-2")).toBe(
    connectorPath(rects["C-1"] as Rect, rects["C-2"] as Rect),
  );
  expect(d("C-2>C-6")).toBe(
    connectorPath(rects["C-2"] as Rect, {
      left: STRIP.left,
      right: STRIP.right,
      top: COUNT.top,
      bottom: COUNT.bottom,
    }),
  );
  // Same lane: bows out past the right edges and arrows into C-5's right edge.
  expect(d("C-2>C-5")).toMatch(new RegExp(`${676 + LINE_ARROW} 550$`));
  // Moving to the gap or off the board removes every line and highlight.
  hover(board);
  expect(svg(container)).toBeNull();
  expect(related(board)).toEqual([]);
  hover(linkOf("C-2"));
  expect(svg(container)).not.toBeNull();
  fireEvent.pointerLeave(board);
  expect(svg(container)).toBeNull();
  expect(related(board)).toEqual([]);
});

test("a card without dependencies draws nothing; touch does not trigger hover", () => {
  const { container, linkOf } = setup();
  hover(linkOf("C-4"));
  expect(svg(container)).toBeNull();
  hover(linkOf("C-2"), "touch");
  expect(svg(container)).toBeNull();
});

test("keyboard focus shows the lines and blur hides them", () => {
  const { container, linkOf } = setup();
  act(() => linkOf("C-2").focus());
  expect(edges(container)).toContain("C-1>C-2");
  act(() => linkOf("C-2").blur());
  expect(svg(container)).toBeNull();
});

test("related cards scrolled out of their lane get no line", () => {
  rects["C-3"] = { left: 700, top: 905, right: 1026, bottom: 1005 };
  // Only 4px of C-1 shows at the top of its lane: treated as out of view.
  rects["C-1"] = { left: 0, top: 0, right: 326, bottom: 44 };
  const { container, board, linkOf } = setup();
  hover(linkOf("C-2"));
  expect(edges(container)).toEqual(["C-2>C-6", "C-2>C-5"]);
  expect(related(board)).toEqual(["C-5"]);
});

test("a partly visible card is joined at the middle of its visible part", () => {
  rects["C-3"] = { left: 700, top: 800, right: 1026, bottom: 1000 };
  const { container, linkOf } = setup();
  hover(linkOf("C-2"));
  const d = container.querySelector('[data-edge="C-2>C-3"]')?.getAttribute("d");
  expect(d).toMatch(/ 850$/);
});

test("lines follow scrolling and leave nothing behind when the lane folds", async () => {
  const { container, board, linkOf, rerender } = setup();
  hover(linkOf("C-2"));
  rects["C-3"] = { left: 700, top: 500, right: 1026, bottom: 600 };
  fireEvent.scroll(board.querySelector(".board-lane-cards") as Element);
  await waitFor(() =>
    expect(
      container.querySelector('[data-edge="C-2>C-3"]')?.getAttribute("d"),
    ).toMatch(/ 550$/),
  );
  // Folding the hovered card's lane removes it: no stale lines remain.
  rerender({ done: true, in_progress: true });
  expect(svg(container)).toBeNull();
  expect(related(board)).toEqual([]);
});

test("unrelated lanes folding while hovering redraws to the strip", () => {
  const { container, linkOf, rerender } = setup(CARDS, {});
  hover(linkOf("C-2"));
  expect(edges(container)).toContain("C-2>C-3");
  rerender({ review: true });
  expect(
    container.querySelector('[data-edge="C-2>C-3"]')?.getAttribute("d"),
  ).toMatch(new RegExp(`${STRIP.left - LINE_ARROW} 50$`));
});
