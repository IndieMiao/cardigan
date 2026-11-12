// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PriorityBadge, PrioritySelect } from "./Priority.js";

afterEach(cleanup);
test("all tiers have distinct accessible symbols and keyboard focus", () => {
  render(
    [0, 1, 2, 3, 4].map((value) => <PriorityBadge key={value} value={value} />),
  );
  for (const label of ["无", "低", "中", "高", "紧急"]) {
    const badge = screen.getByRole("button", { name: `优先级：${label}` });
    expect(badge.tabIndex).toBe(0);
  }
});
test("search, current selection and keyboard navigation select a tier without submitting the form", async () => {
  const onChange = vi.fn();
  render(<PrioritySelect value={1} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "优先级：低" });
  fireEvent.click(trigger);
  const search = screen.getByRole("combobox", { name: "搜索优先级" });
  expect(document.activeElement).toBe(search);
  expect(
    screen.getByRole("option", { name: "低" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith(2);
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "urgent" },
  });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith(4);
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "不存在" },
  });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(onChange).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});
