import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HumanActionId, requestDeploymentAction } from "@cardigan/domain";
import {
  MACHINE_CAPABILITY_INTERVAL_MS,
  manualUpgradeKey,
} from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  HELPER_SIBLING_FOLLOWUP_MS,
  startMachineCapabilityLoop,
} from "./machine-capability-loop.js";
import type { MachineHost } from "./web/machine-host.js";

const lookup = vi.hoisted(() => ({ fails: false }));
vi.mock("./reconcile-helper-actions.js", async (original) => {
  const actual =
    await original<typeof import("./reconcile-helper-actions.js")>();
  return {
    ...actual,
    siblingHelperConfirmedAt: (
      ...args: Parameters<typeof actual.siblingHelperConfirmedAt>
    ) => {
      if (lookup.fails) throw new Error("private lookup failure");
      return actual.siblingHelperConfirmedAt(...args);
    },
  };
});

// One physical machine registered by two projects (C-764).
const machine = "shared";
const passed = { status: "passed", failed_steps: [] } as const;
const clock = { now: () => new Date().toISOString() };
// Helper confirmation locks are real files: wait on real time for them.
const realSetTimeout = globalThis.setTimeout;
let progress = () => "";
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  let last = "",
    stable = 0;
  for (let i = 0; i < 400 && stable < 5; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    await vi.advanceTimersByTimeAsync(0);
    const now = progress();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}
let root: string;
let store: Store;
beforeEach(() => {
  vi.useFakeTimers({
    now: Date.parse("2026-11-26T03:00:00.000Z"),
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
  lookup.fails = false;
  root = mkdtempSync(join(tmpdir(), "helper-sibling-"));
  store = Store.open({ dataDir: root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function register(project: string, open = true) {
  store.createProject({ id: project });
  return store.uow.run((tx) => {
    const local = tx.machines.get(project, "local");
    if (!local) throw new Error("fixture");
    tx.machines.put(project, {
      ...local,
      id: machine,
      label: machine,
      herdr_machine: machine,
      status: "online",
    });
    if (!open) return undefined;
    const effect = unwrap(
      requestDeploymentAction(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        {
          key: manualUpgradeKey(machine),
          reason: "worker_maintenance",
          instructions: "private fixture path",
          helper_upgrade: {
            machine_id: machine,
            binding: `binding-${project}`,
          },
        },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data.id;
  });
}

/** Each project's helper files are judged on that project's own binding. */
function start(consistent: Record<string, boolean>) {
  const check = vi.fn<MachineHost["check"]>(
    async (project, m, kind, _progress, _signal, _job, confirmation) => {
      expect([m, confirmation?.binding]).toEqual([
        machine,
        `binding-${project}`,
      ]);
      return kind === "worker" && !consistent[project]
        ? { status: "failed", failed_steps: ["helpers"] }
        : passed;
    },
  );
  const refreshMachine = vi.fn(async () => ({
    capabilities: [],
    health: {
      status: "passed" as const,
      available: true,
      evidence_ref: "patrol",
      checked_at: clock.now(),
      blockers: [],
      launch_enabled: false,
    },
  }));
  const onError = vi.fn();
  const loop = startMachineCapabilityLoop({
    store,
    verification: {
      clock,
      host: {
        bindings: () => () => null,
        workerRecord: () => null,
        bindingFingerprint: (project) => `binding-${project}`,
        check,
      },
    },
    runtime: { refreshMachine },
    onError,
  });
  progress = () =>
    JSON.stringify([
      check.mock.calls.length,
      check.mock.results.map((r) => r.type),
      refreshMachine.mock.calls.length,
      store.uow.read((tx) =>
        store
          .listProjects()
          .flatMap((p) => tx.human_actions.list(p.id).map((h) => h.status)),
      ),
    ]);
  const workerChecks = (project: string) =>
    check.mock.calls.filter((c) => c[0] === project && c[2] === "worker")
      .length;
  return { loop, check, onError, workerChecks };
}
const status = (project: string, id: HumanActionId | undefined) =>
  store.uow.read((tx) => (id ? tx.human_actions.get(project, id) : undefined));

test("a sibling confirmation gives the other project its own recheck within a minute", async () => {
  const a = register("a"),
    b = register("b");
  const consistent = { a: true, b: false };
  const { loop, onError, workerChecks } = start(consistent);
  try {
    await advance(0);
    expect(status("a", a)).toMatchObject({ status: "done" });
    expect(status("b", b)).toMatchObject({ status: "open" });
    expect(workerChecks("b")).toBe(1);
    // B's own files are rewritten after its patrol already failed.
    consistent.b = true;
    await advance(HELPER_SIBLING_FOLLOWUP_MS);
    expect(workerChecks("b")).toBe(2);
    expect(workerChecks("a")).toBe(1);
    expect(status("b", b)).toMatchObject({
      status: "done",
      helper_checks: { worker: passed, machine: passed },
    });
    expect(HELPER_SIBLING_FOLLOWUP_MS).toBeLessThan(
      MACHINE_CAPABILITY_INTERVAL_MS / 10,
    );
    // Nothing left to follow up: no further checks before the next patrol.
    await advance(20 * HELPER_SIBLING_FOLLOWUP_MS);
    expect(workerChecks("b")).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await loop.stop();
  }
});

test("the other project's open confirmation stays open while its own files differ; follow-ups are bounded", async () => {
  const a = register("a"),
    b = register("b");
  const { loop, onError, workerChecks } = start({ a: true, b: false });
  try {
    await advance(0);
    expect(status("a", a)).toMatchObject({ status: "done" });
    // Follow-ups 1, 2, 4 and 8 rounds apart: minutes 1, 3, 7 and 15.
    const expected: Record<number, number> = { 1: 2, 2: 2, 3: 3, 7: 4, 15: 5 };
    for (let minute = 1; minute < 30; minute += 1) {
      await advance(HELPER_SIBLING_FOLLOWUP_MS);
      const want = Object.entries(expected)
        .filter(([m]) => Number(m) <= minute)
        .at(-1)?.[1];
      expect(workerChecks("b"), `minute ${minute}`).toBe(want);
      expect(status("b", b)).toMatchObject({ status: "open" });
      expect(status("b", b)?.helper_checks).toBeUndefined();
    }
    // The regular patrol keeps its own cadence.
    await advance(HELPER_SIBLING_FOLLOWUP_MS);
    expect(workerChecks("b")).toBe(6);
    expect(status("b", b)).toMatchObject({ status: "open" });
    expect(workerChecks("a")).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await loop.stop();
  }
});

test("without a sibling confirmation only the regular patrol rechecks", async () => {
  register("a", false);
  const b = register("b");
  const consistent = { a: true, b: false };
  const { loop, onError, workerChecks } = start(consistent);
  try {
    await advance(0);
    expect(workerChecks("b")).toBe(1);
    consistent.b = true;
    await advance(MACHINE_CAPABILITY_INTERVAL_MS - 1);
    expect(workerChecks("b")).toBe(1);
    expect(status("b", b)).toMatchObject({ status: "open" });
    await advance(1);
    expect(workerChecks("b")).toBe(2);
    expect(status("b", b)).toMatchObject({ status: "done" });
    expect(workerChecks("a")).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await loop.stop();
  }
});

test("a failing sibling lookup is reported once and falls back to the patrol", async () => {
  register("a");
  const b = register("b");
  const consistent = { a: true, b: false };
  const { loop, onError, workerChecks } = start(consistent);
  try {
    await advance(0);
    lookup.fails = true;
    consistent.b = true;
    await advance(MACHINE_CAPABILITY_INTERVAL_MS - 1);
    expect(workerChecks("b")).toBe(1);
    expect(status("b", b)).toMatchObject({ status: "open" });
    expect(onError.mock.calls).toEqual([
      [new Error("Helper sibling lookup failed")],
    ]);
    await advance(1);
    expect(status("b", b)).toMatchObject({ status: "done" });
  } finally {
    await loop.stop();
  }
});
