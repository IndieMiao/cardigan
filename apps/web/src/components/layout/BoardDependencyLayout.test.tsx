// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  curveLength,
  FLOW_SPEED,
  flowGap,
} from "../../board-dependency-flow.js";
import { BoardDependencyLines } from "./BoardDependencyLayout.js";

/** 300px: one dot; 600px: three dots 200px apart. */
const LINES = [
  { key: "C-1>C-2", d: "M0 0C100 0 200 0 300 0" },
  { key: "C-2>C-3", d: "M0 100C200 100 400 100 600 100" },
];

let frames: Map<number, FrameRequestCallback>;
let next: number;
let reduced: boolean;
let listeners: Set<() => void>;

beforeEach(() => {
  frames = new Map();
  next = 1;
  reduced = false;
  listeners = new Set();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.set(next, cb);
    return next++;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return query === "(prefers-reduced-motion: reduce)" && reduced;
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

/** Runs the pending animation frame at `now` ms. */
const frame = (now: number) =>
  act(() => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, cb] of pending) cb(now);
  });
const flows = (container: HTMLElement) =>
  [...container.querySelectorAll<SVGPathElement>("[data-flow]")].map((p) => ({
    key: p.dataset.flow,
    d: p.getAttribute("d"),
    dasharray: p.getAttribute("stroke-dasharray"),
    dashoffset: Number(p.getAttribute("stroke-dashoffset")),
  }));

test("every line carries dots on its own path, starting at its start", () => {
  const { container } = render(<BoardDependencyLines lines={LINES} />);
  expect(flows(container)).toEqual([
    {
      key: "C-1>C-2",
      d: LINES[0]?.d,
      dasharray: "0 300",
      dashoffset: 300,
    },
    {
      key: "C-2>C-3",
      d: LINES[1]?.d,
      dasharray: "0 200",
      dashoffset: 200,
    },
  ]);
  // The dots paint over their line; the line keeps its arrow.
  const paths = [...container.querySelectorAll("path")];
  expect(
    paths.indexOf(container.querySelector("[data-flow]") as SVGPathElement),
  ).toBeGreaterThan(
    paths.indexOf(container.querySelector("[data-edge]") as SVGPathElement),
  );
  expect(
    container.querySelector("[data-edge]")?.getAttribute("marker-end"),
  ).toMatch(/^url\(#/);
  expect(
    container.querySelector("[data-flow]")?.hasAttribute("marker-end"),
  ).toBe(false);
});

test("dots move from the start towards the arrow at one speed on every line", () => {
  const { container } = render(<BoardDependencyLines lines={LINES} />);
  frame(1000);
  frame(1050);
  const step = (FLOW_SPEED * 50) / 1000;
  // A shrinking offset moves the dash pattern towards the path's end.
  expect(flows(container).map((f) => f.dashoffset)).toEqual([
    300 - step,
    200 - step,
  ]);
  frame(1100);
  expect(flows(container).map((f) => f.dashoffset)).toEqual([
    300 - 2 * step,
    200 - 2 * step,
  ]);
});

test("a redraw keeps the phase of lines that stay; new lines start at their start", () => {
  const view = render(<BoardDependencyLines lines={LINES} />);
  frame(0);
  frame(100);
  const step = (FLOW_SPEED * 100) / 1000;
  // Scrolling made the first line longer; a third line appears.
  const longer = [
    { key: "C-1>C-2", d: "M0 0C120 0 240 0 360 0" },
    LINES[1] as (typeof LINES)[number],
    { key: "C-2>C-4", d: "M0 200C30 200 60 200 90 200" },
  ];
  view.rerender(<BoardDependencyLines lines={longer} />);
  const gap = flowGap(curveLength(longer[0]?.d ?? ""));
  expect(flows(view.container).map((f) => [f.key, f.dashoffset])).toEqual([
    ["C-1>C-2", Number((gap - step).toFixed(2))],
    ["C-2>C-3", 200 - step],
    ["C-2>C-4", 90],
  ]);
});

test("unmounting the lines stops the animation", () => {
  const { unmount } = render(<BoardDependencyLines lines={LINES} />);
  frame(0);
  expect(frames.size).toBe(1);
  unmount();
  expect(frames.size).toBe(0);
  expect(window.cancelAnimationFrame).toHaveBeenCalled();
});

test("reduced motion shows the still lines and arrows only", () => {
  reduced = true;
  const { container } = render(<BoardDependencyLines lines={LINES} />);
  expect(container.querySelectorAll("[data-edge]")).toHaveLength(2);
  expect(container.querySelectorAll("[data-flow]")).toHaveLength(0);
  expect(frames.size).toBe(0);
  // Turning reduced motion off later starts the dots; on again stops them.
  reduced = false;
  act(() => {
    for (const cb of listeners) cb();
  });
  expect(container.querySelectorAll("[data-flow]")).toHaveLength(2);
  expect(frames.size).toBe(1);
  reduced = true;
  act(() => {
    for (const cb of listeners) cb();
  });
  expect(container.querySelectorAll("[data-flow]")).toHaveLength(0);
  expect(frames.size).toBe(0);
});
