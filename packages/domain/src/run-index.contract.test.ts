import { expect, test } from "vitest";
import { id, run } from "./commands/test-fixtures.js";
import { queuedRun, type Run, runById, runsOf } from "./index.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

const statuses = [
  "queued",
  "dispatched",
  "running",
  "completed",
  "cancelled",
] as const;

/** Random Run lists with duplicate ids and several queued Runs per Assignment. */
function randomRuns(seed: number): Run[] {
  const pick = rng(seed);
  return Array.from({ length: pick(25) }, (_, i) => ({
    ...run(pick(4) === 0 ? 1 + pick(i + 1) : i + 1, 1 + pick(5)),
    status: statuses[pick(statuses.length)] ?? "queued",
  }));
}

test("C-244: keyed Run lookups match the linear scans", () => {
  let hits = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const runs = randomRuns(seed);
    for (let n = 1; n <= runs.length + 2; n++) {
      const key = id("run", n);
      const expected = runs.find((r) => r.id === key);
      if (expected) hits++;
      expect(runById(runs, key)).toBe(expected);
    }
    for (const odd of [undefined, null, 7, {}, ""])
      expect(runById(runs, odd)).toBe(runs.find((r) => r.id === odd));
    for (let a = 1; a <= 6; a++) {
      const assignment = id("assignment", a);
      expect(queuedRun(runs, assignment)).toBe(
        runs.find(
          (r) => r.assignment_id === assignment && r.status === "queued",
        ),
      );
      expect(runsOf(runs, assignment)).toEqual(
        runs.filter((r) => r.assignment_id === assignment),
      );
    }
  }
  expect(hits).toBeGreaterThan(1000);
});

test("C-244: a new Run snapshot rebuilds the index; the old one keeps its answer", () => {
  const before: readonly Run[] = [{ ...run(1), status: "completed" }];
  const queued: Run = { ...run(2, 1), status: "queued" };
  const after: readonly Run[] = [...before, queued];
  expect(queuedRun(before, id("assignment", 1))).toBeUndefined();
  expect(queuedRun(after, id("assignment", 1))).toBe(queued);
  expect(runsOf(after, id("assignment", 1))).toHaveLength(2);
  expect(runsOf(before, id("assignment", 1))).toHaveLength(1);
  expect(runById(before, queued.id)).toBeUndefined();
});
