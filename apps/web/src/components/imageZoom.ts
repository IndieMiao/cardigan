/**
 * C-830: geometry of the zoomable image preview. All coordinates are in CSS
 * pixels relative to the stage's top-left corner; `x`/`y` place the scaled
 * image's top-left corner.
 */
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface View extends Point {
  readonly scale: number;
}

/** Largest zoom, as a multiple of the image's own pixels. */
export const MAX_SCALE = 8;
/** One step of the zoom buttons and keys. */
export const ZOOM_STEP = 1.25;
const EPSILON = 0.001;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The whole image inside the stage, never enlarged beyond its own pixels. */
export function fitScale(image: Size, stage: Size): number {
  return Math.min(1, stage.width / image.width, stage.height / image.height);
}

/** Fit is the smallest zoom; the largest is MAX_SCALE (or fit, if larger). */
export function scaleBounds(image: Size, stage: Size) {
  const min = fitScale(image, stage);
  return { min, max: Math.max(MAX_SCALE, min) };
}

/**
 * Keep the scale within bounds and the image over the stage: an image smaller
 * than the stage along an axis is centred on it, a larger one cannot be
 * dragged past its own edge.
 */
export function clampView(view: View, image: Size, stage: Size): View {
  const { min, max } = scaleBounds(image, stage);
  const scale = clamp(view.scale, min, max);
  const axis = (offset: number, length: number, room: number) =>
    length <= room ? (room - length) / 2 : clamp(offset, room - length, 0);
  return {
    scale,
    x: axis(view.x, image.width * scale, stage.width),
    y: axis(view.y, image.height * scale, stage.height),
  };
}

export function fitView(image: Size, stage: Size): View {
  return clampView({ scale: 0, x: 0, y: 0 }, image, stage);
}

export function isFitted(view: View, image: Size, stage: Size): boolean {
  return view.scale <= fitScale(image, stage) + EPSILON;
}

/** Zoom to `scale`, keeping the image point under `at` where it is. */
export function zoomAt(
  view: View,
  scale: number,
  at: Point,
  image: Size,
  stage: Size,
): View {
  const { min, max } = scaleBounds(image, stage);
  const next = clamp(scale, min, max),
    ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: at.x - (at.x - view.x) * ratio,
      y: at.y - (at.y - view.y) * ratio,
    },
    image,
    stage,
  );
}

/** Whether the scaled image is larger than the stage, i.e. can be dragged. */
export function canPan(view: View, image: Size, stage: Size): boolean {
  return (
    image.width * view.scale > stage.width + EPSILON ||
    image.height * view.scale > stage.height + EPSILON
  );
}

/**
 * Zoom factor of one wheel event. A trackpad pinch arrives as a wheel event
 * with `ctrlKey` and small deltas, so it is scaled up to feel the same.
 */
export function wheelFactor(
  deltaY: number,
  deltaMode: number,
  pinch: boolean,
): number {
  const pixels =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-clamp(pixels, -200, 200) * (pinch ? 0.01 : 0.002));
}

/** The view after a two-finger gesture that started at `from`. */
export function pinchView(
  start: View,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
  image: Size,
  stage: Size,
): View {
  const distance = ([a, b]: readonly [Point, Point]) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const middle = ([a, b]: readonly [Point, Point]) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const { min, max } = scaleBounds(image, stage);
  const before = distance(from);
  const scale = clamp(
    before > 0 ? (start.scale * distance(to)) / before : start.scale,
    min,
    max,
  );
  const m0 = middle(from),
    m1 = middle(to),
    ratio = scale / start.scale;
  return clampView(
    {
      scale,
      x: m1.x - (m0.x - start.x) * ratio,
      y: m1.y - (m0.y - start.y) * ratio,
    },
    image,
    stage,
  );
}

export const percent = (view: View) => `${Math.round(view.scale * 100)}%`;
