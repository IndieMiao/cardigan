import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestDeploymentAction } from "@cardigan/domain";
import { manualUpgradeKey } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import type { TimerLoopOptions } from "./loop.js";
import { startMachineCapabilityLoop } from "./machine-capability-loop.js";
import type { MachineHost } from "./web/machine-host.js";

// Drive one real patrol tick to completion; no wall-clock sleeps or early aborts.
vi.mock("./loop.js", () => ({
  startTimerLoop: ({ tick }: TimerLoopOptions) => {
    const done = tick();
    return { done, stop: () => done };
  },
}));
const clock = { now: () => "2026-01-01T00:00:00.000Z" };
const project = "test",
  machine = "remote",
  binding = "current";
test.each([
  "success",
  "legacy",
  "mismatch",
  "worker failed",
  "machine failed",
  "rebound",
  "draining",
])("one patrol round: %s", async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "helper-patrol-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: project });
  const id = store.uow.run((tx) => {
    const local = tx.machines.get(project, "local");
    if (!local) throw new Error("fixture");
    tx.machines.put(project, {
      ...local,
      id: machine,
      label: machine,
      herdr_machine: machine,
      status: scenario === "draining" ? "draining" : "online",
    });
    const effect = unwrap(
      requestDeploymentAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        {
          key: manualUpgradeKey(machine),
          reason: "worker_maintenance",
          instructions: "private fixture path",
          ...(scenario === "legacy"
            ? {}
            : { helper_upgrade: { machine_id: machine, binding } }),
        },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data.id;
  });
  let liveBinding = binding;
  const passed = { status: "passed", failed_steps: [] } as const;
  const check = vi.fn<MachineHost["check"]>(
    async (p, m, kind, _progress, _signal, _job, confirmation) => {
      expect([p, m, confirmation?.binding]).toEqual([
        project,
        machine,
        binding,
      ]);
      if (kind === "machine" && scenario === "rebound") liveBinding = "other";
      if (scenario === `${kind} failed`)
        return { status: "failed", failed_steps: ["runtime"] };
      if (kind === "machine" && scenario === "draining")
        return {
          status: "failed",
          failed_steps: ["machine_not_ready"],
          maintenance: passed,
        };
      return passed;
    },
  );
  const patrolPassed = scenario !== "mismatch" && scenario !== "draining";
  const onError = vi.fn();
  const refreshMachine = vi.fn(async () => ({
    capabilities: [],
    health: {
      status: patrolPassed ? ("passed" as const) : ("failed" as const),
      available: patrolPassed,
      evidence_ref: "patrol",
      checked_at: clock.now(),
      blockers: patrolPassed
        ? []
        : [scenario === "draining" ? "machine_not_ready" : "helper mismatch"],
      launch_enabled: false,
    },
  }));
  const loop = startMachineCapabilityLoop({
    store,
    verification: {
      clock,
      host: {
        bindings: () => () => null,
        workerRecord: () => null,
        bindingFingerprint: () => liveBinding,
        check,
      },
    },
    runtime: { refreshMachine },
    onError,
  });
  try {
    const snapshot = () =>
      store.uow.read((tx) => tx.human_actions.get(project, id));
    await loop.done;
    expect(refreshMachine).toHaveBeenCalledTimes(2);
    if (["success", "legacy", "draining"].includes(scenario)) {
      expect(snapshot()).toMatchObject({
        status: "done",
        helper_checks: { at: clock.now(), worker: passed, machine: passed },
      });
      expect(snapshot()?.result?.text).toContain(
        "三个 helper 文件的 SHA-256 均与当前部署一致",
      );
    }
    expect(onError).not.toHaveBeenCalled();
    expect(check.mock.calls.map((c) => c[2])).toEqual(
      scenario === "mismatch" ? [] : ["worker", "machine"],
    );
    if (!["success", "legacy", "draining"].includes(scenario))
      expect(snapshot()?.status).toBe("open");
  } finally {
    await loop.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
