import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProbe, type ProbeJob } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "probe-config-instance-"));
  roots.push(root);
  const job: ProbeJob = {
    id: "1".repeat(32),
    project_id: "fixture",
    card_id: "C-1" as never,
    work_item_id: "W-1" as never,
    assignment_id: "A-1" as never,
    probe: "config",
    head_sha: "a".repeat(40),
    created_at: new Date().toISOString(),
    status: "running",
    cleanup: "pending",
    profile: {
      operations: ["smoke"],
      timeout_ms: 10000,
      rest_budget_per_hour: 120,
    },
  };
  return {
    root,
    job,
    adapter: new ConfigProbe({
      dataDir: root,
      releaseSha: job.head_sha,
      entry: new URL("../dist/config-probe-worker.js", import.meta.url),
    }),
  };
}

test("trusted child starts a migrated isolated database and restarts it without inheriting credentials or production roots", async () => {
  const f = fixture();
  const production = join(f.root, "production");
  mkdirSync(production, { mode: 0o700 });
  const sentinel = join(production, "sentinel");
  writeFileSync(sentinel, "keep");
  vi.stubEnv("CARDIGAN_DATA_DIR", production);
  vi.stubEnv("CARDIGAN_CONFIG_DIR", production);
  // This would make any child inheriting NODE_OPTIONS fail before loading the worker.
  vi.stubEnv("NODE_OPTIONS", "--require /synthetic/secret-preload.cjs");
  vi.stubEnv("GITHUB_TOKEN", "synthetic-private-token");
  const checkpoints: ProbeJob[] = [];
  const result = await f.adapter.advance(f.job, (j) => checkpoints.push(j));
  expect(result).toMatchObject({
    status: "passed",
    cleanup: "complete",
    tested_sha: f.job.head_sha,
  });
  expect(checkpoints.some((j) => j.process?.pid && j.sandbox)).toBe(true);
  expect(existsSync(join(f.root, "probe-sandboxes", f.job.id))).toBe(false);
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
  expect(JSON.stringify(result)).not.toContain("synthetic-private-token");
});

test("an installed version mismatch never becomes successful current-version evidence", async () => {
  const f = fixture();
  const result = await f.adapter.advance(
    { ...f.job, head_sha: "b".repeat(40) },
    () => {},
  );
  expect(result).toMatchObject({
    status: "failed",
    cleanup: "complete",
    tested_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
  });
});

test("recovery removes only the registered directory inode, and unarmed child recovery is safe", async () => {
  const f = fixture();
  const base = join(f.root, "probe-sandboxes");
  mkdirSync(base, { mode: 0o700 });
  const root = join(base, f.job.id);
  mkdirSync(root, { mode: 0o700 });
  const st = lstatSync(root);
  const armed = { ...f.job, sandbox: { dev: st.dev, ino: st.ino } };
  const rejected = await f.adapter.advance(
    { ...armed, sandbox: { dev: st.dev, ino: st.ino + 1 } },
    () => {},
  );
  expect(rejected.cleanup).toBe("held");
  expect(existsSync(root)).toBe(true);
  expect(await f.adapter.advance(armed, () => {})).toMatchObject({
    status: "failed",
    cleanup: "complete",
  });
  expect(await f.adapter.advance(armed, () => {})).toMatchObject({
    cleanup: "complete",
  });
});
