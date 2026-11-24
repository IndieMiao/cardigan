// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { DEFAULT_CARD_DISPLAY } from "../card-display.js";
import { card } from "../testing/fixtures.js";
import { BoardCard } from "./BoardCard.js";
import { Drawer } from "./Drawer.js";
import { EmployeeIdentity } from "./EmployeeIdentity.js";
import { IdTag } from "./IdTag.js";
import { CardLink } from "./Operations.js";
import { TimelineVersion } from "./TimelineVersion.js";
import { Tooltip } from "./Tooltip.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const style = document.createElement("style");
beforeAll(() => {
  style.textContent = readFileSync(
    new NodeURL("../styles.css", import.meta.url),
    "utf8",
  );
  document.head.append(style);
});
afterAll(() => style.remove());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a card link clears its header, remeasures on reopening and flips at the viewport edge", async () => {
  let top = 200;
  let linkTop = 300;
  const { container } = render(
    <section className="execution-card">
      <span>员工姓名</span>
      <CardLink projectId="p-1" id="C-1" tooltipClearAbove=".execution-card" />
    </section>,
  );
  const link = screen.getByRole("link", { name: "C-1 卡片" });
  const section = container.querySelector("section");
  if (!section) throw new Error("Missing boundary");
  vi.spyOn(section, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, top, 300, 150),
  );
  vi.spyOn(link, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, linkTop, 74, 32),
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    900,
  );
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1440,
  );
  // C-691: the 5px the arrow used to add is part of the offset now. jsdom
  // measured the arrow as 0px, so these jsdom positions move by 5px; in a
  // browser the hint opens where it did (see test-support/c691-capture.mjs).
  for (const [headerTop, anchorTop, side, hintTop] of [
    [200, 300, "top", 189],
    [170, 300, "top", 159],
    [-20, 30, "bottom", 123],
  ] as const) {
    top = headerTop;
    linkTop = anchorTop;
    act(() => link.focus());
    const hint = screen.getByRole("tooltip");
    await waitFor(() => {
      expect(hint.dataset.side).toBe(side);
      expect(hint.parentElement?.style.transform).toBe(
        `translate(137px, ${hintTop}px)`,
      );
    });
    expect(link.getAttribute("aria-describedby")).toBe(hint.id);
    act(() => link.blur());
  }
});

test("hover waits 1000ms, leaving cancels it and reopening never skips the delay", () => {
  vi.useFakeTimers();
  render(
    <Tooltip content="查看详情">
      <button type="button">详情</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "详情" });
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerLeave(trigger);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip").textContent).toBe("查看详情");
  // C-691: tips share the avatar card's edge, which has no arrow.
  expect(document.querySelector(".ui-tooltip svg")).toBeNull();
  fireEvent.keyDown(trigger, { key: "Escape" });
  fireEvent.pointerLeave(trigger);
  fireEvent.pointerMove(trigger);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("tooltip")).toBeTruthy();
});

test("keyboard focus reveals the hint immediately and blur dismisses it", () => {
  vi.useFakeTimers();
  render(
    <Tooltip content="查看详情">
      <button type="button">详情</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "详情" });
  fireEvent.focus(trigger);
  expect(screen.getByRole("tooltip").textContent).toBe("查看详情");
  fireEvent.blur(trigger);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test.each([
  {
    name: "card link",
    element: <IdTag id="C-1" href="#/p/p-1/cards/C-1" />,
    text: "C-1 卡片",
  },
  {
    name: "employee metadata",
    element: (
      <EmployeeIdentity author_display="开发工程师" metadata="员工信息" />
    ),
    text: "员工信息",
  },
  {
    name: "board title",
    element: (
      <BoardCard card={card} projectId="p-1" display={DEFAULT_CARD_DISPLAY} />
    ),
    text: card.title,
  },
])(
  "$name keeps its description without intercepting pointer input",
  ({ name, element, text }) => {
    const { container } = render(element);
    const trigger = container.querySelector<HTMLElement>(
      name === "board title" ? ".card-tile-link" : "a, button",
    );
    if (!trigger) throw new Error("Missing tooltip trigger");
    act(() => trigger.focus());
    const hint = screen.getByRole("tooltip");
    expect(hint.textContent).toBe(text);
    expect(trigger.getAttribute("aria-describedby")).toBe(hint.id);
    // jsdom cannot hit-test geometry; cover both layers' computed styles here.
    // Browser measurements separately verify elementFromPoint and real input.
    expect(getComputedStyle(hint).pointerEvents).toBe("none");
    expect(
      getComputedStyle(hint.parentElement as HTMLElement).pointerEvents,
    ).toBe("none");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

test("modal layering does not make a passive hint intercept clicks", () => {
  render(
    <Drawer open onOpenChange={() => {}} title="详情">
      <Tooltip content="查看详情">
        <button type="button">详情</button>
      </Tooltip>
    </Drawer>,
  );
  act(() => screen.getByRole("button", { name: "详情" }).focus());
  expect(getComputedStyle(document.body).pointerEvents).toBe("none");
  const hint = screen.getByRole("tooltip");
  expect(getComputedStyle(hint).pointerEvents).toBe("none");
  expect(
    getComputedStyle(hint.parentElement as HTMLElement).pointerEvents,
  ).toBe("none");
  expect(getComputedStyle(screen.getByRole("dialog")).pointerEvents).toBe(
    "auto",
  );
});

test("commit hints still allow selecting the full SHA for manual copying", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  render(<TimelineVersion value={sha} />);
  act(() => screen.getByRole("button", { name: "复制提交 1234567" }).focus());
  const hint = screen.getByRole("tooltip");
  expect(hint.textContent).toContain(sha);
  expect(getComputedStyle(hint).pointerEvents).toBe("auto");
  expect(
    getComputedStyle(hint.parentElement as HTMLElement).pointerEvents,
  ).toBe("auto");
});

test("long details scroll from the focused trigger and Escape preserves focus", () => {
  render(
    <Tooltip scrollable content="完整状态详情">
      <button type="button">状态</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "状态" });
  act(() => trigger.focus());
  const tip = screen.getByRole("tooltip");
  const area = tip.querySelector<HTMLElement>(".ui-tooltip-scrollarea");
  if (!area) throw new Error("Missing scroll area");
  // jsdom has no layout; the browser regression covers actual viewport bounds.
  Object.defineProperties(area, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 100 },
  });
  area.style.lineHeight = "20px";
  expect(getComputedStyle(tip).pointerEvents).toBe("auto");
  expect(fireEvent.keyDown(trigger, { key: "PageDown" })).toBe(false);
  expect(area.scrollTop).toBeGreaterThan(0);
  expect(area.scrollTop).toBeLessThan(area.clientHeight);
  fireEvent.keyDown(trigger, { key: "PageUp" });
  expect(area.scrollTop).toBe(0);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(area.scrollTop).toBeGreaterThan(0);
  fireEvent.keyDown(trigger, { key: "ArrowUp" });
  expect(area.scrollTop).toBe(0);
  fireEvent.keyDown(trigger, { key: "End" });
  expect(area.scrollTop).toBe(area.scrollHeight - area.clientHeight);
  expect(fireEvent.keyDown(trigger, { key: "Home", ctrlKey: true })).toBe(true);
  expect(area.scrollTop).toBeGreaterThan(0);
  fireEvent.keyDown(trigger, { key: "Home" });
  expect(area.scrollTop).toBe(0);
  fireEvent.keyDown(trigger, { key: "Tab" });
  expect(document.activeElement).toBe(area);
  expect(screen.getByRole("tooltip")).toBe(tip);
  fireEvent.keyDown(area, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "Tab" });
  fireEvent.keyDown(area, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(fireEvent.keyDown(trigger, { key: "PageDown" })).toBe(true);
});

test("short details leave page scrolling keys alone", () => {
  render(
    <Tooltip scrollable content="短提示">
      <button type="button">状态</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "状态" });
  act(() => trigger.focus());
  expect(fireEvent.keyDown(trigger, { key: "PageDown" })).toBe(true);
  expect(fireEvent.keyDown(trigger, { key: "End" })).toBe(true);
});
