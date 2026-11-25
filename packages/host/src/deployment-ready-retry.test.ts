import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeploymentRecord } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import { readReadyRetry } from "./deployment-audit.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const server = (prelude: string) => `
${prelude}
const net = require('node:net');
const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
let ready = 0;
const servers = ports.map(port => net.createServer().listen(port, '127.0.0.1', () => {
  if (++ready === 2)
    process.stdout.write(JSON.stringify({ ready: true, deployment_fence: 1,
      url: 'http://127.0.0.1:' + ports[0], web_url: 'http://127.0.0.1:' + ports[1] }) + '\\n');
}));
process.on('SIGTERM', () => servers.forEach(s => s.close()));
`;

test.runIf(process.platform === "linux")(
  "C-650: a candidate that exits on a locked database is rolled back, retried after a supervisor restart and deployed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-ready-retry-"));
    const release = join(root, "release");
    const candidate = join(root, "candidate");
    const dataDir = join(root, "data");
    const counter = join(root, "attempts");
    for (const dir of [release, candidate])
      await mkdir(join(dir, "apps/server/dist"), { recursive: true });
    await mkdir(join(dataDir, "central"), { recursive: true });
    await chmod(release, 0o755);
    await chmod(dataDir, 0o700);
    const store = Store.open({ dataDir });
    store.createProject({ id: "cardigan" });
    const git = (args: string[], cwd = release) =>
      exec(
        "git",
        [
          ...gitSafetyArguments,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
    const drivers: NodeDeploymentDriver[] = [];
    const unlocks: (() => Promise<void>)[] = [];
    try {
      await writeFile(join(release, "apps/server/dist/bin.js"), server(""));
      // The first candidate start meets a write lock it cannot wait out.
      await writeFile(
        join(candidate, "apps/server/dist/bin.js"),
        server(`
const fs = require('node:fs');
const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n === 1) {
  process.stderr.write('Error: database is locked\\nTOKEN=synthetic-secret\\n');
  process.exit(1);
}`),
      );
      await git(["init", "-b", "main"]);
      await git(["add", "."]);
      await git(["commit", "-m", "test: initial server"]);
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await git([
        "clone",
        "--bare",
        release,
        join(dataDir, "central/cardigan.git"),
      ]);
      const bin = join(root, "bin");
      await mkdir(bin);
      for (const command of ["hc", "pnpm"])
        await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", {
          mode: 0o700,
        });
      const target = "b".repeat(40);
      let now = Date.parse("2026-11-23T11:28:00.000Z");
      const options = {
        store,
        dataDir,
        config: {
          enabled: true,
          initial_release: release,
          initial_sha: sha,
          ready_timeout_ms: 10000,
          stop_timeout_ms: 3000,
          build_timeout_ms: 5000,
          poll_interval_ms: 1000,
          ready_retry_max: 2,
          ready_retry_interval_ms: 60_000,
        },
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          CARDIGAN_HC_SESSION: "synthetic-session",
          CARDIGAN_MCP_PORT: String(await freePort()),
          CARDIGAN_WEB_PORT: String(await freePort()),
        },
      };
      // Each supervisor generation adopts the running server and its audit.
      const supervisor = async () => {
        const driver = new NodeDeploymentDriver(options);
        drivers.push(driver);
        unlocks.push(await driver.initialize());
        vi.spyOn(driver, "now").mockImplementation(() => now);
        vi.spyOn(driver, "main").mockResolvedValue(target);
        vi.spyOn(driver, "isFastForward").mockResolvedValue(true);
        vi.spyOn(driver, "passedMergeGate").mockResolvedValue(true);
        vi.spyOn(driver, "migrationsChanged").mockResolvedValue(false);
        vi.spyOn(driver, "refreshRoles").mockResolvedValue();
        const build = vi.spyOn(driver, "build").mockResolvedValue({
          build: { sha: target, release: candidate },
          log_tail: "install: exit 0\nbuild: exit 0",
        });
        return { controller: new DeploymentController(driver), build };
      };
      const records = async () =>
        (await readDeploymentDiagnostics(store, "cardigan"))?.records ?? [];
      const actions = () =>
        store.uow.read((tx) => tx.human_actions.list("cardigan"));

      let s = await supervisor();
      await s.controller.tick();
      const rolledBack = (await records())[0];
      expect(rolledBack).toMatchObject({
        status: "rolled_back",
        ready: true,
        failure_stage: "ready",
        summary:
          "ready_failed（数据库被锁）；已恢复上一构建；不早于 60 秒后自动重试（第 1/2 次）",
        log_tail: "原因：数据库被锁\nready: exit 1",
        ready_retry: {
          failures: 1,
          max: 2,
          next_at: "2026-11-23T11:29:00.000Z",
        },
      });
      // The restored build serves; no person is asked while a retry is due.
      expect(actions()).toHaveLength(0);
      expect(await readReadyRetry(store, "cardigan", target)).toEqual(
        rolledBack?.ready_retry,
      );
      expect(
        await readReadyRetry(store, "cardigan", target, "human-pin"),
      ).toBeUndefined();

      // The supervisor restarts before the retry is due: nothing happens.
      await unlocks.pop()?.();
      s = await supervisor();
      now += 59_999;
      await s.controller.tick();
      expect(s.build).not.toHaveBeenCalled();
      // Due: the restarted supervisor retries from the durable count.
      now += 1;
      await s.controller.tick();
      expect(s.build).toHaveBeenCalledTimes(1);
      expect((await records())[0]).toMatchObject({
        status: "deployed",
        to: target,
        ready: true,
      });
      expect(await readFile(counter, "utf8")).toBe("2");
      expect(actions()).toHaveLength(0);
      const serialized = JSON.stringify(
        store.uow.read((tx) => tx.events.listAfter("cardigan", undefined, 0)),
      );
      expect(serialized).not.toMatch(/synthetic-secret|TOKEN=|Error:/);
    } finally {
      for (const driver of drivers.reverse())
        await driver.stop().catch(() => {});
      for (const unlock of unlocks) await unlock().catch(() => {});
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

test("C-650: only a used-up retry opens a human action, carrying the real cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-ready-retry-audit-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  const { writeDeploymentRecord } = await import("./deployment-audit.js");
  const base: DeploymentRecord = {
    attempt: "attempt-1",
    from: "a".repeat(40),
    to: "b".repeat(40),
    status: "rolled_back",
    build: "passed",
    ready: true,
    downtime_ms: 10,
    failure_stage: "ready",
    log_tail: "原因：数据库被锁\nready: exit 1",
    summary: "ready_failed（数据库被锁）；已恢复上一构建",
  };
  try {
    store.createProject({ id: "cardigan" });
    writeDeploymentRecord(store, "cardigan", {
      ...base,
      ready_retry: { failures: 1, max: 1, next_at: "2026-11-23T11:29:00.000Z" },
    });
    expect(store.uow.read((tx) => tx.human_actions.list("cardigan"))).toEqual(
      [],
    );
    writeDeploymentRecord(store, "cardigan", {
      ...base,
      attempt: "attempt-2",
      ready_retry: { failures: 2, max: 1 },
    });
    const opened = store.uow.read((tx) => tx.human_actions.list("cardigan"));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.instructions).toContain("数据库被锁");
    expect(await readReadyRetry(store, "cardigan", base.to)).toEqual({
      failures: 2,
      max: 1,
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
