/**
 * C-628: the off-site backfill runs in one process at a time, in bounded
 * ticks, and never starves the event loop of the process serving MCP.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Readable } from "node:stream";
import type { Attachment } from "@cardigan/domain";
import {
  artifactKey,
  fileAttachmentStore,
  Offsite,
  type OssTransport,
  registerOffsite,
  writeSyncStatus,
} from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FakeOss,
  startFakeOss,
  writeStorageConfig,
} from "../../../packages/mcp-server/test-support/fake-oss.js";
import {
  OFFSITE_TICK_MAX_FILES,
  OffsiteSync,
  offsiteSyncLockPath,
} from "./offsite-sync.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let root: string, dataDir: string, configDir: string;
let fake: FakeOss, records: Attachment[];
let unregister: (() => void) | undefined;
let holder: ChildProcess | undefined;
const store = {
  listProjects: () => [{ id: "p" }],
  uow: {
    read: (fn: (tx: unknown) => unknown) =>
      fn({ attachments: { list: () => records } }),
  },
} as unknown as Pick<Store, "listProjects" | "uow">;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cardigan-offsite-load-"));
  dataDir = join(root, "data");
  configDir = join(root, "config");
  await mkdir(dataDir, { mode: 0o700 });
  fake = await startFakeOss();
  records = [];
});
afterEach(async () => {
  holder?.kill("SIGKILL");
  holder = undefined;
  unregister?.();
  unregister = undefined;
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

async function offsite(transport?: OssTransport) {
  const o = new Offsite({
    dataDir,
    storageDir: await writeStorageConfig(configDir, fake),
    role: "background",
    ...(transport ? { transport } : {}),
  });
  unregister = registerOffsite(o);
  return o;
}
async function attachment(text: string) {
  const body = Buffer.from(text);
  await fileAttachmentStore(dataDir).put(sha(body), body);
  records.push({
    id: `F-${records.length + 1}`,
    sha256: sha(body),
    size: body.length,
  } as unknown as Attachment);
}
const puts = () => fake.requests.filter((r) => r.method === "PUT").length;
const statusFile = () => join(dataDir, "offsite", "status.json");

test.runIf(process.platform === "linux")(
  "while another process holds the sync lock this one neither scans, hashes, uploads nor writes status",
  async () => {
    for (let i = 0; i < 3; i++) await attachment(`held ${i}`);
    const lines: Record<string, unknown>[] = [];
    const sync = new OffsiteSync({
      offsite: await offsite(),
      store,
      role: "background",
      log: (line) => lines.push({ ...line }),
    });
    // Another OS process takes the same host-wide lock first.
    const path = offsiteSyncLockPath(dataDir);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    // One process: the shell opens the file, locks it and becomes `sleep`,
    // so killing it releases the lock.
    holder = spawn(
      "sh",
      ["-c", 'exec 3>>"$1"; flock --exclusive 3; exec sleep 60', "sh", path],
      { stdio: "ignore" },
    );
    await waitUntilLocked(path);
    await sync.tick();
    expect(fake.requests).toEqual([]);
    await expect(readFile(statusFile())).rejects.toThrow();
    expect(lines).toEqual([
      expect.objectContaining({
        event: "offsite_sync_lock",
        state: "standby",
        role: "background",
        pid: process.pid,
      }),
    ]);
    expect(sync.continueSoon).toBe(false);
    // Released: this process becomes the owner and copies everything.
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder?.once("exit", resolve));
    holder = undefined;
    await sync.tick();
    expect(puts()).toBe(3);
    expect(lines.map((l) => [l.event, l.state ?? l.uploaded])).toEqual([
      ["offsite_sync_lock", "standby"],
      ["offsite_sync_lock", "owner"],
      ["offsite_sync_tick", 3],
    ]);
    // The lock is released after each tick, so another process may follow.
    const again = await tryFlock(path);
    expect(again).toBe(0);
  },
);

test("two syncs of one host never upload in the same tick window", async () => {
  for (let i = 0; i < 20; i++) await attachment(`shared ${i}`);
  const o = await offsite();
  let held = false;
  let overlaps = 0;
  // The same contract as the flock: a second taker is turned away.
  const lock = async () => {
    if (held) {
      overlaps++;
      return undefined;
    }
    held = true;
    return async () => {
      held = false;
    };
  };
  const a = new OffsiteSync({ offsite: o, store, lock });
  const b = new OffsiteSync({ offsite: o, store, lock });
  await Promise.all([a.tick(), b.tick()]);
  expect(overlaps).toBe(1);
  expect(puts()).toBe(20);
  // Nothing was uploaded twice (no "already exists" read-back either).
  expect(fake.requests.filter((r) => r.method === "GET")).toEqual([]);
});

test("one tick is capped in files and bytes, but always takes at least one object", async () => {
  for (let i = 0; i < 5; i++) await attachment(`capped ${i}`);
  const sync = new OffsiteSync({
    offsite: await offsite(),
    store,
    maxFilesPerTick: 2,
  });
  await sync.tick();
  expect(puts()).toBe(2);
  expect(sync.continueSoon).toBe(true);
  await sync.tick();
  await sync.tick();
  expect(puts()).toBe(5);
  expect(sync.continueSoon).toBe(false);
  expect(OFFSITE_TICK_MAX_FILES).toBeGreaterThan(0);

  await attachment("x".repeat(4096));
  await attachment("y".repeat(4096));
  const bytes = new OffsiteSync({
    offsite: await offsite(),
    store,
    maxBytesPerTick: 1024,
  });
  await bytes.tick();
  expect(puts()).toBe(6);
  await bytes.tick();
  expect(puts()).toBe(7);
});

test("the health page shows the event-loop delay and alerts above 200 ms", async () => {
  await attachment("measured");
  const o = await offsite();
  await new OffsiteSync({ offsite: o, store }).tick();
  const status = JSON.parse(await readFile(statusFile(), "utf8"));
  // Give the monitor a sample in this process.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(o.status().loop_delay?.server).toMatchObject({
    p99_ms: expect.any(Number),
    max_ms: expect.any(Number),
  });
  expect(o.status().alerts).not.toContain("loop_slow");
  writeSyncStatus(dataDir, {
    ...status,
    loop_delay: { p99_ms: 350, max_ms: 900, window_ms: 60_000 },
  });
  expect(o.status().loop_delay?.sync).toEqual({
    p99_ms: 350,
    max_ms: 900,
    window_ms: 60_000,
  });
  expect(o.status().alerts).toContain("loop_slow");
});

test("a backfill of 1000 small files and a 1 GiB artifact keeps the event loop under 200 ms p99 and health checks answering", {
  timeout: 300_000,
}, async () => {
  for (let i = 0; i < 1000; i++) await attachment(`small file ${i}`);
  // A sparse 1 GiB artifact: no disk, but every byte is read and hashed.
  const size = 1024 ** 3;
  const blob = "cccccccc-1111-2222-3333-444444444444";
  await mkdir(join(dataDir, "artifacts"), { recursive: true, mode: 0o700 });
  const handle = await open(join(dataDir, "artifacts", blob), "wx", 0o600);
  await handle.truncate(size);
  await handle.close();
  const zeros = Buffer.alloc(1024 ** 2);
  const digest = createHash("sha256");
  for (let i = 0; i < 1024; i++) digest.update(zeros);
  records.push({
    id: "F-big",
    sha256: digest.digest("hex"),
    size,
    streamed_artifact: { blob_id: blob },
  } as unknown as Attachment);

  // OSS stand-in that accepts and discards every body.
  const uploaded = new Map<string, number>();
  const transport: OssTransport = async (url, init) => {
    let bytes = 0;
    if (init.body instanceof Readable)
      for await (const chunk of init.body) bytes += chunk.length;
    else if (init.body) bytes = init.body.length;
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    if (init.method === "PUT") uploaded.set(key, bytes);
    return Object.assign(Readable.from([]), {
      statusCode: init.method === "PUT" ? 200 : 404,
      headers: {},
    }) as unknown as IncomingMessage;
  };
  const o = await offsite(transport);
  // Worst case for the event loop: reading is not paced, only sliced.
  const sync = new OffsiteSync({
    offsite: o,
    store,
    readBytesPerSecond: 0,
  });

  // The MCP endpoint's health check, served by the same event loop.
  const health = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const port = (health.address() as AddressInfo).port;
  const latencies: number[] = [];
  let failures = 0;
  let probing = true;
  const probe = async () => {
    while (probing) {
      const started = performance.now();
      const ok = await new Promise<boolean>((resolve) => {
        const req = get({ host: "127.0.0.1", port, path: "/health" }, (res) =>
          res.resume().once("end", () => resolve(res.statusCode === 200)),
        );
        // Far stricter than the 10 s MCP probe of a worker.
        req.setTimeout(1000, () => req.destroy());
        req.once("error", () => resolve(false));
      });
      if (ok) latencies.push(performance.now() - started);
      else failures++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const probing$ = probe();
  let ticks = 0;
  try {
    do {
      await sync.tick();
      ticks++;
    } while (sync.continueSoon && ticks < 100);
  } finally {
    delay.disable();
    probing = false;
    await probing$;
    await new Promise((resolve) => health.close(resolve));
  }

  expect(uploaded.size).toBe(1001);
  expect(uploaded.get(artifactKey(blob))).toBe(size);
  // 1000 files at 200 per tick, then the artifact alone.
  expect(ticks).toBeGreaterThanOrEqual(6);
  expect(JSON.parse(await readFile(statusFile(), "utf8"))).toMatchObject({
    pending: { count: 0 },
    failed: { count: 0 },
    loop_delay: { p99_ms: expect.any(Number) },
  });
  expect(failures).toBe(0);
  expect(latencies.length).toBeGreaterThan(10);
  expect(Math.max(...latencies)).toBeLessThan(1000);
  expect(delay.percentile(99) / 1e6).toBeLessThan(200);
});

async function tryFlock(path: string) {
  return new Promise<number | null>((resolve) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", path, "true"], {
      stdio: "ignore",
    });
    child.once("exit", (code) => resolve(code));
  });
}
async function waitUntilLocked(path: string) {
  for (let i = 0; i < 200; i++) {
    if ((await tryFlock(path)) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("lock holder did not start");
}
