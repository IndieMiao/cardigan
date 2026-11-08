import { fireEvent, screen } from "@testing-library/react";

export async function selectMenu(trigger: RegExp, option: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: trigger }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: option }));
}
