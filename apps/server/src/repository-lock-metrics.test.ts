import type { RepositoryLockSample } from "@cardigan/git-service";
import { expect, test } from "vitest";
import { RepositoryLockMetrics } from "./repository-lock-metrics.js";

const sample = (
  over: Partial<RepositoryLockSample> = {},
): RepositoryLockSample => ({
  project_id: "cardigan",
  machine_id: "local",
  operation: "candidate.check",
  wait_ms: 0,
  hold_ms: 0,
  outcome: "ok",
  ...over,
});

test("C-636: one line per project, machine and operation per window, with exact counts", () => {
  const lines: Record<string, unknown>[] = [];
  const metrics = new RepositoryLockMetrics({
    log: (line) => lines.push({ ...line }),
    sha: "a".repeat(40),
    now: () => new Date("2026-11-23T00:00:00.000Z"),
    reportIntervalMs: 0,
    maxSamples: 50,
  });
  for (let i = 1; i <= 100; i++)
    metrics.record(sample({ wait_ms: i, hold_ms: i / 10 }));
  metrics.record(sample({ operation: "worktree.ensure", hold_ms: 1500 }));
  metrics.record(
    sample({ operation: "worktree.ensure", outcome: "error", hold_ms: 2 }),
  );
  metrics.record(
    sample({
      operation: "worktree.ensure",
      outcome: "timeout",
      wait_ms: 30_000,
    }),
  );
  // A timeout is logged at once, before any summary.
  expect(lines).toEqual([
    {
      event: "repository_lock_timeout",
      project_id: "cardigan",
      machine_id: "local",
      operation: "worktree.ensure",
      wait_ms: 30_000,
      ts: "2026-11-23T00:00:00.000Z",
      sha: "a".repeat(40),
    },
  ]);
  metrics.report();
  expect(lines.slice(1)).toEqual([
    {
      event: "repository_lock",
      project_id: "cardigan",
      machine_id: "local",
      operation: "candidate.check",
      n: 100,
      timeouts: 0,
      errors: 0,
      // Percentiles from the first 50 kept samples; counts and maxima exact.
      wait_p50_ms: 26,
      wait_p95_ms: 48,
      wait_max_ms: 100,
      hold_p50_ms: 2.6,
      hold_p95_ms: 4.8,
      hold_max_ms: 10,
      ts: "2026-11-23T00:00:00.000Z",
      sha: "a".repeat(40),
    },
    {
      event: "repository_lock",
      project_id: "cardigan",
      machine_id: "local",
      operation: "worktree.ensure",
      n: 3,
      timeouts: 1,
      errors: 1,
      wait_p50_ms: 0,
      wait_p95_ms: 30_000,
      wait_max_ms: 30_000,
      // A timed-out wait never held the lock and is not a hold sample.
      hold_p50_ms: 1500,
      hold_p95_ms: 1500,
      hold_max_ms: 1500,
      ts: "2026-11-23T00:00:00.000Z",
      sha: "a".repeat(40),
    },
  ]);
  // Each window starts empty; stop flushes the last one.
  metrics.report();
  expect(lines).toHaveLength(3);
  metrics.record(sample({ project_id: "sensen", machine_id: "mac" }));
  metrics.stop();
  expect(lines[3]).toMatchObject({
    event: "repository_lock",
    project_id: "sensen",
    machine_id: "mac",
    n: 1,
  });
});
