import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_PRESENCE_INTERVAL_MS,
  DeviceRegistry,
  MACHINE_CAPABILITY_INTERVAL_MS,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  DEVICE_INIT_FOLLOWUP_MS,
  startMachineCapabilityLoop,
} from "./machine-capability-loop.js";

test("patrol refreshes each project immediately and every 30 minutes, tolerates failure and drains on stop", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "capability-loop-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: "a" });
  store.createProject({ id: "b" });
  const refreshMachine = vi
    .fn(
      async (
        _project: string,
        _machine: string,
        _options?: { signal?: AbortSignal },
      ) => ({ capabilities: [], health: null }),
    )
    .mockRejectedValueOnce(new Error("private-error"));
  const onError = vi.fn();
  const loop = startMachineCapabilityLoop({
    store,
    runtime: { refreshMachine },
    onError,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshMachine.mock.calls).toEqual([
      ["a", "local", { signal: expect.any(AbortSignal) }],
      ["b", "local", { signal: expect.any(AbortSignal) }],
    ]);
    expect(onError).toHaveBeenCalledWith(
      new Error("Machine capability refresh failed"),
    );
    await vi.advanceTimersByTimeAsync(MACHINE_CAPABILITY_INTERVAL_MS - 1);
    expect(refreshMachine).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshMachine).toHaveBeenCalledTimes(4);
    let stopped = false;
    refreshMachine.mockImplementationOnce(
      async (_project, _machine, options) => {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              stopped = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { capabilities: [], health: null };
      },
    );
    await vi.advanceTimersByTimeAsync(MACHINE_CAPABILITY_INTERVAL_MS);
    expect(refreshMachine).toHaveBeenCalledTimes(5);
    await loop.stop();
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(MACHINE_CAPABILITY_INTERVAL_MS);
    expect(refreshMachine).toHaveBeenCalledTimes(5);
  } finally {
    await loop.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

test("C-666: worker usage is read after a passing check of a remote binding only; its failure stays in the patrol", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "capability-usage-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: "a" });
  const remote = (id: string) => ({
    id,
    label: id,
    herdr_machine: id,
    os: "darwin" as const,
    arch: "arm64",
    tags: [],
    max_assignments: 4,
    status: "online" as const,
    last_seen: null,
  });
  store.uow.run((tx) => {
    tx.machines.put("a", remote("mac-mini"));
    tx.machines.put("a", remote("broken"));
  });
  const health = (available: boolean) => ({
    capabilities: [],
    health: {
      status: available ? ("passed" as const) : ("failed" as const),
      checked_at: "2026-11-25T00:00:00.000Z",
      blockers: available ? [] : ["worker_unreachable"],
      launch_enabled: available,
      evidence_ref: "machine-observation:x",
      available,
    },
  });
  const refreshMachine = vi.fn(async (_project: string, machine: string) =>
    health(machine !== "broken"),
  );
  const usage = vi.fn(async () => {
    throw new Error("private-ssh-detail");
  });
  const onError = vi.fn();
  const loop = startMachineCapabilityLoop({
    store,
    runtime: { refreshMachine } as never,
    usage,
    onError,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshMachine).toHaveBeenCalledTimes(3);
    expect(usage.mock.calls).toEqual([["a", "mac-mini"]]);
    expect(onError.mock.calls).toEqual([
      [new Error("Worker usage observation failed")],
    ]);
  } finally {
    await loop.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

test("C-817: a device a person enabled is initialized by its project's check within a minute", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "capability-device-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: "a" });
  store.createProject({ id: "b" });
  const refreshMachine = vi.fn(
    async (
      _project: string,
      _machine: string,
      _options?: { signal?: AbortSignal },
    ) => ({ capabilities: [], health: null }),
  );
  const loop = startMachineCapabilityLoop({
    store,
    runtime: { refreshMachine },
    onError: vi.fn(),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    refreshMachine.mockClear();
    // Nothing to initialize: the follow-up checks nothing.
    await vi.advanceTimersByTimeAsync(DEVICE_INIT_FOLLOWUP_MS);
    expect(refreshMachine).not.toHaveBeenCalled();
    const registry = new DeviceRegistry(store);
    const now = new Date().toISOString();
    registry.discover(
      "local",
      { type: "android.device", id: "S1", state: "available" },
      now,
    );
    registry.request({
      machine: "local",
      type: "android.device",
      id: "S1",
      request: "enable",
      projects: ["b"],
      now,
    });
    await vi.advanceTimersByTimeAsync(DEVICE_INIT_FOLLOWUP_MS);
    expect(refreshMachine.mock.calls).toEqual([
      ["b", "local", { signal: expect.any(AbortSignal) }],
    ]);
    // Claimed by a running check: not checked again until the claim is stale.
    registry.claimInit(
      "local",
      "android.device",
      "S1",
      "b",
      new Date().toISOString(),
    );
    refreshMachine.mockClear();
    await vi.advanceTimersByTimeAsync(DEVICE_INIT_FOLLOWUP_MS);
    expect(refreshMachine).not.toHaveBeenCalled();
  } finally {
    await loop.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

test("C-841: device presence is checked for every project's machines each minute between patrols, after the patrol and never at once with it", async () => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "capability-presence-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: "a" });
  store.createProject({ id: "b" });
  let patrolling = false;
  const refreshMachine = vi.fn(async () => {
    patrolling = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    patrolling = false;
    return { capabilities: [], health: null };
  });
  const overlapped = vi.fn();
  const refreshDevicePresence = vi.fn(
    async (
      _project: string,
      _machine: string,
      _options?: { signal?: AbortSignal },
    ) => {
      if (patrolling) overlapped();
      return { checked: 1, recorded: true, changed: false };
    },
  );
  refreshDevicePresence.mockRejectedValueOnce(new Error("private-ssh"));
  const onError = vi.fn();
  const loop = startMachineCapabilityLoop({
    store,
    runtime: { refreshMachine, refreshDevicePresence } as never,
    onError,
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshMachine).toHaveBeenCalledTimes(2);
    expect(refreshDevicePresence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEVICE_PRESENCE_INTERVAL_MS);
    expect(refreshDevicePresence.mock.calls).toEqual([
      ["a", "local", { signal: expect.any(AbortSignal) }],
      ["b", "local", { signal: expect.any(AbortSignal) }],
    ]);
    // One failure is reported without its detail; the other project is still checked.
    expect(onError.mock.calls).toEqual([
      [new Error("Device presence check failed")],
    ]);
    await vi.advanceTimersByTimeAsync(DEVICE_PRESENCE_INTERVAL_MS);
    expect(refreshDevicePresence).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(MACHINE_CAPABILITY_INTERVAL_MS);
    expect(overlapped).not.toHaveBeenCalled();
  } finally {
    await loop.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  }
});
