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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  DeploymentServerLog,
  type ServerLogAudit,
} from "./deployment-server-log.js";

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
  const create = (maxBytes = 8, maxFiles = 3, previous?: Promise<void>) =>
    new DeploymentServerLog(
      dir,
      "a".repeat(40),
      { maxBytes, maxFiles },
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
