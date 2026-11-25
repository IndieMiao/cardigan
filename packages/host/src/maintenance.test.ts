import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  DeploymentInProgress,
  deploymentInProgress,
} from "./deployment-capacity.js";
import {
  maintenanceActive,
  readMaintenance,
} from "./deployment-maintenance.js";
import {
  type CommandResult,
  type MaintenanceDriver,
  MaintenanceRunner,
  maintenanceStatus,
} from "./maintenance.js";
import type { MaintenanceActivity } from "./maintenance-activity.js";
import { parseMaintenanceConfig } from "./maintenance-config.js";
import {
  appendMaintenanceAudit,
  MAINTENANCE_AUDIT_EVENT,
  MAINTENANCE_NOTICE_EVENT,
} from "./maintenance-node.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";

const SHA = "a".repeat(40);
const config = parseMaintenanceConfig({
  wait_timeout_minutes: 30,
  poll_interval_seconds: 10,
  server: {
    stop: ["/fake/server-stop"],
    start: ["/fake/server-start"],
    ports: [4100, 4101],
    ready_timeout_seconds: 30,
  },
  hc: {
    targets: [
      {
        id: "host",
        link: "/fake/host/hc",
        install_root: "/fake/host/versions",
        platform: "linux-x86_64",
        stop: ["/fake/hc-stop", "host"],
        start: ["/fake/hc-start", "host"],
      },
      {
        id: "agent",
        link: "/fake/agent/hc",
        install_root: "/fake/agent/versions",
        platform: "linux-x86_64",
        via: ["/usr/bin/sudo", "-n", "-u", "agent"],
        stop: ["/fake/hc-stop", "agent"],
        start: ["/fake/hc-start", "agent"],
      },
    ],
  },
});

/** Synthetic host: services, ports, clock and work are in memory. */
class FakeHost implements MaintenanceDriver {
  clock = Date.parse("2026-11-25T00:00:00.000Z");
  server = true;
  process = 1;
  hc: Record<string, boolean> = { host: true, agent: true };
  versions: Record<string, string> = {
    "/fake/host/hc": "0.1.21",
    "/fake/agent/hc": "0.1.21",
  };
  busy: MaintenanceActivity["busy"] = [];
  standing: MaintenanceActivity["standing"] = [];
  calls: string[] = [];
  lines: string[] = [];
  failStart = 0;
  opCode = 0;
  pin: string | null = null;
  onSleep?: () => void;
  constructor(readonly store: Store) {}
  now() {
    return new Date(this.clock).toISOString();
  }
  async sleep(ms: number) {
    this.clock += ms;
    this.onSleep?.();
  }
  async run(argv: readonly string[]): Promise<CommandResult> {
    const ok = { code: 0, stdout: "", stderr: "" };
    // The agent target reaches its account through `sudo -n -u agent`.
    const [cmd, arg] = argv[0] === "/usr/bin/sudo" ? argv.slice(4) : argv;
    this.calls.push(argv.join(" "));
    if (cmd === "/fake/server-stop") this.server = false;
    else if (cmd === "/fake/server-start") {
      if (this.failStart > 0) {
        this.failStart--;
        return { code: 1, stdout: "", stderr: "start failed" };
      }
      this.server = true;
      this.process++;
    } else if (cmd === "/fake/hc-stop") this.hc[arg as string] = false;
    else if (cmd === "/fake/hc-start") this.hc[arg as string] = true;
    else if (cmd === "/fake/op") return { ...ok, code: this.opCode };
    else if (arg === "--version") {
      const version = this.versions[cmd as string];
      return version
        ? { ...ok, stdout: `hc ${version}\n` }
        : { ...ok, code: 1 };
    }
    return ok;
  }
  activity() {
    return { busy: this.busy, standing: this.standing };
  }
  async software() {
    return {
      sha: SHA,
      process: this.server ? `${this.process}:boot` : null,
      ready: this.server,
    };
  }
  async portOpen() {
    return this.server;
  }
  deployPin() {
    return this.pin;
  }
  audit(
    record: Parameters<MaintenanceDriver["audit"]>[0],
    phase: Parameters<MaintenanceDriver["audit"]>[1],
    note: string,
    notice?: string,
  ) {
    appendMaintenanceAudit(this.store, record, phase, note, notice, this.now());
  }
  say(line: string) {
    this.lines.push(line);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-maintenance-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  const host = new FakeHost(store);
  return { store, host, runner: new MaintenanceRunner(store, config, host) };
}

function events(store: Store, type: string) {
  return (
    store.database
      .prepare(
        "SELECT doc FROM events WHERE project_id = 'cardigan' AND type = ? ORDER BY rowid",
      )
      .all(type) as { doc: string }[]
  ).map((r) => JSON.parse(r.doc) as { payload: Record<string, unknown> });
}

const run = {
  kind: "run" as const,
  id: "R-1",
  project_id: "p",
  card_id: "C-1",
  status: "running",
};

test("manual window: pauses, waits for work, stops, then restores and verifies", async () => {
  const { store, host, runner } = await fixture();
  host.busy = [run];
  host.pin = "b".repeat(40);
  host.onSleep = () => {
    // The gate is closed while the Run finishes.
    expect(store.uow.read(() => deploymentInProgress(store))).toBe(true);
    host.busy = [];
  };
  expect(
    await runner.begin({
      reason: "数据迁移",
      operation: { kind: "manual" },
      stop_hc: ["host"],
    }),
  ).toBe("stopped");
  expect(host.server).toBe(false);
  expect(host.hc).toEqual({ host: false, agent: true });
  expect(maintenanceActive(store)).toBe(true);
  const stopped = readMaintenance(store);
  expect(stopped?.phase).toBe("stopped");
  expect(stopped?.record.before).toMatchObject({
    software_sha: SHA,
    deploy_pin: "b".repeat(40),
    hc: { host: "0.1.21", agent: "0.1.21" },
  });
  // Repeating the step neither stops again nor ends the window.
  await expect(runner.resume("resume")).rejects.toThrow("maintenance end");
  expect(host.calls.filter((c) => c === "/fake/server-stop")).toHaveLength(1);

  expect(await runner.resume("end")).toBe("completed");
  expect(host.server).toBe(true);
  expect(host.hc.host).toBe(true);
  expect(maintenanceActive(store)).toBe(false);
  expect(store.uow.read(() => deploymentInProgress(store))).toBe(false);
  // The human pin is preserved, never cleared by the window.
  expect(host.pin).toBe("b".repeat(40));
  const notices = events(store, MAINTENANCE_NOTICE_EVENT).map(
    (e) => e.payload.phase,
  );
  expect(notices).toEqual(["draining", "completed"]);
  expect(
    events(store, MAINTENANCE_AUDIT_EVENT).map((e) => e.payload.phase),
  ).toContain("stopping");
  expect(maintenanceStatus(store)).toContain("completed");
});

test("drain timeout lists unfinished work; the human waits again or abandons", async () => {
  const { store, host, runner } = await fixture();
  host.busy = [run, { kind: "check", id: "MC-1", status: "running" }];
  expect(
    await runner.begin({
      reason: "hc",
      operation: { kind: "manual" },
      stop_hc: [],
      timeout_ms: 60_000,
    }),
  ).toBe("drain_timeout");
  const row = readMaintenance(store);
  expect(row?.phase).toBe("drain_timeout");
  expect(row?.record.busy.map((b) => b.id)).toEqual(["R-1", "MC-1"]);
  expect(maintenanceActive(store)).toBe(true);
  const timeout = events(store, MAINTENANCE_NOTICE_EVENT).at(-1);
  expect(String(timeout?.payload.notice)).toContain("R-1");
  // Nothing is stopped or cancelled on the system's own initiative.
  expect(host.server).toBe(true);
  expect(host.calls).not.toContain("/fake/server-stop");
  await expect(runner.resume("resume")).rejects.toThrow("--wait");

  expect(await runner.resume("wait")).toBe("drain_timeout");
  expect(
    readMaintenance(store)?.record.history.some(
      (h) => h.note === "人选择继续等待",
    ),
  ).toBe(true);

  expect(await runner.abandon()).toBe("abandoned");
  expect(maintenanceActive(store)).toBe(false);
  expect(host.server).toBe(true);
  expect(events(store, MAINTENANCE_NOTICE_EVENT).at(-1)?.payload.phase).toBe(
    "abandoned",
  );
});

test("the human may proceed past a timeout; the accepted items are recorded", async () => {
  const { store, host, runner } = await fixture();
  host.busy = [run];
  await runner.begin({
    reason: "x",
    operation: { kind: "manual" },
    stop_hc: [],
    timeout_ms: 60_000,
  });
  expect(await runner.resume("proceed")).toBe("stopped");
  expect(readMaintenance(store)?.record.wait.proceeded?.items).toEqual([run]);
  expect(host.server).toBe(false);
});

test("a failed maintenance command rolls services back and lifts the gate", async () => {
  const { store, host, runner } = await fixture();
  host.opCode = 3;
  expect(
    await runner.begin({
      reason: "迁移",
      operation: { kind: "command", argv: ["/fake/op"] },
      stop_hc: ["host", "agent"],
    }),
  ).toBe("rolled_back");
  const row = readMaintenance(store);
  expect(row?.record.error).toContain("退出码 3");
  expect(row?.record.rollback_scope).toContain("命令自身的改动不自动回退");
  expect(host.server).toBe(true);
  expect(host.hc).toEqual({ host: true, agent: true });
  expect(maintenanceActive(store)).toBe(false);
  expect(
    String(events(store, MAINTENANCE_NOTICE_EVENT).at(-1)?.payload.notice),
  ).toContain("失败并已回退");
});

test("an unrecoverable restart keeps the gate closed with instructions, end re-verifies", async () => {
  const { store, host, runner } = await fixture();
  host.failStart = 1;
  expect(
    await runner.begin({
      reason: "x",
      operation: { kind: "command", argv: ["/fake/op"] },
      stop_hc: [],
    }),
  ).toBe("recovery_required");
  const row = readMaintenance(store);
  expect(row?.phase).toBe("recovery_required");
  expect(row?.record.recovery?.join("\n")).toContain("/fake/server-start");
  expect(maintenanceActive(store)).toBe(true);
  expect(store.uow.read(() => deploymentInProgress(store))).toBe(true);
  // Recovery is never reported as success.
  expect(
    events(store, MAINTENANCE_NOTICE_EVENT).map((e) => e.payload.phase),
  ).not.toContain("completed");
  await expect(runner.abandon()).rejects.toThrow("maintenance end");
  expect(await runner.resume("end")).toBe("completed");
  expect(maintenanceActive(store)).toBe(false);
});

test("a version check that fails after restart is not a completed window", async () => {
  const { store, host, runner } = await fixture();
  await runner.begin({
    reason: "x",
    operation: { kind: "manual" },
    stop_hc: ["host"],
  });
  host.versions["/fake/host/hc"] = "0.0.1";
  expect(await runner.resume("end")).toBe("recovery_required");
  expect(readMaintenance(store)?.record.recovery?.[0]).toContain(
    "hc host 版本 0.0.1",
  );
  expect(maintenanceActive(store)).toBe(true);
});

test("an interrupted step resumes from its recovery point without repeating it", async () => {
  const { store, host, runner } = await fixture();
  let hang = true;
  const run = host.run.bind(host);
  host.run = async (argv) => {
    if (hang && argv[0] === "/fake/hc-stop") return new Promise(() => {});
    return run(argv);
  };
  void runner.begin({
    reason: "x",
    operation: { kind: "manual" },
    stop_hc: ["host"],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const interrupted = readMaintenance(store);
  expect(interrupted?.phase).toBe("stopping");
  expect(interrupted?.record.steps.server_stopped).toBe(true);
  hang = false;
  const next = new MaintenanceRunner(store, config, host);
  expect(await next.resume("resume")).toBe("stopped");
  expect(host.calls.filter((c) => c === "/fake/server-stop")).toHaveLength(1);
  expect(host.hc.host).toBe(false);
});

test("only one window at a time; a closed window can be followed by a new one", async () => {
  const { store, host, runner } = await fixture();
  await runner.begin({
    reason: "x",
    operation: { kind: "manual" },
    stop_hc: [],
  });
  await expect(
    new MaintenanceRunner(store, config, host).begin({
      reason: "y",
      operation: { kind: "manual" },
      stop_hc: [],
    }),
  ).rejects.toThrow("已有未结束的维护");
  await runner.resume("end");
  expect(
    await runner.begin({
      reason: "y",
      operation: { kind: "manual" },
      stop_hc: [],
    }),
  ).toBe("stopped");
});

test("an older schema has no gate and refuses to open a window", async () => {
  const { store } = await fixture();
  store.database.exec("DROP TABLE host_maintenance");
  expect(maintenanceActive(store)).toBe(false);
  expect(store.uow.read(() => deploymentInProgress(store))).toBe(false);
  expect(() => readMaintenance(store)).toThrow("维护表");
});

test("config: absolute argv, paired stop/start and the 30 minute default", () => {
  const minimal = parseMaintenanceConfig({
    server: { stop: ["/bin/a"], start: ["/bin/b"] },
  });
  expect(minimal.wait_timeout_ms).toBe(30 * 60_000);
  expect(minimal.hc_targets).toEqual([]);
  expect(() =>
    parseMaintenanceConfig({
      server: { stop: ["systemctl"], start: ["/bin/b"] },
    }),
  ).toThrow("绝对路径");
  expect(() =>
    parseMaintenanceConfig({
      server: { stop: ["/bin/a"], start: ["/bin/b"] },
      hc: { targets: [{ id: "x", stop: ["/bin/a"] }] },
    }),
  ).toThrow("同时配置");
  expect(() =>
    parseMaintenanceConfig({
      server: { stop: ["/bin/a"], start: ["/bin/b"] },
      extra: 1,
    }),
  ).toThrow("未知配置项");
});

test("check admission waits like a deployment while the window is open", async () => {
  const { store, runner } = await fixture();
  store.createProject({ id: "p" });
  await runner.begin({
    reason: "x",
    operation: { kind: "manual" },
    stop_hc: [],
  });
  expect(() => acquireMergeCheckCapacity(store, "p", "MC-1")).toThrow(
    DeploymentInProgress,
  );
  await runner.resume("end");
  expect(() => acquireMergeCheckCapacity(store, "p", "MC-1")).not.toThrow();
});
