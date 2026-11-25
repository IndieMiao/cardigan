import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HcRelease,
  type MaintenanceDriver,
  maintenanceActive,
  parseMaintenanceConfig,
  prepareHcUpgrade,
  readMaintenance,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { main } from "./index.js";
import type { CliIo } from "./io.js";
import { runHcCommand, runMaintenanceCommand } from "./maintenance.js";

const io = (env: Record<string, string> = {}): CliIo & { out: string[] } => {
  const out: string[] = [];
  return {
    out,
    env,
    cwd: "/tmp",
    platform: "linux",
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    signals: { on: vi.fn(), off: vi.fn() },
    spawnInherit: vi.fn(),
    captureCommand: vi.fn(),
  };
};

const config = parseMaintenanceConfig({
  server: { stop: ["/fake/stop"], start: ["/fake/start"] },
});

function driver(): MaintenanceDriver {
  let up = true;
  return {
    now: () => new Date().toISOString(),
    sleep: async () => {},
    run: async (argv) => {
      if (argv[0] === "/fake/stop") up = false;
      if (argv[0] === "/fake/start") up = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    activity: () => ({ busy: [], standing: [] }),
    software: async () => ({ sha: null, process: null, ready: up }),
    portOpen: async () => up,
    deployPin: () => null,
    audit: () => {},
    say: () => {},
  };
}

test("Token and token-file callers are refused before any store or service is touched", async () => {
  const open = vi.spyOn(Store, "open");
  try {
    for (const args of [
      ["maintenance", "begin", "--reason", "x"],
      ["maintenance", "status"],
      ["maintenance", "end"],
      ["hc", "upgrade", "--version", "9.9.9"],
    ]) {
      const tokenIo = io({ CARDIGAN_TOKEN: "agent-token" });
      expect(await main(args, tokenIo)).toBe(2);
      expect(tokenIo.out.join("\n")).toContain("仅限人类操作");
    }
    // The command modules refuse on their own as well.
    await expect(
      runMaintenanceCommand(["status"], { ...io(), tokenFile: "/x" }),
    ).rejects.toThrow("Token/Agent 不可调用");
    await expect(
      runHcCommand(
        ["upgrade", "--version", "9.9.9"],
        io({ CARDIGAN_TOKEN: "" }),
      ),
    ).rejects.toThrow("Token/Agent 不可调用");
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

test("usage errors are rejected before a window opens", async () => {
  for (const args of [
    ["begin"],
    ["begin", "--reason", "x", "--wait"],
    ["run", "--reason", "x"],
    ["run", "--reason", "x", "--", "relative/cmd"],
    ["begin", "--reason", "x", "--timeout-minutes", "0"],
    ["end", "--proceed"],
    ["nope"],
  ])
    await expect(runMaintenanceCommand(args, io())).rejects.toThrow();
  await expect(runHcCommand(["upgrade"], io())).rejects.toThrow("用法");
  await expect(runHcCommand(["install"], io())).rejects.toThrow("用法");
});

test("a human opens, inspects and ends a manual window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-maintenance-cli-"));
  Store.open({ dataDir }).close();
  const hooks = { config, driver: () => driver() };
  const human = io({ CARDIGAN_DATA_DIR: dataDir });
  expect(
    await runMaintenanceCommand(
      ["begin", "--reason", "迁移数据", "--timeout-minutes", "5"],
      human,
      hooks,
    ),
  ).toBe(0);
  expect(await runMaintenanceCommand(["status"], human, hooks)).toBe(0);
  expect(human.out.at(-1)).toContain("stopped");
  const store = Store.open({ dataDir, migrate: false });
  try {
    expect(maintenanceActive(store)).toBe(true);
  } finally {
    store.close();
  }
  expect(await runMaintenanceCommand(["end"], human, hooks)).toBe(0);
  const after = Store.open({ dataDir, migrate: false });
  try {
    expect(maintenanceActive(after)).toBe(false);
  } finally {
    after.close();
  }
  await runMaintenanceCommand(["status"], human, hooks);
  expect(human.out.at(-1)).toContain("completed");
});

// V-3343: past the switch an hc upgrade window needs only its recovery
// points; `end` must not download or stage again, so a network outage or an
// unreachable worker cannot keep the gate closed.
test("end of an hc upgrade needing recovery never downloads or stages again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-maintenance-cli-hc-"));
  Store.open({ dataDir }).close();
  const link = "/srv/hc/bin/hc";
  const hcConfig = parseMaintenanceConfig({
    server: { stop: ["/fake/stop"], start: ["/fake/start"] },
    hc: {
      targets: [
        {
          id: "host",
          link,
          install_root: "/srv/hc/versions",
          platform: "linux-x86_64",
          stop: ["/fake/hc-stop"],
          start: ["/fake/hc-start"],
        },
      ],
    },
  });
  const ran: string[] = [];
  const base = driver();
  const hooks = {
    config: hcConfig,
    driver: (): MaintenanceDriver => ({
      ...base,
      run: async (argv, options) => {
        ran.push(argv[0] as string);
        // The human already put the old entry point back.
        if (argv[0] === link)
          return { code: 0, stdout: "hc 7.1.21\n", stderr: "" };
        return base.run(argv, options);
      },
    }),
    fetchArchive: async (): Promise<Uint8Array> => {
      throw new Error("network down");
    },
  };
  const now = new Date().toISOString();
  const record = {
    id: "M-20261125000000-deadbeef",
    reason: "hc 升级到 7.1.22",
    operation: { kind: "hc_upgrade", version: "7.1.22", targets: ["host"] },
    stop_hc: ["host"],
    started_at: now,
    wait: { timeout_ms: 60_000, deadline: now },
    before: {
      software_sha: null,
      server_process: null,
      deploy_pin: null,
      hc: { host: "7.1.21" },
    },
    rollback_scope: "hc 升级",
    steps: {
      server_stopped: true,
      hc_stopped: ["host"],
      operation: "failed",
      switched: { host: { kind: "symlink", target: "/srv/hc/old/hc" } },
    },
    busy: [],
    error: "升级后核对未通过：server 启动失败（退出码 1）",
    recovery: ["回退失败：hc 目标 host restore 失败：ssh unreachable"],
    history: [{ at: now, phase: "recovery_required", note: "需要人工恢复" }],
  };
  const seed = Store.open({ dataDir, migrate: false });
  try {
    seed.database
      .prepare(`INSERT INTO host_maintenance
        (singleton, id, phase, record, revision, holder_pid, holder_start, holder_machine, updated_at)
        VALUES (1, ?, 'recovery_required', ?, 1, NULL, NULL, NULL, ?)`)
      .run(record.id, JSON.stringify(record), now);
    expect(maintenanceActive(seed)).toBe(true);
  } finally {
    seed.close();
  }
  const human = io({ CARDIGAN_DATA_DIR: dataDir });
  // A failed window ends rolled_back, which is a non-zero exit.
  expect(await runMaintenanceCommand(["end"], human, hooks)).toBe(1);
  // No helper call (python) and no download: only services and the version.
  expect(ran).not.toContain("/usr/bin/python3");
  expect(ran).toEqual(
    expect.arrayContaining(["/fake/hc-start", "/fake/start", link]),
  );
  const after = Store.open({ dataDir, migrate: false });
  try {
    expect(maintenanceActive(after)).toBe(false);
  } finally {
    after.close();
  }
  await runMaintenanceCommand(["status"], human, hooks);
  expect(human.out.join("\n")).toContain("rolled_back");
});

// C-755: an hc upgrade window interrupted while stopping, resumed by the
// human with the network down.
function stagedWindow(phase: "stopping" | "operating") {
  const root = mkdtempSync(join(tmpdir(), "cg-maintenance-cli-stage-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  Store.open({ dataDir }).close();
  const fakeHc = (path: string, v: string) => {
    writeFileSync(path, `#!/bin/sh\nprintf 'hc ${v}\\n'\n`);
    chmodSync(path, 0o755);
  };
  mkdirSync(join(root, "old"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "archive"));
  fakeHc(join(root, "old", "hc"), "7.1.21");
  const link = join(root, "bin", "hc");
  symlinkSync(join(root, "old", "hc"), link);
  fakeHc(join(root, "archive", "herdr-core"), "7.1.22");
  const file = join(root, "hc.tar.gz");
  execFileSync("tar", [
    "-czf",
    file,
    "-C",
    join(root, "archive"),
    "herdr-core",
  ]);
  const bytes = new Uint8Array(readFileSync(file));
  const platform = `linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const release: HcRelease = {
    version: "7.1.22",
    targets: {
      [platform]: {
        url: `https://releases.herdr.dev/core/7.1.22/herdr-core-${platform}.tar.gz`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
  const hcConfig = parseMaintenanceConfig({
    server: { stop: ["/fake/stop"], start: ["/fake/start"] },
    hc: {
      targets: [
        {
          id: "host",
          link,
          install_root: join(root, "versions"),
          platform,
          stop: ["/fake/hc-stop"],
          start: ["/fake/hc-start"],
        },
      ],
    },
  });
  const base = driver();
  const notices: string[] = [];
  const real: MaintenanceDriver = {
    ...base,
    run: async (argv, options) => {
      if (argv[0]?.startsWith("/fake/")) return base.run(argv, options);
      const out = spawnSync(argv[0] as string, argv.slice(1), {
        input: options?.input,
        encoding: "utf8",
      });
      return {
        code: out.status ?? 1,
        stdout: out.stdout,
        stderr: out.stderr,
      };
    },
    audit: (_record, _phase, _note, notice) => {
      if (notice) notices.push(notice);
    },
  };
  let downloads = 0;
  let online = false;
  const hooks = {
    config: hcConfig,
    release,
    driver: () => real,
    fetchArchive: async (): Promise<Uint8Array> => {
      downloads++;
      if (!online) throw new Error("getaddrinfo ENOTFOUND releases.herdr.dev");
      return bytes;
    },
  };
  return {
    root,
    dataDir,
    link,
    hooks,
    notices,
    downloads: () => downloads,
    goOnline: () => {
      online = true;
    },
    async seed() {
      // Staged by `hc upgrade` before the window opened.
      await prepareHcUpgrade({
        config: hcConfig,
        version: "7.1.22",
        release,
        driver: real,
        fetchArchive: async () => bytes,
      });
      const now = new Date().toISOString();
      const record = {
        id: "M-20261126000000-c0ffee00",
        reason: "hc 升级到 7.1.22",
        operation: { kind: "hc_upgrade", version: "7.1.22", targets: ["host"] },
        stop_hc: ["host"],
        started_at: now,
        wait: { timeout_ms: 60_000, deadline: now },
        before: {
          software_sha: null,
          server_process: null,
          deploy_pin: null,
          hc: { host: "7.1.21" },
        },
        rollback_scope: "hc 升级",
        steps:
          phase === "stopping"
            ? { server_stopped: true }
            : { server_stopped: true, hc_stopped: ["host"] },
        busy: [],
        history: [{ at: now, phase, note: "服务已停止" }],
      };
      const store = Store.open({ dataDir, migrate: false });
      try {
        store.database
          .prepare(`INSERT INTO host_maintenance
            (singleton, id, phase, record, revision, holder_pid, holder_start, holder_machine, updated_at)
            VALUES (1, ?, ?, ?, 1, NULL, NULL, NULL, ?)`)
          .run(record.id, phase, JSON.stringify(record), now);
      } finally {
        store.close();
      }
    },
    active() {
      const store = Store.open({ dataDir, migrate: false });
      try {
        return { on: maintenanceActive(store), row: readMaintenance(store) };
      } finally {
        store.close();
      }
    },
  };
}

test.each([
  ["stopping", "continue"],
  ["operating", "end"],
] as const)(
  "%s window resumed offline with %s reuses the staged hc and downloads nothing",
  async (phase, command) => {
    const w = stagedWindow(phase);
    await w.seed();
    const human = io({ CARDIGAN_DATA_DIR: w.dataDir });
    expect(await runMaintenanceCommand([command], human, w.hooks)).toBe(0);
    expect(w.downloads()).toBe(0);
    expect(human.out.join("\n")).toContain("已复用 host");
    expect(readlinkSync(w.link)).toBe(join(w.root, "versions", "7.1.22", "hc"));
    expect(w.active().on).toBe(false);
    expect(w.active().row?.phase).toBe("completed");
  },
);

test("offline with the staged directory gone, end keeps the phase, explains and retries once online", async () => {
  const w = stagedWindow("operating");
  await w.seed();
  rmSync(join(w.root, "versions", "7.1.22"), { recursive: true });
  const human = io({ CARDIGAN_DATA_DIR: w.dataDir });
  await expect(runMaintenanceCommand(["end"], human, w.hooks)).rejects.toThrow(
    /仍在 operating[\s\S]*ENOTFOUND[\s\S]*cardigan maintenance continue/u,
  );
  expect(w.downloads()).toBe(1);
  const { on, row } = w.active();
  expect(on).toBe(true);
  expect(row?.phase).toBe("operating");
  expect(row?.record.error).toBeUndefined();
  expect(row?.record.blocked?.reason).toContain("没有可复用的预置目录");
  expect(w.notices.join("\n")).toContain("ENOTFOUND");
  expect(readlinkSync(w.link)).toBe(join(w.root, "old", "hc"));
  await runMaintenanceCommand(["status"], human, w.hooks);
  expect(human.out.at(-1)).toContain("未能继续");
  expect(human.out.at(-1)).toContain("恢复说明");
  w.goOnline();
  expect(await runMaintenanceCommand(["end"], human, w.hooks)).toBe(0);
  expect(w.downloads()).toBe(2);
  expect(w.active().row?.phase).toBe("completed");
  expect(w.active().row?.record.blocked).toBeUndefined();
  expect(readlinkSync(w.link)).toBe(join(w.root, "versions", "7.1.22", "hc"));
});
