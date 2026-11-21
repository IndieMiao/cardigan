import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { recordCheckFlakes } from "./check-flake-ledger.js";
import { m4Fixture, m4Scenario } from "./m4-fixtures.js";

test("durable per-case rolling count, idempotent receipt and one PM escalation per window", () => {
  const f = m4Fixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const { card } = m4Scenario(f, "auto");
    function record(
      attempt: string,
      day: number,
      store = f.store,
      key: "ssh_remote" | "loopback" = "loopback",
    ) {
      return recordCheckFlakes(
        store,
        f.project_id,
        card.id,
        attempt,
        `2030-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
        [key, key],
        "2",
      );
    }
    expect(record("a", 1)).toContain("近七天 1 次");
    expect(record("a", 1, other)).toContain("近七天 1 次");
    expect(record("b", 2, other)).toContain("近七天 2 次");
    expect(record("b", 2)).toContain("近七天 2 次");
    expect(record("c", 4)).toContain("近七天 3 次");
    expect(record("d", 4, other, "ssh_remote")).toContain("近七天 1 次");
    const notices = () =>
      f.store
        .listNotifications({ project_id: f.project_id })
        .filter(
          (n) => n.recipient.kind === "pm_ops" && n.kind === "escalation",
        );
    expect(notices()).toHaveLength(1);
    expect(record("e", 11)).toContain("近七天 1 次");
    expect(record("f", 11, other)).toContain("近七天 2 次");
    expect(notices()).toHaveLength(2);
    expect(
      f.state().events.filter((e) => e.type === "check_case_recovered"),
    ).toHaveLength(6);
  } finally {
    other.close();
    f.close();
  }
});

test("two writers settling out of timestamp order share one monotonic weekly window", () => {
  const f = m4Fixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const { card } = m4Scenario(f, "auto");
    const record = (id: string, ms: number, store: Store) =>
      recordCheckFlakes(
        store,
        f.project_id,
        card.id,
        id,
        new Date(Date.UTC(2030, 0, 1) + ms).toISOString(),
        ["corepack"],
        "3",
      );
    const notices = () =>
      f.store
        .listNotifications({ project_id: f.project_id })
        .filter((n) => n.recipient.kind === "pm_ops" && n.kind === "escalation")
        .length;
    expect(record("a", 0, f.store)).toContain("近七天 1 次");
    expect(record("b", 1, other)).toContain("近七天 2 次");
    expect(record("c", 3, f.store)).toContain("近七天 3 次");
    expect(record("d", 2, other)).toContain("近七天 4 次");
    const next = 7 * 24 * 60 * 60 * 1000 + 3;
    expect(record("c", next, other)).toContain("近七天 3 次");
    expect(notices()).toBe(1);
    expect(record("e", next, f.store)).toContain("近七天 1 次");
    record("f", next, other);
    record("g", next, f.store);
    expect(notices()).toBe(2);
  } finally {
    other.close();
    f.close();
  }
});
