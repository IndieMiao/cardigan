// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { changeControl } from "../testing/controls.js";
import { CardsViewSwitch } from "./CardsViewSwitch.js";
import { FilterSelect } from "./FilterSelect.js";
import { PageToolbar } from "./PageToolbar.js";
import { RefreshGroup } from "./RefreshGroup.js";

afterEach(cleanup);

test("pending refresh remains focusable and never submits a second request", () => {
  const refresh = vi.fn();
  const props = {
    interval: 30000,
    onIntervalChange: vi.fn(),
    onRefresh: refresh,
  };
  const { rerender } = render(<RefreshGroup {...props} pending />);
  const button = screen.getByRole("button", { name: "立即刷新" });
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(refresh).not.toHaveBeenCalled();
  rerender(<RefreshGroup {...props} pending={false} />);
  fireEvent.click(button);
  expect(refresh).toHaveBeenCalledOnce();
});

test("filters keep their accessible value, clear in their dropdown and render no active-filter row", () => {
  const change = vi.fn();
  render(
    <PageToolbar
      fields={[
        {
          key: "role",
          label: "角色",
          options: [{ value: "coder", label: "开发" }],
          render: (value, onChange) => (
            <FilterSelect
              label="角色"
              value={value}
              options={[{ value: "coder", label: "开发" }]}
              onChange={onChange}
            />
          ),
        },
      ]}
      values={{ role: "coder", q: "标题" }}
      onChange={change}
    />,
  );
  const role = screen.getByRole("combobox", { name: "角色：开发" });
  expect(role.closest(".ui-filter-bar")?.querySelector("fieldset")).toBeNull();
  expect(screen.queryByRole("button", { name: /^移除/ })).toBeNull();
  changeControl(role, { target: { value: "" } });
  expect(change).toHaveBeenCalledWith({ role: "", q: "标题" });
});

test("card view preset preserves labels, selection and a single change callback", () => {
  const change = vi.fn();
  render(<CardsViewSwitch value="board" onChange={change} />);
  expect(
    screen.getByRole("button", { name: "看板" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("list");
});
