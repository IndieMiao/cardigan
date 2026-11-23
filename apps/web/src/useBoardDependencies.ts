import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CardListItem } from "./api.js";
import {
  connectorPath,
  intersectBoxes,
  type LineBox,
} from "./board-dependency-lines.js";
import type { BoardDependencyLine } from "./components/layout/BoardDependencyLayout.js";

/** Set on the card at the other end of a drawn line. */
export const RELATED_ATTRIBUTE = "data-dependency-related";

const boxOf = (element: Element): LineBox => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
};
const cardElement = (target: EventTarget | null) =>
  target instanceof Element
    ? target.closest<HTMLElement>("[data-card-id]")
    : null;

/**
 * C-659: while a board card is hovered or holds keyboard focus, lines to its
 * visible prerequisites and dependents. Nothing is measured until then, so
 * the board's first load is unchanged.
 *
 * A related card is "visible" when part of it shows inside its lane and the
 * board's scroll viewport. A card in a folded lane points at that lane's
 * strip; a card scrolled out of view, filtered out or not yet loaded gets no
 * line, so no line ever ends in empty space.
 */
export function useBoardDependencies(
  board: RefObject<HTMLElement | null>,
  frame: RefObject<HTMLElement | null>,
  cards: readonly CardListItem[],
): readonly BoardDependencyLine[] {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = hovered ?? focused;
  const [lines, setLines] = useState<readonly BoardDependencyLine[]>([]);
  const drawn = useRef("");
  const marked = useRef<HTMLElement[]>([]);
  const latest = useRef(cards);
  latest.current = cards;

  const draw = useCallback(() => {
    for (const element of marked.current)
      element.removeAttribute(RELATED_ATTRIBUTE);
    marked.current = [];
    const commit = (next: BoardDependencyLine[]) => {
      const key = next.map((line) => `${line.key}:${line.d}`).join("|");
      if (key === drawn.current) return;
      drawn.current = key;
      setLines(next);
    };
    const root = board.current,
      host = frame.current;
    if (!active || !root || !host) return commit([]);
    const tiles = new Map<string, HTMLElement>();
    for (const tile of root.querySelectorAll<HTMLElement>("[data-card-id]"))
      if (tile.dataset.cardId) tiles.set(tile.dataset.cardId, tile);
    const find = (id: string) => tiles.get(id);
    const source = find(active);
    if (!source) {
      // The card left the board (lane folded, filtered, refreshed away).
      setHovered(null);
      setFocused(null);
      return commit([]);
    }
    const all = latest.current;
    const dependency = all.find((card) => card.id === active)?.dependency;
    if (!dependency) return commit([]);
    const origin = host.getBoundingClientRect(),
      viewport = boxOf(root);
    const local = (box: LineBox): LineBox => ({
      left: box.left - origin.left,
      right: box.right - origin.left,
      top: box.top - origin.top,
      bottom: box.bottom - origin.top,
    });
    const visible = (element: Element) => {
      let box: LineBox | null = boxOf(element);
      const lane = element.closest(".board-lane-cards");
      if (lane) box = intersectBoxes(box, boxOf(lane));
      return box && intersectBoxes(box, viewport);
    };
    const from = visible(source);
    if (!from) return commit([]);
    const next: BoardDependencyLine[] = [];
    const edges = [
      ...dependency.predecessors.map((c) => [c.id, true] as const),
      ...dependency.successors.map((c) => [c.id, false] as const),
    ];
    const seen = new Set<string>();
    for (const [id, before] of edges) {
      if (id === active || seen.has(`${id}${before}`)) continue;
      seen.add(`${id}${before}`);
      const element = find(id);
      let box: LineBox | null = null;
      if (element) {
        box = visible(element);
        if (box) {
          element.setAttribute(RELATED_ATTRIBUTE, "");
          marked.current.push(element);
        }
      } else {
        const status = all.find((card) => card.id === id)?.status;
        // A folded lane: point at its strip, level with the lane's count.
        const strip = [
            ...root.querySelectorAll<HTMLElement>(".board-column-collapsed"),
          ].find((lane) => lane.dataset.status === status),
          toggle = strip?.querySelector(".column-toggle"),
          count = strip?.querySelector(".board-column-count");
        if (toggle && count) {
          const { left, right } = boxOf(toggle),
            { top, bottom } = boxOf(count);
          box = intersectBoxes({ left, right, top, bottom }, viewport);
        }
      }
      if (!box) continue;
      next.push({
        key: before ? `${id}>${active}` : `${active}>${id}`,
        d: before
          ? connectorPath(local(box), local(from))
          : connectorPath(local(from), local(box)),
      });
    }
    commit(next);
  }, [active, board, frame]);

  // Every board render (refresh, folding, more cards) re-measures; a no-op
  // while nothing is hovered or focused.
  useLayoutEffect(draw);

  useEffect(() => {
    const root = board.current;
    if (!root) return;
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      setHovered(cardElement(event.target)?.dataset.cardId ?? null);
    };
    const leave = () => setHovered(null);
    const focusIn = (event: FocusEvent) =>
      setFocused(cardElement(event.target)?.dataset.cardId ?? null);
    const focusOut = (event: FocusEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !root.contains(event.relatedTarget)
      )
        setFocused(null);
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    return () => {
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
    };
  }, [board]);

  // Follow the board's sideways scroll, every lane's own scroll and resizes.
  useEffect(() => {
    const root = board.current;
    if (!active || !root) return;
    let frameId = 0;
    const schedule = () => {
      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        draw();
      });
    };
    root.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    resize?.observe(root);
    return () => {
      root.removeEventListener("scroll", schedule, { capture: true });
      resize?.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [active, board, draw]);

  // Leave no highlight behind when the board unmounts.
  useEffect(
    () => () => {
      for (const element of marked.current)
        element.removeAttribute(RELATED_ATTRIBUTE);
    },
    [],
  );
  return lines;
}
