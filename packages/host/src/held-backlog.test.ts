import { expect, test } from "vitest";
import { DEFAULT_HELD_BACKLOG_MS, heldBacklogMs } from "./held-backlog.js";

// C-732: the resume-question threshold defaults to 30 minutes and is
// configurable; an invalid value fails host startup instead of silently
// disabling the question.
test("held backlog threshold: default, override and invalid values", () => {
  expect(DEFAULT_HELD_BACKLOG_MS).toBe(1_800_000);
  expect(heldBacklogMs({})).toBe(1_800_000);
  expect(heldBacklogMs({ CARDIGAN_HELD_BACKLOG_MS: "" })).toBe(1_800_000);
  expect(heldBacklogMs({ CARDIGAN_HELD_BACKLOG_MS: "600000" })).toBe(600_000);
  for (const bad of ["0", "-1", "1.5", "abc", "1e3"])
    expect(() => heldBacklogMs({ CARDIGAN_HELD_BACKLOG_MS: bad })).toThrow(
      "Invalid CARDIGAN_HELD_BACKLOG_MS",
    );
});
