import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralRepositoryService } from "@cardigan/git-service";
import { afterEach, expect, test, vi } from "vitest";
import { commit, git } from "../test-support/git.js";
import { CentralGitTransport } from "./central.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const attempt = mkdtempSync(join(tmpdir(), "attempt-"));
  roots.push(attempt);
  const shared = join(attempt, "shared"),
    alias = join(attempt, "alias");
  mkdirSync(shared, { mode: 0o770 });
  symlinkSync(shared, alias);
  vi.stubEnv("TMPDIR", alias);
  vi.stubEnv("XDG_RUNTIME_DIR", alias);
  vi.resetModules();
  return {
    attempt,
    alias,
    paths: await import("../../../test-support/paths.js"),
  };
}

test("private data bypasses inherited shared aliases without relaxing central Git checks", async () => {
  const { attempt, alias, paths } = await fixture();
  const root = paths.createPrivateTestRoot();
  roots.push(root);
  expect(root.startsWith(attempt)).toBe(false);
  expect(realpathSync(root)).toBe(root);
  expect(lstatSync(root).uid).toBe(process.getuid?.());
  expect(lstatSync(root).mode & 0o777).toBe(0o700);
  const source = join(root, "source");
  await git(root, "init", "-b", "main", source);
  await commit(source, "fixture");
  const project = {
    project_id: "fixture",
    source_repo: source,
    base_branch: "main",
  };
  const dataDir = join(root, "data"),
    unsafeDataDir = join(alias, "data");
  const central = new CentralRepositoryService(
    new CentralGitTransport({ dataDir }),
    { dataDir },
  );
  expect(
    await git(
      await central.ensureCentral(project),
      "rev-parse",
      "--is-bare-repository",
    ),
  ).toBe("true");
  const unsafe = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: unsafeDataDir }),
    { dataDir: unsafeDataDir },
  );
  await expect(unsafe.ensureCentral(project)).rejects.toThrow(
    /untrusted writable ancestor/,
  );
});

test("hc uses a unique private leaf under the inherited runtime until final cleanup", async () => {
  const { attempt, alias, paths } = await fixture();
  // A fixture may overwrite the environment later; this must not escape the
  // supervisor runtime that was captured before fixture initialization.
  vi.stubEnv("XDG_RUNTIME_DIR", join(attempt, "wrong-runtime"));
  const runtime = paths.createTestRuntime(join(attempt, "fallback"));
  const other = paths.createTestRuntime(join(attempt, "fallback"));
  expect(runtime.startsWith(`${alias}/`)).toBe(true);
  expect(runtime).not.toBe(other);
  expect(lstatSync(runtime).mode & 0o777).toBe(0o700);
  const socket = join(runtime, "hc.sock");
  writeFileSync(socket, "still live");
  expect(() => paths.removeTestRuntime(socket)).toThrow(/live hc socket/);
  expect(existsSync(socket)).toBe(true);
  rmSync(socket);
  paths.removeTestRuntime(socket);
  paths.removeTestRuntime(socket);
  expect(existsSync(runtime)).toBe(false);
  expect(existsSync(other)).toBe(true);
  paths.removeTestRuntime(join(other, "hc.sock"));
  expect(existsSync(alias)).toBe(true);
});

test("worker teardown only removes empty private data roots", async () => {
  const { paths } = await fixture();
  const root = paths.createPrivateTestRoot();
  roots.push(root);
  const unfinished = join(root, "unfinished");
  writeFileSync(unfinished, "preserve");
  paths.removeEmptyTestRoot(root);
  expect(existsSync(unfinished)).toBe(true);
  rmSync(unfinished);
  paths.removeEmptyTestRoot(root);
  paths.removeEmptyTestRoot(root);
  expect(existsSync(root)).toBe(false);
});

test("worker children cannot leave Node compile caches in private test data", async () => {
  const { paths } = await fixture();
  const root = paths.createPrivateTestRoot();
  roots.push(root);
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
    const module = require('node:module');
    const {status} = module.enableCompileCache();
    module.flushCompileCache();
    console.log(JSON.stringify({disabled:status === module.constants.compileCacheStatus.DISABLED}));
  `,
      ],
      {
        env: {
          ...process.env,
          TMPDIR: root,
          TEMP: root,
          TMP: root,
          // Even an inherited explicit cache opt-in cannot defeat worker policy.
          NODE_COMPILE_CACHE: join(root, "node-compile-cache"),
        },
        encoding: "utf8",
      },
    ),
  );
  paths.removeEmptyTestRoot(root);
  expect(result.disabled).toBe(true);
  expect(existsSync(root)).toBe(false);
});
