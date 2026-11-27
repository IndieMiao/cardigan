import {
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  canPan,
  clampView,
  fitView,
  isFitted,
  type Point,
  pinchView,
  type Size,
  scaleBounds,
  type View,
  wheelFactor,
  ZOOM_STEP,
  zoomAt,
} from "./imageZoom.js";

/** Movement (px) after which a press is a drag, not a click. */
const DRAG = 4;
/** Two taps within this time (ms) and distance (px) are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
/** The click that follows a drag's release arrives within this time (ms). */
const SUPPRESS_MS = 500;

interface Gesture {
  /** Pointers currently down on the stage, in stage coordinates. */
  readonly pointers: Map<number, Point>;
  /** The view and pointer positions when the pointer set last changed. */
  base: { view: View; pointers: Map<number, Point> } | null;
  /** The press moved (or used two fingers): it is a drag or a pinch. */
  moved: boolean;
  /** A click up to this time ends the last drag and must not close. */
  suppressUntil: number;
  /** The press started on the image itself. */
  onImage: boolean;
  lastTap: { time: number; point: Point } | null;
}

/**
 * C-830: zoom and pan state of the image preview. `source` identifies the
 * image; a new one starts fitted to the stage again. Until the image and the
 * stage have been measured `view` is null and the image keeps its CSS fit.
 */
export function useImageZoom(source: string | undefined) {
  // The preview mounts its content after this hook (a portal), so the
  // stage is tracked as state for the effects below to attach once it exists.
  const [element, stage] = useState<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(source);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  /** null follows the stage at “fit”; otherwise the user's own view. */
  const [chosen, setChosen] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  if (shown !== source) {
    setShown(source);
    setNatural(null);
    setChosen(null);
    setDragging(false);
  }
  const ready =
    natural && box && box.width > 0 && box.height > 0 ? { natural, box } : null;
  const view = ready
    ? chosen
      ? clampView(chosen, ready.natural, ready.box)
      : fitView(ready.natural, ready.box)
    : null;
  const latest = useRef({ ready, view });
  latest.current = { ready, view };
  const gesture = useRef<Gesture>({
    pointers: new Map(),
    base: null,
    moved: false,
    suppressUntil: Number.NEGATIVE_INFINITY,
    onImage: false,
    lastTap: null,
  });

  /** Record a new view; one back at the fit follows the stage again. */
  const commit = useCallback((next: View) => {
    const current = latest.current.ready;
    if (!current) return;
    setChosen(isFitted(next, current.natural, current.box) ? null : next);
  }, []);
  const zoomTo = useCallback(
    (scale: (view: View) => number, at?: Point) => {
      const { ready, view } = latest.current;
      if (!ready || !view) return;
      const centre = { x: ready.box.width / 2, y: ready.box.height / 2 };
      commit(zoomAt(view, scale(view), at ?? centre, ready.natural, ready.box));
    },
    [commit],
  );
  const zoomIn = useCallback(
    () => zoomTo((view) => view.scale * ZOOM_STEP),
    [zoomTo],
  );
  const zoomOut = useCallback(
    () => zoomTo((view) => view.scale / ZOOM_STEP),
    [zoomTo],
  );
  const fit = useCallback(() => setChosen(null), []);
  const actualSize = useCallback((at?: Point) => zoomTo(() => 1, at), [zoomTo]);
  /** Double click / tap: between “fit” and 100%, around the pointer. */
  const toggle = useCallback(
    (at: Point) => {
      const { ready, view } = latest.current;
      if (!ready || !view) return;
      if (isFitted(view, ready.natural, ready.box)) actualSize(at);
      else fit();
    },
    [actualSize, fit],
  );

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setBox((previous) =>
        previous?.width === element.clientWidth &&
        previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // React registers wheel listeners as passive; zooming must stop the page
  // (and a trackpad pinch the browser) from zooming instead.
  useEffect(() => {
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const { ready, view } = latest.current;
      if (!ready || !view) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      commit(
        zoomAt(
          view,
          view.scale *
            wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey),
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          ready.natural,
          ready.box,
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [element, commit]);

  const pointOf = (event: { clientX: number; clientY: number }): Point => {
    const rect = element?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };
  const rebase = () => {
    const g = gesture.current,
      view = latest.current.view;
    g.base =
      view && g.pointers.size ? { view, pointers: new Map(g.pointers) } : null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const g = gesture.current;
    // A new gesture: forget presses whose release happened off the stage.
    if (event.isPrimary) g.pointers.clear();
    if (g.pointers.size === 0) {
      g.moved = false;
      g.onImage = event.target instanceof HTMLImageElement;
    } else g.moved = true;
    g.pointers.set(event.pointerId, pointOf(event));
    rebase();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
      onPointerEnd(event);
      return;
    }
    g.pointers.set(event.pointerId, pointOf(event));
    const { ready } = latest.current;
    const base = g.base;
    if (!base || !ready) return;
    const ids = [...g.pointers.keys()];
    if (ids.length >= 2) {
      const [a, b] = ids as [number, number];
      const from = [base.pointers.get(a), base.pointers.get(b)],
        to = [g.pointers.get(a), g.pointers.get(b)];
      if (!from[0] || !from[1] || !to[0] || !to[1]) return;
      commit(
        pinchView(
          base.view,
          [from[0], from[1]],
          [to[0], to[1]],
          ready.natural,
          ready.box,
        ),
      );
      return;
    }
    const start = base.pointers.get(event.pointerId),
      now = g.pointers.get(event.pointerId);
    if (!start || !now) return;
    const dx = now.x - start.x,
      dy = now.y - start.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) <= DRAG) return;
      g.moved = true;
      // Capture only once it is a drag: a captured press would turn a plain
      // click on the image into a click on the blank stage.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (!canPan(base.view, ready.natural, ready.box)) return;
    setDragging(true);
    commit(
      clampView(
        { ...base.view, x: base.view.x + dx, y: base.view.y + dy },
        ready.natural,
        ready.box,
      ),
    );
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    const point = g.pointers.get(event.pointerId);
    if (!point || !g.pointers.delete(event.pointerId)) return;
    rebase();
    if (g.pointers.size) return;
    setDragging(false);
    if (g.moved) g.suppressUntil = event.timeStamp + SUPPRESS_MS;
    if (event.type !== "pointerup" || g.moved || !g.onImage) {
      g.lastTap = null;
      return;
    }
    const tap = g.lastTap;
    if (
      tap &&
      event.timeStamp - tap.time <= DOUBLE_TAP_MS &&
      Math.hypot(point.x - tap.point.x, point.y - tap.point.y) <= DOUBLE_TAP_PX
    ) {
      g.lastTap = null;
      toggle(point);
    } else g.lastTap = { time: event.timeStamp, point };
  };
  /** True once for the click that ends a drag or pinch. */
  const consumeDrag = (click: { timeStamp: number }) => {
    const g = gesture.current,
      suppressed = click.timeStamp <= g.suppressUntil;
    g.suppressUntil = Number.NEGATIVE_INFINITY;
    return suppressed;
  };
  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0)
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
  };
  const bounds =
    ready && view
      ? {
          atMin: isFitted(view, ready.natural, ready.box),
          atMax:
            view.scale >= scaleBounds(ready.natural, ready.box).max - 0.001,
        }
      : { atMin: true, atMax: true };
  return {
    stage,
    view,
    natural,
    pannable: !!(ready && view && canPan(view, ready.natural, ready.box)),
    dragging,
    ...bounds,
    zoomIn,
    zoomOut,
    fit,
    actualSize,
    consumeDrag,
    onImageLoad,
    stageHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  };
}
