import { postComment } from "@cardigan/domain";
import * as mcp from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import { dispatchStateLoader } from "./dispatch-state.js";

afterEach(() => vi.restoreAllMocks());

test("an idle tick loads each project's command state once across all phases", async () => {
  const f = dispatchFixture();
  try {
    f.store.createProject({ id: "second" });
    const load = vi.spyOn(mcp, "loadCommandState");
    const dispatcher = new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime: {} as never,
      snapshot: async () => {
        throw new Error("idle");
      },
      startRun: async () => {
        throw new Error("idle");
      },
    });
    await dispatcher.tick();
    expect(load.mock.calls.map((args) => args[1])).toEqual([
      f.project,
      "second",
    ]);
    await dispatcher.tick();
    expect(load.mock.calls.map((args) => args[1])).toEqual([
      f.project,
      "second",
      f.project,
      "second",
    ]);
  } finally {
    f.close();
  }
});

test("cached states refresh after local writes, rollback and another connection's commit", () => {
  const f = dispatchFixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const target = f.create();
    const load = vi.spyOn(mcp, "loadCommandState");
    const read = dispatchStateLoader(f.store);
    const state = () => f.store.uow.read((tx) => read(tx, f.project));
    const initial = state();
    expect(state()).toBe(initial);
    expect(load).toHaveBeenCalledOnce();
    expect(() =>
      f.store.uow.run((tx) => {
        tx.cards.put(f.project, { ...target.card, title: "rolled back" });
        expect(read(tx, f.project).cards[0]?.title).toBe("rolled back");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(state().cards[0]?.title).toBe(target.card.title);
    other.uow.run((tx) =>
      tx.cards.put(f.project, { ...target.card, title: "external commit" }),
    );
    expect(state().cards[0]?.title).toBe("external commit");
    expect(load).toHaveBeenCalledTimes(4);
    f.store.uow.run((tx) => {
      tx.cards.put(f.project, { ...target.card, title: "local commit" });
      expect(read(tx, f.project).cards[0]?.title).toBe("local commit");
    });
    expect(state().cards[0]?.title).toBe("local commit");
    expect(load).toHaveBeenCalledTimes(5);
  } finally {
    other.close();
    f.close();
  }
});

test("another connection's write cannot change a pinned read snapshot or remain cached afterwards", () => {
  const f = dispatchFixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const target = f.create();
    const read = dispatchStateLoader(f.store);
    f.store.uow.read((tx) => {
      const pinned = read(tx, f.project);
      other.uow.run((writer) =>
        writer.cards.put(f.project, {
          ...target.card,
          title: "after snapshot",
        }),
      );
      expect(read(tx, f.project)).toBe(pinned);
      expect(read(tx, f.project).cards[0]?.title).toBe(target.card.title);
    });
    expect(f.store.uow.read((tx) => read(tx, f.project)).cards[0]?.title).toBe(
      "after snapshot",
    );
  } finally {
    other.close();
    f.close();
  }
});

test("a suspension committed while awaiting runtime status prevents a cached candidate from being dispatched", async () => {
  const f = dispatchFixture();
  const other = Store.open({ dataDir: f.dataDir });
  try {
    const target = f.create();
    f.session(target.assignment);
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Wake candidate",
        },
        p,
      ),
    );
    const wake = vi.fn();
    const status = vi.fn(async () => {
      other.uow.run((tx) => {
        const assignment = tx.assignments.get(f.project, target.assignment.id);
        if (!assignment) throw new Error("fixture assignment missing");
        tx.assignments.put(f.project, { ...assignment, status: "suspended" });
      });
      return {
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      };
    });
    const startRun = vi.fn();
    await new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime: { status, wake } as never,
      snapshot: async () => ({
        model: "fixture",
        agent_cli_version: "fixture",
      }),
      startRun,
    }).tick();
    expect(status).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    expect(f.state().runs).toHaveLength(1);
  } finally {
    other.close();
    f.close();
  }
});
