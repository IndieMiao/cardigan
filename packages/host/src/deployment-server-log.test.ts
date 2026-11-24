import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  DeploymentServerLog,
  type ServerLogAudit,
  taggedServerOutput,
} from "./deployment-server-log.js";

test("role tags preserve fragmented UTF-8/JSON and mark every new source line", () => {
  const chunks: Buffer[] = [];
  const output = taggedServerOutput((data) => chunks.push(data), "background");
  const line = Buffer.from('{"sample":"合成"}\n');
  for (const byte of line) output(Buffer.from([byte]), "stdout");
  output(Buffer.from("first\nsecond\n"), "stderr");
  output(Buffer.alloc(0), "stdout");
  expect(Buffer.concat(chunks).toString("utf8")).toBe(
    '[background] {"sample":"合成"}\n[background] first\n[background] second\n',
  );
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-server-log-"));
  roots.push(root);
  const dir = join(root, "self-deploy");
  await mkdir(dir, { mode: 0o700 });
  const entries: ServerLogAudit[] = [];
  const audit = (entry: ServerLogAudit) => {
    entries.push(entry);
  };
  const create = (
    maxBytes = 8,
    maxFiles = 3,
    previous?: Promise<void>,
    retentionMs?: number,
  ) =>
    new DeploymentServerLog(
      dir,
      "a".repeat(40),
      { maxBytes, maxFiles, ...(retentionMs ? { retentionMs } : {}) },
      audit,
      previous,
    );
  return { root, dir, path: join(dir, "logs"), entries, create };
}

test("rotates raw bytes at exact boundaries and retains a bounded private history across generations", async () => {
  const f = await fixture();
  const first = f.create();
  const bytes = Buffer.from([
    0xff,
    0,
    0x80,
    ...Buffer.from("stdout\nstderr\n1234567"),
  ]);
  first.append(bytes);
  await first.close();
  const names = (await readdir(f.path)).sort();
  expect(names).toHaveLength(3);
  expect(
    Buffer.concat(
      await Promise.all(names.map((n) => readFile(join(f.path, n)))),
    ),
  ).toEqual(bytes);
  expect((await lstat(f.path)).mode & 0o777).toBe(0o700);
  for (const name of names) {
    const stat = await lstat(join(f.path, name));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBeLessThanOrEqual(8);
  }
  const unrelated = join(f.path, "operator-notes");
  await writeFile(unrelated, "keep");
  const second = f.create(8, 3, first.finished);
  second.append(Buffer.from("abcdefghABCDEFGH"));
  await second.close();
  const retained = (await readdir(f.path))
    .filter((n) => n.endsWith(".log"))
    .sort();
  expect(retained).toHaveLength(3);
  expect(retained).toContain(names[2]);
  expect(await readFile(unrelated, "utf8")).toBe("keep");
  expect(
    f.entries.every((e) => e.status === "opened" && !e.file_name.includes("/")),
  ).toBe(true);
  await second.close(); // Idempotent; never reopens the sink.
  expect(await readdir(f.path)).toHaveLength(4);
  const smaller = f.create(4, 1, second.finished);
  smaller.append(Buffer.from("tail"));
  await smaller.close();
  const reduced = (await readdir(f.path)).filter((n) => n.endsWith(".log"));
  expect(reduced).toHaveLength(1);
  expect(await readFile(join(f.path, reduced[0] ?? "missing"), "utf8")).toBe(
    "tail",
  );
});

test("C-638: restarts no longer push out recent logs; age and the byte budget do", async () => {
  const f = await fixture();
  // Ten short generations (restarts) of 2 bytes each, far more files than
  // `maxFiles`, all well inside the 8 * 4 byte budget: every one is kept.
  let previous: Promise<void> | undefined;
  for (let i = 0; i < 10; i++) {
    const log = f.create(8, 4, previous);
    log.append(Buffer.from(String(i).padStart(2, "0")));
    await log.close();
    previous = log.finished;
  }
  const logs = async () =>
    (await readdir(f.path)).filter((n) => n.endsWith(".log")).sort();
  expect(await logs()).toHaveLength(10);
  // Files older than the retention window go at the next rotation.
  const old = (await logs()).slice(0, 3);
  const past = new Date(Date.now() - 49 * 60 * 60 * 1000);
  for (const name of old) await utimes(join(f.path, name), past, past);
  const next = f.create(8, 4, previous);
  next.append(Buffer.from("x"));
  await next.close();
  const kept = await logs();
  expect(kept).toHaveLength(8);
  for (const name of old) expect(kept).not.toContain(name);
  // A shorter window from the host configuration applies too.
  await new Promise((done) => setTimeout(done, 5));
  const recent = f.create(8, 4, next.finished, 1);
  recent.append(Buffer.from("y"));
  await recent.close();
  expect(await logs()).toHaveLength(1);
  const small = await logs();
  // Over the byte budget the oldest go first: closed files stay within
  // 8 * (4 - 1) bytes, so the directory never exceeds 8 * 4.
  const full = f.create(8, 4, recent.finished);
  full.append(Buffer.alloc(8 * 3, 0x61));
  await full.close();
  const fuller = f.create(8, 4, full.finished);
  fuller.append(Buffer.alloc(8 * 2, 0x62));
  await fuller.close();
  const bounded = await logs();
  expect(bounded).toHaveLength(4);
  expect(bounded).not.toContain(small[0]);
  let total = 0;
  for (const name of bounded) total += (await lstat(join(f.path, name))).size;
  expect(total).toBe(8 * 4);
});

test.each(["symlink", "permissions", "replacement", "hardlink"])(
  "rejects unsafe log storage: %s",
  async (kind) => {
    const f = await fixture();
    const outside = join(f.root, "agent-worktree");
    await mkdir(outside, { mode: 0o777 });
    if (kind === "symlink") await symlink(outside, f.path);
    if (kind === "permissions") await mkdir(f.path, { mode: 0o770 });
    const log = f.create(128, 2);
    if (kind === "replacement" || kind === "hardlink") {
      await vi.waitFor(() =>
        expect(f.entries.some((e) => e.status === "opened")).toBe(true),
      );
      if (kind === "replacement") {
        await rename(f.path, `${f.path}-old`);
        await symlink(outside, f.path);
      } else {
        const entry = f.entries.find((e) => e.status === "opened");
        if (!entry?.file_name) throw new Error("Missing file");
        await link(join(f.path, entry.file_name), join(outside, "leak"));
      }
    }
    log.append(Buffer.from("private-server-content"));
    log.append(Buffer.from("more-private-content"));
    await log.close();
    expect(f.entries.filter((e) => e.status === "failed")).toHaveLength(1);
    for (const name of await readdir(outside))
      expect(await readFile(join(outside, name), "utf8")).toBe("");
    expect(JSON.stringify(f.entries)).not.toMatch(/private|agent-worktree/);
  },
);

test.each(["ENOSPC", "EACCES"])(
  "write failure %s warns once and does not escape append/close",
  async (code) => {
    const f = await fixture();
    const probe = await open(join(f.root, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const write = vi
      .spyOn(prototype, "write")
      .mockRejectedValue(
        Object.assign(new Error("private-path-and-content"), { code }),
      );
    const log = f.create(128, 2);
    log.append(Buffer.from("stdout-secret"));
    log.append(Buffer.from("stderr-secret"));
    await log.close();
    log.append(Buffer.from("after-failure"));
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.entries.filter((e) => e.status === "failed")).toEqual([
      { status: "failed", reason: "io", file_name: expect.any(String) },
    ]);
    expect(JSON.stringify(f.entries)).not.toMatch(
      /private|secret|after-failure/,
    );
  },
);

test("a stalled sink has a bounded queue and warns once without backpressuring output", async () => {
  const f = await fixture();
  let release!: () => void;
  const stalled = new Promise<void>((done) => {
    release = done;
  });
  const log = f.create(8, 2, stalled);
  log.append(Buffer.alloc(16));
  for (let i = 0; i < 3; i++) log.append(Buffer.from("overflow-secret"));
  expect(f.entries).toEqual([{ status: "failed", reason: "capacity" }]);
  release();
  await log.close();
  expect(await readdir(f.dir)).toEqual([]);
});

test("an unavailable audit store cannot reject log shutdown or leak its error", async () => {
  const f = await fixture();
  const audit = vi.fn(() => {
    throw new Error("private-database-path");
  });
  const log = new DeploymentServerLog(
    f.dir,
    "a".repeat(40),
    { maxBytes: 32, maxFiles: 1 },
    audit,
  );
  log.append(Buffer.from("private-output"));
  await expect(log.close()).resolves.toBeUndefined();
  expect(audit).toHaveBeenCalledTimes(2); // Open record, then one failure attempt.
  expect(audit.mock.calls[1]).toEqual([
    { status: "failed", reason: "io", file_name: expect.any(String) },
  ]);
  expect(JSON.stringify(audit.mock.calls)).not.toMatch(
    /private-database|private-output/,
  );
});
