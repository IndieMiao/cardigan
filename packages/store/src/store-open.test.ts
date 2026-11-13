import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { Store } from "./store.js";
import { latestSchemaVersion } from "./test-support.js";

test.each(["delete", "memory"])(
  "opening a file-backed database rejects journal_mode=%s and closes the connection",
  (journalMode) => {
    const dataDir = mkdtempSync(join(tmpdir(), "cardigan-wal-check-"));
    let opened: DatabaseSync | undefined;
    const exec = DatabaseSync.prototype.exec;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === "PRAGMA journal_mode = WAL") {
          opened = this;
          // Simulate SQLite silently retaining another mode on a real database.
          exec.call(this, `PRAGMA journal_mode = ${journalMode}`);
          return;
        }
        exec.call(this, sql);
      });
    try {
      expect(() => Store.open({ dataDir })).toThrow(
        `SQLite WAL mode required: expected journal_mode=wal, got ${journalMode}`,
      );
      expect(opened).toBeDefined();
      expect(opened?.isOpen).toBe(false);
    } finally {
      spy.mockRestore();
      if (opened?.isOpen) opened.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test.each([
  { dbPath: ":memory:", journalMode: "memory" },
  { dbPath: "", journalMode: "delete" },
])(
  "explicit non-WAL database $dbPath still initializes",
  ({ dbPath, journalMode }) => {
    const store = Store.open({ dbPath });
    try {
      expect(store.schemaVersion()).toBe(latestSchemaVersion());
      expect(store.database.prepare("PRAGMA journal_mode").get()).toMatchObject(
        {
          journal_mode: journalMode,
        },
      );
      expect(store.database.prepare("PRAGMA foreign_keys").get()).toMatchObject(
        {
          foreign_keys: 1,
        },
      );
      expect(store.database.prepare("PRAGMA busy_timeout").get()).toMatchObject(
        {
          timeout: 5000,
        },
      );
    } finally {
      store.close();
    }
  },
);

interface OpenResult {
  readonly pid: number;
  readonly version?: number;
  readonly journal?: string;
  readonly busyTimeout?: number;
  readonly error?: string;
}

/** Import first, then let the parent release both OS processes together. */
function openingProcess(dataDir: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { Store } = await import(process.argv[1]);
    process.once('message', () => {
      let store;
      let result;
      process.send({ type: 'opening' });
      try {
        store = Store.open({ dataDir: process.argv[2] });
        result = { pid: process.pid, version: store.schemaVersion(),
          journal: store.database.prepare('PRAGMA journal_mode').get().journal_mode,
          busyTimeout: store.database.prepare('PRAGMA busy_timeout').get().timeout };
      } catch (error) { result = { pid: process.pid, error: error.stack }; }
      finally { store?.close(); }
      process.send({ type: 'result', result }, () => process.disconnect());
    });
    process.send({ type: 'ready' });
  `,
      new URL("../dist/index.js", import.meta.url).href,
      dataDir,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  let result: OpenResult | undefined;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<boolean>((resolve) => {
    child.on("message", (message: { type: string; result?: OpenResult }) => {
      if (message.type === "ready") resolve(true);
      if (message.type === "result") result = message.result;
    });
    child.once("error", () => resolve(false));
    child.once("exit", () => resolve(false));
  });
  const exited = new Promise<OpenResult>((resolve) => {
    child.once("error", (error) =>
      resolve({ pid: child.pid ?? -1, error: error.message }),
    );
    child.once("close", (code) =>
      resolve(
        result ?? {
          pid: child.pid ?? -1,
          error: `child exited ${code}: ${stderr}`,
        },
      ),
    );
  });
  return {
    child,
    ready,
    exited,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

test("two processes simultaneously opening the same new database both finish initialization", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-first-open-"));
  const children = [openingProcess(dataDir), openingProcess(dataDir)];
  try {
    expect(await Promise.all(children.map((probe) => probe.ready))).toEqual([
      true,
      true,
    ]);
    expect(existsSync(join(dataDir, "cardigan.db"))).toBe(false);
    for (const probe of children) probe.child.send("open");
    const results = await Promise.all(children.map((probe) => probe.exited));
    expect(new Set(results.map((result) => result.pid)).size).toBe(2);
    for (const result of results) {
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({
        version: latestSchemaVersion(),
        journal: "wal",
        busyTimeout: 5000,
      });
    }
    const store = Store.open({ dataDir });
    try {
      expect(store.migrate()).toEqual([]);
      expect(store.uow.read((tx) => tx.members.list())).toHaveLength(1);
      expect(
        store.uow.read((tx) =>
          tx.global_events
            .listAfter(0)
            .filter((event) => event.type === "member_created"),
        ),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all(children.map((probe) => probe.close()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 15_000);

test("opening a database waits for an existing rollback-journal lock before switching to WAL", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-open-lock-"));
  const locker = new DatabaseSync(join(dataDir, "cardigan.db"));
  locker.exec("BEGIN EXCLUSIVE");
  const probe = openingProcess(dataDir);
  let release: ReturnType<typeof setTimeout> | undefined;
  let locked = true;
  const unlock = () => {
    if (locked) {
      locker.exec("COMMIT");
      locked = false;
    }
  };
  try {
    expect(await probe.ready).toBe(true);
    probe.child.on("message", (message: { type: string }) => {
      if (message.type === "opening") release = setTimeout(unlock, 150);
    });
    probe.child.send("open");
    const result = await probe.exited;
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      version: latestSchemaVersion(),
      journal: "wal",
      busyTimeout: 5000,
    });
  } finally {
    clearTimeout(release);
    unlock();
    await probe.close();
    locker.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 15_000);
