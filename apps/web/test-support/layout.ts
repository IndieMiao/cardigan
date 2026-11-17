import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

/** Load the real rules: jsdom's offsetTop is always zero, so it cannot prove stability. */
export function installLayoutStyles() {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    new NodeURL("../src/styles.css", import.meta.url),
    "utf8",
  );
  document.head.append(style);
  return () => style.remove();
}

/** Snapshot in-flow boxes and sizing rules, optionally stopping at the first content block. */
export function flowLayout(root: Element, through?: Element): unknown {
  let reached = false;
  const visit = (element: Element): unknown => {
    if (reached) return null;
    const style = getComputedStyle(element);
    if (
      element.hasAttribute("hidden") ||
      style.display === "none" ||
      style.position === "absolute" ||
      style.position === "fixed"
    )
      return null;
    // Later descendants cannot move this block's top. Avoid measuring an entire
    // card timeline repeatedly just to compare the position of its header.
    if (element === through) reached = true;
    return {
      tag: element.tagName,
      class: element.getAttribute("class"),
      box: [
        style.display,
        style.position,
        style.width,
        style.height,
        style.minHeight,
        style.margin,
        style.padding,
        style.gap,
        style.fontSize,
        style.lineHeight,
      ],
      // Compare every element and box; only normalize the changing value text.
      content: Array.from(element.childNodes)
        .map((node) => {
          if (reached) return null;
          return node.nodeType === Node.ELEMENT_NODE
            ? visit(node as Element)
            : element.getAttribute("data-ui") === "select-value"
              ? "<selected-value>"
              : node.textContent?.trim() || null;
        })
        .filter((node) => node !== null),
    };
  };
  return visit(root);
}
