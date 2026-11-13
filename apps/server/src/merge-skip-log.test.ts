import type { CardId } from "@cardigan/domain";
import { expect, test } from "vitest";
import { MergeSkipLog } from "./merge-skip-log.js";

const clock = { now: () => "2026-01-01T08:25:00.000Z" };
const card = (n: number) => `C-${n}` as CardId;
const error = (message: string) =>
  ({ code: "illegal_transition", message }) as const;

test("C-112: one log per card and reason, again after the reason changes or the card was ready", () => {
  const logged: string[] = [];
  const log = new MergeSkipLog("merge loop", (m) => logged.push(m), clock);
  log.skipped("p", card(1), error("合并被待执行的人工事项 H-12 挡住"));
  log.skipped("p", card(1), error("合并被待执行的人工事项 H-12 挡住"));
  log.skipped("q", card(1), error("合并被待执行的人工事项 H-12 挡住"));
  expect(logged).toEqual([
    "[2026-01-01T08:25:00.000Z] merge loop skipped p/C-1: illegal_transition: 合并被待执行的人工事项 H-12 挡住",
    "[2026-01-01T08:25:00.000Z] merge loop skipped q/C-1: illegal_transition: 合并被待执行的人工事项 H-12 挡住",
  ]);
  log.skipped("p", card(1), error("合并被未解决的阻塞拍板 Q-3 挡住"));
  expect(logged).toHaveLength(3);
  log.ready("p", card(1));
  log.skipped("p", card(1), error("合并被未解决的阻塞拍板 Q-3 挡住"));
  expect(logged).toHaveLength(4);
  // Leaving awaiting_merge forgets the card; only that project's entries.
  log.retain("p", new Set());
  log.skipped("p", card(1), error("合并被未解决的阻塞拍板 Q-3 挡住"));
  log.skipped("q", card(1), error("合并被待执行的人工事项 H-12 挡住"));
  expect(logged).toHaveLength(5);
});

test("a throwing reporter never escapes, and the undelivered reason is retried", () => {
  const delivered: string[] = [];
  let fail = true;
  const log = new MergeSkipLog(
    "merge checks",
    (e) => {
      if (fail) throw new Error("temporary reporter failure");
      delivered.push(e);
    },
    clock,
  );
  const reason = error("合并被待执行的人工事项 H-12 挡住");
  expect(() => log.skipped("p", card(2), reason)).not.toThrow();
  expect(delivered).toEqual([]);
  fail = false;
  log.skipped("p", card(2), reason);
  log.skipped("p", card(2), reason);
  expect(delivered).toEqual([
    "[2026-01-01T08:25:00.000Z] merge checks skipped p/C-2: illegal_transition: 合并被待执行的人工事项 H-12 挡住",
  ]);
});
