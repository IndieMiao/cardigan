import { expect, test } from "vitest";
import { Store } from "./store.js";
import { card, project_id, withTempStore } from "./test-support.js";

test("C-638: write transactions report the lock wait apart from the hold", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    const other = Store.open({ dataDir });
    const locks: [number, number | undefined][] = [];
    const transactions: number[] = [];
    store.observe({
      writeLock: (wait, hold) => locks.push([wait, hold]),
      transaction: (_kind, ms) => transactions.push(ms),
    });
    try {
      store.database.exec("PRAGMA busy_timeout = 50");
      other.database.exec("BEGIN IMMEDIATE");
      try {
        expect(() =>
          store.uow.run((tx) => tx.cards.put(project_id, card())),
        ).toThrow();
      } finally {
        other.database.exec("ROLLBACK");
      }
      const [blocked] = locks;
      expect(blocked?.[0]).toBeGreaterThanOrEqual(40);
      expect(blocked?.[1]).toBeUndefined();

      store.uow.run((tx) => {
        // Hold the lock for 20 ms without using CPU.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        tx.cards.put(project_id, card());
      });
      const [wait, hold] = locks[1] ?? [];
      expect(wait).toBeLessThan(40);
      expect(hold).toBeGreaterThanOrEqual(15);
      // The whole UnitOfWork still covers wait plus hold.
      expect(transactions.at(-1)).toBeGreaterThanOrEqual(
        (wait ?? 0) + (hold ?? 0) - 1,
      );
      // Reads take no write lock.
      store.uow.read((tx) => tx.cards.list(project_id));
      expect(locks).toHaveLength(2);
    } finally {
      store.observe(undefined);
      other.close();
    }
  });
});

test("C-638: a throwing write-lock observer changes no transaction result", () => {
  withTempStore((store) => {
    store.createProject({ id: project_id });
    store.observe({
      writeLock: () => {
        throw new Error("observer");
      },
    });
    try {
      expect(store.uow.run(() => "committed")).toBe("committed");
      expect(() =>
        store.uow.run(() => {
          throw new Error("work failed");
        }),
      ).toThrow("work failed");
    } finally {
      store.observe(undefined);
    }
  });
});
