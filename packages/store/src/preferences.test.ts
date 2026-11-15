import { expect, test } from "vitest";
import { event, withTempStore } from "./test-support.js";

test("preferences persist per project, default absent, and roll back with their audit", () => {
  withTempStore((store) => {
    for (const id of ["one", "two"])
      expect(store.createProject({ id }).ok).toBe(true);
    expect(store.uow.read((tx) => tx.project_preferences.list("one"))).toEqual(
      [],
    );
    const save = (minutes: number | null) =>
      store.uow.run((tx) => {
        tx.project_preferences.put("one", {
          id: "one",
          auto_merge_after_minutes: minutes,
        });
        const { card_id: _card, ...audit } = event({
          seq: tx.ids.nextEventSequence("one"),
          type: "project_preferences_updated",
        });
        tx.events.append("one", audit);
      });
    save(10);
    expect(
      store.uow.read((tx) => tx.project_preferences.get("one", "one")),
    ).toMatchObject({ auto_merge_after_minutes: 10 });
    expect(store.uow.read((tx) => tx.project_preferences.list("two"))).toEqual(
      [],
    );
    expect(() =>
      store.uow.run((tx) => {
        tx.project_preferences.put("one", {
          id: "one",
          auto_merge_after_minutes: 20,
        });
        throw new Error("abort audit");
      }),
    ).toThrow("abort audit");
    expect(
      store.uow.read((tx) => tx.project_preferences.get("one", "one"))
        ?.auto_merge_after_minutes,
    ).toBe(10);
    save(null);
    expect(
      store.uow.read((tx) => tx.project_preferences.get("one", "one"))
        ?.auto_merge_after_minutes,
    ).toBeNull();
    expect(
      store.uow.read((tx) => tx.events.listAfter("one", undefined, 0)),
    ).toHaveLength(2);
    expect(store.migrate()).toEqual([]);
  });
});

test("human-decided merge preference preserves default absence and rolls back changes", () => {
  withTempStore((store) => {
    store.createProject({ id: "human-merge" });
    expect(
      store.uow.read((tx) =>
        tx.project_preferences.get("human-merge", "human-merge"),
      ),
    ).toBeUndefined();
    store.uow.run((tx) =>
      tx.project_preferences.put("human-merge", {
        id: "human-merge",
        auto_merge_after_minutes: null,
        pm_confirm_human_decided_merges: false,
      }),
    );
    expect(() =>
      store.uow.run((tx) => {
        tx.project_preferences.put("human-merge", {
          id: "human-merge",
          auto_merge_after_minutes: null,
          pm_confirm_human_decided_merges: true,
        });
        throw new Error("audit failed");
      }),
    ).toThrow("audit failed");
    expect(
      store.uow.read((tx) =>
        tx.project_preferences.get("human-merge", "human-merge"),
      )?.pm_confirm_human_decided_merges,
    ).toBe(false);
  });
});
