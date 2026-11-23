import { expect, test } from "vitest";
import {
  connectorPath,
  intersectBoxes,
  LINE_ARROW,
} from "./board-dependency-lines.js";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

test("left-to-right joins the facing edges and stops one arrow short", () => {
  expect(connectorPath(box(0, 0, 100, 20), box(200, 40, 300, 60))).toBe(
    `M100 10C147 10 147 50 ${200 - LINE_ARROW} 50`,
  );
});

test("right-to-left starts on the left edge and ends at the right edge", () => {
  expect(connectorPath(box(200, 0, 300, 20), box(0, 0, 100, 20))).toBe(
    `M200 10C153 10 153 10 ${100 + LINE_ARROW} 10`,
  );
});

test("same lane bows out past the right edges", () => {
  expect(connectorPath(box(0, 0, 100, 20), box(0, 100, 100, 120))).toBe(
    `M100 10C118 10 118 110 ${100 + LINE_ARROW} 110`,
  );
});

test("close boxes keep a minimal bend", () => {
  expect(connectorPath(box(0, 0, 100, 20), box(110, 0, 200, 20))).toBe(
    `M100 10C106 10 98 10 104 10`,
  );
});

test("slivers under 8px do not count as visible", () => {
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 93, 100, 200))).toBeNull();
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 92, 100, 200))).toEqual(
    box(0, 92, 100, 100),
  );
  expect(intersectBoxes(box(0, 0, 10, 10), box(20, 0, 30, 10))).toBeNull();
});
