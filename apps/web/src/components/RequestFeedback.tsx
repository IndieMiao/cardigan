import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const regions = new WeakMap<Element, { node: HTMLDivElement; users: number }>();

/** Share a stack, inside the active dialog when applicable (Radix hides its siblings). */
function useFeedbackRegion() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLDivElement>();
  useEffect(() => {
    const parent = anchor.current?.closest('[role="dialog"]') ?? document.body;
    let region = regions.get(parent);
    if (!region) {
      const node = document.createElement("div");
      node.className = "request-feedback-region";
      parent.append(node);
      region = { node, users: 0 };
      regions.set(parent, region);
    }
    region.users++;
    setTarget(region.node);
    return () => {
      if (--region.users === 0) {
        region.node.remove();
        regions.delete(parent);
      }
    };
  }, []);
  return { anchor, target };
}

export interface RequestFeedbackProps {
  pending?: boolean;
  /** Explicit writes / retries show progress immediately; automatic reads wait. */
  interactive?: boolean | undefined;
  pendingMessage?: string;
  message?: string | undefined;
  error?: string | undefined;
  retry?: (() => void) | undefined;
  retryLabel?: string;
}

/** Request feedback never occupies space in the page, including errors. */
export function RequestFeedback({
  pending = false,
  interactive = false,
  pendingMessage = "正在加载…",
  message,
  error,
  retry,
  retryLabel = "重试",
}: RequestFeedbackProps) {
  const { anchor, target } = useFeedbackRegion();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending || interactive) return;
    const timer = window.setTimeout(() => setSlow(true), 1000);
    return () => window.clearTimeout(timer);
  }, [pending, interactive]);
  const text =
    error || (pending ? (interactive || slow ? pendingMessage : "") : message);
  return (
    <>
      <span ref={anchor} hidden />
      {target &&
        createPortal(
          <div
            className={`request-feedback${error ? " request-feedback-error" : ""}`}
            role={error ? "alert" : "status"}
            aria-live="polite"
            aria-atomic="true"
          >
            {text && <span>{text}</span>}
            {error && retry && (
              <button type="button" onClick={retry}>
                {retryLabel}
              </button>
            )}
          </div>,
          target,
        )}
    </>
  );
}
