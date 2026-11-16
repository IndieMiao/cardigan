import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { GithubBudgetJournal } from "./github-budget-journal.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";

test("D4: two consumers/projects and reopened SQLite share hourly deductions, 304 refunds and Retry-After", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-github-budget-"));
  const path = join(root, "state.sqlite");
  const opened = new Set<Store>();
  const open = () => {
    const store = Store.open({ dbPath: path });
    opened.add(store);
    return store;
  };
  let now = Date.parse("2026-11-15T00:00:00Z");
  try {
    const first = open();
    first.createProject({ id: "one" });
    first.createProject({ id: "two" });
    const second = open();
    const budget = (store: Store, executor = "github") =>
      new GithubRateLimit(
        2,
        () => now,
        new GithubBudgetJournal(store, executor),
      );
    const one = budget(first),
      two = budget(second, "github");
    const refund304 = one.reserve();
    two.reserve();
    expect(() => one.reserve()).toThrow(GithubRetryLater);
    refund304();
    refund304(); // Refund is idempotent, including across intervening writers.
    two.reserve();
    expect(() => one.reserve()).toThrow(GithubRetryLater);
    first.close();
    opened.delete(first);
    second.close();
    opened.delete(second);
    const reopened = open();
    const afterRestart = budget(reopened);
    expect(() => afterRestart.reserve()).toThrow(GithubRetryLater);
    expect(() => budget(reopened, "other").reserve()).not.toThrow();
    now += 3_600_000;
    afterRestart.reserve();
    expect(() => afterRestart.backoff("60")).toThrow(GithubRetryLater);
    const another = open();
    expect(() => budget(another, "github").reserve()).toThrow(GithubRetryLater);
    now += 60_000;
    expect(() => budget(another, "github").reserve()).not.toThrow();
    expect(() => afterRestart.reserve()).toThrow(GithubRetryLater);
    const doc = reopened.database
      .prepare(
        "SELECT doc FROM global_events WHERE type = 'github_rest_budget' ORDER BY seq DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(String(doc?.doc)).payload).toMatchObject({
      executor: "github",
      used: 2,
    });
    expect(JSON.stringify(doc)).not.toMatch(/token|private|Authorization/u);
  } finally {
    for (const store of opened) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("D4: a budget write failure prevents the caller from obtaining a request reservation", () => {
  const rate = new GithubRateLimit(2000, () => 1, {
    update: () => {
      throw new Error("fixed storage failure");
    },
  });
  expect(() => rate.reserve()).toThrow("fixed storage failure");
});
