/**
 * C-659: geometry for the board's hover dependency lines. Boxes are in the
 * overlay's coordinate space; every line starts and ends on a visible box.
 */
export interface LineBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Arrowhead length; the path stops short so the tip touches the box edge. */
export const LINE_ARROW = 6;
/** How far a same-lane line bows out past the cards' right edge. */
const LANE_LOOP = 12;
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

/**
 * A horizontal-tangent curve from `from` to `to`, ending in an arrow into
 * `to`. Boxes in different lanes join facing edges; boxes in one lane join
 * their right edges with a small bow, so the line stays in the lane gap.
 */
export function connectorPath(from: LineBox, to: LineBox): string {
  const y1 = round(middle(from)),
    y2 = round(middle(to));
  let x1: number, x2: number, c1: number, c2: number;
  if (to.left >= from.right) {
    x1 = from.right;
    x2 = to.left - LINE_ARROW;
    const bend = Math.max(LINE_ARROW, (x2 - x1) / 2);
    c1 = x1 + bend;
    c2 = x2 - bend;
  } else if (to.right <= from.left) {
    x1 = from.left;
    x2 = to.right + LINE_ARROW;
    const bend = Math.max(LINE_ARROW, (x1 - x2) / 2);
    c1 = x1 - bend;
    c2 = x2 + bend;
  } else {
    x1 = from.right;
    x2 = to.right + LINE_ARROW;
    c1 = c2 = Math.max(x1, x2) + LANE_LOOP;
  }
  return `M${round(x1)} ${y1}C${round(c1)} ${y1} ${round(c2)} ${y2} ${round(x2)} ${y2}`;
}
