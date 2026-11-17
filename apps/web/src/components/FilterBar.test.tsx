// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FilterBar } from "./FilterBar.js";

afterEach(cleanup);

test("long filter chips preserve full values and only remove their own filter", () => {
  const query = "非常长的搜索文本".repeat(12);
  const onChange = vi.fn();
  const values = { q: query, status: "todo,review,unknown" };
  render(
    <FilterBar
      fields={[
        { key: "q", label: "搜索" },
        {
          key: "status",
          label: "状态",
          multiple: true,
          clearValue: "all",
          options: [
            { value: "todo", label: "待开始" },
            { value: "review", label: "审核中" },
          ],
        },
      ]}
      values={values}
      onChange={onChange}
    />,
  );
  const search = screen.getByRole("button", { name: "移除搜索筛选" });
  const status = screen.getByRole("button", { name: "移除状态筛选" });
  expect(search.title).toBe(`搜索：${query}`);
  expect(search.textContent).toContain(query);
  expect(status.title).toBe("状态：待开始、审核中、unknown");
  fireEvent.click(search);
  expect(onChange).toHaveBeenLastCalledWith({ ...values, q: "" });
  fireEvent.click(status);
  expect(onChange).toHaveBeenLastCalledWith({ ...values, status: "all" });
});
