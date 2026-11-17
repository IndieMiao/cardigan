import { createContext, type ReactNode, useContext } from "react";
import { isLongPlainProse } from "../../markdown.js";

/** Detail surfaces opt in; other consumers of shared Markdown keep their tone. */
export const DetailProse = createContext(false);
export function Prose({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const detail = useContext(DetailProse);
  return (
    <div
      className={
        detail && isLongPlainProse(text) ? "ui-prose-muted" : undefined
      }
    >
      {children}
    </div>
  );
}
