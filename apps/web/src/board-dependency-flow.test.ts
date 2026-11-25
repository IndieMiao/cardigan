import { expect, test } from "vitest";
import {
  advanceFlow,
  curveLength,
  FLOW_MAX_DOTS,
  FLOW_MAX_STEP_MS,
  FLOW_SPACING,
  FLOW_SPEED,
  flowDash,
  flowDots,
  flowGap,
} from "./board-dependency-flow.js";
import { curvePath } from "./board-dependency-lines.js";

test("a cubic's length is measured along the curve", () => {
  // Collinear controls: a straight 300px run.
  expect(curveLength("M0 0C100 0 200 0 300 0")).toBeCloseTo(300, 6);
  // A curve is longer than its chord and shorter than its control polygon.
  const d = curvePath([0, 0], "right", [400, 300], "left");
  const length = curveLength(d);
  expect(length).toBeGreaterThan(Math.hypot(394, 300));
  expect(length).toBeLessThan(200 + 394 + 6 + 300);
  expect(curveLength("")).toBe(0);
  expect(curveLength("M0 0L10 10")).toBe(0);
});

test("a line carries one to three evenly spaced dots", () => {
  expect(flowDots(40)).toBe(1);
  expect(flowDots(FLOW_SPACING)).toBe(1);
  expect(flowDots(FLOW_SPACING * 2)).toBe(2);
  expect(flowDots(FLOW_SPACING * 3)).toBe(3);
  expect(flowDots(5000)).toBe(FLOW_MAX_DOTS);
  // The gaps split the whole line evenly.
  for (const length of [40, 300, 500, 900, 2400])
    expect(flowGap(length) * flowDots(length)).toBeCloseTo(length, 6);
  expect(flowGap(0)).toBe(0);
});

test("dots move forward at one speed and wrap within a gap", () => {
  expect(advanceFlow(0, 200, 1000 / 16)).toBeCloseTo(FLOW_SPEED / 16, 6);
  expect(advanceFlow(190, 200, 250)).toBeCloseTo(
    (190 + (FLOW_SPEED * FLOW_MAX_STEP_MS) / 1000) % 200,
    6,
  );
  // A long pause (a background tab) moves them one capped step only.
  expect(advanceFlow(0, 500, 60_000)).toBeCloseTo(
    (FLOW_SPEED * FLOW_MAX_STEP_MS) / 1000,
    6,
  );
  expect(advanceFlow(10, 200, -5)).toBe(10);
  expect(advanceFlow(10, 0, 16)).toBe(0);
});

test("the dash offset shrinks as the phase grows: dots head for the arrow", () => {
  expect(flowDash(200, 0)).toEqual({ dasharray: "0 200", dashoffset: "200" });
  expect(flowDash(200, 50)).toEqual({ dasharray: "0 200", dashoffset: "150" });
  expect(flowDash(123.456, 23.456)).toEqual({
    dasharray: "0 123.46",
    dashoffset: "100",
  });
  expect(flowDash(0, 5)).toEqual({ dasharray: "0 0", dashoffset: "0" });
});
