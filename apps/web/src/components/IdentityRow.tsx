import { createContext, type HTMLAttributes, useContext } from "react";

const InlineIdentity = createContext(false);
export const useInlineIdentity = () => useContext(InlineIdentity);

/** Keep each identity/tag/control intact while wrapping whole groups in DOM order. */
export function IdentityRow({
  as: Element = "div",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "div" | "span" | "header" | "li" | "h4" | "summary";
}) {
  return (
    <InlineIdentity.Provider value={true}>
      <Element
        {...props}
        className={`identity-row${className ? ` ${className}` : ""}`}
      >
        {children}
      </Element>
    </InlineIdentity.Provider>
  );
}
