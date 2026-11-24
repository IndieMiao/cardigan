/**
 * C-659: geometry for the board's hover dependency lines. Boxes are in the
 * overlay's coordinate space.
 *
 * Lines never pass under a card: every line leaves its `from` card's right
 * edge and enters its `to` card's left edge (prerequisite → card →
 * dependent), runs vertically only in the gaps between lanes, and crosses
 * lanes only in the band above the lane headings, well clear of any card.
 */
export interface LineBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** A card (or a folded lane's strip) and the lane column that holds it. */
export interface LineEnd {
  readonly box: LineBox;
  readonly column: { readonly left: number; readonly right: number };
}

export interface LineFrame {
  /** Middle of the band above the lane headings (the lanes' top padding). */
  readonly band: number;
  /** The board's visible area; vertical runs stay within half a gap of it. */
  readonly viewport: LineBox;
}

/** Arrowhead length; the path stops short so the tip touches the box edge. */
export const LINE_ARROW = 6;
/** Half of the 16px lane gap: the gap's centre from a column edge. */
const GAP_HALF = 8;
/**
 * Offsets from a gap's centre: exits left of it, entries right of it. Lines
 * out of the hovered card keep the inner runs and lines into it the outer
 * ones, so lines of opposite direction never share a run; all lines leaving
 * one card share its exit run and branch off at each target's height.
 */
const TRACK = { out: { exit: -2, entry: 2 }, in: { exit: -5, entry: 5 } };
/** Lines out of the hovered card above lines into it, inside the band. */
const BAND_TRACK = 1.5;
const RADIUS = 4;
/** A sliver smaller than this is treated as scrolled out of view. */
const MIN_VISIBLE = 8;

export function intersectBoxes(a: LineBox, b: LineBox): LineBox | null {
  const box = {
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right - box.left >= MIN_VISIBLE &&
    box.bottom - box.top >= MIN_VISIBLE
    ? box
    : null;
}

const middle = (box: LineBox) => (box.top + box.bottom) / 2;
const round = (value: number) => Math.round(value * 10) / 10;
type Point = readonly [number, number];

/** Polyline with rounded corners; repeated and collinear points dropped. */
export function roundedPath(points: readonly Point[], radius = RADIUS) {
  const p: Point[] = [];
  for (const point of points.map(([x, y]) => [round(x), round(y)] as const)) {
    const last = p.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = p.at(-2);
    if (
      before &&
      last &&
      ((before[0] === last[0] && last[0] === point[0]) ||
        (before[1] === last[1] && last[1] === point[1]))
    )
      p.pop();
    p.push(point);
  }
  const [first] = p;
  if (!first) return "";
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < p.length; i++) {
    const [x, y] = p[i] as Point;
    const next = p[i + 1];
    if (!next) {
      d += `L${x} ${y}`;
      break;
    }
    const [px, py] = p[i - 1] as Point;
    const lengthIn = Math.hypot(x - px, y - py),
      lengthOut = Math.hypot(next[0] - x, next[1] - y),
      r = Math.min(radius, lengthIn / 2, lengthOut / 2);
    const ax = round(x - ((x - px) / lengthIn) * r),
      ay = round(y - ((y - py) / lengthIn) * r),
      bx = round(x + ((next[0] - x) / lengthOut) * r),
      by = round(y + ((next[1] - y) / lengthOut) * r);
    d += `L${ax} ${ay}Q${x} ${y} ${bx} ${by}`;
  }
  return d;
}

/**
 * The route from `from` to `to`. In neighbouring lanes it is a step on the
 * exit run of the gap between them; otherwise it climbs the gap right of
 * `from`, crosses in the band and drops in the gap left of `to`. `outgoing` marks lines that
 * leave the hovered card, so they keep their own band track.
 */
export function connectorPath(
  from: LineEnd,
  to: LineEnd,
  frame: LineFrame,
  outgoing: boolean,
): string {
  // A gap off screen (a lane cut by sideways scrolling) is pulled back to
  // the board's edge; the page padding leaves room for half a gap there.
  const clamp = (x: number) =>
    Math.min(
      Math.max(x, frame.viewport.left - GAP_HALF),
      frame.viewport.right + GAP_HALF,
    );
  const x1 = from.box.right,
    y1 = middle(from.box),
    x2 = to.box.left - LINE_ARROW,
    y2 = middle(to.box);
  const exit = from.column.right + GAP_HALF,
    entry = to.column.left - GAP_HALF;
  // Keep a short horizontal stub at both ends so the arrow points into `to`.
  const leave = (x: number) => Math.max(clamp(x), x1 + 2),
    arrive = (x: number) => Math.min(clamp(x), x2 - 2);
  const track = outgoing ? TRACK.out : TRACK.in;
  if (Math.abs(exit - entry) < 1) {
    const x = Math.min(leave(exit + track.exit), x2 - 2);
    return roundedPath([
      [x1, y1],
      [x, y1],
      [x, y2],
      [x2, y2],
    ]);
  }
  const out = leave(exit + track.exit),
    into = arrive(entry + track.entry),
    band = frame.band + (outgoing ? -BAND_TRACK : BAND_TRACK);
  return roundedPath([
    [x1, y1],
    [out, y1],
    [out, band],
    [into, band],
    [into, y2],
    [x2, y2],
  ]);
}
