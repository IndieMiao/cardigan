import { expect, test } from "vitest";
import {
  curvePath,
  handleLength,
  hubPaths,
  intersectBoxes,
  LINE_ARROW,
  LINE_SPREAD,
  type LineEnd,
  linkSides,
  spreadAnchors,
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
const viewport = box(0, 0, 2000, 900);

/** The cubic's start, controls and end as numbers. */
const cubic = (d: string) => {
  const m = d.match(
    /^M(-?[\d.]+) (-?[\d.]+)C(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/,
  );
  if (!m) throw new Error(`not one cubic: ${d}`);
  const [x0, y0, x1, y1, x2, y2, x3, y3] = m.slice(1).map(Number) as number[];
  return { x0, y0, x1, y1, x2, y2, x3, y3 };
};

/** The cubic's farthest x on either side, sampled every 1%. */
const reach = (d: string) => {
  const { x0, x1, x2, x3 } = cubic(d);
  const xs = Array.from({ length: 101 }, (_, i) => {
    const t = i / 100,
      u = 1 - t;
    return u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3;
  });
  return { min: Math.min(...xs), max: Math.max(...xs) };
};

test("handles: half the horizontal or a share of the vertical span, capped", () => {
  // Between lanes: ½ of the horizontal or ½ of the vertical distance, the
  // vertical share capped at 200px; at least 24px.
  expect(handleLength(368, 200, false)).toBe(184);
  expect(handleLength(18, 200, false)).toBe(100);
  expect(handleLength(18, 1000, false)).toBe(200);
  expect(handleLength(18, 10, false)).toBe(24);
  // One lane: 0.35 of the vertical distance, within 24–180px.
  expect(handleLength(0, 100, true)).toBe(35);
  expect(handleLength(0, 20, true)).toBe(24);
  expect(handleLength(0, 1000, true)).toBe(180);
});

test("between lanes: facing edges, horizontal handles", () => {
  // Right edge of the left card to one arrow before the right card's left
  // edge; handles reach half the horizontal distance out of each card.
  expect(curvePath([330, 350], "right", [704, 550], "left")).toBe(
    `M330 350C514 350 514 550 ${704 - LINE_ARROW} 550`,
  );
  // Right to left: the arrow stops one arrow right of the target's edge.
  expect(curvePath([704, 550], "left", [330, 350], "right")).toBe(
    `M704 550C520 550 520 350 ${330 + LINE_ARROW} 350`,
  );
  // Neighbouring lanes far apart vertically: the handles follow the
  // vertical distance, so the curve swings out over the cards on both
  // sides of the gap (an S) instead of running down the gap.
  const d = curvePath([330, 100], "right", [354, 600], "left");
  expect([cubic(d).x1, cubic(d).x2]).toEqual([530, 348 - 200]);
  expect(reach(d).max).toBeGreaterThan(354 + 30);
  expect(reach(d).min).toBeLessThan(330 - 30);
});

test("handles stop at the bounds, so the curve stays inside them", () => {
  const d = curvePath([330, 350], "right", [354, 850], "left", {
    left: 0,
    right: 400,
  });
  expect(cubic(d).x1).toBe(400);
  expect(reach(d).min).toBeGreaterThanOrEqual(0);
  expect(reach(d).max).toBeLessThanOrEqual(400);
});

test("one lane: both ends on the same side, arcing out over the next lane", () => {
  // 100px apart: a 35px handle; the end leaves room for the arrow.
  expect(cubic(curvePath([680, 150], "right", [680, 250], "right"))).toEqual({
    x0: 680,
    y0: 150,
    x1: 715,
    y1: 150,
    x2: 721,
    y2: 250,
    x3: 686,
    y3: 250,
  });
  // Far apart: well past the 16px gap, at most ¾ of 180px plus the arrow.
  const far = reach(curvePath([680, 150], "right", [680, 650], "right")).max;
  expect(far - 680).toBeGreaterThan(100);
  expect(far - 680).toBeLessThanOrEqual(135 + LINE_ARROW);
  expect(
    reach(curvePath([354, 150], "left", [354, 650], "left")).min,
  ).toBeLessThan(354 - 100);
});

test("sides: lanes face each other; one lane bows where it has room", () => {
  expect(linkSides(card(0, 100), card(700, 100), viewport)).toEqual({
    hub: "right",
    other: "left",
  });
  expect(linkSides(card(700, 100), card(350, 500), viewport)).toEqual({
    hub: "left",
    other: "right",
  });
  expect(linkSides(card(350, 100), card(350, 500), viewport)).toEqual({
    hub: "right",
    other: "right",
  });
  expect(linkSides(card(350, 100), card(350, 500), viewport, "left")).toEqual({
    hub: "left",
    other: "left",
  });
  // The last visible lane bows into the board, not past its right edge.
  const narrow = box(0, 0, 684, 900);
  expect(linkSides(card(350, 100), card(350, 500), narrow)).toEqual({
    hub: "left",
    other: "left",
  });
  // The first one likewise when the left is preferred.
  expect(
    linkSides(card(0, 100), card(0, 500), box(10, 0, 900, 900), "left"),
  ).toEqual({ hub: "right", other: "right" });
  // Neither side fits the bow: the side with more room.
  expect(
    linkSides(card(0, 100), card(0, 500), box(0, 0, 400, 900), "left"),
  ).toEqual({ hub: "right", other: "right" });
  expect(linkSides(card(0, 100), card(0, 500), box(10, 0, 300, 900))).toEqual({
    hub: "left",
    other: "left",
  });
});

test("lines on one side of the card start 6px apart round its middle", () => {
  expect(spreadAnchors(box(0, 100, 10, 200), 1)).toEqual([150]);
  expect(spreadAnchors(box(0, 100, 10, 200), 3)).toEqual([
    150 - LINE_SPREAD,
    150,
    150 + LINE_SPREAD,
  ]);
  // A short visible sliver squeezes them inside 12px of its corners.
  expect(spreadAnchors(box(0, 100, 10, 132), 5)).toEqual([
    112, 114, 116, 118, 120,
  ]);
  expect(spreadAnchors(box(0, 100, 10, 110), 2)).toEqual([105, 105]);
});

test("hub: same-lane links take the quieter side; each side spread by height", () => {
  const hub = card(350, 300);
  const paths = hubPaths(
    hub,
    [
      // Into the hub from the left lane.
      { other: card(0, 100), outgoing: false },
      // Out to the right: below and above.
      { other: card(700, 600), outgoing: true },
      { other: card(1050, 0), outgoing: true },
      // Same lane further down: one line on the left, two on the right, so
      // it bows out on the left.
      { other: card(350, 700), outgoing: true },
    ],
    viewport,
  ).map(cubic);
  const [fromLeft, below, above, sameLane] = paths as ReturnType<
    typeof cubic
  >[];
  // Left side, top to bottom by the other end: from the left lane (150),
  // the same lane (750). Each starts or ends at the other card's middle.
  expect([fromLeft?.x0, fromLeft?.y0]).toEqual([330, 150]);
  expect([fromLeft?.x3, fromLeft?.y3]).toEqual([
    354 - LINE_ARROW,
    350 - LINE_SPREAD / 2,
  ]);
  expect([sameLane?.x0, sameLane?.y0]).toEqual([354, 350 + LINE_SPREAD / 2]);
  expect([sameLane?.x3, sameLane?.y3]).toEqual([354 - LINE_ARROW, 750]);
  // Right side: above (50), below (650).
  expect([above?.x0, above?.y0]).toEqual([680, 350 - LINE_SPREAD / 2]);
  expect([below?.x0, below?.y0]).toEqual([680, 350 + LINE_SPREAD / 2]);
  expect([above?.x3, above?.y3]).toEqual([1054 - LINE_ARROW, 50]);
  expect([below?.x3, below?.y3]).toEqual([704 - LINE_ARROW, 650]);
  // Every handle is horizontal: the curve leaves and enters edges level.
  for (const p of paths) {
    expect(p.y1).toBe(p.y0);
    expect(p.y2).toBe(p.y3);
  }
  // No other-lane links: same-lane ones bow out on the right.
  expect(
    cubic(
      hubPaths(
        hub,
        [{ other: card(350, 700), outgoing: false }],
        viewport,
      )[0] ?? "",
    ).x0,
  ).toBe(680);
});

test("slivers under 8px do not count as visible", () => {
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 93, 100, 200))).toBeNull();
  expect(intersectBoxes(box(0, 0, 100, 100), box(0, 92, 100, 200))).toEqual(
    box(0, 92, 100, 100),
  );
  expect(intersectBoxes(box(0, 0, 10, 10), box(20, 0, 30, 10))).toBeNull();
});
