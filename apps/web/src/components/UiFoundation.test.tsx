// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { changeControl } from "../testing/controls.js";
import { SelectControl } from "./ui/select-control.js";
import { Table, TableHead, TableHeader, TableRow } from "./ui/table.js";

afterEach(cleanup);
function Form() {
  const [value, setValue] = useState("");
  return (
    <form aria-label="选择测试">
      <label>
        角色
        <SelectControl name="role" value={value} onValueChange={setValue}>
          <option value="">全部</option>
          <option value="coder">开发</option>
          <option value="blocked" disabled>
            停用
          </option>
        </SelectControl>
      </label>
    </form>
  );
}
test("select preserves empty/business form values and disabled options", () => {
  render(<Form />);
  const form = screen.getByRole("form") as HTMLFormElement;
  expect(new FormData(form).get("role")).toBe("");
  const trigger = screen.getByRole("combobox", { name: "角色" });
  changeControl(trigger, { target: { value: "coder" } });
  expect(new FormData(form).get("role")).toBe("coder");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const disabled = screen.getByRole("option", { name: "停用" });
  expect(disabled.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(disabled, { key: "Enter" });
  expect(new FormData(form).get("role")).toBe("coder");
});
test("select Escape closes the listbox and restores its trigger", async () => {
  render(<Form />);
  const trigger = screen.getByRole("combobox", { name: "角色" });
  changeControl(trigger, { target: { value: "coder" } });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
test("sortable and ordinary headers share semantics; sorting is keyboard actionable", () => {
  let calls = 0;
  render(
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>标题</TableHead>
          <TableHead sort="descending" onSort={() => calls++}>
            更新时间
          </TableHead>
        </TableRow>
      </TableHeader>
    </Table>,
  );
  const header = screen.getByRole("columnheader", { name: "更新时间" });
  expect(header.getAttribute("aria-sort")).toBe("descending");
  expect(
    screen
      .getByRole("columnheader", { name: "标题" })
      .getAttribute("aria-sort"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更新时间" }));
  expect(calls).toBe(1);
});
