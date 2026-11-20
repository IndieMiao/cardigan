// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { Popover, PopoverTrigger } from "../ui/popover.js";
import { CardPeek } from "./CardPeekLayout.js";

afterEach(cleanup);

function Peek() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger>甲</PopoverTrigger>
        <CardPeek
          aria-label="卡片 甲"
          // Stand-in for a sibling peek taking over before the outside press
          // lands: focus leaves, but this peek is only closed by state.
          onFocusOutside={(event) => event.preventDefault()}
        >
          <button type="button">内部</button>
        </CardPeek>
      </Popover>
      <button type="button" onClick={() => setOpen(false)}>
        乙
      </button>
    </>
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("closing gives focus back to the trigger when focus was inside", async () => {
  render(<Peek />);
  fireEvent.click(screen.getByRole("button", { name: "甲" }));
  await screen.findByRole("dialog", { name: "卡片 甲" });
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await tick();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "甲" }),
  );
});

test("closing leaves focus where it went, not back on the trigger", async () => {
  render(<Peek />);
  fireEvent.click(screen.getByRole("button", { name: "甲" }));
  await screen.findByRole("dialog", { name: "卡片 甲" });
  const other = screen.getByRole("button", { name: "乙" });
  other.focus();
  fireEvent.click(other);
  await tick();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(other);
});
