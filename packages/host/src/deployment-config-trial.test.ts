import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentDriver, DeploymentRecord } from "@cardigan/domain";
import { afterEach, expect, test } from "vitest";
import { DeploymentController } from "./deployment.js";
import {
  checkHostConfig,
  hostConfigFingerprint,
  snapshotHostConfig,
} from "./host-config-check.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function privateDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function fixture() {
  const calls: string[] = [];
  const records: DeploymentRecord[] = [];
  const old = { sha: "a".repeat(40), release: "old" };
  const next = { sha: "b".repeat(40), release: "next" };
  const driver: DeploymentDriver = {
    enabled: true,
    checkServer: async () => {},
    current: async () => old,
    main: async () => next.sha,
    isFastForward: async () => true,
    passedMergeGate: async () => true,
    waitForEvidence: async () => {},
    waitForCapacity: async () => {},
    releaseCapacityWait: async () => {},
    serverDiagnostics: (stage) => `${stage}: exit unknown`,
    acquire: async () => async () => {},
    build: async () => {
      calls.push("build");
      return { build: next, log_tail: "" };
    },
    migrationsChanged: async () => false,
    backup: async () => "database-00000000-0000-0000-0000-000000000001.bak",
    beforeStop: async (record) => {
      calls.push("snapshot");
      return { ...record, status: "stopping" };
    },
    stop: async () => {
      calls.push("stop");
    },
    start: async (build) => {
      calls.push(`start:${build.release}`);
    },
    ready: async () => true,
    promote: async (build) => {
      calls.push(`promote:${build.release}`);
    },
    refreshRoles: async () => {},
    record: async (record) => {
      records.push(record);
    },
    now: () => 100,
  };
  return { driver, calls, records };
}

/** The node driver's trial, in process: private copy plus the real loaders. */
function realTrial(
  f: ReturnType<typeof fixture>,
  configDir: string,
  dataDir: string,
) {
  f.driver.checkConfig = async () => {
    f.calls.push("config");
    const trial = await privateDir("cardigan-trial-");
    const snapshot = await snapshotHostConfig(configDir, trial);
    if (snapshot.errors.length)
      return {
        ok: false,
        errors: snapshot.errors,
        fingerprint: snapshot.fingerprint,
      };
    const check = await checkHostConfig({
      configDir: trial,
      dataDir,
      projects: [{ id: "cardigan" }, { id: "sensen" }],
    });
    return {
      ok: check.ok,
      errors: check.files.flatMap((x) =>
        x.errors.map((e) => `${x.file}：${e}`),
      ),
      fingerprint: snapshot.fingerprint,
    };
  };
  f.driver.configFingerprint = () => hostConfigFingerprint(configDir);
}

test("C-792: a broken merge-gate.yaml is caught before the old server stops, then retried once fixed", async () => {
  const configDir = await privateDir("cardigan-config-");
  const dataDir = await privateDir("cardigan-data-");
  const file = join(configDir, "merge-gate.yaml");
  // A hand edit that would pause merging for every project after a restart.
  await writeFile(file, "projects:\n  cardigan: [unclosed\n", { mode: 0o600 });
  const f = fixture();
  realTrial(f, configDir, dataDir);
  const controller = new DeploymentController(f.driver);
  await controller.tick();
  expect(f.calls).toEqual(["build", "config"]);
  const failed = f.records.at(-1);
  expect(failed).toMatchObject({
    status: "failed",
    failure_stage: "config",
    build: "passed",
    downtime_ms: 0,
  });
  expect(failed?.summary).toContain("config_invalid");
  expect(failed?.summary).toContain("未停旧服务");
  expect(failed?.log_tail).toContain(
    "merge-gate.yaml：merge-gate.yaml 语法无效，所有项目暂停合并",
  );
  // Unchanged configuration: no rebuild, no new record, nothing stopped.
  await controller.tick();
  expect(f.calls).toEqual(["build", "config"]);
  expect(f.records).toHaveLength(2);

  await writeFile(file, "projects: {}\n", { mode: 0o600 });
  await controller.tick();
  expect(f.calls).toEqual([
    "build",
    "config",
    "build",
    "config",
    "snapshot",
    "stop",
    "start:next",
    "promote:next",
  ]);
  expect(f.records.at(-1)).toMatchObject({ status: "deployed" });
});

test("C-792: a group-writable real file is refused, not hidden by the private copy", async () => {
  const configDir = await privateDir("cardigan-config-");
  const dataDir = await privateDir("cardigan-data-");
  const file = join(configDir, "run-capacity.yaml");
  await writeFile(file, "machines: {}\n");
  await chmod(file, 0o664);
  const f = fixture();
  realTrial(f, configDir, dataDir);
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual(["build", "config"]);
  expect(f.records.at(-1)?.log_tail).toBe("- 无法安全读取 run-capacity.yaml");
});

test("C-792: a trial that cannot run fails closed and is not retried for the same target", async () => {
  const f = fixture();
  f.driver.checkConfig = async () => {
    f.calls.push("config");
    throw new Error("spawn failed");
  };
  f.driver.configFingerprint = async () => "same";
  const controller = new DeploymentController(f.driver);
  await controller.tick();
  await controller.tick();
  expect(f.calls).toEqual(["build", "config"]);
  expect(f.records.at(-1)).toMatchObject({
    status: "failed",
    failure_stage: "config",
    log_tail: "- 主机配置试加载未能运行",
  });
  expect(f.records.at(-1)?.summary).toContain("中心 main 更新后重试");
});

test("C-792: adapters without a trial deploy as before", async () => {
  const f = fixture();
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual([
    "build",
    "snapshot",
    "stop",
    "start:next",
    "promote:next",
  ]);
});

test("C-792: checkHostConfig names each file; missing files keep the loader defaults", async () => {
  const configDir = await privateDir("cardigan-config-");
  const dataDir = await privateDir("cardigan-data-");
  const projects = [{ id: "cardigan" }];
  expect(await checkHostConfig({ configDir, dataDir, projects })).toEqual({
    ok: true,
    files: [
      { file: "merge-gate.yaml", status: "missing", errors: [] },
      { file: "run-capacity.yaml", status: "missing", errors: [] },
      { file: "runtime-workers.yaml", status: "missing", errors: [] },
    ],
  });
  await writeFile(join(configDir, "merge-gate.yaml"), "projects: {}\n", {
    mode: 0o600,
  });
  await writeFile(
    join(configDir, "run-capacity.yaml"),
    "machines:\n  local:\n    limit: 9\n    max_limit: 4\n",
    { mode: 0o600 },
  );
  await writeFile(join(configDir, "runtime-workers.yaml"), "workers: {}\n", {
    mode: 0o644,
  });
  const result = await checkHostConfig({ configDir, dataDir, projects });
  expect(result.ok).toBe(false);
  expect(result.files.map((x) => x.status)).toEqual([
    "ok",
    "invalid",
    "invalid",
  ]);
  expect(result.files[1]?.errors[0]).toContain("limit 不得超过 max_limit");
  expect(result.files[2]?.errors[0]).toContain("runtime-workers.yaml 无效");
  // Diagnostics never echo file contents.
  expect(JSON.stringify(result)).not.toContain("max_limit: 4");
});

test("C-792: the merge gate check names an unregistered project", async () => {
  const configDir = await privateDir("cardigan-config-");
  const dataDir = await privateDir("cardigan-data-");
  await mkdir(join(dataDir, "x"), { recursive: true });
  await writeFile(
    join(configDir, "merge-gate.yaml"),
    "projects:\n  ghost:\n    checks: []\n",
    { mode: 0o600 },
  );
  const result = await checkHostConfig({
    configDir,
    dataDir,
    projects: [{ id: "cardigan" }],
  });
  expect(result.ok).toBe(false);
  expect(result.files[0]?.errors.join("")).toContain("项目 ghost");
});

test("C-792: the fingerprint follows content and safety, and the snapshot is private", async () => {
  const configDir = await privateDir("cardigan-config-");
  const before = await hostConfigFingerprint(configDir);
  const file = join(configDir, "run-capacity.yaml");
  await writeFile(file, "machines: {}\n", { mode: 0o600 });
  const written = await hostConfigFingerprint(configDir);
  expect(written).not.toBe(before);
  await chmod(file, 0o666);
  expect(await hostConfigFingerprint(configDir)).not.toBe(written);
  await chmod(file, 0o600);
  expect(await hostConfigFingerprint(configDir)).toBe(written);
  const target = await privateDir("cardigan-trial-");
  const snapshot = await snapshotHostConfig(configDir, target);
  expect(snapshot).toEqual({ errors: [], fingerprint: written });
});
