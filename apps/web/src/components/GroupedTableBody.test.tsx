// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { GroupedTableBody } from "./GroupedTableBody.js";

afterEach(cleanup);
const rows = [
  { id: "a", state: "待办", owner: "甲" },
  { id: "b", state: "进行中", owner: "甲" },
  { id: "c", state: "待办", owner: "乙" },
];
function Table({
  field,
  data = rows,
  columns = 2,
}: {
  field?: "state" | "owner";
  data?: typeof rows;
  columns?: number;
}) {
  return (
    <table>
      <GroupedTableBody
        rows={data}
        groupBy={field ? (row) => row[field] : undefined}
        columns={columns}
        renderRow={(row) => (
          <tr key={row.id}>
            <td>{row.id}</td>
            <td>{row.state}</td>
          </tr>
        )}
      />
    </table>
  );
}
test("shared grouping works for different fields, keeps row order, and collapses only its own group", () => {
  const view = render(<Table field="state" />);
  expect(
    within(screen.getByRole("rowgroup", { name: "待办" }))
      .getAllByRole("row")
      .map((row) => row.textContent),
  ).toEqual(["a待办", "c待办"]);
  expect(screen.getByText("2 项")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: "折叠待办分组" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(
    document.getElementById(toggle.getAttribute("aria-controls") ?? "")?.hidden,
  ).toBe(true);
  expect(screen.queryByRole("rowgroup", { name: "待办" })).toBeNull();
  expect(screen.getByRole("rowgroup", { name: "进行中" })).toBeTruthy();
  view.rerender(<Table field="owner" columns={3} />);
  expect(
    within(screen.getByRole("rowgroup", { name: "甲" }))
      .getAllByRole("row")
      .map((row) => row.textContent),
  ).toEqual(["a待办", "b进行中"]);
  expect(
    screen.getByRole("button", { name: "折叠甲分组" }).closest("td")?.colSpan,
  ).toBe(3);
});
test("flat mode and updated subsets preserve existing table rows without inventing empty groups", () => {
  const view = render(<Table />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getAllByRole("row").map((row) => row.textContent)).toEqual([
    "a待办",
    "b进行中",
    "c待办",
  ]);
  view.rerender(<Table field="state" data={rows.slice(0, 1)} />);
  expect(screen.getByText("1 项")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "折叠进行中分组" })).toBeNull();
  view.rerender(<Table field="state" data={[]} />);
  expect(screen.queryByRole("row")).toBeNull();
});
