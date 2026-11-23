import type { CardId, ProjectId } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { ReadOnlyTransactionError } from "./read-only.js";
import type { OptimisticContext } from "./store.js";
import { Store } from "./store.js";
import { card, project_id, withTempStore } from "./test-support.js";

const other_project = "p-other" as ProjectId;

/** True when another connection can take the writer lock right now. */
function writerFree(other: Store): boolean {
  other.database.exec("PRAGMA busy_timeout = 0");
  try {
    other.database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (String((error as Error).message).includes("locked")) return false;
    throw error;
  }
  other.database.exec("ROLLBACK");
  return true;
}

function withTwoConnections(run: (store: Store, other: Store) => void) {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    store.createProject({ id: other_project });
    const other = Store.open({ dataDir });
    try {
      run(store, other);
    } finally {
      other.close();
    }
  });
}

const title = (store: Store, id = "C-1") =>
  store.uow.read((tx) => tx.cards.get(project_id, id as CardId)?.title);

test("C-641: the plan computes without the writer lock and only its write holds it", () => {
  withTwoConnections((store, other) => {
    const seen: boolean[] = [];
    const value = store.uow.optimistic(project_id, (tx) => {
      seen.push(writerFree(other));
      // The snapshot is read-only; writes belong in `write`.
      const writable = tx.cards as unknown as {
        put(project: ProjectId, entity: unknown): void;
      };
      expect(() => writable.put(project_id, card())).toThrow(
        ReadOnlyTransactionError,
      );
      return {
        value: "planned",
        write: (w) => {
          seen.push(writerFree(other));
          w.cards.put(project_id, card({ title: "committed" }));
        },
      };
    });
    expect(value).toBe("planned");
    expect(seen).toEqual([true, false]);
    expect(title(other)).toBe("committed");
    expect(store.optimisticStats).toEqual({
      committed: 1,
      unchanged: 0,
      conflicts: 0,
      fallbacks: 0,
    });
  });
});

test("C-641: a plan with nothing to write never waits for the writer lock", () => {
  withTwoConnections((store, other) => {
    store.database.exec("PRAGMA busy_timeout = 50");
    other.database.exec("BEGIN IMMEDIATE");
    try {
      expect(
        store.uow.optimistic(project_id, (tx) => ({
          value: tx.cards.list(project_id).length,
        })),
      ).toBe(0);
    } finally {
      other.database.exec("ROLLBACK");
    }
    expect(store.optimisticStats.unchanged).toBe(1);
  });
});

test("C-641: a write to the project's read set recomputes; other projects and non-command rows do not conflict", () => {
  withTwoConnections((store, other) => {
    store.uow.run((tx) => tx.cards.put(project_id, card({ title: "v1" })));
    let calls = 0;
    store.uow.optimistic(project_id, (tx) => {
      calls++;
      const read = tx.cards.get(project_id, "C-1" as CardId)?.title;
      if (calls === 1)
        other.uow.run((w) => w.cards.put(project_id, card({ title: "v2" })));
      return {
        value: undefined,
        write: (w) =>
          w.cards.put(
            project_id,
            card({ id: "C-2" as CardId, title: `seen ${read}` }),
          ),
      };
    });
    expect(calls).toBe(2);
    expect(title(store, "C-2")).toBe("seen v2");
    expect(store.optimisticStats).toMatchObject({ committed: 1, conflicts: 1 });

    calls = 0;
    store.uow.optimistic(project_id, () => {
      calls++;
      other.uow.run((w) => {
        w.cards.put(other_project, card({ project_id: other_project }));
        w.ids.next(other_project, "card");
      });
      return {
        value: undefined,
        write: (w) => w.cards.put(project_id, card({ title: "v3" })),
      };
    });
    expect(calls).toBe(1);
    expect(title(store)).toBe("v3");
    expect(store.optimisticStats).toMatchObject({ committed: 2, conflicts: 1 });
  });
});

test("C-641: IDs numbered in the snapshot commit with the plan and conflict when another writer took one", () => {
  withTwoConnections((store, other) => {
    const allocate = (tx: OptimisticContext) => ({
      card: tx.ids.next(project_id, "card"),
      seq: tx.ids.nextEventSequence(project_id, "C-1" as CardId),
    });
    // Nothing written: nothing burned.
    store.uow.optimistic(project_id, (tx) => ({ value: allocate(tx) }));
    let calls = 0;
    const planned = store.uow.optimistic(project_id, (tx) => {
      calls++;
      const ids = allocate(tx);
      if (calls === 1) other.uow.run((w) => w.ids.next(project_id, "card"));
      return {
        value: ids,
        write: (w) =>
          w.cards.put(project_id, card({ id: ids.card, title: "numbered" })),
      };
    });
    expect(calls).toBe(2);
    expect(planned).toEqual({ card: "C-2", seq: 1 });
    expect(title(store, "C-2")).toBe("numbered");
    expect(
      store.uow.run((tx) => ({
        card: tx.ids.next(project_id, "card"),
        seq: tx.ids.nextEventSequence(project_id, "C-1" as CardId),
      })),
    ).toEqual({ card: "C-3", seq: 2 });
  });
});

test("C-641: retries are bounded and then the plan runs under the writer lock", () => {
  withTwoConnections((store, other) => {
    const locked: boolean[] = [];
    let n = 0;
    const result = store.uow.optimistic(
      project_id,
      () => {
        const free = writerFree(other);
        locked.push(!free);
        if (free)
          other.uow.run((w) =>
            w.cards.put(project_id, card({ title: `race ${++n}` })),
          );
        return {
          value: locked.length,
          write: (w) => w.cards.put(project_id, card({ title: "final" })),
        };
      },
      { attempts: 2 },
    );
    expect(locked).toEqual([false, false, true]);
    expect(result).toBe(3);
    expect(title(store)).toBe("final");
    expect(store.optimisticStats).toEqual({
      committed: 0,
      unchanged: 0,
      conflicts: 2,
      fallbacks: 1,
    });

    const direct = vi.fn(() => ({ value: !writerFree(other) }));
    expect(store.uow.optimistic(project_id, direct, { attempts: 0 })).toBe(
      true,
    );
    expect(direct).toHaveBeenCalledTimes(1);
    for (const attempts of [-1, 1.5, 21])
      expect(() =>
        store.uow.optimistic(project_id, direct, { attempts }),
      ).toThrow("Invalid optimistic attempt limit");
  });
});

test("C-641: machine placement is outside the validated read set and runs pessimistically", () => {
  withTwoConnections((store, other) => {
    const placement = { machines: new Map() } as never;
    const reader = vi.fn(() => placement);
    store.setMachinePlacementReader(reader);
    const locked: boolean[] = [];
    const value = store.uow.optimistic(project_id, (tx) => {
      locked.push(!writerFree(other));
      let read: unknown;
      try {
        read = tx.read_machine_placement?.(
          project_id,
          "2026-01-01T00:00:00.000Z",
          undefined,
          { assignments: [], work_items: [], runs: [] },
        );
      } catch {
        // A domain wrapper may swallow the signal; the Store still falls back.
        read = "swallowed";
      }
      return { value: read };
    });
    expect(value).toBe(placement);
    expect(locked).toEqual([false, true]);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(store.optimisticStats.fallbacks).toBe(1);
  });
});

test("C-641: plan and write failures persist nothing; nesting is rejected", () => {
  withTwoConnections((store) => {
    expect(() =>
      store.uow.optimistic(project_id, () => {
        throw new Error("synthetic plan failure");
      }),
    ).toThrow("synthetic plan failure");
    expect(() =>
      store.uow.optimistic(project_id, (tx) => {
        const id = tx.ids.next(project_id, "card");
        return {
          value: undefined,
          write: (w) => {
            w.cards.put(project_id, card({ id, title: "not committed" }));
            throw new Error("synthetic write failure");
          },
        };
      }),
    ).toThrow("synthetic write failure");
    expect(store.uow.read((tx) => tx.cards.list(project_id))).toEqual([]);
    expect(store.uow.run((tx) => tx.ids.next(project_id, "card"))).toBe("C-1");
    expect(() =>
      store.uow.run(() =>
        store.uow.optimistic(project_id, () => ({ value: undefined })),
      ),
    ).toThrow("nested UnitOfWork is not supported");
  });
});
