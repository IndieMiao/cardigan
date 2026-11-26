import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  maintenanceActive,
  readMaintenance,
} from "./deployment-maintenance.js";
import {
  type HcRelease,
  hcStagingRecovery,
  prepareHcUpgrade,
} from "./hc-upgrade.js";
import type { MaintenanceDriver } from "./maintenance.js";
import { MaintenanceRunner, maintenanceStatus } from "./maintenance.js";
import {
  type MaintenanceHcTarget,
  parseMaintenanceConfig,
} from "./maintenance-config.js";
import { appendMaintenanceAudit, runArgv } from "./maintenance-node.js";

// Isolated real files: the Python helper stages, switches and restores in a
// temporary directory; services are synthetic and no real hc is touched.
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platform = `linux-${arch}`;

function fakeHc(path: string, version: string) {
  writeFileSync(path, `#!/bin/sh\nprintf 'hc ${version}\\n'\n`);
  chmodSync(path, 0o755);
}

function archive(
  root: string,
  version: string,
  kind: "file" | "symlink" = "file",
) {
  const dir = mkdtempSync(join(root, "archive-"));
  if (kind === "file") fakeHc(join(dir, "herdr-core"), version);
  else symlinkSync("/bin/sh", join(dir, "herdr-core"));
  const file = join(root, `herdr-core-${version}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", dir, "herdr-core"]);
  return new Uint8Array(readFileSync(file));
}

function release(version: string, bytes: Uint8Array, sha?: string): HcRelease {
  return {
    version,
    targets: {
      [platform]: {
        url: `https://releases.herdr.dev/core/${version}/herdr-core-${platform}.tar.gz`,
        sha256: sha ?? createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}

function setup(layout: "symlink" | "file", shell = false, ports = false) {
  const root = mkdtempSync(join(tmpdir(), "cg-hc-upgrade-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "old"));
  const link = join(root, "bin", "hc");
  if (layout === "symlink") {
    fakeHc(join(root, "old", "hc"), "7.1.21");
    symlinkSync(join(root, "old", "hc"), link);
  } else fakeHc(link, "7.1.21");
  // Stands in for ssh: the far side receives one shell command line.
  const ssh = join(root, "fake-ssh");
  writeFileSync(ssh, '#!/bin/sh\nexec /bin/sh -c "$*"\n');
  chmodSync(ssh, 0o755);
  const target: Record<string, unknown> = {
    id: "host",
    link,
    install_root: join(root, "versions"),
    platform,
    stop: ["/fake/hc-stop"],
    start: ["/fake/hc-start"],
    ...(shell ? { via: [ssh], via_shell: true } : {}),
  };
  const config = parseMaintenanceConfig({
    server: {
      stop: ["/fake/server-stop"],
      start: ["/fake/server-start"],
      ...(ports ? { ports: [65000], ready_timeout_seconds: 1 } : {}),
    },
    hc: { targets: [target] },
  });
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  const calls: string[] = [];
  // Synthetic commands that fail the given number of times.
  const failing = new Map<string, number>();
  let portsStuck = false;
  // Waits advance a fake clock instead of spinning on the real one.
  let skew = 0;
  const driver: MaintenanceDriver = {
    now: () => new Date(Date.now() + skew).toISOString(),
    sleep: async (ms) => {
      skew += ms;
    },
    run: async (argv, options) => {
      const command = argv[0];
      if (command?.startsWith("/fake/")) {
        calls.push(command);
        const left = failing.get(command) ?? 0;
        if (left > 0) {
          failing.set(command, left - 1);
          return { code: 1, stdout: "", stderr: "synthetic" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return runArgv(argv, options);
    },
    activity: () => ({ busy: [], standing: [] }),
    software: async () => ({ sha: null, process: null, ready: false }),
    portOpen: async () => portsStuck,
    deployPin: () => null,
    audit: (record, phase, note, notice) =>
      appendMaintenanceAudit(store, record, phase, note, notice),
    say: () => {},
  };
  return {
    root,
    link,
    config,
    store,
    driver,
    calls,
    failNextStart: () => failing.set("/fake/server-start", 1),
    fail: (command: string, times = 1) => failing.set(command, times),
    stickPorts: (stuck: boolean) => {
      portsStuck = stuck;
    },
    target: config.hc_targets[0] as MaintenanceHcTarget,
  };
}

async function upgrade(
  f: ReturnType<typeof setup>,
  rel: HcRelease,
  bytes: Uint8Array,
) {
  const plan = await prepareHcUpgrade({
    config: f.config,
    version: rel.version,
    release: rel,
    driver: f.driver,
    fetchArchive: async () => bytes,
  });
  const runner = new MaintenanceRunner(
    f.store,
    f.config,
    f.driver,
    () => plan.work,
  );
  return {
    plan,
    outcome: await runner.begin({
      reason: "hc",
      operation: {
        kind: "hc_upgrade",
        version: rel.version,
        targets: ["host"],
      },
      stop_hc: ["host"],
    }),
  };
}

const version = (path: string) =>
  execFileSync(path, ["--version"], { encoding: "utf8" }).trim();

test.each([false, true])(
  "symlink layout switches to a versioned directory (via shell: %s)",
  async (shell) => {
    const f = setup("symlink", shell);
    const bytes = archive(f.root, "7.1.22");
    const { plan, outcome } = await upgrade(f, release("7.1.22", bytes), bytes);
    expect(outcome).toBe("completed");
    expect(plan.staged.host).toBe(join(f.root, "versions", "7.1.22", "hc"));
    expect(readlinkSync(f.link)).toBe(plan.staged.host);
    expect(version(f.link)).toBe("hc 7.1.22");
    expect(readMaintenance(f.store)?.record.steps.switched?.host).toEqual({
      kind: "symlink",
      target: join(f.root, "old", "hc"),
    });
    expect(f.calls).toEqual([
      "/fake/server-stop",
      "/fake/hc-stop",
      "/fake/hc-start",
      "/fake/server-start",
    ]);
    expect(maintenanceActive(f.store)).toBe(false);
    // Staging again is idempotent and leaves the live link alone.
    const again = await prepareHcUpgrade({
      config: f.config,
      version: "7.1.22",
      release: release("7.1.22", bytes),
      driver: f.driver,
      fetchArchive: async () => bytes,
    });
    expect(again.staged.host).toBe(plan.staged.host);
  },
);

test("a failed smoke check after the switch restores the original file and old version", async () => {
  const f = setup("file");
  const original = readFileSync(f.link, "utf8");
  const bytes = archive(f.root, "7.1.22");
  f.failNextStart();
  const { outcome } = await upgrade(f, release("7.1.22", bytes), bytes);
  expect(outcome).toBe("rolled_back");
  expect(lstatSync(f.link).isFile()).toBe(true);
  expect(readFileSync(f.link, "utf8")).toBe(original);
  expect(version(f.link)).toBe("hc 7.1.21");
  const record = readMaintenance(f.store)?.record;
  expect(record?.steps.switched?.host).toMatchObject({ kind: "file" });
  expect(record?.error).toContain("server 启动失败");
  expect(maintenanceActive(f.store)).toBe(false);
  // The new version stays staged for a later attempt.
  expect(version(join(f.root, "versions", "7.1.22", "hc"))).toBe("hc 7.1.22");
});

test("checksum, version and archive problems stop before any service is touched", async () => {
  const f = setup("symlink");
  const bytes = archive(f.root, "7.1.22");
  await expect(
    upgrade(f, release("7.1.22", bytes, "0".repeat(64)), bytes),
  ).rejects.toThrow("SHA-256 不符");
  await expect(
    prepareHcUpgrade({
      config: f.config,
      version: "7.1.23",
      release: release("7.1.22", bytes),
      driver: f.driver,
      fetchArchive: async () => bytes,
    }),
  ).rejects.toThrow("锁定的版本是 7.1.22");
  const linked = archive(f.root, "7.1.24", "symlink");
  await expect(upgrade(f, release("7.1.24", linked), linked)).rejects.toThrow(
    "regular herdr-core",
  );
  const lying = archive(f.root, "7.1.25");
  await expect(upgrade(f, release("7.1.26", lying), lying)).rejects.toThrow(
    "does not report version 7.1.26",
  );
  expect(f.calls).toEqual([]);
  expect(readMaintenance(f.store)).toBeUndefined();
  expect(readlinkSync(f.link)).toBe(join(f.root, "old", "hc"));
});

test("an unofficial manifest URL is refused", async () => {
  const f = setup("symlink");
  const bytes = archive(f.root, "7.1.22");
  const rel = release("7.1.22", bytes);
  const bad: HcRelease = {
    version: "7.1.22",
    targets: {
      [platform]: {
        url: "https://example.invalid/hc.tar.gz",
        sha256: rel.targets[platform]?.sha256 as string,
      },
    },
  };
  await expect(upgrade(f, bad, bytes)).rejects.toThrow("官方版本化地址");
});

// V-3341: stopping failed before the upgrade switched anything, so the window
// must come back on the old version and end as rolled_back, not wait for the
// new version forever with the gate closed.
test.each([
  ["server stop exits non-zero", "server"],
  ["server ports stay open", "ports"],
  ["hc stop exits non-zero", "hc"],
] as const)(
  "a stop failure before the switch rolls back on the old version (%s)",
  async (_name, failure) => {
    const f = setup("symlink", false, failure === "ports");
    if (failure === "server") f.fail("/fake/server-stop");
    if (failure === "hc") f.fail("/fake/hc-stop");
    if (failure === "ports") {
      f.stickPorts(true);
      // Ports close again once the server is restarted and checked.
      const run = f.driver.run;
      f.driver.run = async (argv, options) => {
        if (argv[0] === "/fake/server-start") f.stickPorts(false);
        const result = await run(argv, options);
        if (argv[0] === "/fake/server-start") f.stickPorts(true);
        return result;
      };
    }
    const bytes = archive(f.root, "7.1.22");
    const { outcome } = await upgrade(f, release("7.1.22", bytes), bytes);
    const row = readMaintenance(f.store);
    expect(row?.record.steps.switched).toBeUndefined();
    expect(row?.record.steps.operation).toBeUndefined();
    expect(row?.record.error).toBeTruthy();
    expect(outcome).toBe("rolled_back");
    expect(row?.phase).toBe("rolled_back");
    expect(maintenanceActive(f.store)).toBe(false);
    expect(readlinkSync(f.link)).toBe(join(f.root, "old", "hc"));
    expect(version(f.link)).toBe("hc 7.1.21");
    if (failure === "server") expect(f.calls).toEqual(["/fake/server-stop"]);
    if (failure === "hc")
      expect(f.calls).toEqual([
        "/fake/server-stop",
        "/fake/hc-stop",
        "/fake/server-start",
      ]);
  },
);

test("end after a stop failure needing recovery re-checks the old version and stays rolled_back", async () => {
  const f = setup("symlink");
  f.fail("/fake/hc-stop");
  // Restarting the server also fails once, so the window needs a human.
  f.fail("/fake/server-start");
  const bytes = archive(f.root, "7.1.22");
  const { plan, outcome } = await upgrade(f, release("7.1.22", bytes), bytes);
  expect(outcome).toBe("recovery_required");
  expect(maintenanceActive(f.store)).toBe(true);
  expect(readMaintenance(f.store)?.record.recovery?.join("\n")).toContain(
    "server 启动失败",
  );
  const runner = new MaintenanceRunner(
    f.store,
    f.config,
    f.driver,
    () => plan.work,
  );
  expect(await runner.resume("end")).toBe("rolled_back");
  const row = readMaintenance(f.store);
  expect(row?.record.error).toContain("停止 hc host");
  expect(row?.record.recovery).toBeUndefined();
  expect(maintenanceActive(f.store)).toBe(false);
  expect(version(f.link)).toBe("hc 7.1.21");
});

// C-755: a window interrupted while stopping or operating (the command was
// killed mid-step), then resumed with the network down. Stopping catches its
// own errors, so that command hangs on the hc stop after the server stopped;
// operating is interrupted right after its phase was saved.
async function interrupted(
  f: ReturnType<typeof setup>,
  rel: HcRelease,
  bytes: Uint8Array,
  phase: "stopping" | "operating",
) {
  const { audit, run } = f.driver;
  let armed = true;
  if (phase === "stopping")
    f.driver.run = (argv, options) => {
      if (armed && argv[0] === "/fake/hc-stop") {
        armed = false;
        return new Promise(() => {});
      }
      return run(argv, options);
    };
  else
    f.driver.audit = (record, at, note, notice) => {
      audit(record, at, note, notice);
      if (armed && at === "operating") {
        armed = false;
        throw new Error("interrupted");
      }
    };
  const pending = upgrade(f, rel, bytes);
  if (phase === "operating")
    await expect(pending).rejects.toThrow("interrupted");
  else
    for (let i = 0; armed && i < 500; i++)
      await new Promise((r) => setTimeout(r, 10));
  f.driver.audit = audit;
  f.driver.run = run;
  const row = readMaintenance(f.store);
  expect(row?.phase).toBe(phase);
  if (phase === "stopping") {
    expect(row?.record.steps.server_stopped).toBe(true);
    expect(row?.record.steps.hc_stopped).toBeUndefined();
  }
  expect(maintenanceActive(f.store)).toBe(true);
}

const offline = () => {
  const calls = { downloads: 0 };
  return {
    calls,
    fetchArchive: async (): Promise<Uint8Array> => {
      calls.downloads++;
      throw new Error("getaddrinfo ENOTFOUND releases.herdr.dev");
    },
  };
};

test.each([
  ["stopping", "resume"],
  ["stopping", "end"],
  ["operating", "resume"],
  ["operating", "end"],
] as const)(
  "interrupted while %s, %s offline reuses the staged version without downloading",
  async (phase, choice) => {
    const f = setup("symlink");
    const bytes = archive(f.root, "7.1.22");
    const rel = release("7.1.22", bytes);
    await interrupted(f, rel, bytes, phase);
    const net = offline();
    const plan = await prepareHcUpgrade({
      config: f.config,
      version: "7.1.22",
      release: rel,
      targetIds: ["host"],
      driver: f.driver,
      reuseStaged: true,
      fetchArchive: net.fetchArchive,
    });
    expect(net.calls.downloads).toBe(0);
    expect(plan.reused).toEqual(["host"]);
    const runner = new MaintenanceRunner(
      f.store,
      f.config,
      f.driver,
      () => plan.work,
    );
    expect(await runner.resume(choice)).toBe("completed");
    expect(net.calls.downloads).toBe(0);
    expect(readlinkSync(f.link)).toBe(join(f.root, "versions", "7.1.22", "hc"));
    expect(version(f.link)).toBe("hc 7.1.22");
    expect(maintenanceActive(f.store)).toBe(false);
  },
);

const tampering = {
  missing: (dir: string) => rmSync(dir, { recursive: true }),
  marker: (dir: string) =>
    writeFileSync(join(dir, ".sha256"), `${"0".repeat(64)}\n`),
  // Still reports the right version, but is not what the archive contained.
  binary: (dir: string) =>
    appendFileSync(join(dir, "herdr-core"), "# changed\n"),
  extra: (dir: string) => writeFileSync(join(dir, "planted"), "x"),
  list: (dir: string) => rmSync(join(dir, ".files")),
} as const;

test.each(Object.keys(tampering) as (keyof typeof tampering)[])(
  "a staged directory that fails the stage check (%s) is downloaded and staged again",
  async (kind) => {
    const f = setup("symlink");
    const bytes = archive(f.root, "7.1.22");
    const rel = release("7.1.22", bytes);
    await interrupted(f, rel, bytes, "operating");
    const dir = join(f.root, "versions", "7.1.22");
    tampering[kind](dir);
    let downloads = 0;
    const plan = await prepareHcUpgrade({
      config: f.config,
      version: "7.1.22",
      release: rel,
      targetIds: ["host"],
      driver: f.driver,
      reuseStaged: true,
      fetchArchive: async () => {
        downloads++;
        return bytes;
      },
    });
    expect(downloads).toBe(1);
    expect(plan.reused).toEqual([]);
    expect(readFileSync(join(dir, "herdr-core"), "utf8")).not.toContain(
      "changed",
    );
    expect(lstatSync(join(dir, "planted"), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    const runner = new MaintenanceRunner(
      f.store,
      f.config,
      f.driver,
      () => plan.work,
    );
    expect(await runner.resume("end")).toBe("completed");
    expect(version(f.link)).toBe("hc 7.1.22");
  },
);

test("a first stage applies the same check: a tampered directory is replaced, not trusted", async () => {
  const f = setup("symlink");
  const bytes = archive(f.root, "7.1.22");
  const rel = release("7.1.22", bytes);
  const stage = () =>
    prepareHcUpgrade({
      config: f.config,
      version: "7.1.22",
      release: rel,
      driver: f.driver,
      fetchArchive: async () => bytes,
    });
  await stage();
  tampering.binary(join(f.root, "versions", "7.1.22"));
  await stage();
  expect(
    readdirSync(join(f.root, "versions")).some((n) => n.startsWith(".stale-")),
  ).toBe(true);
  expect(
    readFileSync(join(f.root, "versions", "7.1.22", "herdr-core"), "utf8"),
  ).not.toContain("changed");
});

test("offline with nothing reusable keeps the phase, records why with recovery steps and tells the human", async () => {
  const f = setup("symlink");
  const bytes = archive(f.root, "7.1.22");
  const rel = release("7.1.22", bytes);
  await interrupted(f, rel, bytes, "stopping");
  tampering.missing(join(f.root, "versions", "7.1.22"));
  const notices: string[] = [];
  const audit = f.driver.audit;
  f.driver.audit = (record, phase, note, notice) => {
    if (notice) notices.push(notice);
    audit(record, phase, note, notice);
  };
  const net = offline();
  const failure = await prepareHcUpgrade({
    config: f.config,
    version: "7.1.22",
    release: rel,
    targetIds: ["host"],
    driver: f.driver,
    reuseStaged: true,
    fetchArchive: net.fetchArchive,
  }).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  const reason = (failure as Error).message;
  expect(reason).toContain("没有可复用的预置目录（missing）");
  expect(reason).toContain("ENOTFOUND");
  expect(net.calls.downloads).toBe(1);
  const recovery = hcStagingRecovery("stopping", "7.1.22", rel);
  const runner = new MaintenanceRunner(f.store, f.config, f.driver);
  expect(runner.block(reason, recovery)).toBe("stopping");
  const row = readMaintenance(f.store);
  expect(row?.phase).toBe("stopping");
  expect(row?.record.error).toBeUndefined();
  expect(row?.record.blocked?.reason).toBe(reason);
  expect(maintenanceActive(f.store)).toBe(true);
  const status = maintenanceStatus(f.store);
  expect(status).toContain("stopping");
  expect(status).toContain("ENOTFOUND");
  expect(status).toContain("cardigan maintenance continue");
  expect(status).not.toContain("abandon");
  expect(notices.join("\n")).toContain("ENOTFOUND");
  expect(notices.join("\n")).toContain("cardigan maintenance end");
  // Network back: the retry stages, completes and drops the block.
  const plan = await prepareHcUpgrade({
    config: f.config,
    version: "7.1.22",
    release: rel,
    targetIds: ["host"],
    driver: f.driver,
    reuseStaged: true,
    fetchArchive: async () => bytes,
  });
  const again = new MaintenanceRunner(
    f.store,
    f.config,
    f.driver,
    () => plan.work,
  );
  expect(await again.resume("resume")).toBe("completed");
  expect(readMaintenance(f.store)?.record.blocked).toBeUndefined();
  expect(maintenanceStatus(f.store)).not.toContain("未能继续");
  expect(version(f.link)).toBe("hc 7.1.22");
});

test("recovery steps offer abandon only before services stopped", () => {
  const rel = release("7.1.22", new Uint8Array([1]));
  expect(hcStagingRecovery("draining", "7.1.22", rel).join("\n")).toContain(
    "cardigan maintenance abandon",
  );
  expect(
    hcStagingRecovery("operating", "7.1.22", rel).join("\n"),
  ).not.toContain("abandon");
  expect(hcStagingRecovery("operating", "7.1.22", rel).join("\n")).toContain(
    rel.targets[platform]?.url as string,
  );
});
