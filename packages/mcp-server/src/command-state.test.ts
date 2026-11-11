import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { loadCommandState } from "./commands/execute.js";
import { NOW, project_id, serverCard } from "./test-support.js";

test("bulk event history preserves stream order, isolates projects and survives rollback/reopen", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-state-"));
  let store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  const audit = (
    id: string,
    seq: number,
    card_id?: Event["card_id"],
  ): Event => ({
    id,
    seq,
    ...(card_id ? { card_id } : {}),
    type: "fixture",
    actor: { kind: "system", project_id },
    payload: {},
    created_at: NOW,
  });
  const read = () => store.uow.read((tx) => loadCommandState(tx, project_id));
  try {
    store.createProject({ id: project_id });
    store.createProject({ id: "other" });
    store.uow.run((tx) => {
      tx.cards.put(project_id, serverCard);
      tx.events.append(project_id, audit("card-2", 2, serverCard.id));
      tx.events.append(project_id, audit("project-1", 1));
      tx.events.append(project_id, audit("card-1", 1, serverCard.id));
      tx.events.append("other", audit("other-1", 1));
    });
    const first = read();
    expect(first.events.map((e) => e.id)).toEqual([
      "project-1",
      "card-1",
      "card-2",
    ]);
    store.uow.read((tx) => {
      const after = vi.spyOn(tx.events, "listAfter");
      const bulk = vi.spyOn(tx.events, "listStreams");
      expect(loadCommandState(tx, project_id)).toEqual(first);
      expect(loadCommandState(tx, project_id).events[2]).toBe(first.events[2]);
      expect(after).not.toHaveBeenCalled();
      expect(bulk).toHaveBeenCalledTimes(2);
      // Backends without the optional bulk port retain the exact legacy result.
      expect(
        loadCommandState(
          { ...tx, events: { listAfter: tx.events.listAfter } },
          project_id,
        ),
      ).toEqual(first);
    });
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(project_id, audit("rolled-back", 3, serverCard.id));
        expect(loadCommandState(tx, project_id).events.at(-1)?.id).toBe(
          "rolled-back",
        );
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(read()).toEqual(first);
    other.uow.run((tx) =>
      tx.events.append(project_id, audit("external", 3, serverCard.id)),
    );
    expect(read().events.map((e) => e.id)).toEqual([
      "project-1",
      "card-1",
      "card-2",
      "external",
    ]);
    // Later writes in the same transaction must be visible on the next load.
    store.uow.run((tx) => {
      loadCommandState(tx, project_id);
      tx.events.append(project_id, audit("same-transaction", 2));
      expect(loadCommandState(tx, project_id).events[1]?.id).toBe(
        "same-transaction",
      );
    });
    const committed = read();
    store.close();
    store = Store.open({ dataDir });
    expect(read()).toEqual(committed);
  } finally {
    other.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
