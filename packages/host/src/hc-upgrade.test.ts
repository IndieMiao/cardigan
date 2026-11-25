import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
import { type HcRelease, prepareHcUpgrade } from "./hc-upgrade.js";
import type { MaintenanceDriver } from "./maintenance.js";
import { MaintenanceRunner } from "./maintenance.js";
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

function setup(layout: "symlink" | "file", shell = false) {
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
    server: { stop: ["/fake/server-stop"], start: ["/fake/server-start"] },
    hc: { targets: [target] },
  });
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  const calls: string[] = [];
  let failStart = 0;
  const driver: MaintenanceDriver = {
    now: () => new Date().toISOString(),
    sleep: async () => {},
    run: async (argv, options) => {
      if (argv[0]?.startsWith("/fake/")) {
        calls.push(argv[0]);
        if (argv[0] === "/fake/server-start" && failStart > 0) {
          failStart--;
          return { code: 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return runArgv(argv, options);
    },
    activity: () => ({ busy: [], standing: [] }),
    software: async () => ({ sha: null, process: null, ready: false }),
    portOpen: async () => false,
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
    failNextStart: () => {
      failStart = 1;
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
