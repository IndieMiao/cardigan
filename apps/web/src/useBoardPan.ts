import { type RefObject, useEffect } from "react";

const INTERACTIVE =
  '.board-card, a, button, input, textarea, select, label, summary, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"]), [tabindex]:not(.board):not(.board-lane-cards)';

/** Mouse-only panning; native touch, wheel and keyboard scrolling stay intact. */
export function useBoardPan(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const board = scroller.current;
    if (!board) return;
    let pan: {
      pointerId: number;
      x: number;
      scrollLeft: number;
      dragging: boolean;
    } | null = null;
    let suppressClick = false;
    const stop = () => {
      const previous = pan;
      pan = null;
      board.classList.remove("board-pan-ready", "board-panning");
      if (previous && board.hasPointerCapture?.(previous.pointerId))
        board.releasePointerCapture(previous.pointerId);
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      if (
        pan ||
        event.pointerType !== "mouse" ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        board.contains(event.target.closest(INTERACTIVE)) ||
        board.scrollWidth <= board.clientWidth
      )
        return;
      const rect = board.getBoundingClientRect();
      // Leave the native horizontal scrollbar available for direct dragging.
      if (
        event.clientY >= rect.top + board.clientTop + board.clientHeight ||
        event.clientX >= rect.left + board.clientLeft + board.clientWidth
      )
        return;
      pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        scrollLeft: board.scrollLeft,
        dragging: false,
      };
      board.classList.add("board-pan-ready");
    };
    const move = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.pointerId) return;
      if ((event.buttons & 1) === 0) {
        stop();
        return;
      }
      const distance = event.clientX - pan.x;
      if (!pan.dragging) {
        if (Math.abs(distance) <= 5) return;
        pan.dragging = true;
        suppressClick = true;
        board.classList.add("board-panning");
        board.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      board.scrollLeft = Math.max(
        0,
        Math.min(
          board.scrollWidth - board.clientWidth,
          pan.scrollLeft - distance,
        ),
      );
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId === pan?.pointerId) stop();
    };
    const click = (event: MouseEvent) => {
      // Only the pointer click belonging to this drag; keyboard activation
      // and the next pointer gesture must keep their normal behavior.
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    board.addEventListener("pointerdown", down);
    board.addEventListener("click", click, true);
    board.addEventListener("lostpointercapture", end);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      board.removeEventListener("pointerdown", down);
      board.removeEventListener("click", click, true);
      board.removeEventListener("lostpointercapture", end);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
    };
  }, [scroller]);
}
