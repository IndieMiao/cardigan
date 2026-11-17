import { fireEvent, screen } from "@testing-library/react";

export async function selectMenu(trigger: RegExp, option: string) {
  fireEvent.keyDown(
    screen.queryByRole("combobox", { name: trigger }) ??
      screen.getByRole("button", { name: trigger }),
    {
      key: "ArrowDown",
    },
  );
  fireEvent.click(
    await screen.findByRole(
      screen.queryByRole("listbox") ? "option" : "menuitem",
      { name: option },
    ),
  );
}
