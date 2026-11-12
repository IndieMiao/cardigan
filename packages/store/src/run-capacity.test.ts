import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRunLimit } from "@cardigan/domain";
import { expect, test } from "vitest";
import { persistRunLimitEffect, readRunLimit, Store } from "./index.js";

test("capacity and audit commit atomically, survive reopen, and are visible across connections", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "capacity-store-"));
  const store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  const save = (limit: number, fail = false) =>
    store.uow.run((tx) => {
      const result = setRunLimit(
        { kind: "human" },
        { machine_id: "local", limit },
        {
          machines: [{ id: "local" }],
          previous: readRunLimit(store.database, "local")?.limit ?? 4,
          member_id: "M-1",
          clock: { now: () => "2026-11-12T00:00:00.000Z" },
          ids: tx.global_ids,
        },
      );
      if (!result.ok) throw new Error(result.error.message);
      persistRunLimitEffect(store.database, tx, result.value);
      if (fail) throw new Error("rollback");
    });
  try {
    save(6);
    expect(() => save(2, true)).toThrow("rollback");
    expect(readRunLimit(other.database, "local")?.limit).toBe(6);
    expect(
      other.uow.read((tx) =>
        tx.global_events
          .listAfter(0)
          .filter((event) => event.type === "run_capacity_updated"),
      ),
    ).toHaveLength(1);
    save(3);
  } finally {
    store.close();
    other.close();
  }
  const reopened = Store.open({ dataDir });
  try {
    expect(readRunLimit(reopened.database, "local")?.limit).toBe(3);
    expect(
      reopened.uow.read((tx) =>
        tx.global_events
          .listAfter(0)
          .filter((event) => event.type === "run_capacity_updated")
          .map((event) => event.payload),
      ),
    ).toMatchObject([
      { old_value: 4, new_value: 6, member_id: "M-1" },
      { old_value: 6, new_value: 3, member_id: "M-1" },
    ]);
  } finally {
    reopened.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
