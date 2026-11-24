/**
 * C-659 / C-668: geometry for the board's hover dependency lines. Boxes are
 * in the overlay's coordinate space.
 *
 * Every line is one cubic Bézier from the edge of one card straight to the
 * edge of the other. Cards in different lanes connect through their facing
 * sides (the right edge of the left card, the left edge of the right card);
 * cards in one lane bow out of the same side. Both ends leave the edge
 * horizontally, so the curve bends smoothly and the arrow points into the
 * card. The handles grow with the vertical distance too (design review
 * V-3201): neighbouring lanes swing out over the cards in an S, and one lane
 * arcs out over its neighbour, instead of running down the narrow gap
 * between lanes. Lines that meet the hovered card on one side are spread
 * along it.
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

/** One line at the hovered card: to `other` when `outgoing`, else from it. */
export interface HubLink {
  readonly other: LineEnd;
  readonly outgoing: boolean;
}

export type Side = "left" | "right";

/** Arrowhead length; the path stops short so the tip touches the box edge. */
export const LINE_ARROW = 6;
/** Spacing between lines that meet the hovered card on the same side. */
export const LINE_SPREAD = 6;
/** Spread lines keep this far from the card's top and bottom corners. */
const SPREAD_INSET = 12;
/**
 * Handle length: the larger of half the horizontal span (between lanes
 * only) and a share of the vertical one, within [min, max]. A same-lane
 * loop bows out by ¾ of its handle; an S between neighbouring lanes swings
 * about ⅓ of its handle to either side.
 */
const HANDLE = {
  across: { min: 24, perHeight: 0.5, max: 200 },
  loop: { min: 24, perHeight: 0.35, max: 180 },
} as const;
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
const outward = (side: Side) => (side === "right" ? 1 : -1);
const opposite = (side: Side): Side => (side === "right" ? "left" : "right");
const edge = (box: LineBox, side: Side) =>
  side === "right" ? box.right : box.left;
const sameLane = (a: LineEnd, b: LineEnd) =>
  Math.abs(a.column.left - b.column.left) < 1;

/** See `HANDLE`. */
export function handleLength(dx: number, dy: number, loop: boolean): number {
  const rule = loop ? HANDLE.loop : HANDLE.across;
  const wanted = Math.max(
    loop ? 0 : Math.abs(dx) / 2,
    Math.min(Math.abs(dy) * rule.perHeight, rule.max),
  );
  return Math.max(wanted, rule.min);
}

/**
 * Which side of each card the line uses. Different lanes face each other;
 * one lane bows out on the `prefer`red side, or on the other one when the
 * preferred bow would leave the board's visible area and the other would
 * not; when neither fits, on the side with more room.
 */
export function linkSides(
  hub: LineEnd,
  other: LineEnd,
  viewport: LineBox,
  prefer: Side = "right",
): { readonly hub: Side; readonly other: Side } {
  if (sameLane(hub, other)) {
    const bow =
      (handleLength(0, middle(hub.box) - middle(other.box), true) * 3) / 4 +
      LINE_ARROW / 2;
    const room = {
      right: viewport.right - Math.max(hub.box.right, other.box.right),
      left: Math.min(hub.box.left, other.box.left) - viewport.left,
    };
    const spare = opposite(prefer);
    const side =
      room[prefer] >= bow || (room[spare] < bow && room[prefer] >= room[spare])
        ? prefer
        : spare;
    return { hub: side, other: side };
  }
  return hub.column.left < other.column.left
    ? { hub: "right", other: "left" }
    : { hub: "left", other: "right" };
}

/**
 * `count` heights along a box's side, `LINE_SPREAD` apart and centred on its
 * middle; squeezed together when the box is too short to fit them.
 */
export function spreadAnchors(box: LineBox, count: number): number[] {
  const centre = middle(box);
  if (count <= 1) return [centre];
  const room = Math.max(box.bottom - box.top - 2 * SPREAD_INSET, 0);
  const step = Math.min(LINE_SPREAD, room / (count - 1));
  return Array.from(
    { length: count },
    (_, i) => centre + (i - (count - 1) / 2) * step,
  );
}

type Point = readonly [number, number];

/**
 * A cubic from `start` (on a card edge facing `startSide`) to one arrow
 * short of `end` (on an edge facing `endSide`). Both handles are horizontal
 * and point out of their card. Handles are cut back at the edges of
 * `bounds`, so the curve (inside its control points' hull) never leaves it.
 */
export function curvePath(
  start: Point,
  startSide: Side,
  end: Point,
  endSide: Side,
  bounds?: { readonly left: number; readonly right: number },
): string {
  const [x0, y0] = start;
  const x3 = end[0] + outward(endSide) * LINE_ARROW,
    y3 = end[1];
  const handle = handleLength(x3 - x0, y3 - y0, startSide === endSide);
  const clamp = (x: number) =>
    bounds ? Math.min(Math.max(x, bounds.left), bounds.right) : x;
  const x1 = clamp(x0 + outward(startSide) * handle),
    x2 = clamp(x3 + outward(endSide) * handle);
  const p = (x: number, y: number) => `${round(x)} ${round(y)}`;
  return `M${p(x0, y0)}C${p(x1, y0)} ${p(x2, y3)} ${p(x3, y3)}`;
}

/**
 * The path of every link of the hovered card `hub`, in the given order.
 * Same-lane links bow out on the side fewer other-lane links use (the right
 * on a tie), so they cross as few other lines as possible. Links
 * meeting the hub on one side are spread along it, ordered by the other
 * end's height so that neighbouring lines do not cross at the hub; the
 * other end always takes the middle of its card's side.
 */
export function hubPaths(
  hub: LineEnd,
  links: readonly HubLink[],
  viewport: LineBox,
): string[] {
  const across = links
    .filter((link) => !sameLane(hub, link.other))
    .map((link) => linkSides(hub, link.other, viewport).hub);
  const count = (side: Side) => across.filter((s) => s === side).length;
  const prefer = count("left") < count("right") ? "left" : "right";
  const sides = links.map((link) =>
    linkSides(hub, link.other, viewport, prefer),
  );
  const anchors = new Array<number>(links.length);
  for (const side of ["left", "right"] as const) {
    const at = links
      .map((link, i) => ({ i, y: middle(link.other.box) }))
      .filter(({ i }) => sides[i]?.hub === side)
      .sort((a, b) => a.y - b.y);
    const ys = spreadAnchors(hub.box, at.length);
    at.forEach(({ i }, n) => {
      anchors[i] = ys[n] as number;
    });
  }
  return links.map((link, i) => {
    const side = sides[i] as { hub: Side; other: Side };
    const atHub: Point = [edge(hub.box, side.hub), anchors[i] as number],
      atOther: Point = [
        edge(link.other.box, side.other),
        middle(link.other.box),
      ];
    return link.outgoing
      ? curvePath(atHub, side.hub, atOther, side.other, viewport)
      : curvePath(atOther, side.other, atHub, side.hub, viewport);
  });
}
