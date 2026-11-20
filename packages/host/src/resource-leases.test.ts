import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assignment, run } from "../../domain/src/commands/test-fixtures.js";
import { MachineLeases } from "./resource-leases.js";
import { type ResourceProbe, targetProbe } from "./resource-probe.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";

const start = "2032-02-01T00:00:00.000Z",
  end = "2032-02-01T02:00:00.000Z";
const human = { kind: "human" as const, project_id: "first" };
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cg-leases-"));
  store = Store.open({ dataDir: dir });
  for (const id of ["first", "second"]) store.createProject({ id });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});
const binding = {
  adb_port: 17071,
  device: "synthetic-1",
  release: ["/opt/test/proof"],
};
async function config(bound = true) {
  await writeFile(
    join(dir, "run-capacity.yaml"),
    JSON.stringify({
      machines: {
        local: {
          resources: { fixture: 1 },
          resource_policies: {
            fixture: {
              reservable_by: ["first"],
              ...(bound
                ? {
                    bindings: {
                      first: binding,
                      second: {
                        ...binding,
                        adb_port: 17072,
                        device: "synthetic-2",
                      },
                    },
                  }
                : {}),
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const cfg = await loadRunCapacityConfig({ configDir: dir });
  expect(cfg.errors).toEqual([]);
  return cfg;
}
test("calendar is half-open, rejects overlaps across projects, and audits the actual deadline once after restart", async () => {
  const cfg = await config(false);
  const leases = new MachineLeases(store, cfg, vi.fn());
  const id = await leases.reserve(
    human,
    "local",
    "fixture",
    start,
    end,
    () => start,
  );
  await expect(
    leases.reserve(
      { ...human, project_id: "second" },
      "local",
      "fixture",
      start,
      end,
      () => start,
    ),
  ).rejects.toThrow();
  expect(leases.blocked("second", "local", ["fixture"], start)).toContain(
    "预约",
  );
  expect(leases.blocked("first", "local", ["fixture"], start)).toBeUndefined();
  expect(leases.blocked("second", "local", ["fixture"], end)).toBeUndefined();
  store.close();
  store = Store.open({ dataDir: dir });
  const reboot = new MachineLeases(store, cfg, vi.fn());
  await reboot.reconcile("first", () => end);
  await reboot.reconcile("first", () => end);
  const events = store
    .getUpdates({ project_id: "first" })
    .events.filter((e) => e.type === "machine_resource_deadline");
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toMatchObject({
    generation: id,
    ends_at: end,
    physical_release: "not_applicable",
  });
});
test("Q-964: a clock deadline, missing config, stale target and failed probe each retain the physical hold; only current generation proof releases", async () => {
  const cfg = await config();
  let result: string | undefined = "target-1";
  const probe: ResourceProbe = vi.fn(async () => result);
  const l = new MachineLeases(store, cfg, probe);
  const id = await l.reserve(
    human,
    "local",
    "fixture",
    start,
    end,
    () => start,
  );
  result = undefined;
  await l.reconcile("first", () => end);
  expect(l.blocked("second", "local", ["fixture"], end)).toContain("释放核验");
  const missing = new MachineLeases(store, await config(false), probe);
  await missing.reconcile("first", () => end);
  expect(missing.blocked("second", "local", ["fixture"], end)).toContain(
    "释放核验",
  );
  result = "wrong-target";
  await l.reconcile("first", () => end);
  expect(l.blocked("second", "local", ["fixture"], end)).toContain("释放核验");
  result = "target-1";
  await l.reconcile("first", () => end);
  expect(probe).toHaveBeenCalledWith(
    binding.release,
    expect.objectContaining({
      project: "first",
      generation: id,
      port: binding.adb_port,
    }),
    "target-1",
  );
  expect(l.blocked("second", "local", ["fixture"], end)).toBeUndefined();
  const audit = store.getUpdates({ project_id: "first" }).events;
  expect(audit.at(-1)).toMatchObject({
    type: "machine_resource_release_verified",
    payload: { generation: id },
  });
  expect(JSON.stringify(audit)).not.toContain("/opt/test");
});
test("Run holders survive finish, release result racing the next owner cannot clear a newer generation", async () => {
  const cfg = await config();
  let reply: ((v: string) => void) | undefined;
  const late = new MachineLeases(
    store,
    cfg,
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const fast = new MachineLeases(store, cfg, async () => "target");
  const owner = assignment(1);
  const r = run();
  store.uow.run((tx) => {
    tx.assignments.put("first", owner);
    tx.runs.put("first", { ...r, status: "completed" });
  });
  const acquire = async (l: MachineLeases) => {
    const { fingerprint } = await import("./resource-policy.js");
    return store.uow.run((tx) =>
      l.acquire(
        tx,
        "first",
        owner,
        r,
        ["fixture"],
        { signature: fingerprint(["fixture"]), target: "target" },
        start,
      ),
    );
  };
  const first = await acquire(fast);
  const delayed = late.reconcile("first", () => end);
  await vi.waitFor(() => expect(reply).toBeDefined());
  await fast.reconcile("first", () => end);
  const next = await acquire(fast);
  expect(next?.bindings[0]?.generation).not.toBe(
    first?.bindings[0]?.generation,
  );
  reply?.("target");
  await delayed;
  expect(fast.blocked("second", "local", ["fixture"], end)).toContain(
    "释放核验",
  );
});
// Use the wrapper's required system interpreter as a synthetic probe. Coreutils
// applets can be symlinks; a private probe must name a trusted regular file.
async function syntheticProbe(program: string) {
  return [
    await realpath("/usr/bin/python3"),
    "-I",
    "-B",
    "-c",
    program,
  ] as const;
}
const printGeneration =
  "import json, os; print(json.loads(os.environ['CARDIGAN_RESOURCE_CONTEXT'])['generation'], flush=True)";

test("the production wrapper checks the actual target, never accepts old-generation stdout, or substitutes local for remote", async () => {
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  const ctx = {
    action: "release" as const,
    project: "first",
    machine: "local",
    key: "fixture",
    generation: "generation-2",
  };
  const current = await syntheticProbe(printGeneration);
  const stale = await syntheticProbe("print('generation-1')");
  expect(await probe(current, ctx, "local")).toBe("local");
  expect(await probe(stale, ctx, "local")).toBeUndefined();
  expect(await probe(current, { ...ctx, machine: "remote" })).toBeUndefined();

  const alias = join(dir, "probe-link");
  await symlink(current[0], alias);
  expect(
    await probe([alias, ...current.slice(1)], ctx, "local"),
  ).toBeUndefined();
});

test("standing PM bookings require explicit project authorization and fresh identity at commit; retries are idempotent", async () => {
  const l = new MachineLeases(store, await config(false), vi.fn());
  const pm = {
    kind: "assignment" as const,
    project_id: "first",
    assignment_id: assignment().id,
    role_id: "pm",
    role_version: 1,
    allowed_tools: ["reserve_machine_resource" as const],
    capabilities: [],
  };
  const base = assignment(1, "pm");
  store.uow.run((tx) => tx.assignments.put("first", base));
  const request = { key: "one", revalidate: vi.fn() };
  const reserve = () =>
    l.reserve(pm, "local", "fixture", start, end, () => start, request);
  await expect(reserve()).rejects.toThrow();
  const { work_item_id: _work, ...rest } = base;
  store.uow.run((tx) =>
    tx.assignments.put("first", { ...rest, scope: "standing" }),
  );
  await expect(
    l.reserve(pm, "local", "fixture", start, end, () => start, {
      ...request,
      revalidate: () => {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  await expect(
    l.reserve(
      { ...pm, project_id: "second" },
      "local",
      "fixture",
      start,
      end,
      () => start,
      request,
    ),
  ).rejects.toThrow();
  const id = await reserve();
  expect(await reserve()).toBe(id);
  expect(request.revalidate).toHaveBeenCalledTimes(2);
  expect(
    store
      .getUpdates({ project_id: "first" })
      .events.filter((e) => e.type === "machine_resource_reserved"),
  ).toHaveLength(1);
});

test.each([
  { first: { adb_port: 5037 } },
  { first: { adb_port: 70000 } },
  { first: { adb_port: 12000 }, second: { adb_port: 12000 } },
  { first: { device: "private-device" }, second: { device: "private-device" } },
  { first: { device: "private-device", release: "shell text" } },
])(
  "invalid or duplicate endpoint config is rejected without echoing it",
  async (bindings) => {
    await writeFile(
      join(dir, "run-capacity.yaml"),
      JSON.stringify({
        machines: {
          local: {
            resources: { fixture: 1 },
            resource_policies: { fixture: { bindings } },
          },
        },
      }),
      { mode: 0o600 },
    );
    const cfg = await loadRunCapacityConfig({ configDir: dir });
    expect(cfg.errors).toHaveLength(1);
    expect(cfg.forMachine("local")).toBe(0);
    expect(cfg.errors.join()).not.toContain("private-device");
  },
);

test("production probe fails closed on timeout, failed status and unreachable target", async () => {
  const probe = targetProbe(() => ({ mode: "local", dataDir: dir }));
  const ctx = {
    action: "release" as const,
    project: "first",
    machine: "local",
    key: "fixture",
    generation: "old",
  };
  // Even correct generation output is not proof if the process fails to finish successfully.
  const slow = await syntheticProbe(
    `${printGeneration}; import time; time.sleep(10)`,
  );
  const failed = await syntheticProbe(
    `${printGeneration}; raise SystemExit(1)`,
  );
  expect(await probe(slow, ctx, "local")).toBeUndefined();
  expect(await probe(failed, ctx, "local")).toBeUndefined();
  const offline = targetProbe(() => {
    throw new Error("unreachable");
  });
  expect(
    await offline(await syntheticProbe(printGeneration), ctx, "local"),
  ).toBeUndefined();
}, 15_000);
