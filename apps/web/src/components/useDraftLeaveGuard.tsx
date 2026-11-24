import { useEffect, useRef, useState } from "react";
import { registerLeaveGuard } from "../leave-guard.js";
import { parseRoute } from "../route.js";
import { SettingsDiscardDialog } from "./layout/SettingsLayout.js";

/**
 * An unsent draft on a card: closing or reloading the tab asks through the
 * browser; links to another page, closing the card drawer and `ask(leave)`
 * ask through the dialog titled `title`.
 */
export function useDraftLeaveGuard(
  dirty: boolean,
  projectId: string,
  cardId: string,
  forget: () => void,
  title: string,
) {
  const forgetRef = useRef(forget);
  forgetRef.current = forget;
  const [pending, setPending] = useState<() => void>();
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href^='#']")
          : null;
      if (!link || link.target === "_blank") return;
      const href = link.getAttribute("href") ?? "";
      const route = parseRoute(href);
      // Anchors within this card keep the page and the draft.
      if (
        route &&
        route.projectId === projectId &&
        ((route.kind === "card" && route.cardId === cardId) ||
          route.filters?.card === cardId)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => {
        forgetRef.current();
        window.location.hash = href;
      });
    };
    // Closing the card drawer (button, Escape, outside click) asks too.
    const unregister = registerLeaveGuard((leave) => {
      setPending(() => () => {
        forgetRef.current();
        leave();
      });
      return true;
    });
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, projectId, cardId]);
  const ask = (leave: () => void) => {
    if (dirty) setPending(() => leave);
    else leave();
  };
  const dialog = (
    <SettingsDiscardDialog
      title={title}
      open={pending !== undefined}
      onKeep={() => setPending(undefined)}
      onDiscard={() => {
        const leave = pending;
        setPending(undefined);
        leave?.();
      }}
    />
  );
  return { ask, dialog };
}
