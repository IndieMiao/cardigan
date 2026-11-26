import { useEffect, useState } from "react";

/**
 * Whether this tab is showing. Pass it as `useResource`'s `enabled` so a page
 * left in a background tab stops reading and reads once when shown again.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}
