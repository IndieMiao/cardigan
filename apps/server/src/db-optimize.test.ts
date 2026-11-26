import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { optimizeDatabase, startDbOptimizeLoop } from "./db-optimize.js";

const stats = (store: Store) =>
  Number(
    store.database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'",
      )
      .get()?.n,
  );

function seeded(): Store {
  const store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: "p" });
  const insert = store.database.prepare(
    "INSERT INTO deliveries (project_id, id, work_item_id, doc) VALUES ('p', ?, ?, '{}')",
  );
  for (let i = 0; i < 200; i += 1) insert.run(`D-${i}`, `W-${i % 7}`);
  return store;
}

test("C-793: optimizeDatabase gathers statistics for tables never analyzed", () => {
  const store = seeded();
  try {
    expect(stats(store)).toBe(0);
    optimizeDatabase(store);
    expect(stats(store)).toBe(1);
    expect(
      store.database
        .prepare(
          "SELECT stat FROM sqlite_stat1 WHERE idx = 'deliveries_by_work_item'",
        )
        .get()?.stat,
    ).toMatch(/^200 /u);
    // Repeating it is cheap and leaves the statistics in place.
    optimizeDatabase(store);
    expect(stats(store)).toBe(1);
  } finally {
    store.close();
  }
});

test("C-793: the optimize loop waits for startup, runs after its delay and stops cleanly", async () => {
  const store = seeded();
  const startup = Promise.withResolvers<boolean>();
  const errors: unknown[] = [];
  const loop = startDbOptimizeLoop({
    store,
    startup: startup.promise,
    initialDelayMs: 1,
    intervalMs: 3_600_000,
    onError: (error) => errors.push(error),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stats(store)).toBe(0);
    startup.resolve(true);
    await expect
      .poll(() => stats(store), { timeout: 2000, interval: 5 })
      .toBe(1);
  } finally {
    await loop.stop();
    store.close();
  }
  expect(errors).toEqual([]);
});

test("C-793: a failed startup never runs the optimize loop", async () => {
  const store = seeded();
  const loop = startDbOptimizeLoop({
    store,
    startup: Promise.resolve(false),
    initialDelayMs: 0,
    onError: () => {},
  });
  await loop.done;
  try {
    expect(stats(store)).toBe(0);
  } finally {
    store.close();
  }
});
