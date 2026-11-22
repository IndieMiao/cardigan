import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { id } from "../../../packages/domain/src/commands/test-fixtures.js";
import { centralFixture } from "../../../packages/git-transport/test-support/git.js";
import {
  realReviewTrust,
  reviewedCompletion,
} from "../../../packages/host/test-support/real-review.js";
import { measureWrites } from "../../../packages/host/test-support/tick-work.js";
import { MergeShadowObserver } from "./merge-shadow.js";

// V-2725: one current confirmation plus 15 unrecorded historical confirmations
// of the same completion. The host reads a protected policy and actual Git ref.
test("live review evidence is rechecked without holding the SQLite writer", async () => {
  const x = await centralFixture();
  const dbPath = join(x.root, "shadow.db");
  const store = Store.open({ dbPath });
  const other = new DatabaseSync(dbPath);
  try {
    const t = await realReviewTrust(x, "fixture-project");
    const { d, decision } = await reviewedCompletion(t);
    const project = d.state.project_id;
    store.createProject({ id: project });
    store.setTestReviewTrust(t.trust);
    store.uow.run((tx) => {
      for (const e of d.state.employees ?? []) tx.employees.put(e);
      for (const k of [
        "roles",
        "cards",
        "work_items",
        "assignments",
        "runs",
        "deliveries",
        "reviews",
        "decisions",
      ] as const)
        for (const row of d.state[k])
          (tx[k].put as (p: string, e: unknown) => void)(project, row);
      for (const e of d.state.events) tx.events.append(project, e);
      store.database
        .prepare(
          `INSERT INTO event_counters(project_id,stream,seq)
           SELECT project_id,stream,MAX(seq) FROM events WHERE project_id=? GROUP BY project_id,stream
           ON CONFLICT(project_id,stream) DO UPDATE SET seq=excluded.seq`,
        )
        .run(project);
      tx.project_preferences.put(project, {
        id: project,
        auto_merge_after_minutes: null,
        system_merge_shadow: true,
      });
      for (let i = 0; i < 15; i++)
        tx.decisions.put(project, {
          ...decision,
          id: id("decision", 900 + i),
          key: id("decision", 900 + i),
          status: "superseded",
        });
    });
    const shadows = () =>
      store.uow.read((tx) =>
        tx.events
          .listAfter(project, decision.card_id, 0)
          .filter((e) => e.type === "system_merge_shadow_recorded"),
      );
    const observer = new MergeShadowObserver(store, undefined, d.io.clock);
    // Independently attempt BEGIN IMMEDIATE
    // on a second connection at every synchronous central ref lookup.
    other.exec("PRAGMA busy_timeout = 0");
    const readRef = x.transport.readRefSync.bind(x.transport);
    const locked: unknown[] = [];
    const refs = vi
      .spyOn(x.transport, "readRefSync")
      .mockImplementation((...args) => {
        try {
          other.exec("BEGIN IMMEDIATE; ROLLBACK");
        } catch (error) {
          locked.push(error);
        }
        return readRef(...args);
      });
    const writes = await measureWrites(store, () => observer.tick(project));
    expect(shadows()).toHaveLength(16);
    expect(locked).toEqual([]);
    expect(refs.mock.calls.length).toBe(64); // 2 baseline reads per proof, at planning AND consumption
    expect(writes).toHaveLength(16);
    // One audit and its timeline entry, including sequence/index updates.
    expect(Math.max(...writes)).toBeLessThanOrEqual(8);
    expect(await measureWrites(store, () => observer.tick(project))).toEqual(
      [],
    );

    // Now revoke between projection and final guard, without changing SQLite.
    store.uow.run((tx) =>
      tx.decisions.put(project, {
        ...decision,
        id: id("decision", 999),
        key: id("decision", 999),
        status: "superseded",
      }),
    );
    const timeline = () =>
      store.uow.read((tx) => tx.timeline.list(project).length);
    const beforeRevocation = timeline();
    let reads = 0;
    store.observe({
      transaction(kind) {
        if (kind === "read" && ++reads === 2) t.revoke();
      },
    });
    await observer.tick(project);
    expect(shadows()).toHaveLength(16);
    expect(timeline()).toBe(beforeRevocation);
    store.observe(undefined);
    await observer.tick(project);
    expect(
      shadows()
        .filter(
          (e) => (e.payload as { decision_id: string }).decision_id === "Q-999",
        )
        .map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({
        would_confirm: false,
        pm_blockers: expect.arrayContaining([
          "增量复核的隔离证据已失效，须完整复核",
        ]),
      }),
    ]);
  } finally {
    other.close();
    store.close();
    await x.close();
  }
}, 20000);
