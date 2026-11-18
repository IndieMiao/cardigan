// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FilterBar } from "./FilterBar.js";

afterEach(cleanup);

test("active filters stay in their controls without a separate removable row", () => {
  const values = { q: "搜索词", status: "todo", role: "coder" };
  const { container } = render(
    <FilterBar
      fields={[
        { key: "q", label: "搜索" },
        {
          key: "role",
          label: "角色",
          options: [{ value: "coder", label: "开发" }],
        },
        {
          key: "status",
          label: "状态",
          multiple: true,
          options: [
            { value: "todo", label: "待开始" },
            { value: "review", label: "审核中" },
          ],
        },
      ]}
      values={values}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /^移除/ })).toBeNull();
  expect(screen.queryByRole("group", { name: "已选筛选" })).toBeNull();
  expect(container.querySelector(".filter-chips, .ui-filter-chips")).toBeNull();
  expect((screen.getByLabelText("搜索") as HTMLInputElement).value).toBe(
    "搜索词",
  );
  expect(screen.getByRole("combobox", { name: "角色" }).textContent).toBe(
    "开发",
  );
});
