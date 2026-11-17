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
  for (const [headerTop, anchorTop, side, hintTop] of [
    [200, 300, "top", 194],
    [170, 300, "top", 164],
    [-20, 30, "bottom", 118],
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
