// @vitest-environment jsdom
/** Phase 1.5 §9 U.S-2 #1: the board is one row that scrolls inside its own strip. */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CardListItem } from "../api.js";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card } from "../testing/fixtures.js";
import { Board } from "./Board.js";

afterEach(cleanup);

const cards: readonly CardListItem[] = [
  { ...card, id: "C-1", title: "进行中的卡片", status: "in_progress" },
  { ...card, id: "C-2", title: "待开始的卡片", status: "todo" },
  { ...card, id: "C-3", title: "已完成卡片", status: "done" },
];

const renderBoard = () =>
  render(
    <Board
      cards={cards}
      projectId="p-1"
      lanes={{}}
      onLaneChange={() => {}}
      display={DEFAULT_CARD_DISPLAY}
    />,
  );

const styles = readFileSync(
  new NodeURL("../styles.css", import.meta.url),
  "utf8",
);
const rule = (selector: string) => {
  const start = styles.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
};

test("U6a board columns stay in one row inside a horizontally scrollable strip", () => {
  const board = rule(".board");
  expect(board).toContain("display: flex;");
  expect(board).toContain("flex-wrap: nowrap;");
  expect(board).toContain("overflow-x: auto;");
  // The scrollbar is styled explicitly so it does not disappear on macOS.
  expect(rule(":is(.board, .board-lane-cards)")).toContain(
    "scrollbar-width: thin;",
  );
  expect(styles).toContain(
    ":is(.board, .board-lane-cards)::-webkit-scrollbar {",
  );
  expect(rule(".board-column")).toContain("flex: 0 0 420px;");
  expect(rule(".board-column")).toContain("min-width: 0;");
  const collapsed = rule(".board-column-collapsed");
  expect(collapsed).toContain("flex: 0 0 48px;");
  expect(collapsed).toContain("min-width: 48px;");
  expect(rule(".board-scroll")).toContain("min-width: 0;");
  // The page itself never scrolls sideways: the strip cannot widen the content.
  expect(rule(".content")).toContain("min-width: 0;");
});

test("lanes constrain card height and keep headings outside independent vertical scroll roots", () => {
  expect(rule(".cards-page-board")).toContain("100dvh");
  expect(rule(".cards-page-board")).toContain("flex-direction: column;");
  expect(rule(".board-scroll")).toContain("flex: 1;");
  expect(rule(".board")).toContain("height: 100%;");
  expect(rule(".board-column")).toContain("height: 100%;");
  expect(rule(".board-column")).toContain("min-height: 0;");
  expect(rule(".board-lane-cards")).toContain("overflow-y: auto;");
  expect(rule(".board-lane-cards")).toContain("min-height: 0;");
  expect(rule(".board-column-title")).toContain("flex-shrink: 0;");
});

test.each(["light", "dark"])(
  "%s lanes and empty-column controls have no surface or frame, while compact cards retain their surface",
  (theme) => {
    // Check the cascade against the global quiet-button background as well as
    // both theme palettes. Browser geometry is covered by the layout contracts.
    const darkStart = styles.indexOf("@media (prefers-color-scheme: dark)");
    const darkPalette = styles.slice(
      darkStart,
      styles.indexOf("\n}\n", darkStart),
    );
    const palette =
      theme === "dark"
        ? darkPalette.slice(darkPalette.indexOf(":root"))
        : rule(":root");
    const style = document.createElement("style");
    style.textContent = [
      palette,
      rule("button"),
      rule("button.quiet,\n.filter"),
      rule(".board-column"),
      rule(".board-column-collapsed"),
      rule(".column-toggle"),
      rule(".board-column .column-toggle,\n.board-column .board-load-more"),
      rule(
        ".board-column .column-toggle:hover,\n.board-column .board-load-more:hover",
      ),
      rule(".board-column-title"),
      rule(".card-tile"),
    ].join("\n");
    document.head.append(style);
    try {
      render(
        <Board
          cards={Array.from({ length: 11 }, (_, index) => ({
            ...card,
            id: `C-${index + 1}`,
          }))}
          projectId="p-1"
          lanes={{ todo: false }}
          onLaneChange={() => {}}
          display={DEFAULT_CARD_DISPLAY}
        />,
      );
      const collapsed = screen.getByRole("region", { name: "待整理" });
      const expanded = screen.getByRole("region", { name: "待开始" });
      const active = screen.getByRole("region", { name: "进行中" });
      for (const lane of [collapsed, expanded, active]) {
        expect(getComputedStyle(lane).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(lane).borderTopWidth).toBe("0px");
        const heading = within(lane).getByRole("heading");
        expect(getComputedStyle(heading).backgroundColor).toBe(
          "rgba(0, 0, 0, 0)",
        );
      }
      for (const control of [
        screen.getByRole("button", { name: "展开待整理列" }),
        screen.getByRole("button", { name: "折叠待开始列" }),
        screen.getByRole("button", { name: "加载更多进行中卡片" }),
      ]) {
        expect(getComputedStyle(control).backgroundColor).toBe(
          "rgba(0, 0, 0, 0)",
        );
        expect(getComputedStyle(control).borderTopWidth).toBe("0px");
      }
      expect(rule(".card-tile")).toContain("background: var(--surface);");
      expect(rule(".board-column-collapsed .status")).toContain(
        "writing-mode: vertical-rl;",
      );
      for (const token of ["surface", "text", "text-muted", "accent"])
        expect(palette).toContain(`--${token}:`);
    } finally {
      style.remove();
    }
  },
);

test("unframed empty lanes keep their count and expansion control", () => {
  const onLaneChange = vi.fn();
  const props = {
    cards,
    projectId: "p-1",
    lanes: {},
    onLaneChange,
    display: DEFAULT_CARD_DISPLAY,
  };
  const view = render(<Board {...props} />);
  const button = screen.getByRole("button", { name: "展开待整理列" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.textContent).toBe("待整理0");
  fireEvent.click(button, { detail: 1 });
  expect(onLaneChange).toHaveBeenCalledWith("backlog", false);
  view.rerender(<Board {...props} lanes={{ backlog: false }} />);
  const lane = screen.getByRole("region", { name: "待整理" });
  expect(within(lane).getByText("已显示全部 0 张")).toBeTruthy();
  const close = within(lane).getByRole("button", { name: "折叠待整理列" });
  expect(close.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(close, { detail: 1 });
  expect(onLaneChange).toHaveBeenLastCalledWith("backlog", true);
});

test("narrow screens release the sidebar width and let filters wrap inside the page", () => {
  const mobile = styles.slice(styles.indexOf("@media (max-width: 760px)"));
  expect(mobile).toContain("grid-template-columns: minmax(0, 1fr);");
  expect(mobile).toContain("position: static;");
  expect(mobile).toContain("grid-column: 1;");
  expect(rule(".cards-page .filter-bar .filter-controls")).toContain(
    "flex-wrap: wrap;",
  );
  expect(rule(".board")).toContain("max-width: 100%;");
  expect(rule(".board-scroll")).toContain("width: 100%;");
});

test("Shift+wheel reaches the right end on a phone-width board without hijacking ordinary or horizontal wheel events", () => {
  renderBoard();
  const strip = screen.getByRole("region", { name: "看板" });
  Object.defineProperties(strip, {
    scrollWidth: { configurable: true, value: 1800 },
    clientWidth: { configurable: true, value: 320 },
  });
  const lane = screen.getByRole("region", { name: "进行中卡片" });
  expect(fireEvent.wheel(lane, { deltaY: 300, cancelable: true })).toBe(true);
  expect(strip.scrollLeft).toBe(0);
  expect(
    fireEvent.wheel(lane, { shiftKey: true, deltaY: 5000, cancelable: true }),
  ).toBe(false);
  expect(strip.scrollLeft).toBe(1480);
  expect(document.querySelector(".board-fade")).toBeNull();
  expect(
    fireEvent.wheel(lane, { shiftKey: true, deltaX: -100, cancelable: true }),
  ).toBe(true);
  fireEvent.wheel(lane, { shiftKey: true, deltaY: -1, deltaMode: 2 });
  expect(strip.scrollLeft).toBe(1160);
  expect(document.querySelector(".board-fade")).toBeTruthy();
  fireEvent.wheel(lane, { shiftKey: true, deltaY: -5000 });
  expect(strip.scrollLeft).toBe(0);
});

test("U6a every status column renders as one child of the single board strip", () => {
  renderBoard();
  expect(screen.getByText(/空列默认收起/).textContent).not.toContain("折行");
  const strip = document.querySelector(".board");
  expect(strip).toBeTruthy();
  const columns = [...document.querySelectorAll(".board-column")];
  expect(columns).toHaveLength(7);
  for (const column of columns) expect(column.parentElement).toBe(strip);
});

test("U6a the edge fade appears while columns are hidden and disappears at the right end", () => {
  const scrollWidth = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollWidth",
    ),
    clientWidth = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientWidth",
    );
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get: () => 1800,
  });
  Object.defineProperty(Element.prototype, "clientWidth", {
    configurable: true,
    get: () => 1440,
  });
  try {
    renderBoard();
    const strip = document.querySelector(".board") as HTMLElement;
    expect(document.querySelector(".board-fade")).toBeTruthy();
    strip.scrollLeft = 360;
    fireEvent.scroll(strip);
    expect(document.querySelector(".board-fade")).toBeNull();
    strip.scrollLeft = 0;
    fireEvent.scroll(strip);
    expect(document.querySelector(".board-fade")).toBeTruthy();
  } finally {
    if (scrollWidth)
      Object.defineProperty(Element.prototype, "scrollWidth", scrollWidth);
    if (clientWidth)
      Object.defineProperty(Element.prototype, "clientWidth", clientWidth);
  }
});

test("U6a the fade lives outside the scroller and never blocks clicks", () => {
  expect(rule(".board-fade")).toContain("pointer-events: none;");
  expect(rule(".board-fade")).toContain("position: absolute;");
});
