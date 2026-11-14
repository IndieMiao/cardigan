import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CentralRepositoryService } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { CentralGitTransport } from "./central.js";
import { LocalGitTransport } from "./index.js";

let f: Awaited<ReturnType<typeof centralFixture>>;
beforeEach(async () => {
  f = await centralFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await f.close();
});

type Failure = "query_failed" | "timeout" | "output_limit";

// Inject a child-process failure only for the optional probe. Successful
// commands, including the fallback fetch, always run real Git.
async function failProbe(reason: Failure) {
  const binary = (await promisify(execFile)("which", ["git"])).stdout.trim();
  const bin = join(f.root, "probe-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('ls-remote')) {
  const reason = ${JSON.stringify(reason)};
  if (reason === 'timeout') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  const diagnostic = 'https://fixture:probe-secret@example.invalid/private-repo ';
  process.stderr.write(reason === 'output_limit' ? diagnostic.repeat(100000) : diagnostic, () => process.exit(73));
} else {
  const child = spawnSync(${JSON.stringify(binary)}, args, {stdio: 'inherit'});
  process.exit(child.status ?? 99);
}
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}

function pollingService() {
  return new CentralRepositoryService(
    new CentralGitTransport({
      dataDir: f.dataDir,
      queryTimeoutMs: 1000,
      transferTimeoutMs: 5000,
      onCommand: (cwd, args) => f.calls.push({ cwd, args }),
    }),
    { dataDir: f.dataDir },
  );
}

const failures: Failure[] = ["query_failed", "timeout", "output_limit"];
test.each(failures)(
  "backup falls back after probe %s, saves the commit and resumes skipping unchanged refs",
  async (reason) => {
    const repo = await f.central.ensureCentral(f.project);
    const base = join(f.dataDir, "agent", "repos", f.project.project_id);
    await new LocalGitTransport().ensureClone(repo, base);
    await git(base, "checkout", "-b", "agent/C-1/W-1");
    const sha = await commit(base, "backup after probe failure");
    const ref = "refs/cardigan/backups/local/agent/C-1/W-1";
    const report = vi.spyOn(console, "warn").mockImplementation(() => {});
    const central = pollingService();
    await failProbe(reason);
    f.calls.length = 0;

    await central.backupAgentBranches(f.project, "local");

    expect(await git(repo, "rev-parse", ref)).toBe(sha);
    expect(f.calls.filter((c) => c.args.includes("ls-remote"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
    expect(report.mock.calls).toEqual([
      [`Git refs preflight failed (${reason}); falling back to fetch`],
    ]);

    vi.unstubAllEnvs();
    report.mockClear();
    f.calls.length = 0;
    await central.backupAgentBranches(f.project, "local");
    expect(f.calls.some((c) => c.args.includes("ls-remote"))).toBe(true);
    expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    expect(report).not.toHaveBeenCalled();
  },
);

test.each(failures)(
  "source reconciliation falls back after probe %s without moving the baseline",
  async (reason) => {
    const repo = await f.central.ensureCentral(f.project);
    const sha = await commit(f.source, "source after probe failure");
    const report = vi.spyOn(console, "warn").mockImplementation(() => {});
    const central = pollingService();
    await failProbe(reason);
    f.calls.length = 0;

    expect((await central.reconciliationState(f.project)).source_sync).toBe(
      "fast_forwarded",
    );
    expect(await git(repo, "rev-parse", "refs/cardigan/source/main")).toBe(sha);
    expect(await git(repo, "rev-parse", "main")).toBe(f.initial);
    expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
    expect(report.mock.calls).toEqual([
      [`Git refs preflight failed (${reason}); falling back to fetch`],
    ]);
  },
);

test("a real fallback fetch failure still rejects and preserves the previous backup", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const base = join(f.dataDir, "agent", "repos", f.project.project_id);
  await new LocalGitTransport().ensureClone(repo, base);
  await git(base, "checkout", "-b", "agent/C-1/W-1");
  const first = await commit(base, "previous backup");
  const ref = "refs/cardigan/backups/local/agent/C-1/W-1";
  await f.central.backupAgentBranches(f.project, "local");
  await commit(base, "unavailable backup");
  await writeFile(join(repo, `${ref}.lock`), "held");
  const report = vi.spyOn(console, "warn").mockImplementation(() => {});
  const central = pollingService();
  await failProbe("query_failed");
  f.calls.length = 0;

  await expect(
    central.backupAgentBranches(f.project, "local"),
  ).rejects.toMatchObject({
    code: expect.any(Number),
    stderr: expect.stringContaining("cannot lock ref"),
  });
  expect(await git(repo, "rev-parse", ref)).toBe(first);
  expect(f.calls.filter((c) => c.args.includes("fetch"))).toHaveLength(1);
  expect(report).toHaveBeenCalledTimes(1);
});
