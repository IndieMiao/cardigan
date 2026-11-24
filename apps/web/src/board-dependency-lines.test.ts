import { expect, test } from "vitest";
import {
  connectorPath,
  intersectBoxes,
  LINE_ARROW,
  type LineEnd,
  roundedPath,
} from "./board-dependency-lines.js";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
/** A 326px card in a 334px lane whose left edge is `lane`. */
const card = (lane: number, top: number): LineEnd => ({
  box: box(lane + 4, top, lane + 330, top + 100),
  column: { left: lane, right: lane + 334 },
});
const frame = { band: 36, viewport: box(0, 0, 2000, 900) };

test("rounded corners, repeated and collinear points dropped", () => {
  expect(
    roundedPath([
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 0],
      [20, 30],
    ]),
  ).toBe("M0 0L16 0Q20 0 20 4L20 30");
  // Short legs shrink the radius to half the leg.
  expect(
    roundedPath([
      [0, 0],
      [2, 0],
      [2, 10],
    ]),
  ).toBe("M0 0L1 0Q2 0 2 1L2 10");
});

test("neighbouring lanes: one step on the exit run of the gap", () => {
  // Lanes at 0 and 350: the gap centre is 342; lines out of the hovered
  // card exit 2px left of it, lines into it 5px left.
  expect(connectorPath(card(0, 300), card(350, 100), frame, true)).toBe(
    roundedPath([
      [330, 350],
      [340, 350],
      [340, 150],
      [354 - LINE_ARROW, 150],
    ]),
  );
  expect(connectorPath(card(0, 300), card(350, 100), frame, false)).toBe(
    roundedPath([
      [330, 350],
      [337, 350],
      [337, 150],
      [354 - LINE_ARROW, 150],
    ]),
  );
});

test("farther lanes climb the gap, cross in the band and drop", () => {
  // From lane 0 to lane 700: exit at 340 (gap 342), enter at 694 (gap 692).
  expect(connectorPath(card(0, 300), card(700, 500), frame, true)).toBe(
    roundedPath([
      [330, 350],
      [340, 350],
      [340, 34.5],
      [694, 34.5],
      [694, 550],
      [704 - LINE_ARROW, 550],
    ]),
  );
  // Lines into the hovered card take the outer runs and the lower band
  // track. The first lane's entry gap lies outside the board, in the page
  // padding, and keeps a 2px stub before the arrow.
  expect(connectorPath(card(700, 500), card(0, 300), frame, false)).toBe(
    roundedPath([
      [1030, 550],
      [1037, 550],
      [1037, 37.5],
      [-4, 37.5],
      [-4, 350],
      [4 - LINE_ARROW, 350],
    ]),
  );
});

test("the same lane goes round the top: out on the right, in on the left", () => {
  expect(connectorPath(card(350, 500), card(350, 100), frame, true)).toBe(
    roundedPath([
      [680, 550],
      [690, 550],
      [690, 34.5],
      [344, 34.5],
      [344, 150],
      [354 - LINE_ARROW, 150],
    ]),
  );
});

test("gaps off screen are pulled to the board edge, arrows still point in", () => {
  const narrow = { band: 36, viewport: box(0, 0, 684, 900) };
  // The exit gap is beyond the right edge: runs stay within 8px of it.
  expect(connectorPath(card(350, 500), card(350, 100), narrow, true)).toBe(
    roundedPath([
      [680, 550],
      [690, 550],
      [690, 34.5],
      [344, 34.5],
      [344, 150],
      [348, 150],
    ]),
  );
  // A target cut by the left edge: its visible part starts at the edge.
  const cut: LineEnd = {
    box: box(0, 100, 200, 200),
    column: { left: -130, right: 204 },
  };
  expect(connectorPath(card(350, 500), cut, narrow, true)).toBe(
    roundedPath([
      [680, 550],
      [690, 550],
      [690, 34.5],
      [-8, 34.5],
      [-8, 150],
      [-LINE_ARROW, 150],
    ]),
  );
});

test("slivers under 8px do not count as visible", () => {
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 93, 100, 200))).toBeNull();
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 92, 100, 200))).toEqual(
    box(0, 92, 100, 100),
  );
  expect(intersectBoxes(box(0, 0, 10, 10), box(20, 0, 30, 10))).toBeNull();
});
