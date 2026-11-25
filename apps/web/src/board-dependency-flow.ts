/**
 * C-673: the dots that flow along each hover dependency line, the way its
 * arrow points (prerequisite → dependent). Every line path already starts at
 * the prerequisite and ends at the arrow, so the dots simply move from the
 * path's start towards its end.
 *
 * A line carries 1–3 evenly spaced dots: its length split into gaps of about
 * `FLOW_SPACING`. Each dot is a zero-length dash with a round cap; the dash
 * pattern `0 gap` puts one every `gap` along the path, and the dash offset
 * moves them at `FLOW_SPEED` on every line alike. When a redraw changes a
 * line's length (scrolling, resizing), the dots keep their phase instead of
 * restarting.
 */

/** Distance between neighbouring dots a line aims for, in px. */
export const FLOW_SPACING = 240;
/** Most dots one line carries at a time. */
export const FLOW_MAX_DOTS = 3;
/** Speed of the dots along every line, in px per second. */
export const FLOW_SPEED = 64;
/** A longer frame (a background tab, a stall) moves the dots this far only. */
export const FLOW_MAX_STEP_MS = 100;
/** Straight pieces used to measure a cubic. */
const SAMPLES = 32;

/** Length of a `M x y C x1 y1 x2 y2 x3 y3` path; 0 if it is not one. */
export function curveLength(d: string): number {
  const n = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (n?.length !== 8 || !/^M[^C]*C/.test(d)) return 0;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = n as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const at = (t: number, a: number, b: number, c: number, e: number) => {
    const u = 1 - t;
    return (
      u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * e
    );
  };
  let length = 0,
    px = x0,
    py = y0;
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES,
      x = at(t, x0, x1, x2, x3),
      y = at(t, y0, y1, y2, y3);
    length += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return length;
}

/** How many dots a line of `length` carries. */
export function flowDots(length: number): number {
  return Math.min(
    FLOW_MAX_DOTS,
    Math.max(1, Math.round(length / FLOW_SPACING)),
  );
}

/** Distance between the dots on a line of `length`; 0 for no line. */
export function flowGap(length: number): number {
  return length > 0 ? length / flowDots(length) : 0;
}

/** The phase (distance of the first dot from the start) `ms` later. */
export function advanceFlow(phase: number, gap: number, ms: number): number {
  if (gap <= 0) return 0;
  const step =
    (FLOW_SPEED * Math.min(Math.max(ms, 0), FLOW_MAX_STEP_MS)) / 1000;
  return (phase + step) % gap;
}

const fixed = (x: number) => String(Math.round(x * 100) / 100);

/**
 * Dash attributes that put a dot at `phase` and then every `gap` after it.
 * The offset is `gap - phase` (not `-phase`), so it never goes negative;
 * a shrinking offset moves the dots towards the path's end.
 */
export function flowDash(
  gap: number,
  phase: number,
): { dasharray: string; dashoffset: string } {
  return {
    dasharray: `0 ${fixed(gap)}`,
    dashoffset: fixed(gap > 0 ? gap - (phase % gap) : 0),
  };
}
