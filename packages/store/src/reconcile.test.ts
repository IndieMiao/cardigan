/**
 * M4.4 reconciliation ledger (M4 plan §3.6, development plan §12.6).
 *
 * `reconcile` reports findings; the store remembers when each was first seen,
 * when it was last confirmed and when it stopped appearing. A finding that
 * disappears is resolved, not deleted, and a finding that reappears after being
 * resolved counts as new again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findingKey, Store } from "./index.js";

const project = "p-reconcile" as never;
let dataDir: string;
let store: Store;
let time: number;
const clock = { now: () => new Date(time).toISOString() };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-reconcile-"));
  time = Date.parse("2030-01-01T00:00:00.000Z");
  store = Store.open({ dataDir, clock });
  store.createProject({ id: project, name: "Reconcile" });
});
afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const orphan = {
  kind: "orphan_worktree",
  detail: "Worktree exists but no Assignment owns it",
  path: "/srv/worktrees/p/A-9",
};

test("a finding keeps its first-seen time and updates last-seen", () => {
  const first = store.recordReconcileFindings(project, [orphan]);
  expect(first.created).toHaveLength(1);
  time += 60_000;
  const second = store.recordReconcileFindings(project, [
    { ...orphan, detail: "same path, new wording" },
  ]);
  expect(second.created).toEqual([]);
  const [record] = store.listReconcileFindings(project);
  expect(record).toMatchObject({
    id: findingKey(orphan),
    kind: "orphan_worktree",
    path: orphan.path,
    detail: "same path, new wording",
    first_seen_at: "2030-01-01T00:00:00.000Z",
    last_seen_at: "2030-01-01T00:01:00.000Z",
    resolved_at: null,
  });
});

test("a finding that disappears is resolved, and reappearing reopens it", () => {
  store.recordReconcileFindings(project, [orphan]);
  time += 60_000;
  expect(store.recordReconcileFindings(project, []).created).toEqual([]);
  expect(store.listReconcileFindings(project, { openOnly: true })).toEqual([]);
  const [resolved] = store.listReconcileFindings(project);
  expect(resolved?.resolved_at).toBe("2030-01-01T00:01:00.000Z");

  time += 60_000;
  const reopened = store.recordReconcileFindings(project, [orphan]);
  expect(reopened.created).toHaveLength(1);
  const [record] = store.listReconcileFindings(project);
  expect(record?.resolved_at).toBeNull();
  expect(record?.first_seen_at).toBe("2030-01-01T00:02:00.000Z");
});

test("kinds without a subject are one finding each and do not collide", () => {
  const diverged = {
      kind: "source_diverged",
      detail: "Registered source and central baseline diverged",
    },
    missing = {
      kind: "missing_worktree",
      detail: "gone",
      assignment_id: "A-2",
    };
  const { created } = store.recordReconcileFindings(project, [
    diverged,
    missing,
  ]);
  expect(created).toHaveLength(2);
  expect(store.listReconcileFindings(project, { openOnly: true })).toHaveLength(
    2,
  );
  expect(findingKey(diverged)).toBe("source_diverged:");
});
