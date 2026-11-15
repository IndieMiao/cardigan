import { expect, test } from "vitest";
import type { NeedsPage } from "./api.js";
import { needsAges } from "./needs-age.js";

test("validated reuse advances display waits/countdowns without mutating its stored sample", () => {
  const page = {
    decisions: [{ waited_ms: 100, auto_merge: { remaining_ms: 500 } }],
    human_actions: [{ waited_ms: null }],
    incidents: [{ waited_ms: 20 }],
    attention: [{ waited_ms: 30 }],
  } as unknown as NeedsPage;
  const result = needsAges(
    page,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z",
  );
  expect(result.decisions[0]?.waited_ms).toBe(1100);
  expect(result.decisions[0]?.auto_merge?.remaining_ms).toBe(0);
  expect(result.human_actions[0]?.waited_ms).toBeNull();
  expect(result.incidents[0]?.waited_ms).toBe(1020);
  expect(page.decisions[0]?.waited_ms).toBe(100);
});
