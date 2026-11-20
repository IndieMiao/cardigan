// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { TableBody, TableRow } from "../ui/table.js";
import {
  DataTableCell,
  DataTableId,
  DataTableLayout,
} from "./DataTableLayout.js";

afterEach(cleanup);

test("DataTableId keeps the text and offers a break only after _ - .", () => {
  const { container } = render(
    <code>
      <DataTableId>integration_verification-long.key</DataTableId>
    </code>,
  );
  const code = container.querySelector("code");
  expect(code?.textContent).toBe("integration_verification-long.key");
  expect(code?.innerHTML).toBe(
    "integration_<wbr>verification-<wbr>long.<wbr>key",
  );
});

test("recordsAlways adds the always-on record layout beside records", () => {
  const { container } = render(
    <DataTableLayout records recordsAlways aria-label="t">
      <TableBody>
        <TableRow>
          <DataTableCell data-record="lead">a</DataTableCell>
        </TableRow>
      </TableBody>
    </DataTableLayout>,
  );
  const table = container.querySelector("table");
  expect(table?.className).toMatch(/always/);
  expect(table?.className).toMatch(/records/);
});
