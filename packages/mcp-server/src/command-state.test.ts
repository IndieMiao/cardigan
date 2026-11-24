import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandState,
  type Event,
  eventById,
  eventsForDecision,
  eventsOfType,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { loadCommandState } from "./commands/execute.js";
import { NOW, project_id, serverCard } from "./test-support.js";

test("MCP state rechecks project machine authorization after another connection writes", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-machine-state-"));
  const store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  const read = () => store.uow.read((tx) => loadCommandState(tx, project_id));
  try {
    store.createProject({ id: project_id });
    const first = read();
    const local = first.machines?.[0];
    if (!local) throw new Error("missing local");
    expect(read()).toBe(first);
    other.uow.run((tx) =>
      tx.machines.put("other", {
        ...local,
        id: "worker-a",
        herdr_machine: "worker-a",
        label: "Worker A",
      }),
    );
    expect(read()).toBe(first);
    other.uow.run((tx) =>
      tx.machines.put(project_id, { ...local, status: "draining" }),
    );
    expect(read()).not.toBe(first);
    expect(read().machines).toEqual([{ ...local, status: "draining" }]);
  } finally {
    other.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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
    other.uow.run((tx) =>
      tx.cards.put(project_id, { ...serverCard, title: "Changed title" }),
    );
    expect(read().events).toBe(first.events);
    expect(read().cards[0]?.title).toBe("Changed title");
    other.uow.run((tx) => tx.cards.put(project_id, serverCard));
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

test("C-640: Store log indexes stay isolated across rollback and grow without re-sorting", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-state-log-"));
  const store = Store.open({ dataDir });
  const other = Store.open({ dataDir });
  const audit = (
    id: string,
    seq: number,
    type: string,
    card_id?: Event["card_id"],
  ): Event => ({
    id,
    seq,
    ...(card_id ? { card_id } : {}),
    type,
    actor: { kind: "system", project_id },
    payload: { decision_id: "Q-1" },
    created_at: NOW,
  });
  const read = () => store.uow.read((tx) => loadCommandState(tx, project_id));
  try {
    store.createProject({ id: project_id });
    store.uow.run((tx) => {
      tx.cards.put(project_id, serverCard);
      tx.events.append(project_id, audit("project-1", 1, "base"));
      tx.events.append(project_id, audit("card-1", 1, "base", serverCard.id));
    });
    const first = read();
    expect(eventsOfType(first.events, "base")).toHaveLength(2);
    let held: CommandState | undefined;
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(
          project_id,
          audit("secret", 2, "secret", serverCard.id),
        );
        held = loadCommandState(tx, project_id);
        expect(eventsOfType(held.events, "secret")).toHaveLength(1);
        expect(eventById(held.events, "secret")?.type).toBe("secret");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    const afterRollback = read();
    expect(afterRollback.events).toBe(first.events);
    expect(eventsOfType(afterRollback.events, "secret")).toEqual([]);
    expect(eventById(afterRollback.events, "secret")).toBeUndefined();
    expect(eventsForDecision(afterRollback.events, "Q-1")).toHaveLength(2);
    // The same seq/rowid is reused by a committed event from another connection.
    other.uow.run((tx) =>
      tx.events.append(project_id, audit("public", 2, "public", serverCard.id)),
    );
    const sort = vi.spyOn(Array.prototype, "sort");
    let next: CommandState;
    try {
      next = read();
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
    expect(next.events.map((e) => e.id)).toEqual([
      "project-1",
      "card-1",
      "public",
    ]);
    expect(eventsOfType(next.events, "secret")).toEqual([]);
    expect(eventsOfType(next.events, "public")).toHaveLength(1);
    expect(eventsForDecision(next.events, "Q-1")).toHaveLength(3);
    // Earlier snapshots, including the rolled-back one, keep their own answers.
    expect(eventsOfType(first.events, "public")).toEqual([]);
    expect(eventsOfType(held?.events ?? [], "public")).toEqual([]);
    expect(eventsOfType(held?.events ?? [], "secret")).toHaveLength(1);
    expect(first.events.map((e) => e.id)).toEqual(["project-1", "card-1"]);
  } finally {
    other.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
