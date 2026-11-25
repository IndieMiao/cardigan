import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  advanceFlow,
  curveLength,
  flowDash,
  flowGap,
} from "./board-dependency-flow.js";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const reducedMotionQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION)
    : null;

/** Whether the system asks for reduced motion; follows later changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => reducedMotionQuery()?.matches ?? false,
  );
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/**
 * C-673: moves the dots of every `[data-flow]` path under `svg` (see
 * `board-dependency-flow.ts`), and with them (C-689) their halo rings, the
 * `[data-flow-glow]` paths of the same line. One animation frame loop runs
 * only while the lines are mounted and `running`; unmounting the lines stops
 * it. Each frame writes two attributes per path and reads no layout.
 */
export function useBoardDependencyFlow(
  svg: RefObject<SVGSVGElement | null>,
  lines: readonly { readonly key: string; readonly d: string }[],
  running: boolean,
): void {
  const phases = useRef(new Map<string, number>());
  const gaps = useMemo(
    () =>
      new Map(lines.map((line) => [line.key, flowGap(curveLength(line.d))])),
    [lines],
  );
  const current = useRef(gaps);

  const paint = useCallback(() => {
    const root = svg.current;
    if (!root) return;
    for (const path of root.querySelectorAll<SVGPathElement>(
      "[data-flow], [data-flow-glow]",
    )) {
      const key = path.dataset.flow ?? path.dataset.flowGlow ?? "";
      const dash = flowDash(
        current.current.get(key) ?? 0,
        phases.current.get(key) ?? 0,
      );
      if (path.getAttribute("stroke-dasharray") !== dash.dasharray)
        path.setAttribute("stroke-dasharray", dash.dasharray);
      path.setAttribute("stroke-dashoffset", dash.dashoffset);
    }
  }, [svg]);

  // Before the browser paints a redraw: new lines start with their dots half
  // a gap in (n dots, none on the card edge or the arrow); lines that stay
  // keep their phase on the new length.
  useLayoutEffect(() => {
    current.current = gaps;
    for (const key of [...phases.current.keys()])
      if (!gaps.has(key)) phases.current.delete(key);
    for (const [key, gap] of gaps)
      if (!phases.current.has(key)) phases.current.set(key, gap / 2);
    paint();
  }, [gaps, paint]);

  useEffect(() => {
    if (!running || typeof window.requestAnimationFrame !== "function") return;
    let frame = 0,
      last: number | null = null;
    const tick = (now: number) => {
      const ms = last === null ? 0 : now - last;
      last = now;
      for (const [key, gap] of current.current)
        phases.current.set(
          key,
          advanceFlow(phases.current.get(key) ?? 0, gap, ms),
        );
      paint();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [running, paint]);
}
