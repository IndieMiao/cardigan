import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { centralFixture } from "../test-support/git.js";
import { CentralGitTransport } from "./central.js";
import { LocalGitTransport } from "./index.js";
import { withGitTimeout } from "./timeouts.js";

let f: Awaited<ReturnType<typeof centralFixture>>;
beforeEach(async () => {
  f = await centralFixture();
  await f.central.ensureCentral(f.project);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.close();
});

// Delay the selected command, then forward to real Git without replacing its output.
async function delayGit(command: string) {
  const binary = (await promisify(execFile)("which", ["git"])).stdout.trim();
  const bin = join(f.root, "slow-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(command)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
const child = spawnSync(${JSON.stringify(binary)}, args, {stdio:'inherit'});
process.exit(child.status ?? 99);
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}

test("guarded publication keeps the query timeout and cannot audit a timed-out CAS", async () => {
  await delayGit("update-ref");
  const transport = new CentralGitTransport({
    dataDir: f.dataDir,
    queryTimeoutMs: 30,
  });
  let audited = false;
  const failure = await transport
    .compareAndSwapRef(
      f.central.repositoryPath(f.project),
      "refs/heads/main",
      f.initial,
      f.initial,
      (publish) => {
        publish();
        audited = true;
        return true;
      },
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    /timed out.*CARDIGAN_GIT_QUERY_TIMEOUT_MS/,
  );
  expect(audited).toBe(false);
});

test.each(["central", "local"] as const)(
  "%s queries use the short budget and report its setting",
  async (kind) => {
    await delayGit("rev-parse");
    const options = { queryTimeoutMs: 30, transferTimeoutMs: 5000 };
    const operation =
      kind === "central"
        ? new CentralGitTransport({
            dataDir: f.dataDir,
            ...options,
          }).objectFormat(f.central.repositoryPath(f.project))
        : new LocalGitTransport("git", options).resolveCommit(
            f.source,
            f.initial,
          );
    const failure = await operation.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /timed out.*CARDIGAN_GIT_QUERY_TIMEOUT_MS/,
    );
    if (kind === "local" && process.platform !== "win32")
      expect(failure).toMatchObject({ executionExited: true });
  },
);

test.each(["central", "local"] as const)(
  "%s clones use the independent transfer budget",
  async (kind) => {
    await delayGit("clone");
    const options = { queryTimeoutMs: 5000, transferTimeoutMs: 30 };
    const operation =
      kind === "central"
        ? new CentralGitTransport({
            dataDir: f.dataDir,
            ...options,
          }).ensureBare(
            f.source,
            join(f.dataDir, "central", "slow.git"),
            "refs/heads/main",
          )
        : new LocalGitTransport("git", options).ensureClone(
            f.source,
            join(f.root, "slow-clone"),
          );
    await expect(operation).rejects.toThrow(
      /clone timed out.*CARDIGAN_GIT_TRANSFER_TIMEOUT_MS/,
    );
  },
);

test("query and transfer defaults, environment overrides and invalid timeout settings", async () => {
  for (const command of ["clone", "fetch", "push", "bundle"])
    expect(await withGitTimeout(command, {}, async (ms) => ms)).toBe(1_800_000);
  expect(await withGitTimeout("rev-parse", {}, async (ms) => ms)).toBe(30_000);
  vi.stubEnv("CARDIGAN_GIT_QUERY_TIMEOUT_MS", "47");
  vi.stubEnv("CARDIGAN_GIT_TRANSFER_TIMEOUT_MS", "2300");
  expect(await withGitTimeout("cat-file", {}, async (ms) => ms)).toBe(47);
  expect(await withGitTimeout("fetch", {}, async (ms) => ms)).toBe(2300);
  vi.stubEnv("CARDIGAN_GIT_TRANSFER_TIMEOUT_MS", "invalid");
  await expect(withGitTimeout("push", {}, async () => "never")).rejects.toThrow(
    /CARDIGAN_GIT_TRANSFER_TIMEOUT_MS/,
  );
});

test("an hc timeout does not claim that the remote Git process exited", async () => {
  await expect(
    withGitTimeout("rev-parse", { queryTimeoutMs: 10 }, async () => {
      throw Object.assign(new Error("client timed out"), {
        code: "runtime_timeout",
      });
    }),
  ).rejects.toMatchObject({ executionExited: false });
});
