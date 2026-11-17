import { fireEvent, screen } from "@testing-library/react";

/** Open the real shared card tab before interacting with its contents. */
export async function selectCardTab(name: RegExp) {
  fireEvent.click(await screen.findByRole("tab", { name }));
}
