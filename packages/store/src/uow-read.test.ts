import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ReadOnlyTransactionError } from "./repositories.js";
import { DEFAULT_DB_FILE, Store } from "./store.js";
import { card, launchSignalScript } from "./test-support.js";

let dataDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-read-"));
  dbPath = join(dataDir, DEFAULT_DB_FILE);
  store = Store.open({ dataDir });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const project_id = "p-fictional" as never;

test("uow.read returns rows and rolls back like a transaction", () => {
  store.uow.run((tx) => {
    tx.cards.put(project_id, {
      id: "C-1" as never,
      project_id,
      title: "Fictional card",
      goal: "",
      acceptance_criteria: [],
      source: { kind: "quote", text: "" },
      out_of_scope: [],
      related_cards: [],
      repo: "example/repo",
      base_branch: "main",
      priority: 1,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  const titles = store.uow.read((tx) =>
    tx.cards.list(project_id).map((card) => card.title),
  );
  expect(titles).toEqual(["Fictional card"]);

  // A throw inside read leaves the connection usable.
  expect(() =>
    store.uow.read(() => {
      throw new Error("fictional read failure");
    }),
  ).toThrow(/fictional read failure/);
  expect(store.uow.read((tx) => tx.cards.list(project_id))).toHaveLength(1);
});

test("writing through a read transaction throws", () => {
  const read: unknown = store.uow.read((tx) => tx);
  const repositories = read as {
    cards: { put(...args: unknown[]): void };
    events: { append(...args: unknown[]): void };
  };

  expect(() => repositories.cards.put(project_id, {})).toThrow(
    ReadOnlyTransactionError,
  );
  expect(() => repositories.cards.put(project_id, {})).toThrow(
    /not allowed in a read transaction/,
  );
  expect(() => repositories.events.append(project_id, {})).toThrow(
    ReadOnlyTransactionError,
  );
});

test("a read transaction does not take the write lock", () => {
  const other = Store.open({ dataDir });
  try {
    // A second connection writes while this read transaction is open; that
    // would fail with "database is locked" if the read held the write lock.
    const rows = store.uow.read(() => {
      other.uow.run((tx) => tx.cards.put(project_id, card()));
      return other.uow.read((tx) => tx.cards.list(project_id).length);
    });
    expect(rows).toBe(1);
  } finally {
    other.close();
  }
});

test("a nested read inside a read is rejected", () => {
  expect(() => store.uow.read(() => store.uow.read(() => 1))).toThrow(
    /nested UnitOfWork/,
  );
});

/**
 * Two-process test: another process holds BEGIN IMMEDIATE while this one reads.
 *
 * The child writes one row, prints `locked`, then waits for the release file.
 * A read in this process must finish while the lock is still held; the
 * write-transaction path (`uow.run`) must fail with SQLITE_BUSY instead, which
 * is the behaviour `uow.read` exists to avoid.
 */
test("a write in another process does not block a read", async () => {
  const releaseFile = join(dataDir, "release");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", launchSignalScript(dbPath, releaseFile)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForLine(child, "locked");

    const startedAt = performance.now();
    const rows = store.uow.read((tx) => tx.cards.list(project_id));
    const elapsed = performance.now() - startedAt;

    expect(rows).toEqual([]);
    expect(elapsed).toBeLessThan(1000);

    // Closing the write lock from this side is the only blocking direction left,
    // so shorten the busy timeout and confirm it still waits for the lock.
    store.database.exec("PRAGMA busy_timeout = 100");
    expect(() => store.uow.run((tx) => tx.cards.list(project_id))).toThrow(
      /locked|busy/i,
    );
  } finally {
    writeFileSync(releaseFile, "release");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});

function waitForLine(
  child: ReturnType<typeof spawn>,
  line: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`no "${line}" from child`)),
      10000,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes(line)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("the child script helper is wired to a real database file", () => {
  // Guards the fixture path used by the two-process test above.
  expect(statSync(dbPath).isFile()).toBe(true);
});
