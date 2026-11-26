import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapacityOverrideChange,
  changeCapacityOverride,
} from "@cardigan/domain";
import {
  persistCapacityOverrideEffect,
  readCapacityOverride,
  Store,
} from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import {
  capacityOverrideBase,
  withCapacityOverrides,
} from "./capacity-overrides.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";

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
const YAML = `machines:
  mac-mini:
    limit: 4
    max_limit: 6
    resources:
      godot: 1
      android.emulator: 2
    adb_slots:
      resources: [android.emulator]
      adb_port_base: 15037
      emulator_port_base: 5600
    projects:
      sensen:
        limit: 2
`;

async function setup(yaml = YAML) {
  const configDir = temp("capacity-config-");
  writeFileSync(join(configDir, "run-capacity.yaml"), yaml, { mode: 0o600 });
  const dataDir = temp("capacity-data-");
  const store = Store.open({ dataDir });
  const config = await loadRunCapacityConfig({ configDir, env: {} });
  return { store, config, dataDir };
}

function change(
  store: Store,
  config: Awaited<ReturnType<typeof loadRunCapacityConfig>>,
  input: CapacityOverrideChange,
) {
  return store.uow.run((tx) => {
    const result = changeCapacityOverride({ kind: "human" }, input, {
      machines: [{ id: "mac-mini" }],
      projects: ["cardigan", "sensen"],
      current: readCapacityOverride(store.database, input.machine_id),
      base: capacityOverrideBase(config, input.machine_id),
      member_id: "M-1",
      clock: { now: () => "2026-11-26T00:00:00.000Z" },
      ids: tx.global_ids,
    });
    if (!result.ok) throw new Error(result.error.message);
    persistCapacityOverrideEffect(
      store.database,
      tx,
      input.machine_id,
      result.value,
    );
  });
}

test("C-792: resource slots and project ceilings change live, without editing YAML or restarting", async () => {
  const { store, config, dataDir } = await setup();
  // The long-running server's view, built once at startup.
  const server = Store.open({ dataDir });
  const live = withCapacityOverrides(config, server.database);
  try {
    expect(Object.fromEntries(live.resourcesForMachine("mac-mini"))).toEqual({
      godot: 1,
      "android.emulator": 2,
    });
    expect(live.projectQuota("mac-mini", "sensen")).toEqual({
      limit: 2,
      resources: new Map(),
    });
    // A CLI process writes; the already-built server view sees it at once.
    change(store, config, {
      kind: "set_resource",
      machine_id: "mac-mini",
      key: "godot",
      slots: 3,
    });
    change(store, config, {
      kind: "set_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
      limit: 1,
      resources: { godot: 2 },
    });
    expect(Object.fromEntries(live.resourcesForMachine("mac-mini"))).toEqual({
      godot: 3,
      "android.emulator": 2,
    });
    expect(live.projectQuota("mac-mini", "sensen")).toEqual({
      limit: 1,
      resources: new Map([["godot", 2]]),
    });
    // Other projects and machines keep their YAML values.
    expect(live.projectQuota("mac-mini", "cardigan")).toBeUndefined();
    expect(live.resourcesForMachine("local").size).toBe(0);
    // The adb-bound resource stays YAML-only.
    expect(() =>
      change(store, config, {
        kind: "set_resource",
        machine_id: "mac-mini",
        key: "android.emulator",
        slots: 3,
      }),
    ).toThrow("run-capacity.yaml");
    change(store, config, {
      kind: "clear_project_quota",
      machine_id: "mac-mini",
      project_id: "sensen",
    });
    change(store, config, {
      kind: "clear_resource",
      machine_id: "mac-mini",
      key: "godot",
    });
    expect(readCapacityOverride(store.database, "mac-mini")).toBeUndefined();
    expect(live.resourcesForMachine("mac-mini").get("godot")).toBe(1);
    expect(live.projectQuota("mac-mini", "sensen")?.limit).toBe(2);
    expect(
      store.uow.read((tx) =>
        tx.global_events
          .listAfter(0)
          .filter((e) => e.type === "run_capacity_override_updated")
          .map((e) => (e.payload as { change: string }).change),
      ),
    ).toEqual([
      "set_resource",
      "set_project_quota",
      "clear_project_quota",
      "clear_resource",
    ]);
  } finally {
    server.close();
    store.close();
  }
});

test("C-792: invalid YAML still fails closed; an override cannot reopen the machine", async () => {
  const good = await setup();
  change(good.store, good.config, {
    kind: "set_resource",
    machine_id: "mac-mini",
    key: "godot",
    slots: 3,
  });
  good.store.close();
  const configDir = temp("capacity-config-");
  writeFileSync(join(configDir, "run-capacity.yaml"), "machines: [", {
    mode: 0o600,
  });
  const broken = await loadRunCapacityConfig({ configDir, env: {} });
  const store = Store.open({ dataDir: good.dataDir });
  try {
    const live = withCapacityOverrides(broken, store.database);
    expect(live.forMachine("mac-mini")).toBe(0);
    expect(live.resourcesForMachine("mac-mini").size).toBe(0);
    expect(capacityOverrideBase(broken, "mac-mini").valid).toBe(false);
  } finally {
    store.close();
  }
});
