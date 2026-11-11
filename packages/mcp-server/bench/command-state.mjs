// C-126: run after `pnpm exec tsc -b apps/server`.
// `node packages/mcp-server/bench/command-state.mjs`
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { loadCommandState } from "../dist/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "cg-state-bench-"));
const store = Store.open({ dataDir });
const project = "benchmark";
const now = "2030-01-01T00:00:00.000Z";
const event = (id, card_id, seq) => ({
  id,
  card_id,
  seq,
  type: "comment_posted",
  actor: { kind: "system", project_id: project },
  payload: { body: "Synthetic benchmark event", refs: [], mentions: [] },
  created_at: now,
});
const read = (legacy = false) =>
  store.uow.read((tx) =>
    loadCommandState(
      // Exactly the old loader's per-card listAfter(..., 0) path; all other lists
      // and the transaction boundary are identical in both measurements.
      legacy ? { ...tx, events: { listAfter: tx.events.listAfter } } : tx,
      project,
    ),
  );
const measure = (fn) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  store.createProject({ id: project });
  store.uow.run((tx) => {
    for (let c = 1; c <= 200; c++) {
      const id = `C-${c}`;
      tx.cards.put(project, {
        id,
        project_id: project,
        title: `Card ${c}`,
        goal: "Benchmark",
        acceptance_criteria: [],
        source: { kind: "quote", text: "fixture" },
        priority: 1,
        status: "todo",
        template: "general",
        out_of_scope: [],
        related_cards: [],
        created_by: "human",
        created_at: now,
      });
      for (let seq = 1; seq <= 100; seq++)
        tx.events.append(project, event(`e-${c}-${seq}`, id, seq));
    }
  });
  const cold = measure(() => read());
  assert.deepEqual(read(), read(true));
  for (let i = 0; i < 5; i++) {
    read(true);
    read();
  }
  const before = [],
    unchanged = [],
    incremental = [];
  for (let i = 0; i < 21; i++) {
    // Alternate execution order to limit GC/JIT order bias.
    if (i % 2) unchanged.push(measure(() => read()));
    before.push(measure(() => read(true)));
    if (!(i % 2)) unchanged.push(measure(() => read()));
  }
  for (let i = 0; i < 21; i++) {
    store.uow.run((tx) =>
      tx.events.append(project, event(`new-${i}`, "C-1", 101 + i)),
    );
    incremental.push(measure(() => read()));
  }
  assert.deepEqual(read(), read(true));
  const result = {
    node: process.version,
    cards: 200,
    initial_events: 20000,
    samples: 21,
    cold_ms: cold,
    before_median_ms: median(before),
    unchanged_median_ms: median(unchanged),
    incremental_median_ms: median(incremental),
    unchanged_speedup: median(before) / median(unchanged),
    incremental_speedup: median(before) / median(incremental),
  };
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.unchanged_speedup >= 5 && result.incremental_speedup >= 5);
} finally {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}
