import { fireEvent, screen } from "@testing-library/react";

/** Exercise Radix's public keyboard and option interactions; native inputs keep change events. */
export function changeControl(
  element: Element | Window,
  event: { target?: Record<string, unknown> } = {},
) {
  if (
    !(element instanceof HTMLElement) ||
    element.tagName !== "BUTTON" ||
    element.getAttribute("role") !== "combobox"
  )
    return fireEvent.change(element, event);
  // jsdom has no layout, scrolling or pointer capture. Browser checks cover these APIs.
  if (!HTMLElement.prototype.scrollIntoView)
    HTMLElement.prototype.scrollIntoView = () => {};
  if (!HTMLElement.prototype.hasPointerCapture)
    HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.setPointerCapture)
    HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture)
    HTMLElement.prototype.releasePointerCapture = () => {};
  fireEvent.keyDown(element, { key: "ArrowDown" });
  const value = String(event.target?.value ?? "");
  const option = screen
    .getAllByRole("option")
    .find((node) => node.getAttribute("data-value") === value);
  if (!option) throw new Error(`Missing select option ${value}`);
  return fireEvent.keyDown(option, { key: "Enter" });
}
