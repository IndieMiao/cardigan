import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  DEFAULT_STARTUP_BUSY_RETRY_MS,
  DEFAULT_STARTUP_BUSY_WAIT_MS,
  isDatabaseLocked,
  startupBusyRetryConfig,
  startWithBusyRetry,
} from "./startup-busy-retry.js";

/** A clock that only moves when the retry sleeps. */
function clock() {
  let now = 0;
  const pauses: number[] = [];
  return {
    pauses,
    now: () => now,
    sleep: async (ms: number) => {
      pauses.push(ms);
      now += ms;
    },
  };
}

test("C-650: a start that meets a held write lock waits for its release and then starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-startup-busy-"));
  const store = Store.open({ dataDir: root });
  store.close();
  // The old process still holds the write lock while the new one starts.
  const holder = new DatabaseSync(join(root, "cardigan.db"));
  holder.exec("BEGIN IMMEDIATE");
  const c = clock();
  const warnings: string[] = [];
  let attempts = 0;
  try {
    const started = await startWithBusyRetry(
      async () => {
        attempts++;
        const s = Store.open({ dataDir: root });
        try {
          // Same as a background start that writes during initialisation.
          s.database.exec("PRAGMA busy_timeout = 0");
          s.database.exec("BEGIN IMMEDIATE");
          s.database.exec("COMMIT");
          return "ready";
        } finally {
          s.close();
        }
      },
      {
        waitMs: 10_000,
        retryMs: 1_000,
        now: c.now,
        sleep: async (ms) => {
          await c.sleep(ms);
          // The old process exits after the second pause.
          if (c.pauses.length === 2) holder.exec("COMMIT");
        },
        warn: (line) => warnings.push(line),
      },
    );
    expect(started).toBe("ready");
    expect(attempts).toBe(3);
    expect(c.pauses).toEqual([1_000, 1_000]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("database is locked");
  } finally {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C-650: the wait is bounded and other start failures are never retried", async () => {
  const locked = Object.assign(new Error("database is locked"), {
    errcode: 5,
  });
  const c = clock();
  let attempts = 0;
  await expect(
    startWithBusyRetry(
      async () => {
        attempts++;
        throw locked;
      },
      { waitMs: 2_500, retryMs: 1_000, now: c.now, sleep: c.sleep },
    ),
  ).rejects.toBe(locked);
  expect(c.pauses).toEqual([1_000, 1_000, 500]);
  expect(attempts).toBe(4);

  const other = new Error("listen EADDRINUSE");
  attempts = 0;
  await expect(
    startWithBusyRetry(
      async () => {
        attempts++;
        throw other;
      },
      { waitMs: 60_000, retryMs: 1_000, ...clock() },
    ),
  ).rejects.toBe(other);
  expect(attempts).toBe(1);
  // A zero wait keeps the old fail-fast start.
  attempts = 0;
  await expect(
    startWithBusyRetry(
      async () => {
        attempts++;
        throw locked;
      },
      { waitMs: 0, retryMs: 1_000, ...clock() },
    ),
  ).rejects.toBe(locked);
  expect(attempts).toBe(1);
});

test("C-650: lock detection follows causes; overrides are strict integers", () => {
  expect(isDatabaseLocked({ errcode: 5 })).toBe(true);
  expect(isDatabaseLocked({ errcode: 261 })).toBe(true); // SQLITE_BUSY_RECOVERY
  expect(isDatabaseLocked({ errcode: 6 })).toBe(true);
  expect(
    isDatabaseLocked(
      new Error("startup failed", {
        cause: new Error("database is locked"),
      }),
    ),
  ).toBe(true);
  for (const error of [
    undefined,
    "database is locked",
    new Error("database disk image is malformed"),
    { errcode: 11 },
  ])
    expect(isDatabaseLocked(error)).toBe(false);

  expect(startupBusyRetryConfig({})).toEqual({
    waitMs: DEFAULT_STARTUP_BUSY_WAIT_MS,
    retryMs: DEFAULT_STARTUP_BUSY_RETRY_MS,
  });
  expect(
    startupBusyRetryConfig({
      CARDIGAN_STARTUP_BUSY_WAIT_MS: "0",
      CARDIGAN_STARTUP_BUSY_RETRY_MS: "250",
    }),
  ).toEqual({ waitMs: 0, retryMs: 250 });
  for (const env of [
    { CARDIGAN_STARTUP_BUSY_WAIT_MS: "-1" },
    { CARDIGAN_STARTUP_BUSY_WAIT_MS: "1.5" },
    { CARDIGAN_STARTUP_BUSY_WAIT_MS: "soon" },
    { CARDIGAN_STARTUP_BUSY_RETRY_MS: "0" },
  ])
    expect(() => startupBusyRetryConfig(env)).toThrow();
});
