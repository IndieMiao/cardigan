import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MACHINE_CAPABILITY_INTERVAL_MS } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { startMachineCapabilityLoop } from "./machine-capability-loop.js";

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
