import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMachine } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { runCapacityCommand, runConfigCommand } from "./host-config.js";
import type { CliIo } from "./io.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}
function setup() {
  const dataDir = temp("cli-host-config-data-");
  const configDir = temp("cli-host-config-");
  const store = Store.open({ dataDir });
  store.createProject({ id: "cardigan" });
  store.createProject({ id: "sensen" });
  store.uow.run((tx) => {
    const effect = saveMachine(
      loadCommandState(tx, "cardigan"),
      { kind: "human", project_id: "cardigan" },
      {
        operation: "register",
        machine: {
          id: "mac-mini",
          label: "Mac mini",
          status: "online",
          herdr_machine: "mac-mini",
          os: "darwin",
          arch: "arm64",
          tags: [],
          max_assignments: 4,
          last_seen: "2026-11-26T00:00:00.000Z",
        },
      },
      { clock: { now: () => "2026-11-26T00:00:00.000Z" }, ids: tx.ids },
    );
    if (!effect.ok) throw new Error(effect.error.message);
    persistEffect(tx, "cardigan", effect.value);
  });
  store.close();
  const out: string[] = [];
  const io = (env: Record<string, string> = {}): CliIo => ({
    env: { CARDIGAN_DATA_DIR: dataDir, CARDIGAN_CONFIG_DIR: configDir, ...env },
    cwd: "/tmp",
    platform: "linux",
    stdout: (text) => {
      out.push(text);
    },
    stderr: vi.fn(),
    signals: { on: vi.fn(), off: vi.fn() },
    spawnInherit: vi.fn(),
    captureCommand: vi.fn(),
  });
  return { dataDir, configDir, out, io };
}

test("C-792: config check reports every file and fails on any invalid one", async () => {
  const s = setup();
  expect(await runConfigCommand(["check"], s.io())).toBe(0);
  expect(s.out.at(-1)).toBe(
    [
      "merge-gate.yaml：未配置（使用默认值）",
      "run-capacity.yaml：未配置（使用默认值）",
      "runtime-workers.yaml：未配置（使用默认值）",
    ].join("\n"),
  );
  writeFileSync(join(s.configDir, "merge-gate.yaml"), "projects: [", {
    mode: 0o600,
  });
  expect(await runConfigCommand(["check"], s.io())).toBe(1);
  expect(s.out.at(-1)).toContain(
    "merge-gate.yaml：无效\n  - merge-gate.yaml 语法无效，所有项目暂停合并",
  );
  // A candidate directory is checked before it replaces the real one.
  const candidate = temp("cli-host-config-candidate-");
  writeFileSync(join(candidate, "merge-gate.yaml"), "projects: {}\n", {
    mode: 0o600,
  });
  expect(
    await runConfigCommand(
      ["check", "--config-dir", candidate, "--json"],
      s.io(),
    ),
  ).toBe(0);
  expect(JSON.parse(s.out.at(-1) as string)).toMatchObject({
    ok: true,
    files: [
      { file: "merge-gate.yaml", status: "ok" },
      { file: "run-capacity.yaml", status: "missing" },
      { file: "runtime-workers.yaml", status: "missing" },
    ],
  });
  await expect(
    runConfigCommand(["check"], s.io({ CARDIGAN_TOKEN: "x" })),
  ).rejects.toThrow("Token");
});

test("C-792: capacity writes are human-only, live, and keep adb-bound resources in YAML", async () => {
  const s = setup();
  writeFileSync(
    join(s.configDir, "run-capacity.yaml"),
    `machines:
  mac-mini:
    limit: 4
    resources:
      godot: 1
      android.emulator: 1
    adb_slots:
      resources: [android.emulator]
      adb_port_base: 15037
      emulator_port_base: 5600
`,
    { mode: 0o600 },
  );
  await expect(
    runCapacityCommand(
      ["resource", "mac-mini", "godot", "2"],
      s.io({ CARDIGAN_TOKEN: "x" }),
    ),
  ).rejects.toThrow("Token");
  expect(
    await runCapacityCommand(["resource", "mac-mini", "godot", "2"], s.io()),
  ).toBe(0);
  expect(
    await runCapacityCommand(
      ["quota", "mac-mini", "sensen", "--limit", "1", "--resource", "godot=1"],
      s.io(),
    ),
  ).toBe(0);
  expect(await runCapacityCommand(["show", "mac-mini"], s.io())).toBe(0);
  expect(JSON.parse(s.out.at(-1) as string)).toMatchObject({
    yaml_resources: { godot: 1, "android.emulator": 1 },
    effective_resources: { godot: 2, "android.emulator": 1 },
    override: {
      resources: { godot: 2 },
      projects: { sensen: { limit: 1, resources: { godot: 1 } } },
    },
    yaml_only_resources: ["android.emulator"],
  });
  await expect(
    runCapacityCommand(
      ["resource", "mac-mini", "android.emulator", "2"],
      s.io(),
    ),
  ).rejects.toThrow("run-capacity.yaml");
  await expect(
    runCapacityCommand(["quota", "mac-mini", "ghost", "--limit", "1"], s.io()),
  ).rejects.toThrow("项目未登记");
  expect(
    await runCapacityCommand(
      ["quota", "mac-mini", "sensen", "--clear"],
      s.io(),
    ),
  ).toBe(0);
  expect(
    await runCapacityCommand(
      ["resource", "mac-mini", "godot", "--clear"],
      s.io(),
    ),
  ).toBe(0);
  expect(JSON.parse(s.out.at(-1) as string)).toEqual({
    machine_id: "mac-mini",
    override: null,
  });
  writeFileSync(join(s.configDir, "run-capacity.yaml"), "machines: [", {
    mode: 0o600,
  });
  await expect(
    runCapacityCommand(["resource", "mac-mini", "godot", "2"], s.io()),
  ).rejects.toThrow("并发配置无效");
});
