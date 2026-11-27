import { expect, test } from "vitest";
import {
  canPan,
  clampView,
  fitScale,
  fitView,
  isFitted,
  MAX_SCALE,
  percent,
  pinchView,
  wheelFactor,
  zoomAt,
} from "./imageZoom.js";

const stage = { width: 800, height: 600 };
// SEN-C-141's comparison: a tall 2×3 grid of screenshots.
const tall = { width: 720, height: 2880 };
const wide = { width: 4000, height: 500 };
const small = { width: 200, height: 100 };

test("tall, wide and small images open whole and centred, never enlarged", () => {
  expect(fitScale(tall, stage)).toBeCloseTo(600 / 2880);
  expect(fitView(tall, stage)).toEqual({
    scale: 600 / 2880,
    x: (800 - 720 * (600 / 2880)) / 2,
    y: 0,
  });
  expect(fitScale(wide, stage)).toBeCloseTo(0.2);
  expect(fitView(wide, stage).y).toBeCloseTo((600 - 100) / 2);
  expect(fitView(small, stage)).toEqual({ scale: 1, x: 300, y: 250 });
  expect(percent(fitView(tall, stage))).toBe("21%");
});

test("the scale stays between fit and 800%; the image cannot leave the stage", () => {
  expect(clampView({ scale: 0.01, x: 0, y: 0 }, tall, stage).scale).toBe(
    fitScale(tall, stage),
  );
  expect(clampView({ scale: 99, x: 0, y: 0 }, tall, stage).scale).toBe(
    MAX_SCALE,
  );
  // At 100% the 720px-wide image is narrower than the stage: centred.
  // Vertically it may move between its top and bottom edge only.
  expect(clampView({ scale: 1, x: -500, y: 50 }, tall, stage)).toEqual({
    scale: 1,
    x: 40,
    y: 0,
  });
  expect(clampView({ scale: 1, x: 0, y: -99999 }, tall, stage).y).toBe(
    600 - 2880,
  );
  expect(clampView({ scale: 2, x: 99, y: 0 }, tall, stage).x).toBe(0);
  expect(clampView({ scale: 2, x: -99999, y: 0 }, tall, stage).x).toBe(
    800 - 1440,
  );
});

test("zooming keeps the point under the pointer in place", () => {
  const start = fitView(tall, stage);
  const at = { x: 400, y: 300 };
  const before = {
    x: (at.x - start.x) / start.scale,
    y: (at.y - start.y) / start.scale,
  };
  const next = zoomAt(start, 2, at, tall, stage);
  expect(next.scale).toBe(2);
  expect((at.x - next.x) / next.scale).toBeCloseTo(before.x);
  expect((at.y - next.y) / next.scale).toBeCloseTo(before.y);
  expect(canPan(next, tall, stage)).toBe(true);
  expect(canPan(start, tall, stage)).toBe(false);
  expect(isFitted(start, tall, stage)).toBe(true);
  expect(isFitted(next, tall, stage)).toBe(false);
});

test("a pinch scales by the finger distance around their midpoint", () => {
  const start = { scale: 1, x: 40, y: -1000 };
  const next = pinchView(
    start,
    [
      { x: 350, y: 300 },
      { x: 450, y: 300 },
    ],
    [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ],
    tall,
    stage,
  );
  expect(next.scale).toBe(2);
  // The image point under the midpoint (400, 300) stays there.
  expect((400 - next.x) / 2).toBeCloseTo((400 - start.x) / 1);
  expect((300 - next.y) / 2).toBeCloseTo((300 - start.y) / 1);
});

test("wheel down zooms out, up zooms in; a trackpad pinch is amplified", () => {
  expect(wheelFactor(100, 0, false)).toBeLessThan(1);
  expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
  expect(wheelFactor(3, 1, false)).toBeCloseTo(wheelFactor(48, 0, false));
  expect(wheelFactor(-10, 0, true)).toBeCloseTo(Math.exp(0.1));
  // One huge notch cannot jump more than a bounded step.
  expect(wheelFactor(-100000, 0, false)).toBeCloseTo(Math.exp(0.4));
});
