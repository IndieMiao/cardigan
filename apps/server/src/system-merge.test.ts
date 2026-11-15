import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityChange,
  type ProjectId,
  setProjectPreferences,
  systemConfirmMerge,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { systemMergeFixture } from "../../../packages/domain/src/commands/system-merge/test-fixtures.js";
import type { MergeGit } from "./git.js";
import { MergeExecutor, runSystemCommand } from "./merge-loop.js";
import { needsYou } from "./web/read.js";

async function setup() {
  const fixture = await systemMergeFixture();
  // Use normal domain check transitions before saving the synthetic future snapshot.
  fixture.check();
  const state = fixture.f.state;
  const project = state.project_id as ProjectId;
  const root = mkdtempSync(join(tmpdir(), "cardigan-system-merge-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: project });
  const clock = { now: () => "2026-01-02T00:00:00Z" };
  store.uow.run((tx) => {
    const keys = [
      "machines",
      "project_preferences",
      "cards",
      "work_items",
      "assignments",
      "runs",
      "deliveries",
      "reviews",
      "decisions",
    ] as const;
    const changes = keys.flatMap((collection) =>
      (state[collection] ?? []).map((entity) => ({ collection, entity })),
    ) as EntityChange[];
    persistEffect(tx, project, {
      data: null,
      changes,
      events: state.events,
      timeline: [],
      token_requests: [],
    });
    // Snapshot import preserves the counters used by subsequent real transactions.
    for (const kind of [
      "card",
      "work_item",
      "assignment",
      "run",
      "delivery",
      "review",
      "decision",
    ] as const) {
      const lists = {
        card: state.cards,
        work_item: state.work_items,
        assignment: state.assignments,
        run: state.runs,
        delivery: state.deliveries,
        review: state.reviews,
        decision: state.decisions,
      };
      const maximum = Math.max(
        0,
        ...lists[kind].map((e) => Number(e.id.replace(/\D/g, ""))),
      );
      for (let n = 0; n < maximum; n++) tx.ids.next(project, kind);
    }
    for (const card of [undefined, ...state.cards.map((c) => c.id)]) {
      const max = Math.max(
        0,
        ...state.events.filter((e) => e.card_id === card).map((e) => e.seq),
      );
      for (let n = 0; n < max; n++) tx.ids.nextEventSequence(project, card);
    }
  });
  let current = store;
  const read = () => current.uow.read((tx) => loadCommandState(tx, project));
  const reopen = () => {
    current.close();
    current = Store.open({ dataDir: root });
    return current;
  };
  const close = () => {
    current.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    store,
    openPeer: () => Store.open({ dataDir: root }),
    project,
    state,
    q: fixture.q,
    clock,
    read,
    reopen,
    close,
  };
}

function publisher(project: ProjectId, mutate?: () => void) {
  const published = vi.fn();
  const git: MergeGit = {
    projectOf: () => ({
      project_id: project,
      source_repo: "synthetic-source",
      base_branch: "main",
    }),
    sync: async () => "up_to_date",
    merge: async () => {
      throw new Error("Expected guarded publication");
    },
    prepare: async () => {
      mutate?.();
      return {
        status: "candidate",
        candidate_sha: "d".repeat(40),
        previous_sha: "b".repeat(40),
        tree_sha: "c".repeat(40),
      };
    },
    publish: async (_project, _completion, candidate, guard) =>
      guard(published)
        ? {
            status: "merged",
            merge_sha: candidate.candidate_sha,
            previous_sha: candidate.previous_sha,
            tree_sha: candidate.tree_sha,
          }
        : { status: "stale" },
  };
  return { git, published };
}

test("A3: merge loop confirms once, produces only a Needs You notice, and records done through fake guarded publisher", async () => {
  const f = await setup();
  try {
    const { git, published } = publisher(f.project);
    const executor = new MergeExecutor({ store: f.store, git, clock: f.clock });
    await Promise.all([executor.tick(), executor.tick()]);
    expect(published).toHaveBeenCalledTimes(1);
    expect(f.read().cards[0]?.status).toBe("done");
    expect(
      f.read().events.filter((e) => e.type === "decision_resolved"),
    ).toHaveLength(1);
    const view = needsYou(f.read(), f.clock.now(), "enabled");
    expect(view.decisions).toEqual([]);
    expect(view.notices).toMatchObject([
      { kind: "merge", resolved_by: "system" },
    ]);
  } finally {
    f.close();
  }
});

test("A3: separate connections, restart and failed commits cannot duplicate or lose a system resolution", async () => {
  const f = await setup();
  try {
    expect(() =>
      f.store.uow.run((tx) => {
        const result = systemConfirmMerge(
          loadCommandState(tx, f.project),
          { kind: "system", project_id: f.project },
          { decision_id: f.q.id },
          { clock: f.clock, ids: tx.ids },
        );
        if (!result.ok) throw new Error(result.error.message);
        persistEffect(tx, f.project, result.value);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(f.read().decisions[0]?.status).toBe("open");
    const resolve = (store: Store) =>
      runSystemCommand(
        store,
        f.project,
        (s, a, p) => systemConfirmMerge(s, a, { decision_id: f.q.id }, p),
        f.clock,
      );
    const peer = f.openPeer();
    try {
      expect(resolve(f.store).ok).toBe(true);
      expect(resolve(peer).ok).toBe(true);
    } finally {
      peer.close();
    }
    const restarted = f.reopen();
    expect(resolve(restarted).ok).toBe(true);
    expect(
      f.read().events.filter((e) => e.type === "decision_resolved"),
    ).toHaveLength(1);
    const { git, published } = publisher(f.project);
    await new MergeExecutor({ store: restarted, git, clock: f.clock }).tick();
    expect(published).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

test.each(["pause", "human condition"])(
  "A3: %s committed after preparation prevents publication; next tick reconciles authority",
  async (change) => {
    const f = await setup();
    try {
      let changed = false;
      const { git, published } = publisher(f.project, () => {
        if (changed) return;
        changed = true;
        f.store.uow.run((tx) => {
          if (change === "pause") {
            const result = setProjectPreferences(
              loadCommandState(tx, f.project),
              { kind: "human", project_id: f.project },
              { auto_merge_paused: true },
              { clock: f.clock, ids: tx.ids },
            );
            if (!result.ok) throw new Error(result.error.message);
            persistEffect(tx, f.project, result.value);
          } else {
            const card = tx.cards.list(f.project)[0];
            if (!card) throw new Error("Missing fixture card");
            tx.cards.put(f.project, { ...card, sensitive: true });
          }
        });
      });
      const executor = new MergeExecutor({
        store: f.store,
        git,
        clock: f.clock,
      });
      await executor.tick();
      expect(published).not.toHaveBeenCalled();
      expect(f.read().cards[0]?.status).toBe("awaiting_merge");
      await executor.tick();
      if (change === "human condition") {
        expect(f.read().decisions.find((q) => q.id === f.q.id)?.status).toBe(
          "superseded",
        );
        expect(f.read().decisions.at(-1)?.decider).toBe("human");
      } else {
        f.store.uow.run((tx) => {
          const result = setProjectPreferences(
            loadCommandState(tx, f.project),
            { kind: "human", project_id: f.project },
            { auto_merge_paused: false },
            { clock: f.clock, ids: tx.ids },
          );
          if (!result.ok) throw new Error(result.error.message);
          persistEffect(tx, f.project, result.value);
        });
        await executor.tick();
        expect(published).toHaveBeenCalledTimes(1);
      }
    } finally {
      f.close();
    }
  },
);
