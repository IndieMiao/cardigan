import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { capacityMachine } from "./capacity-owner.js";
import {
  acquireDeploymentCapacity,
  releaseDeploymentWait,
} from "./deployment-capacity.js";
import {
  loadDeploymentConfig,
  parseDeploymentConfig,
} from "./deployment-config.js";
import {
  finishSupervisorUpgrade,
  loadSupervisorUpgradeConfig,
  readSupervisorUpgradePlan,
  SharedCapacityWait,
  type SupervisorRestartPorts,
  type SupervisorUpgradeConfig,
  type SupervisorUpgradeHost,
  SupervisorUpgrader,
  supervisorHelperArguments,
} from "./deployment-supervisor-upgrade.js";
import { fenceLongOperations, holdLongOperation } from "./long-operations.js";
import { executionOwner } from "./process-identity.js";

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
let root: string;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-supervisor-upgrade-"));
  await chmod(root, 0o700);
  store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const events = () =>
  store
    .getUpdates({ project_id: "cardigan" })
    .events.filter((e) => e.type === "host_supervisor_upgrade")
    .map((e) => e.payload as { status: string; summary: string });
const actions = () => store.uow.read((tx) => tx.human_actions.list("cardigan"));

async function layout() {
  const install = join(root, "selfdeploy");
  const old = join(install, `release-watch-${FROM}`);
  const directory = join(root, "data", "self-deploy");
  const units = join(root, "units");
  const configDir = join(root, "config");
  for (const dir of [old, directory, units, configDir])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  const launch = join(units, "cardigan-selfdeploy.service");
  const original = `[Service]\nExecStart=/usr/bin/node ${old}/apps/cli/dist/bin.js self-deploy watch\nWorkingDirectory=${old}\nEnvironment=OTHER=${old}-sibling\n`;
  await writeFile(launch, original, { mode: 0o600 });
  const config: SupervisorUpgradeConfig = {
    enabled: true,
    unit: "cardigan-selfdeploy.service",
    launch_file: launch,
    health_timeout_ms: 60_000,
  };
  return { install, old, directory, launch, original, config, configDir };
}

function fakeHost(
  l: Awaited<ReturnType<typeof layout>>,
  overrides: Partial<SupervisorUpgradeHost> = {},
) {
  const calls: string[] = [];
  let deployed: string | undefined = TO;
  // As in the driver: the waiter row is shared with deployments.
  const shared = new SharedCapacityWait(() => releaseDeploymentWait(store));
  const host: SupervisorUpgradeHost & {
    calls: string[];
    deploy(sha: string | undefined): void;
  } = {
    store,
    directory: l.directory,
    configDir: l.configDir,
    root: l.old,
    supervisor: FROM,
    calls,
    deploy(sha) {
      deployed = sha;
    },
    idleDeployment: async () => deployed,
    checkout: async (sha, release) => {
      calls.push(`checkout ${sha}`);
      await mkdir(release, { recursive: true });
      return { ok: true, log_tail: "install: exit 0\nbuild: exit 0" };
    },
    validate: async () => {
      calls.push("validate");
      return true;
    },
    systemctl: async (args) => {
      calls.push(`systemctl ${args.join(" ")}`);
      return { code: 0, text: "" };
    },
    launchHelper: async (_attempt, from) => {
      calls.push(`helper ${from}`);
      return true;
    },
    ports: () => [{ host: "127.0.0.1", port: 3004 }],
    server: () => executionOwner(process.pid),
    recheck: () => calls.push("recheck"),
    capacityWaiting: (waiting) => shared.set("upgrade", waiting),
    now: () => Date.now(),
    ...overrides,
  };
  return host;
}

test("C-767: the switch lives in its own file; self-deploy.yaml stays readable by the current (old) parser", async () => {
  const dir = join(root, "config");
  await mkdir(dir, { mode: 0o700 });
  const base = `initial_release: ${root}\ninitial_sha: ${FROM}\nready_timeout_ms: 1000\nstop_timeout_ms: 1000\npoll_interval_ms: 1000\nbuild_timeout_ms: 1000\n`;
  await writeFile(join(dir, "self-deploy.yaml"), base, { mode: 0o600 });
  // Missing file: off, exactly as before this change.
  expect(await loadSupervisorUpgradeConfig(dir)).toBeUndefined();
  // Why a separate file: the existing parser rejects any unknown key.
  expect(() =>
    parseDeploymentConfig({
      initial_release: root,
      initial_sha: FROM,
      ready_timeout_ms: 1,
      stop_timeout_ms: 1,
      poll_interval_ms: 1,
      build_timeout_ms: 1,
      supervisor_upgrade: true,
    }),
  ).toThrow();
  const file = join(dir, "supervisor-upgrade.yaml");
  await writeFile(file, "enabled: false\n", { mode: 0o600 });
  expect(await loadSupervisorUpgradeConfig(dir)).toBeUndefined();
  await writeFile(
    file,
    `enabled: true\nunit: cardigan-selfdeploy.service\nlaunch_file: ${root}/unit.service\nfuture_key: 1\n`,
  );
  // Unknown keys are ignored, so a rolled-back older version still reads it.
  expect(await loadSupervisorUpgradeConfig(dir)).toEqual({
    enabled: true,
    unit: "cardigan-selfdeploy.service",
    launch_file: `${root}/unit.service`,
    health_timeout_ms: 60_000,
  });
  // The supervisor's own config is untouched and still parses.
  await expect(loadDeploymentConfig(dir)).resolves.toMatchObject({
    initial_sha: FROM,
  });
  for (const bad of [
    "enabled: yes please\n",
    `enabled: true\nunit: "x; rm"\nlaunch_file: ${root}/u\n`,
    "enabled: true\nunit: a.service\nlaunch_file: relative\n",
    `enabled: true\nunit: a.service\nlaunch_file: ${root}/u\nhealth_timeout_ms: 5\n`,
  ]) {
    await writeFile(file, bad);
    await expect(loadSupervisorUpgradeConfig(dir)).rejects.toThrow();
  }
  await writeFile(file, "enabled: true\n");
  await chmod(file, 0o644);
  await expect(loadSupervisorUpgradeConfig(dir)).rejects.toThrow();
});

test("C-767: a running merge check (or long operation) holds the restart; nothing is rewritten until both clear", async () => {
  const l = await layout();
  const host = fakeHost(l);
  const upgrader = new SupervisorUpgrader(host, l.config);
  expect(upgrader.automatic(FROM, TO, ["packages/host"])).toBe(true);
  // Mid-switch or in maintenance (not idle): no build, no restart.
  host.deploy(undefined);
  expect(await upgrader.step()).toBe("waiting");
  expect(host.calls).toEqual([]);
  // C-787: the server still runs the old build: prepare, but leave the
  // restart to the deployment of main (it joins the same stop/start).
  host.deploy(FROM);
  expect(await upgrader.step()).toBe("waiting");
  expect(host.calls).toEqual([`checkout ${TO}`, "validate"]);
  host.deploy(TO);
  // A merge check of the other project is still running (card and batch
  // checks hold the same per-attempt capacity row while they execute).
  store.createProject({ id: "other" });
  const self = executionOwner(process.pid);
  if (!self) throw new Error("identity");
  store.database
    .prepare(
      `INSERT INTO merge_check_capacity
      (project_id, attempt_id, machine_id, owner_pid, owner_start, owner_machine) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("other", "MC-1", "local", self.pid, self.start, capacityMachine());
  expect(await upgrader.step()).toBe("waiting");
  expect(await upgrader.step()).toBe("waiting");
  expect(host.calls).toEqual([`checkout ${TO}`, "validate"]);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
  expect(events().map((e) => e.status)).toEqual(["started"]);
  // Waiting closes new check admission, like a waiting deployment.
  const waiter = () =>
    store.database.prepare("SELECT phase FROM host_deployment_waiter").get() as
      | { phase: string }
      | undefined;
  expect(waiter()?.phase).toBe("waiting");
  // Main stops needing an upgrade: the admission gate is released at once.
  upgrader.automatic(FROM, TO, []);
  expect(await upgrader.step()).toBe("idle");
  expect(waiter()).toBeUndefined();
  upgrader.automatic(FROM, TO, ["packages/host"]);
  store.database.prepare("DELETE FROM merge_check_capacity").run();
  // Managed long operations (signing, publication, worker upgrade) too.
  const release = await holdLongOperation(store, {
    kind: "artifact_publication",
    project_id: "other",
    label: "publish",
  });
  expect(await upgrader.step()).toBe("waiting");
  expect(host.calls.some((c) => c.startsWith("helper"))).toBe(false);
  release();
  expect(await upgrader.step()).toBe("restarting");
  expect(upgrader.restarting).toBe(true);
  const target = join(l.install, `release-watch-${TO}`);
  const launch = await readFile(l.launch, "utf8");
  expect(launch).toContain(`${target}/apps/cli/dist/bin.js`);
  expect(launch).toContain(`WorkingDirectory=${target}\n`);
  // A longer sibling path is not the running checkout and is left alone.
  expect(launch).toContain(`OTHER=${l.old}-sibling`);
  const plan = await readSupervisorUpgradePlan(l.directory);
  expect(plan).toMatchObject({
    from: FROM,
    to: TO,
    old_root: l.old,
    new_root: target,
  });
  expect(await readFile(plan?.backup_file ?? "", "utf8")).toBe(l.original);
  expect((await stat(plan?.backup_file ?? "")).mode & 0o777).toBe(0o600);
  expect(host.calls.slice(-2)).toEqual([
    "systemctl --user daemon-reload",
    `helper ${l.old}`,
  ]);
  expect(events().map((e) => e.status)).toEqual(["started", "restarting"]);
  // The capacity stays held: new merge checks are not admitted meanwhile.
  expect(
    store.database.prepare("SELECT 1 FROM host_deployment_capacity").get(),
  ).toBeTruthy();
  expect(actions()).toEqual([]);
});

test("C-767: preparation failures open one Needs You item, restore nothing they did not change and stop automatic attempts", async () => {
  const l = await layout();
  const host = fakeHost(l, {
    checkout: async () => ({ ok: false, log_tail: "build: exit 1" }),
  });
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(await upgrader.step()).toBe("failed");
  expect(events().map((e) => e.status)).toEqual(["started", "failed"]);
  expect(actions()).toMatchObject([
    { status: "open", instructions: expect.stringContaining("build: exit 1") },
  ]);
  expect(host.calls).toContain("recheck");
  // The running SHA now goes back to the human reminder.
  expect(upgrader.automatic(FROM, TO, ["packages/host"])).toBe(false);
  expect(await upgrader.step()).toBe("idle");
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
});

test("C-767: a launch file that does not name the running checkout, or a helper that cannot start, leaves the old launch file", async () => {
  const l = await layout();
  await writeFile(l.launch, "[Service]\nExecStart=/somewhere/else\n");
  const first = new SupervisorUpgrader(fakeHost(l), l.config);
  first.automatic(FROM, TO, ["packages/host"]);
  expect(await first.step()).toBe("failed");
  expect(events().at(-1)?.summary).toContain("没有引用当前监督器目录");

  const second = await mkdtemp(join(tmpdir(), "cg-supervisor-upgrade-"));
  try {
    store.close();
    store = Store.open({ dataDir: second, dbPath: ":memory:" });
    store.createProject({ id: "cardigan" });
    await writeFile(l.launch, l.original);
    await rm(join(l.install, `release-watch-${TO}`), { recursive: true });
    const host = fakeHost(l, { launchHelper: async () => false });
    const upgrader = new SupervisorUpgrader(host, l.config);
    upgrader.automatic(FROM, TO, ["packages/host"]);
    expect(await upgrader.step()).toBe("failed");
    expect(await readFile(l.launch, "utf8")).toBe(l.original);
    expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
    expect(events().at(-1)?.summary).toContain("启动配置已恢复");
    expect(
      store.database.prepare("SELECT 1 FROM host_deployment_capacity").get(),
    ).toBeUndefined();
  } finally {
    await rm(second, { recursive: true, force: true });
  }
});

/** A fake service manager: the upgrade target is `healthy`, `hangs` or `crashes`. */
function restartPorts(
  l: Awaited<ReturnType<typeof layout>>,
  target: "healthy" | "hangs" | "crashes",
) {
  let clock = 0;
  let running = l.old;
  const calls: string[] = [];
  const newServer = { pid: process.pid, start: "new-server" };
  const ports: SupervisorRestartPorts = {
    async systemctl(args) {
      calls.push(args.join(" "));
      if (args.includes("restart")) {
        const text = await readFile(l.launch, "utf8");
        running = text.includes(`release-watch-${TO}`)
          ? join(l.install, `release-watch-${TO}`)
          : l.old;
      }
      if (args.includes("show")) {
        const isNew = running !== l.old;
        if (isNew && target === "crashes")
          return {
            code: 0,
            text: "ActiveState=activating\nSubState=auto-restart\nMainPID=0\n",
          };
        return {
          code: 0,
          text: `ActiveState=active\nSubState=running\nMainPID=4242\n`,
        };
      }
      return { code: 0, text: "" };
    },
    async readState() {
      if (running !== l.old && target !== "healthy")
        return { current: { sha: TO }, running: { sha: TO }, ready: false };
      return {
        current: { sha: TO },
        running: { sha: TO },
        ready: true,
        process: newServer,
      };
    },
    portOpen: async () => true,
    cmdline: async () => ["/usr/bin/node", `${running}/apps/cli/dist/bin.js`],
    alive: (owner) => owner === newServer,
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
  };
  return { ports, calls, elapsed: () => clock };
}

async function prepareRestart() {
  const l = await layout();
  const upgrader = new SupervisorUpgrader(fakeHost(l), l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(await upgrader.step()).toBe("restarting");
  return l;
}

test("C-767: a healthy new supervisor completes the upgrade without Needs You", async () => {
  const l = await prepareRestart();
  const { ports, calls } = restartPorts(l, "healthy");
  expect(
    await finishSupervisorUpgrade({ store, directory: l.directory, ports }),
  ).toBe("completed");
  expect(calls[0]).toBe(
    "--user restart --no-block cardigan-selfdeploy.service",
  );
  expect(events().map((e) => e.status)).toEqual([
    "started",
    "restarting",
    "completed",
  ]);
  expect(actions()).toEqual([]);
  expect(await readFile(l.launch, "utf8")).toContain(`release-watch-${TO}`);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
});

test("C-767: a health check that times out rolls back from the backup and tells Needs You", async () => {
  const l = await prepareRestart();
  const { ports, calls, elapsed } = restartPorts(l, "hangs");
  expect(
    await finishSupervisorUpgrade({ store, directory: l.directory, ports }),
  ).toBe("rolled_back");
  // The full 60 s window was used before rolling back.
  expect(elapsed()).toBeGreaterThanOrEqual(60_000);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(calls.filter((c) => c.startsWith("--user restart"))).toHaveLength(2);
  expect(calls).toContain("--user daemon-reload");
  expect(events().at(-1)).toMatchObject({
    status: "rolled_back",
    summary: expect.stringContaining("60 秒内健康检查未通过"),
  });
  expect(actions()).toMatchObject([
    { status: "open", instructions: expect.stringContaining("已用备份回滚") },
  ]);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
});

test("C-767: an explicit start failure rolls back at once, without waiting for the timeout", async () => {
  const l = await prepareRestart();
  const { ports, elapsed } = restartPorts(l, "crashes");
  expect(
    await finishSupervisorUpgrade({ store, directory: l.directory, ports }),
  ).toBe("rolled_back");
  expect(elapsed()).toBeLessThan(5_000);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(events().at(-1)?.summary).toContain("新监督器启动失败");
  expect(actions()).toHaveLength(1);
});

test("C-767: rollback never overwrites a launch file someone edited meanwhile; a failed restart command keeps the old supervisor", async () => {
  const l = await prepareRestart();
  const { ports } = restartPorts(l, "hangs");
  const edited = `${await readFile(l.launch, "utf8")}# operator edit\n`;
  await writeFile(l.launch, edited);
  expect(
    await finishSupervisorUpgrade({ store, directory: l.directory, ports }),
  ).toBe("failed");
  expect(await readFile(l.launch, "utf8")).toBe(edited);
  expect(events().at(-1)?.summary).toContain("未自动回滚");

  const again = await prepareRestartAgain(l);
  const refused = restartPorts(again, "healthy");
  const systemctl = refused.ports.systemctl;
  refused.ports.systemctl = async (args) =>
    args.includes("restart") ? { code: 1, text: "" } : systemctl(args);
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: again.directory,
      ports: refused.ports,
    }),
  ).toBe("failed");
  expect(await readFile(again.launch, "utf8")).toBe(again.original);
  expect(events().at(-1)?.summary).toContain("旧监督器继续运行");
});

async function prepareRestartAgain(l: Awaited<ReturnType<typeof layout>>) {
  store.close();
  store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  await writeFile(l.launch, l.original);
  await rm(join(l.install, `release-watch-${TO}`), { recursive: true });
  const upgrader = new SupervisorUpgrader(fakeHost(l), l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(await upgrader.step()).toBe("restarting");
  return l;
}

test("C-767: deployment and upgrade share the capacity waiter; neither reopens admission under the other", () => {
  const released: string[] = [];
  const shared = new SharedCapacityWait(() => released.push("release"));
  // Switch off: a deployment that stops waiting releases, exactly as before.
  shared.set("deploy", false);
  expect(released).toEqual(["release"]);
  shared.set("upgrade", true);
  // An idle deployment tick no longer drops the upgrade's waiter row.
  shared.set("deploy", false);
  expect(released).toEqual(["release"]);
  shared.set("deploy", true);
  // Nor does an abandoned upgrade drop a waiting deployment's row.
  shared.set("upgrade", false);
  expect(released).toEqual(["release"]);
  shared.set("deploy", false);
  expect(released).toEqual(["release", "release"]);
});

const fenced = () =>
  store.database.prepare("SELECT 1 FROM host_long_operation_fence").get() !==
  undefined;
const capacityHeld = () =>
  store.database.prepare("SELECT 1 FROM host_deployment_capacity").get() !==
  undefined;

function handoff(l: Awaited<ReturnType<typeof layout>>) {
  return {
    attempt: "00000000-0000-4000-8000-000000000787",
    sha: TO,
    release: join(l.directory, `release-${TO}-x`),
    from: FROM,
    stopped_at: 1_700_000_000_000,
  };
}

test("C-787: a deployment of the pending main waits one step for the preparation, then hands the restart its stopped server", async () => {
  const l = await layout();
  const host = fakeHost(l, {
    server: () => undefined,
    switchWindowMs: () => 7_000,
  });
  host.deploy(FROM);
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(upgrader.join(TO)).toBe("prepare");
  expect(upgrader.join("c".repeat(40))).toBeUndefined();
  // The step prepares while the server still runs the old build.
  expect(await upgrader.step()).toBe("waiting");
  expect(host.calls).toEqual([`checkout ${TO}`, "validate"]);
  expect(upgrader.join(TO)).toBe("join");
  // The deployment holds capacity and the operation fence, then stops the server.
  const release = acquireDeploymentCapacity(store);
  fenceLongOperations(store);
  expect(release).toBeTruthy();
  expect(await upgrader.handOff(handoff(l))).toBe(true);
  expect(upgrader.restarting).toBe(true);
  expect(upgrader.join(TO)).toBeUndefined();
  const plan = await readSupervisorUpgradePlan(l.directory);
  expect(plan).toMatchObject({
    from: FROM,
    to: TO,
    new_root: join(l.install, `release-watch-${TO}`),
    // Room for the new build's start and a rollback's start.
    health_timeout_ms: 67_000,
    deploy: handoff(l),
  });
  expect(plan?.server).toBeUndefined();
  expect(events().map((e) => e.status)).toEqual(["started", "restarting"]);
  expect(events().at(-1)?.summary).toContain("与服务部署合并为一次停起");
  expect(host.calls.slice(-2)).toEqual([
    "systemctl --user daemon-reload",
    `helper ${l.old}`,
  ]);
  expect(await readFile(l.launch, "utf8")).toContain(`release-watch-${TO}`);
  // Still the deployment's: the restart replaces this supervisor holding them.
  expect(capacityHeld()).toBe(true);
  expect(fenced()).toBe(true);
  expect(actions()).toEqual([]);
});

test("C-787: a refused handoff restores the launch file, records the failure and leaves the deployment's capacity and fence", async () => {
  const l = await layout();
  const host = fakeHost(l, { launchHelper: async () => false });
  host.deploy(FROM);
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  // Nothing prepared yet, or for another main: never handed over.
  expect(await upgrader.handOff(handoff(l))).toBe(false);
  await upgrader.step();
  expect(await upgrader.handOff({ ...handoff(l), sha: "c".repeat(40) })).toBe(
    false,
  );
  acquireDeploymentCapacity(store);
  fenceLongOperations(store);
  expect(await upgrader.handOff(handoff(l))).toBe(false);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
  expect(events().at(-1)).toMatchObject({
    status: "failed",
    summary: expect.stringContaining("启动配置已恢复"),
  });
  expect(capacityHeld()).toBe(true);
  expect(fenced()).toBe(true);
  // The deployment starts the build itself; this version is not tried again.
  expect(upgrader.join(TO)).toBeUndefined();
  expect(upgrader.automatic(FROM, TO, ["packages/host"])).toBe(false);
});

test("C-787: a step that cannot prepare, or an earlier helper's plan, never holds a deployment", async () => {
  const l = await layout();
  const host = fakeHost(l, {
    checkout: async () => {
      throw new Error("disk");
    },
  });
  host.deploy(FROM);
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(upgrader.join(TO)).toBe("prepare");
  expect(await upgrader.step()).toBe("failed");
  expect(upgrader.join(TO)).toBeUndefined();

  // A fresh state for this version: the earlier failure blocked it.
  store.close();
  store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  await writeFile(join(l.directory, "supervisor-upgrade.json"), "{not a plan", {
    mode: 0o600,
  });
  const other = new SupervisorUpgrader(fakeHost(l), l.config);
  other.automatic(FROM, TO, ["packages/host"]);
  expect(await other.step()).toBe("waiting");
  expect(other.join(TO)).toBeUndefined();
});

test("C-787: a plan's handed-over deployment is validated with the plan", async () => {
  const l = await layout();
  const host = fakeHost(l, { server: () => undefined });
  host.deploy(FROM);
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  await upgrader.step();
  await upgrader.handOff({
    ...handoff(l),
    backup_file: "database-00000000-0000-4000-8000-000000000001.bak",
  });
  const file = join(l.directory, "supervisor-upgrade.json");
  const plan = JSON.parse(await readFile(file, "utf8"));
  expect((await readSupervisorUpgradePlan(l.directory))?.deploy).toMatchObject({
    backup_file: "database-00000000-0000-4000-8000-000000000001.bak",
  });
  for (const deploy of [
    { ...plan.deploy, sha: "c".repeat(40) },
    { ...plan.deploy, release: "relative" },
    { ...plan.deploy, backup_file: "../state.json" },
    { ...plan.deploy, stopped_at: "soon" },
    "yes",
  ]) {
    await writeFile(file, JSON.stringify({ ...plan, deploy }), {
      mode: 0o600,
    });
    await expect(readSupervisorUpgradePlan(l.directory)).rejects.toThrow();
  }
});

/** The upgrader of `prepareRestart`, with its clock under test control. */
async function restartingUpgrader() {
  const l = await layout();
  let clock = Date.now();
  const host = fakeHost(l, { now: () => clock });
  const upgrader = new SupervisorUpgrader(host, l.config);
  upgrader.automatic(FROM, TO, ["packages/host"]);
  expect(await upgrader.step()).toBe("restarting");
  const plan = await readSupervisorUpgradePlan(l.directory);
  expect(await readFile(l.launch, "utf8")).toContain(`release-watch-${TO}`);
  return {
    l,
    host,
    upgrader,
    plan,
    advance(ms: number) {
      clock += ms;
    },
  };
}

test("C-770: giving up on a helper that never restarted puts the backed-up launch file back, reloads systemd and opens one Needs You", async () => {
  const { l, host, upgrader, advance } = await restartingUpgrader();
  // Within 2 × 60 s + 120 s the supervisor keeps waiting.
  advance(239_000);
  expect(await upgrader.step()).toBe("restarting");
  host.calls.length = 0;
  advance(2_000);
  expect(await upgrader.step()).toBe("idle");
  // Any later restart of the unit runs the old checkout again.
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(host.calls).toContain("systemctl --user daemon-reload");
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
  expect(events().map((e) => e.status)).toEqual([
    "started",
    "restarting",
    "failed",
  ]);
  expect(events().at(-1)?.summary).toContain("启动配置已恢复为备份");
  expect(actions()).toMatchObject([{ status: "open" }]);
  expect(
    store.database.prepare("SELECT 1 FROM host_deployment_capacity").get(),
  ).toBeUndefined();
  // This version no longer upgrades itself; the human item is the reminder.
  expect(upgrader.automatic(FROM, TO, ["packages/host"])).toBe(false);
});

test("C-770: giving up never overwrites a launch file someone edited; Needs You still opens once", async () => {
  const { l, host, upgrader, advance } = await restartingUpgrader();
  const edited = `${await readFile(l.launch, "utf8")}# operator edit\n`;
  await writeFile(l.launch, edited);
  host.calls.length = 0;
  advance(241_000);
  expect(await upgrader.step()).toBe("idle");
  expect(await readFile(l.launch, "utf8")).toBe(edited);
  expect(host.calls).not.toContain("systemctl --user daemon-reload");
  expect(events().at(-1)).toMatchObject({
    status: "failed",
    summary: expect.stringContaining("未覆盖"),
  });
  expect(actions()).toHaveLength(1);
});

test("C-770: when the audit cannot be written on giving up, the plan stays and a notice is raised instead", async () => {
  const { l, upgrader, advance } = await restartingUpgrader();
  let broken = 1;
  // Only the terminal record fails; the notice itself is a later write.
  failWrites(() => broken-- > 0);
  advance(241_000);
  expect(await upgrader.step()).toBe("idle");
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeDefined();
  expect(actions()).toMatchObject([
    { status: "open", instructions: expect.stringContaining("重启助手超过") },
  ]);
});

/** Store writes fail while `when()` holds, as with a locked database. */
function failWrites(when: () => boolean) {
  const getter = Object.getOwnPropertyDescriptor(Store.prototype, "uow")?.get;
  if (!getter) throw new Error("no uow");
  const target = store;
  Object.defineProperty(target, "uow", {
    configurable: true,
    get() {
      const uow = getter.call(target) as Store["uow"];
      return {
        ...uow,
        run: ((operation: Parameters<Store["uow"]["run"]>[0]) => {
          if (when()) throw new Error("database is locked");
          return uow.run(operation);
        }) as Store["uow"]["run"],
      };
    },
  });
}

/** A helper that died: the plan as the helper left it, before or after restarting. */
async function diedHelper(restarted: boolean) {
  const l = await prepareRestart();
  const plan = await readSupervisorUpgradePlan(l.directory);
  if (!plan) throw new Error("no plan");
  if (restarted)
    await writeFile(
      join(l.directory, "supervisor-upgrade.json"),
      JSON.stringify({
        ...plan,
        restart_requested_at: new Date(0).toISOString(),
      }),
      { mode: 0o600 },
    );
  return l;
}

test("C-770: recovery after the helper died with the new supervisor crashing rolls back and opens one Needs You", async () => {
  const l = await diedHelper(true);
  const { ports, calls } = restartPorts(l, "crashes");
  // The unit already restarted into the new checkout before the helper died.
  await ports.systemctl(["--user", "restart", "--no-block", "x"]);
  calls.length = 0;
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("rolled_back");
  // The recovery never restarts into the new version again.
  expect(calls.filter((c) => c.startsWith("--user restart"))).toHaveLength(1);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(events().at(-1)).toMatchObject({
    status: "rolled_back",
    summary: expect.stringContaining("重启助手异常退出"),
  });
  expect(actions()).toHaveLength(1);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
});

test("C-770: recovery after the helper died with the new supervisor healthy completes without Needs You", async () => {
  const l = await diedHelper(true);
  const { ports, calls } = restartPorts(l, "healthy");
  await ports.systemctl(["--user", "restart", "--no-block", "x"]);
  calls.length = 0;
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("completed");
  expect(calls.some((c) => c.includes("restart"))).toBe(false);
  expect(actions()).toEqual([]);
  expect(await readFile(l.launch, "utf8")).toContain(`release-watch-${TO}`);
});

test("C-770: recovery after the helper died before restarting restores the launch file without restarting", async () => {
  const l = await diedHelper(false);
  const { ports, calls } = restartPorts(l, "healthy");
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("failed");
  expect(calls).toEqual(["--user daemon-reload"]);
  expect(await readFile(l.launch, "utf8")).toBe(l.original);
  expect(events().at(-1)?.summary).toContain("重启助手在发出重启前退出");
  expect(actions()).toHaveLength(1);
});

test("C-770: recovery after the helper died mid-rollback does not restart a healthy old supervisor again", async () => {
  const l = await diedHelper(true);
  const { ports, calls } = restartPorts(l, "crashes");
  // The helper had already restored the launch file and restarted the old one.
  await writeFile(l.launch, l.original);
  await ports.systemctl(["--user", "restart", "--no-block", "x"]);
  calls.length = 0;
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("rolled_back");
  expect(calls.some((c) => c.includes("restart"))).toBe(false);
  expect(actions()).toHaveLength(1);
});

test("C-770: recovery after a normal helper exit is a no-op; a helper outcome whose audit failed is replayed", async () => {
  const l = await prepareRestart();
  const { ports } = restartPorts(l, "hangs");
  let fail = true;
  failWrites(() => fail);
  expect(
    await finishSupervisorUpgrade({ store, directory: l.directory, ports }),
  ).toBe("rolled_back");
  expect(actions()).toEqual([]);
  expect(await readSupervisorUpgradePlan(l.directory)).toMatchObject({
    result: {
      status: "rolled_back",
      summary: expect.stringContaining("已用备份恢复"),
    },
  });
  fail = false;
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("rolled_back");
  expect(actions()).toMatchObject([
    { status: "open", instructions: expect.stringContaining("已用备份回滚") },
  ]);
  expect(await readSupervisorUpgradePlan(l.directory)).toBeUndefined();
  expect(
    await finishSupervisorUpgrade({
      store,
      directory: l.directory,
      ports,
      resume: true,
    }),
  ).toBe("none");
  expect(actions()).toHaveLength(1);
});

test("C-770: the helper unit runs the recovery as ExecStopPost= with a stop timeout covering both windows", () => {
  const args = supervisorHelperArguments({
    attempt: "0b5c8f9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
    node: "/usr/bin/node",
    bin: "/srv/self deploy/release-watch-a/apps/cli/dist/bin.js",
    dataDir: "/srv/data",
    path: "/usr/bin:/bin",
    runtimeDir: "/run/user/1000",
    healthTimeoutMs: 60_000,
  });
  expect(args).toContain(
    '--property=ExecStopPost="/usr/bin/node" "/srv/self deploy/release-watch-a/apps/cli/dist/bin.js" "self-deploy" "recover-upgrade"',
  );
  expect(args).toContain("--property=TimeoutStopSec=240s");
  expect(args).toContain("--unit=cardigan-supervisor-upgrade-0b5c8f9e");
  expect(args.slice(args.indexOf("--") + 1)).toEqual([
    "/usr/bin/node",
    "/srv/self deploy/release-watch-a/apps/cli/dist/bin.js",
    "self-deploy",
    "finish-upgrade",
  ]);
  expect(
    supervisorHelperArguments({
      attempt: "0b5c8f9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      node: "/opt/n%de$x/node",
      bin: '/srv/a"b\\c/bin.js',
      dataDir: "/d",
      path: undefined,
      runtimeDir: undefined,
      healthTimeoutMs: 10_000,
    }).find((a) => a.startsWith("--property=ExecStopPost=")),
  ).toBe(
    '--property=ExecStopPost="/opt/n%%de$$x/node" "/srv/a\\"b\\\\c/bin.js" "self-deploy" "recover-upgrade"',
  );
});
