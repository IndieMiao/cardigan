import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandState,
  compareHotState,
  type Event,
  eventById,
  eventsForDecision,
  eventsOfType,
  fullEventHistory,
  hotCommandEvents,
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

test("C-639 hot scope keeps open and targeted cards whole and matches the domain definition", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-hot-state-"));
  const full = Store.open({ dataDir, commandState: "full" });
  const hot = Store.open({ dataDir, commandState: "hot" });
  const event = (
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
    payload: {},
    created_at: NOW,
  });
  const open = serverCard;
  const closed = {
    ...serverCard,
    id: "C-2" as Event["card_id"] & string,
    status: "done" as const,
  };
  try {
    full.createProject({ id: project_id });
    full.uow.run((tx) => {
      tx.cards.put(project_id, open);
      tx.cards.put(project_id, closed);
      tx.events.append(project_id, event("p1", 1, "run_started"));
      tx.events.append(project_id, event("o1", 1, "run_started", open.id));
      tx.events.append(project_id, event("c1", 1, "card_merged", closed.id));
      tx.events.append(project_id, event("c2", 2, "run_started", closed.id));
    });
    const whole = full.uow.read((tx) => loadCommandState(tx, project_id));
    const ids = (s: { events: readonly Event[] }) => s.events.map((e) => e.id);
    // C-643: run_started is telemetry, so it is only in the journal.
    const all = (s: { events: readonly Event[] }) =>
      fullEventHistory(s.events).map((e) => e.id);
    expect(full.commandStateScope).toBe("full");
    expect(ids(whole)).toEqual(["c1"]);
    expect(all(whole)).toEqual(["p1", "o1", "c1", "c2"]);
    // Project stream and open cards stay whole; the cold card drops telemetry.
    const base = hot.uow.read((tx) => loadCommandState(tx, project_id));
    expect(all(base)).toEqual(["p1", "o1", "c1"]);
    const expected = hotCommandEvents(whole);
    expect(ids(base)).toEqual(expected.map((e) => e.id));
    expect(all(base)).toEqual(fullEventHistory(expected).map((e) => e.id));
    // A command naming the closed card (directly or nested) restores it.
    const targeted = hot.uow.read((tx) =>
      loadCommandState(tx, project_id, undefined, {
        targets: [{ nested: { card_id: closed.id } }],
      }),
    );
    expect(ids(targeted)).toEqual(ids(whole));
    expect(all(targeted)).toEqual(all(whole));
    expect(
      compareHotState(whole, base, { now: NOW }).filter((c) => !c.equal),
    ).toEqual([]);
  } finally {
    hot.close();
    full.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("C-643: command state leaves telemetry out of its stream and keeps it in the journal", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-telemetry-"));
  const store = Store.open({ dataDir });
  const event = (
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
    payload: { run_id: "R-1" },
    created_at: NOW,
  });
  try {
    store.createProject({ id: project_id });
    store.uow.run((tx) => {
      tx.cards.put(project_id, serverCard);
      tx.events.append(project_id, event("p-1", 1, "pm_coordination_started"));
      tx.events.append(
        project_id,
        event("p-2", 2, "session_maintenance_changed"),
      );
      tx.events.append(
        project_id,
        event("c-1", 1, "run_queued", serverCard.id),
      );
      tx.events.append(
        project_id,
        event("c-2", 2, "work_item_assigned", serverCard.id),
      );
      tx.events.append(
        project_id,
        event("c-3", 3, "run_dispatched", serverCard.id),
      );
      tx.events.append(
        project_id,
        event("c-4", 4, "github_check_dispatch", serverCard.id),
      );
      tx.events.append(
        project_id,
        event("c-5", 5, "assignment_branch_backed_up", serverCard.id),
      );
      tx.events.append(
        project_id,
        event("c-6", 6, "delivery_submitted", serverCard.id),
      );
    });
    const full = ["p-1", "p-2", "c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
    store.uow.read((tx) => {
      for (const state of [
        loadCommandState(tx, project_id),
        // Backends without the bulk port split the same way.
        loadCommandState(
          { ...tx, events: { listAfter: tx.events.listAfter } },
          project_id,
        ),
      ]) {
        expect(state.events.map((e) => e.id)).toEqual(["p-1", "c-2", "c-6"]);
        expect(fullEventHistory(state.events).map((e) => e.id)).toEqual(full);
        expect(
          eventsOfType(state.events, "run_dispatched").map((e) => e.id),
        ).toEqual(["c-3"]);
        expect(eventById(state.events, "c-1")?.type).toBe("run_queued");
      }
      // The raw streams (timeline, activity, get_updates) are unchanged.
      expect(
        [
          ...tx.events.listAfter(project_id, undefined, 0),
          ...tx.events.listAfter(project_id, serverCard.id, 0),
        ].map((e) => e.id),
      ).toEqual(full);
    });
    // C-640 log: telemetry of a rolled-back transaction never reaches later snapshots.
    const read = () => store.uow.read((tx) => loadCommandState(tx, project_id));
    const before = read();
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(
          project_id,
          event("c-7", 7, "run_started", serverCard.id),
        );
        const held = loadCommandState(tx, project_id);
        expect(held.events).toEqual(before.events);
        expect(eventById(held.events, "c-7")?.type).toBe("run_started");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    const after = read();
    expect(after.events).toBe(before.events);
    expect(eventById(after.events, "c-7")).toBeUndefined();
    expect(eventsOfType(after.events, "run_started")).toEqual([]);
    expect(fullEventHistory(after.events).map((e) => e.id)).toEqual(full);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
