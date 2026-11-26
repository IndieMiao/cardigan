import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { inIds } from "./sql-state.js";

// C-793: the execution view loads deliveries by work item. The indexed column
// mirrors the document; json_extract over the document parsed every row.
test("C-793: execution deliveries lookup searches deliveries_by_work_item without statistics", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const plan = store.database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT doc FROM deliveries WHERE project_id = ? AND (${inIds("work_item_id")})`,
      )
      .all("p", JSON.stringify(["W-1"]))
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toMatch(
      /SEARCH deliveries USING INDEX deliveries_by_work_item \(project_id=\? AND work_item_id=\?\)/u,
    );
  } finally {
    store.close();
  }
});
