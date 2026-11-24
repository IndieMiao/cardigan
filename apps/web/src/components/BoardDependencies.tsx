import { memo, type RefObject } from "react";
import type { CardListItem } from "../api.js";
import { useBoardDependencies } from "../useBoardDependencies.js";
import { BoardDependencyLines } from "./layout/BoardDependencyLayout.js";

/**
 * C-659: the hover/focus dependency lines. Owns the hover state, so moving the
 * pointer across cards re-renders only this overlay, not the board. Render
 * it before the board inside the board's frame.
 */
export const BoardDependencies = memo(function BoardDependencies({
  board,
  frame,
  cards,
}: {
  board: RefObject<HTMLElement | null>;
  frame: RefObject<HTMLElement | null>;
  cards: readonly CardListItem[];
}) {
  const lines = useBoardDependencies(board, frame, cards);
  return lines.length > 0 ? <BoardDependencyLines lines={lines} /> : null;
});
