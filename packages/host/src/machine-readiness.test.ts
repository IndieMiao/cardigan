import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { type MachineReadiness, Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import {
  assignment,
  now,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { AGENT_TOOLS_CAPABILITY } from "./agent-tools.js";
import { refreshMachineObservations } from "./machine-capabilities.js";
import {
  CLEANUP_SCRIPT,
  observeReadiness,
  READINESS_SCRIPT,
  RELEASED_GRACE_MS,
  type ReadinessRunner,
  recordReadiness,
  runScriptProcess,
  THROUGHPUT_SCRIPT,
} from "./machine-readiness.js";
import {
  DEFAULT_READINESS_CONFIG,
  parseReadinessConfig,
  type ReadinessConfig,
} from "./machine-readiness-config.js";
import { digestMismatch } from "./worker-helper-release.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "machine-readiness-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const path of [join(root, "denied"), join(root, "locked")])
      if (existsSync(path)) chmodSync(path, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
const GIB = 1024 ** 3;
const project = "sample",
  machine = "worker-a";
const execution: Extract<ExecutionConfig, { mode: "agent-ssh" }> = {
  mode: "agent-ssh",
  dataDir: "/fixture",
  agentRoot: "/workers/sample",
  machine,
  gid: 2201,
  identityFile: "/test/identity",
  knownHostsFile: "/test/hosts",
  mcp: { url: "https://control.example.ts.net:8443/mcp", timeoutMs: 10000 },
};
const later = new Date(Date.parse(now) + RELEASED_GRACE_MS * 2).toISOString();
function fixtureStore() {
  const store = Store.open({ dbPath: ":memory:" });
  store.createProject({ id: project });
  return store;
}
const ok = { blockers: [], capability_failures: [] };
function runner(
  answers: Partial<
    Record<
      "readiness" | "throughput" | "cleanup",
      unknown | ((request: Record<string, unknown>) => unknown)
    >
  >,
) {
  return vi.fn<ReadinessRunner>(async (_execution, script, request) => {
    const answer = answers[script];
    if (answer === undefined) throw new Error("probe failed");
    return typeof answer === "function" ? answer(request) : answer;
  });
}
const healthy = {
  disk: { free: 100 * GIB, total: 500 * GIB },
  rtt_ms: 40,
  avds: {},
  simulators: {},
};
const fast = { bytes: 4 * 1024 * 1024, seconds: 0.25, complete: true };
const config =
  (overrides: Partial<ReadinessConfig> = {}, invalid = false) =>
  () => ({ config: { ...DEFAULT_READINESS_CONFIG, ...overrides }, invalid });
const observe = (
  store: Store,
  run: ReadinessRunner,
  overrides: Partial<Parameters<typeof observeReadiness>[0]> = {},
) =>
  observeReadiness({
    store,
    project,
    machine,
    os: "darwin",
    execution,
    health: ok,
    capabilities: [AGENT_TOOLS_CAPABILITY],
    now: () => later,
    config: config(),
    run,
    ...overrides,
  });
const item = (r: MachineReadiness, key: string) =>
  r.items.find((i) => i.key === key);

test("configuration: defaults, explicit values and fail-closed parsing", () => {
  expect(parseReadinessConfig(undefined)).toBe(DEFAULT_READINESS_CONFIG);
  expect(DEFAULT_READINESS_CONFIG).toMatchObject({
    disk_min_free_bytes: 20 * GIB,
    min_throughput_bytes_per_s: 2_000_000,
    max_rtt_ms: 500,
  });
  expect(
    parseReadinessConfig({
      version: 1,
      disk_min_free_gib: 30,
      network: { min_throughput_mb_s: 5, max_rtt_ms: 200, payload_mib: 1 },
      projects: {
        "sensen-godot": {
          android_avds: ["Pixel_7_API_34"],
          ios_simulators: ["iPhone 15"],
        },
      },
    }),
  ).toEqual({
    disk_min_free_bytes: 30 * GIB,
    min_throughput_bytes_per_s: 5_000_000,
    max_rtt_ms: 200,
    payload_bytes: 1024 * 1024,
    projects: {
      "sensen-godot": {
        android_avds: ["Pixel_7_API_34"],
        ios_simulators: ["iPhone 15"],
      },
    },
  });
  for (const bad of [
    { version: 2 },
    { version: 1, other: true },
    { version: 1, disk_min_free_gib: -1 },
    { version: 1, network: { max_rtt_ms: "fast" } },
    { version: 1, projects: { "../x": {} } },
    { version: 1, projects: { p: { android_avds: ["a/b"] } } },
    { version: 1, projects: { p: { android_avds: "Pixel" } } },
  ])
    expect(() => parseReadinessConfig(bad)).toThrow(
      "Machine readiness configuration invalid",
    );
});

test("a healthy worker reports every item without repairs or alerts", async () => {
  const store = fixtureStore();
  const probe = runner({ readiness: healthy, throughput: fast });
  const { readiness, repaired } = await observe(store, probe);
  expect(repaired).toBeUndefined();
  expect(readiness.items).toEqual([
    { key: "disk", status: "ok", detail: "可用 100.0 GiB" },
    { key: "network", status: "ok", detail: "下行 16.8 MB/s，往返 40 ms" },
    { key: "mcp", status: "ok", detail: "Card MCP 可达" },
    { key: "helper", status: "ok", detail: "与当前部署一致" },
    { key: "agent_tools", status: "ok", detail: "附件助手就绪" },
  ]);
  expect(readiness.metrics).toEqual({
    disk_free_bytes: 100 * GIB,
    rtt_ms: 40,
    throughput_bytes_per_s: 16777216,
  });
  // The probe targets the MCP host and the worker root, never a project path.
  expect(probe.mock.calls[0]?.[2]).toMatchObject({
    root: "/workers/sample",
    mcp: { host: "control.example.ts.net", port: 8443 },
    avds: [],
    simulators: [],
  });
  expect(probe.mock.calls[1]?.[3]).toMatchObject({ payload: 4 * 1024 * 1024 });
  expect(probe).toHaveBeenCalledTimes(2);
});

test("low disk is cleaned first; account caches only while this project is idle", async () => {
  const store = fixtureStore();
  const old = { released_at: now, status: "released" as const };
  store.uow.run((tx) => {
    tx.assignments.put(project, {
      ...assignment(1),
      ...old,
      machine_id: machine,
    });
    // Released recently, with a Run still pending, or on another machine: kept.
    tx.assignments.put(project, {
      ...assignment(2),
      status: "released",
      released_at: later,
      machine_id: machine,
    });
    tx.assignments.put(project, {
      ...assignment(3),
      ...old,
      machine_id: machine,
    });
    tx.runs.put(project, { ...run(3, 3), status: "queued" });
    tx.assignments.put(project, {
      ...assignment(4),
      ...old,
      machine_id: "other",
    });
    tx.assignments.put(project, { ...assignment(5), machine_id: machine });
  });
  const cleanup = vi.fn((request: Record<string, unknown>) => ({
    before: 10 * GIB,
    after: 25 * GIB,
    removed: 3,
    request,
  }));
  const low = { ...healthy, disk: { free: 10 * GIB, total: 500 * GIB } };
  const probe = runner({ readiness: low, throughput: fast, cleanup });
  const first = await observe(store, probe);
  expect(cleanup).toHaveBeenCalledWith({
    root: "/workers/sample",
    project,
    assignments: ["A-1"],
    account_caches: true,
  });
  expect(item(first.readiness, "disk")).toEqual({
    key: "disk",
    status: "repaired",
    detail: "已自动清理 3 处缓存，释放 15.0 GiB，可用 25.0 GiB",
  });
  expect(first.repaired).toEqual({ freed_bytes: 15 * GIB, removed: 3 });

  // A Run of this project occupies the machine: keep account caches, still too low.
  store.uow.run((tx) =>
    tx.runs.put(project, { ...run(5, 5), status: "running" }),
  );
  cleanup.mockReturnValue({
    before: 10 * GIB,
    after: 12 * GIB,
    removed: 1,
    request: {},
  });
  const second = await observe(store, probe);
  expect(cleanup.mock.lastCall?.[0]).toMatchObject({ account_caches: false });
  expect(item(second.readiness, "disk")).toEqual({
    key: "disk",
    status: "warning",
    detail:
      "可用 12.0 GiB，低于 20.0 GiB；已自动清理 1 处缓存，释放 2.0 GiB（有任务在跑，账号级缓存留到空闲时清）",
  });
});

test("a slow link is a named warning; an unreachable MCP is the only failure", async () => {
  const store = fixtureStore();
  const slow = runner({
    readiness: { ...healthy, rtt_ms: 820 },
    throughput: { bytes: 4 * 1024 * 1024, seconds: 7, complete: true },
  });
  const r = (
    await observe(store, slow, {
      health: { blockers: ["mcp_timeout"], capability_failures: [] },
    })
  ).readiness;
  const link = "链路慢：下行 0.6 MB/s，往返 820 ms（阈值 2.0 MB/s、500 ms）";
  expect(item(r, "network")).toEqual({
    key: "network",
    status: "warning",
    detail: link,
  });
  expect(item(r, "mcp")).toEqual({
    key: "mcp",
    status: "failed",
    detail: `Card MCP 不可达（mcp_timeout），暂停向该机器派发；${link}`,
  });
  // A download that never completes is slow too, and RTT alone can trigger it.
  const stalled = runner({ readiness: healthy });
  expect(item((await observe(store, stalled)).readiness, "network")).toEqual({
    key: "network",
    status: "warning",
    detail: "链路慢：下行测速未完成，往返 40 ms（阈值 2.0 MB/s、500 ms）",
  });
  const none = runner({});
  expect(item((await observe(store, none)).readiness, "network")).toEqual({
    key: "network",
    status: "unknown",
    detail: "链路未能测量",
  });
});

test("helper, attachment tools, AVD, simulator and configuration findings stay warnings", async () => {
  const store = fixtureStore();
  const probe = runner({
    readiness: {
      ...healthy,
      avds: { Pixel_7: "unreadable", Tablet: "missing", Phone: "ok" },
      simulators: { "iPhone 15": "missing" },
    },
    throughput: fast,
  });
  const r = (
    await observe(store, probe, {
      health: {
        blockers: [],
        warnings: [digestMismatch],
        capability_failures: [
          {
            key: AGENT_TOOLS_CAPABILITY,
            search_locations: [],
            reason: "附件助手 download-attachment.mjs 缺失",
          },
        ],
      },
      capabilities: [],
      config: config(
        {
          projects: {
            [project]: {
              android_avds: ["Pixel_7", "Tablet", "Phone"],
              ios_simulators: ["iPhone 15"],
            },
          },
        },
        true,
      ),
    })
  ).readiness;
  expect(probe.mock.calls[0]?.[2]).toMatchObject({
    avds: ["Pixel_7", "Tablet", "Phone"],
    simulators: ["iPhone 15"],
  });
  expect(r.items.filter((i) => i.status !== "ok")).toEqual([
    {
      key: "helper",
      status: "warning",
      detail: `${digestMismatch}；协议兼容，继续派发并自动升级`,
    },
    {
      key: "agent_tools",
      status: "warning",
      detail: "附件助手 download-attachment.mjs 缺失",
    },
    {
      key: "avd:Pixel_7",
      status: "warning",
      detail: "AVD 文件无法读取（检查外接盘与系统隐私权限）",
    },
    { key: "avd:Tablet", status: "warning", detail: "AVD 不存在" },
    {
      key: "simulator:iPhone 15",
      status: "warning",
      detail: "模拟器设备不存在或不可用",
    },
    {
      key: "config",
      status: "warning",
      detail: "就绪巡检配置无效，已按默认值检查",
    },
  ]);
  // Simulators are only declared on macOS workers.
  const linux = runner({ readiness: healthy, throughput: fast });
  await observe(store, linux, {
    os: "linux",
    config: config({
      projects: {
        [project]: { android_avds: [], ios_simulators: ["iPhone 15"] },
      },
    }),
  });
  expect(linux.mock.calls[0]?.[2]).toMatchObject({ simulators: [] });
});

test("the control host's own account checks disk only", async () => {
  const store = fixtureStore();
  const probe = runner({ readiness: healthy });
  const r = (await observe(store, probe, { machine: "local" })).readiness;
  expect(r.items.map((i) => i.key)).toEqual(["disk", "agent_tools"]);
  expect(probe).toHaveBeenCalledOnce();
  expect(probe.mock.calls[0]?.[2]).not.toHaveProperty("mcp");
});

test("timeline records changes and repairs; host ops hears about each new problem once", () => {
  const store = fixtureStore();
  const at = (items: MachineReadiness["items"]): MachineReadiness => ({
    checked_at: later,
    items,
  });
  const record = (
    previous: MachineReadiness | undefined,
    items: MachineReadiness["items"],
    repaired?: { freed_bytes: number; removed: number },
  ) =>
    store.uow.run((tx) =>
      recordReadiness(
        tx,
        project,
        machine,
        previous,
        { readiness: at(items), ...(repaired ? { repaired } : {}) },
        later,
      ),
    );
  const events = () =>
    store.uow
      .read((tx) => tx.events.listAfter(project, undefined, 0))
      .filter((e) => e.type.startsWith("machine_readiness_"));
  const actions = () => store.uow.read((tx) => tx.human_actions.list(project));
  const slow = {
    key: "network",
    status: "warning" as const,
    detail: "链路慢：下行 0.6 MB/s",
  };
  const helper = {
    key: "helper",
    status: "warning" as const,
    detail: digestMismatch,
  };
  const disk = { key: "disk", status: "ok" as const, detail: "可用 50.0 GiB" };
  record(undefined, [disk, slow, helper], { freed_bytes: GIB, removed: 2 });
  expect(events().map((e) => [e.type, e.payload])).toEqual([
    [
      "machine_readiness_repaired",
      { machine_id: machine, key: "disk", freed_bytes: GIB, removed: 2 },
    ],
    [
      "machine_readiness_changed",
      { machine_id: machine, items: [disk, slow, helper] },
    ],
  ]);
  // Helper drift already has its own upgrade task.
  expect(actions()).toMatchObject([
    {
      triage: "host",
      host_operator: "host_ops",
      blocked_work_items: [],
      instructions: `项目 ${project} 的机器 ${machine} 就绪巡检：链路慢：下行 0.6 MB/s。系统已继续派发能做的任务，处理后等待下次巡检确认。`,
    },
  ]);
  const unchanged = at([disk, slow, helper]);
  record(unchanged, [disk, slow, helper]);
  expect(events()).toHaveLength(2);
  expect(actions()).toHaveLength(1);
  const mcp = {
    key: "mcp",
    status: "failed" as const,
    detail: "Card MCP 不可达（mcp_timeout），暂停向该机器派发",
  };
  record(unchanged, [disk, slow, helper, mcp]);
  expect(events()).toHaveLength(3);
  expect(actions()).toHaveLength(2);
  expect(actions()[1]?.instructions).not.toContain("继续派发");
});

test("refreshMachineObservations stores readiness with the health and never lets it fail the check", async () => {
  const store = fixtureStore();
  store.uow.run((tx) => {
    const local = tx.machines.get(project, "local");
    if (!local) throw new Error("fixture machine missing");
    tx.machines.put(project, {
      ...local,
      id: machine,
      label: "Worker A",
      herdr_machine: machine,
    });
  });
  const registered = store.uow.read((tx) => tx.machines.get(project, machine));
  if (!registered) throw new Error("fixture machine missing");
  const readiness = vi.fn(async () => ({
    readiness: at([{ key: "disk", status: "warning", detail: "可用 1.0 GiB" }]),
  }));
  const at = (items: MachineReadiness["items"]): MachineReadiness => ({
    checked_at: later,
    items,
  });
  const options = {
    store,
    project,
    machine,
    target: () => ({ machine: registered, execution }),
    check: async () => ({
      blockers: [digestMismatch],
      launch_enabled: false,
    }),
    catalog: () => [],
    readiness,
  };
  const observed = await refreshMachineObservations(options);
  expect(observed.health).toMatchObject({
    status: "passed",
    available: true,
    blockers: [],
    warnings: [digestMismatch],
    readiness: at([{ key: "disk", status: "warning", detail: "可用 1.0 GiB" }]),
  });
  expect(readiness.mock.calls[0]?.[0]).toMatchObject({
    os: registered.os,
    health: { blockers: [], warnings: [digestMismatch] },
  });
  readiness.mockRejectedValueOnce(new Error("probe crashed"));
  const again = await refreshMachineObservations(options);
  expect(again.health).toMatchObject({ status: "passed", available: true });
  expect(again.health).not.toHaveProperty("readiness");
  // An unreachable worker is not probed again for readiness.
  readiness.mockClear();
  await refreshMachineObservations({
    ...options,
    check: async () => ({
      blockers: ["worker_unreachable"],
      launch_enabled: false,
    }),
  });
  expect(readiness).not.toHaveBeenCalled();
});

// The fixed scripts run as the worker account; exercise them with this account.
const python = (script: string, request: unknown, prelude = "") => ({
  file: "python3",
  args: ["-I", "-B", "-c", `${prelude}\n${script}`, JSON.stringify(request)],
});

test("readiness script: disk, TCP round trip, readable and unreadable AVDs", async () => {
  const root = temp();
  const avd = join(root, "avd");
  mkdirSync(join(avd, "Phone.avd"), { recursive: true });
  writeFileSync(join(avd, "Phone.ini"), `path=${join(avd, "Phone.avd")}\n`);
  writeFileSync(join(avd, "Phone.avd", "config.ini"), "hw=1\n");
  writeFileSync(join(avd, "Phone.avd", "userdata-qemu.img"), "x");
  // An AVD on a disk the account may not read (macOS privacy denial).
  const denied = join(root, "denied");
  mkdirSync(denied);
  writeFileSync(join(avd, "Locked.ini"), `path=${denied}\n`);
  chmodSync(denied, 0o000);
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await runScriptProcess(
      python(READINESS_SCRIPT, {
        root,
        env: { ANDROID_AVD_HOME: avd },
        mcp: { host: "127.0.0.1", port },
        avds: ["Phone", "Locked", "Missing"],
        simulators: [],
      }),
      { timeoutMs: 20000 },
    );
    expect(result).toMatchObject({
      disk: { free: expect.any(Number), total: expect.any(Number) },
      rtt_ms: expect.any(Number),
      avds: {
        Phone: "ok",
        Locked: process.getuid?.() === 0 ? "ok" : "unreadable",
        Missing: "missing",
      },
      simulators: {},
    });
  } finally {
    server.close();
  }
});

test("throughput script times only the bytes sent after the worker is ready", async () => {
  const result = (await runScriptProcess(
    python(THROUGHPUT_SCRIPT, { bytes: 1024 * 1024 }),
    { timeoutMs: 20000, payload: 1024 * 1024 },
  )) as { bytes: number; seconds: number; complete: boolean };
  expect(result.complete).toBe(true);
  expect(result.bytes).toBeLessThanOrEqual(1024 * 1024);
  expect(result.seconds).toBeGreaterThanOrEqual(0);
  // Fewer bytes than announced: never reported as a completed measurement.
  expect(
    await runScriptProcess(python(THROUGHPUT_SCRIPT, { bytes: 4096 }), {
      timeoutMs: 20000,
      payload: 1024,
    }),
  ).toMatchObject({ complete: false });
  await expect(
    runScriptProcess(python("import time\ntime.sleep(5)", {}), {
      timeoutMs: 200,
    }),
  ).rejects.toThrow("readiness_timeout");
});

test("cleanup script removes only owned spare directories and keeps sessions", async () => {
  const root = temp();
  const home = join(root, "home");
  const runs = join(root, "runs", project);
  for (const a of ["A-1", "A-2"])
    for (const kind of ["cache", "generations", "temporary", "sessions"]) {
      mkdirSync(join(runs, a, kind, "nested"), { recursive: true });
      writeFileSync(join(runs, a, kind, "nested", "file"), "x");
    }
  // Read-only directories (Go module caches) are still removable.
  chmodSync(join(runs, "A-1", "cache", "nested"), 0o500);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "x");
  mkdirSync(join(runs, "A-3"), { recursive: true });
  symlinkSync(outside, join(runs, "A-3", "cache"));
  symlinkSync(outside, join(runs, "A-4"));
  const derived = join(home, "Library/Developer/Xcode/DerivedData");
  mkdirSync(join(derived, "App-abc"), { recursive: true });
  mkdirSync(join(home, ".npm/_cacache"), { recursive: true });
  // Point the account's home at the fixture; the script itself never takes a path for it.
  const prelude = `import pwd\n_real = pwd.getpwuid\npwd.getpwuid = lambda uid: type('P', (), dict(pw_dir=${JSON.stringify(home)}, pw_name=_real(uid).pw_name))()`;
  const result = (await runScriptProcess(
    python(
      CLEANUP_SCRIPT,
      {
        root,
        project,
        assignments: ["A-1", "A-3", "A-4", "../x"],
        account_caches: true,
      },
      prelude,
    ),
    { timeoutMs: 20000 },
  )) as Record<string, number>;
  expect(result).toMatchObject({
    before: expect.any(Number),
    after: expect.any(Number),
    failed: 1,
  });
  for (const kind of ["cache", "generations", "temporary"])
    expect(existsSync(join(runs, "A-1", kind))).toBe(false);
  expect(existsSync(join(runs, "A-1", "sessions", "nested", "file"))).toBe(
    true,
  );
  expect(existsSync(join(runs, "A-2", "cache", "nested", "file"))).toBe(true);
  expect(existsSync(join(outside, "keep"))).toBe(true);
  expect(existsSync(join(runs, "A-3", "cache"))).toBe(true);
  if (process.platform === "darwin") {
    expect(existsSync(derived)).toBe(true);
    expect(existsSync(join(derived, "App-abc"))).toBe(false);
  }
  expect(existsSync(join(home, ".npm/_cacache"))).toBe(false);
});
