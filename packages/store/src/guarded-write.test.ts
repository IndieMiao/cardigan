import { expect, test, vi } from "vitest";
import { Store } from "./store.js";
import { card, project_id, withTempStore } from "./test-support.js";

test("guarded promotion skips a held writer or a stale WAL snapshot; a new attempt commits atomically", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    const other = Store.open({ dataDir });
    const revision = () => {
      const v = store.snapshotVersion(project_id);
      if (!v) throw new Error("missing version");
      return v;
    };
    const append = vi.fn();
    try {
      store.database.exec("PRAGMA busy_timeout=1234");
      other.database.exec("BEGIN IMMEDIATE");
      try {
        expect(
          store.tryGuardedWrite(revision, revision(), () => append),
        ).toBeUndefined();
      } finally {
        other.database.exec("ROLLBACK");
      }
      const before = revision();
      expect(
        store.tryGuardedWrite(revision, before, () => {
          other.uow.run((tx) => tx.cards.put(project_id, card()));
          return append;
        }),
      ).toBeUndefined();
      expect(revision()).not.toBe(before);
      expect(append).not.toHaveBeenCalled();
      expect(store.database.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(
        1234,
      );
      const guard = vi.fn(() => append);
      expect(store.tryGuardedWrite(revision, before, guard)).toBeUndefined();
      expect(guard).not.toHaveBeenCalled();
      const fresh = revision();
      expect(() =>
        store.tryGuardedWrite(revision, fresh, () => (tx) => {
          tx.cards.put(project_id, card({ title: "not committed" }));
          throw new Error("synthetic append failure");
        }),
      ).toThrow("synthetic append failure");
      expect(store.uow.read((tx) => tx.cards.list(project_id)[0]?.title)).toBe(
        card().title,
      );
      const next = store.tryGuardedWrite(revision, revision(), () => (tx) => {
        tx.cards.put(project_id, card({ title: "confirmed" }));
      });
      expect(next).toBe(revision());
      expect(other.uow.read((tx) => tx.cards.list(project_id)[0]?.title)).toBe(
        "confirmed",
      );
    } finally {
      other.close();
    }
  });
});
