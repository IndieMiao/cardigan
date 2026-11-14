/**
 * `cardigan review-snapshot create` (C-267): human-only, read-only on the
 * production database, publishes only a clean scan, atomically, with 0640
 * files in the share group, keeping exactly one previous snapshot.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import {
  groupIdFromEtc,
  type ReviewSnapshotDeps,
  runReviewSnapshotCommand,
} from "./review-snapshot.js";

const P = "alpha";
const OTHER = "beta-secret";
const SENSITIVE_TITLE = "收购计划草案第二版（内部）";
const HOST = "review-host-xyz";
const NOW = "2026-11-14T00:00:00.000Z";

let dir: string;
let dataDir: string;
let out: string;
let work: string;
let output: string[];
let errors: string[];
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cardigan-cli-review-snapshot-"));
  dataDir = join(dir, "data");
  out = join(dir, "share", "review-snapshots");
  work = join(dir, "tmp");
  mkdirSync(work);
  output = [];
  errors = [];
  clock = Date.parse(NOW);

  const store = Store.open({ dataDir });
  store.createProject({ id: P });
  store.createProject({ id: OTHER });
  store.issueToken({
    project_id: P,
    assignment_id: "A-1",
    role: { role_version: 1, allowed_tools: ["get_card"] },
  });
  store.close();
  const db = new DatabaseSync(join(dataDir, "cardigan.db"));
  const card = (project: string, id: string, extra: object) =>
    JSON.stringify({
      id,
      project_id: project,
      title: `${id}`,
      goal: "",
      acceptance_criteria: [],
      source: { kind: "quote", text: "" },
      out_of_scope: [],
      related_cards: [],
      priority: 3,
      status: "todo",
      template: "dev",
      created_by: "human",
      created_at: NOW,
      ...extra,
    });
  db.prepare("INSERT INTO cards VALUES (?, 'C-1', ?)").run(
    P,
    card(P, "C-1", { goal: `部署在 ${HOST} 的 /home/someone/app` }),
  );
  db.prepare("INSERT INTO cards VALUES (?, 'C-2', ?)").run(
    P,
    card(P, "C-2", { title: SENSITIVE_TITLE, sensitive: true }),
  );
  db.prepare("INSERT INTO cards VALUES (?, 'C-1', ?)").run(
    OTHER,
    card(OTHER, "C-1", { title: "beta 项目的机密卡片" }),
  );
  db.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const io = (env: Record<string, string> = {}): CliIo => ({
  env,
  cwd: dir,
  platform: "linux",
  stdout: (line) => output.push(line),
  stderr: (line) => errors.push(line),
  signals: { on: () => undefined, off: () => undefined },
  spawnInherit: () => {
    throw new Error("review-snapshot must not spawn");
  },
  captureCommand: async () => {
    throw new Error("review-snapshot must not run commands");
  },
});

const gid = process.getgid?.() ?? 0;
const deps = (extra: Partial<ReviewSnapshotDeps> = {}): ReviewSnapshotDeps => ({
  groupId: () => gid,
  hostname: () => HOST,
  tmpRoot: work,
  now: () => {
    clock += 60_000;
    return new Date(clock);
  },
  ...extra,
});

async function create(extra: Partial<ReviewSnapshotDeps> = {}) {
  output = [];
  errors = [];
  const code = await runReviewSnapshotCommand(
    ["create", "--project", P, "--out", out, "--data-dir", dataDir],
    io(),
    deps(extra),
  );
  return { code, out: output.join("\n"), err: errors.join("\n") };
}

const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("publishes a scanned copy as current with 0640 files in the share group", async () => {
  const source = join(dataDir, "cardigan.db");
  const before = sha(source);
  const result = await create();
  expect(result.err).not.toContain("扫描命中");
  expect(result.code).toBe(0);

  // The production database is untouched.
  expect(sha(source)).toBe(before);
  // The private working copy is gone.
  expect(readdirSync(work)).toEqual([]);

  const current = join(out, "current");
  expect(readlinkSync(current)).toMatch(
    /^snapshots\/\d{8}T\d{6}Z-[0-9a-f]{6}$/,
  );
  for (const name of ["cardigan.db", "manifest.json"]) {
    const stat = statSync(join(current, name));
    expect(stat.mode & 0o777).toBe(0o640);
    expect(stat.gid).toBe(gid);
  }
  expect(statSync(current).mode & 0o777).toBe(0o750);
  expect(statSync(out).mode & 0o777).toBe(0o750);

  const manifestText = readFileSync(join(current, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  expect(manifest).toMatchObject({
    format: "cardigan-review-snapshot",
    project: P,
    rules_version: 1,
    scan: { passed: true, hit_count: 0 },
    database: {
      file: "cardigan.db",
      sha256: sha(join(current, "cardigan.db")),
    },
  });
  expect(manifest.source_schema_version).toBeGreaterThan(0);
  expect(manifest.row_counts.cards).toBe(2);
  expect(manifest.row_counts.tokens).toBe(0);
  for (const raw of [OTHER, SENSITIVE_TITLE, HOST, "/home/"])
    expect(manifestText).not.toContain(raw);

  const bytes = readFileSync(join(current, "cardigan.db")).toString("utf8");
  for (const raw of [
    SENSITIVE_TITLE,
    "beta 项目的机密卡片",
    HOST,
    "/home/someone",
  ])
    expect(bytes).not.toContain(raw);

  // A reviewer copies it and opens the copy; migrations run on open.
  const copy = join(dir, "review.db");
  copyFileSync(join(current, "cardigan.db"), copy);
  const store = Store.open({ dbPath: copy });
  expect(store.listProjects().map((p) => p.id)).toEqual([P]);
  store.close();
});

test("keeps exactly one previous snapshot and swaps current atomically", async () => {
  expect((await create()).code).toBe(0);
  const first = readlinkSync(join(out, "current"));
  expect(existsSync(join(out, "previous"))).toBe(false);

  expect((await create()).code).toBe(0);
  const second = readlinkSync(join(out, "current"));
  expect(second).not.toBe(first);
  expect(readlinkSync(join(out, "previous"))).toBe(first);

  expect((await create()).code).toBe(0);
  expect(readlinkSync(join(out, "previous"))).toBe(second);
  expect(readdirSync(join(out, "snapshots")).sort()).toEqual(
    [second, readlinkSync(join(out, "current"))]
      .map((p) => p.replace("snapshots/", ""))
      .sort(),
  );
});

test("a scan hit publishes nothing, exits non-zero and names locations only", async () => {
  expect((await create()).code).toBe(0);
  const current = readlinkSync(join(out, "current"));
  const snapshots = readdirSync(join(out, "snapshots"));

  const result = await create({
    scrub: () => ({ row_counts: {}, sensitive_rows: 0 }),
  });
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("未发布");
  expect(result.err).toMatch(/\[credential\] credential_table_empty：tokens/);
  expect(result.err).toMatch(/\[other_project\]/);
  expect(result.err).toMatch(/\[sensitive_card\]/);
  expect(result.err).toMatch(/\[host\]/);
  for (const raw of [SENSITIVE_TITLE, HOST, "/home/someone", "beta 项目"])
    expect(result.err).not.toContain(raw);

  expect(readlinkSync(join(out, "current"))).toBe(current);
  expect(readdirSync(join(out, "snapshots"))).toEqual(snapshots);
  expect(readdirSync(work)).toEqual([]);
});

test("Token mode is refused before anything is read or written", async () => {
  output = [];
  errors = [];
  const code = await main(
    [
      "review-snapshot",
      "create",
      "--project",
      P,
      "--out",
      out,
      "--data-dir",
      dataDir,
    ],
    io({ CARDIGAN_TOKEN: "not-a-real-token" }),
  );
  expect(code).toBe(2);
  expect(errors.join("\n")).toContain("仅限人类");
  expect(existsSync(out)).toBe(false);

  // The command itself refuses too, independent of the dispatcher.
  await expect(
    runReviewSnapshotCommand(
      ["create", "--project", P, "--out", out],
      io({ CARDIGAN_TOKEN: "x" }),
      deps(),
    ),
  ).rejects.toThrow("仅限人类");
  expect(existsSync(out)).toBe(false);
});

test("an existing current that is not a link is never replaced", async () => {
  mkdirSync(join(out, "current"), { recursive: true });
  writeFileSync(join(out, "current", "keep"), "x");
  await expect(create()).rejects.toThrow("不是符号链接");
  expect(readFileSync(join(out, "current", "keep"), "utf8")).toBe("x");
  expect(readdirSync(work)).toEqual([]);
});

test("missing project or output directory is a usage error", async () => {
  await expect(
    runReviewSnapshotCommand(
      ["create", "--out", out, "--data-dir", dataDir],
      io(),
      deps(),
    ),
  ).rejects.toThrow("--project");
  await expect(
    runReviewSnapshotCommand(
      ["create", "--project", P, "--data-dir", dataDir],
      io(),
      deps(),
    ),
  ).rejects.toThrow("--out");
  await expect(
    runReviewSnapshotCommand(
      ["create", "--project", "nope", "--out", out, "--data-dir", dataDir],
      io(),
      deps(),
    ),
  ).rejects.toThrow("不存在");
  expect(existsSync(out)).toBe(false);
});

test("group lookup reads /etc/group format", () => {
  const file = join(dir, "group");
  writeFileSync(file, "root:x:0:\ncardigan-share:x:1234:agent,host\n");
  expect(groupIdFromEtc("cardigan-share", file)).toBe(1234);
  expect(() => groupIdFromEtc("missing", file)).toThrow("找不到用户组");
});

test("works while the server holds the database open in WAL mode", async () => {
  const server = Store.open({ dataDir });
  // An uncheckpointed write must be in the snapshot (online backup sees WAL).
  server.createProject({ id: "gamma" });
  try {
    const result = await create();
    expect(result.code).toBe(0);
    const copy = new DatabaseSync(join(out, "current", "cardigan.db"), {
      readOnly: true,
    });
    expect(
      copy
        .prepare("SELECT id FROM projects")
        .all()
        .map((r) => r.id),
    ).toEqual([P]);
    copy.close();
  } finally {
    server.close();
  }
});

test("a bad previous fails before current moves, and a retry keeps the last good snapshot", async () => {
  expect((await create()).code).toBe(0);
  const first = readlinkSync(join(out, "current"));
  mkdirSync(join(out, "previous"));

  await expect(create()).rejects.toThrow("不是符号链接");
  // Readers still see the last good snapshot; nothing new was left behind.
  expect(readlinkSync(join(out, "current"))).toBe(first);
  expect(readdirSync(join(out, "snapshots"))).toEqual([
    first.replace("snapshots/", ""),
  ]);
  expect(readdirSync(work)).toEqual([]);

  rmSync(join(out, "previous"), { recursive: true });
  expect((await create()).code).toBe(0);
  expect(readlinkSync(join(out, "previous"))).toBe(first);
  expect(existsSync(join(out, "previous", "cardigan.db"))).toBe(true);
  expect(readlinkSync(join(out, "current"))).not.toBe(first);
});
