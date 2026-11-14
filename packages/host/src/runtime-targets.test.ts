import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Machine,
  Role,
  RuntimeLaunch,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import {
  type HerdrOptions,
  writeRegisteredRuntime,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RuntimeTargets } from "./runtime-targets.js";
import type { RuntimeWorker } from "./runtime-workers-config.js";

const value = <T>(result: RuntimeResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const assignment = (machine_id = "local"): Assignment => ({
  id: "A-1",
  scope: "standing",
  role_id: "pm",
  role_version: 1,
  status: "active",
  runtime_state: "not_provisioned",
  machine_id,
  runtime_ref: null,
  mcp_token_id: "fixture",
  created_at: "2026-01-01T00:00:00Z",
});
const role = { role_id: "pm", version: 1 } as Role;
const launch: RuntimeLaunch = {
  agent_name: "same-name",
  command: "node",
  args: [],
  cwd: "/fixture",
  labels: { project: "fixture", run: "R-1" },
};
const machine = (id: string, alias = "local"): Machine => ({
  id,
  label: id,
  herdr_machine: alias,
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 1,
  status: "online",
  last_seen: "2026-01-01T00:00:00Z",
});
let root: string,
  store: Store,
  workers: RuntimeWorker[],
  router: RuntimeTargets;
const calls = vi.fn();
const factory = vi.fn(async (options: HerdrOptions) => {
  const target = options.execution?.target;
  const alias =
    options.execution?.mode === "agent-ssh"
      ? options.execution.machine
      : "local";
  const ref: RuntimeRef = {
    machine_id: target?.machine_id ?? "local",
    runtime_machine: alias,
    terminal_ref: alias === "local" ? "t1" : `${alias}/t1`,
    agent_name: launch.agent_name,
    ...(target ? { target } : {}),
  };
  const call =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<RuntimeResult<T>> => {
      calls(target?.machine_id ?? "local", method, ...args);
      return { ok: true, value: result };
    };
  return {
    ok: true as const,
    value: {
      provision: call("provision", ref),
      wake: call("wake", { sent: true }),
      status: call("status", {
        process: "alive" as const,
        agent: "idle" as const,
        observed_seq: 1,
      }),
      interrupt: call("interrupt", undefined),
      resume_or_replace: call("resume_or_replace", ref),
      human_entry: call("human_entry", `attach ${ref.terminal_ref}`),
      release: call("release", undefined),
      probeTerminal: call("probeTerminal", "alive" as const),
      captureAgent: call("captureAgent", "fixture 1.0"),
      async *events() {
        calls(target?.machine_id, "events");
        yield {
          ok: true as const,
          value: { seq: 1, type: "snapshot", observations: [] },
        };
        yield {
          ok: true as const,
          value: { seq: 2, type: "snapshot", observations: [] },
        };
      },
    },
  };
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cg-targets-"));
  store = Store.open({ dataDir: root });
  store.createProject({ id: "fixture", name: "Fixture" });
  store.createProject({ id: "other", name: "Other" });
  workers = ["worker-a", "worker-b"].map((id) => ({
    machine_id: id,
    project_id: "fixture",
    os: "linux",
    arch: "x64",
    session: id,
    generation: "one",
    execution: {
      mode: "agent-ssh",
      dataDir: root,
      agentRoot: `/workers/${id}`,
      gid: 2001,
      machine: id,
      host: `${id}.invalid`,
      user: "project_a",
      identityFile: "/private/key",
      knownHostsFile: "/private/known_hosts",
      path: "/usr/bin:/bin",
    },
  }));
  store.uow.run((tx) => {
    for (const worker of workers)
      tx.machines.put(
        "fixture",
        machine(worker.machine_id, worker.execution.machine),
      );
  });
  calls.mockClear();
  factory.mockClear();
  router = value(
    await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      project: "fixture",
      workers: () => workers,
      factory,
    }),
  );
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("seven methods, get probes and events select two machines with identical Assignment and terminal numbers", async () => {
  for (const id of ["worker-a", "worker-b"]) {
    const ref = value(
      await router.provision(assignment(id), role, machine(id), launch),
    );
    expect(ref.target?.machine_id).toBe(id);
    value(await router.wake(ref, "bell"));
    value(await router.status(ref));
    value(await router.interrupt(ref));
    value(await router.resume_or_replace(ref, launch));
    value(await router.human_entry(ref));
    value(await router.release(ref, { force: true }));
    value(await router.probeTerminal(ref));
    for await (const event of router.events(ref)) value(event);
    expect(
      calls.mock.calls.filter((c) => c[0] === id).map((c) => c[1]),
    ).toEqual([
      "provision",
      "wake",
      "status",
      "interrupt",
      "resume_or_replace",
      "human_entry",
      "release",
      "probeTerminal",
      "events",
    ]);
    expect(
      calls.mock.calls.find((c) => c[0] === id && c[1] === "provision")?.[4],
    ).toEqual(machine(id, id));
    expect(() => router.forLaunch("fixture", assignment(id))).toThrow(
      "target rejected",
    );
  }
});
test("cross-project/machine/alias/session/prefix/fingerprint/generation references fail before any IO", async () => {
  const ref = value(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  );
  const binding = ref.target;
  if (!binding) throw new Error("Missing fixture binding");
  const badRefs = [
    { ...ref, machine_id: "worker-b" },
    { ...ref, runtime_machine: "worker-b" },
    { ...ref, terminal_ref: "worker-b/t1" },
    ...[
      { project_id: "other" },
      { session: "other" },
      { generation: "old" },
      { fingerprint: "old" },
      { machine_id: "worker-b" },
    ].map((patch) => ({ ...ref, target: { ...binding, ...patch } })),
    { ...ref, target: undefined },
  ];
  calls.mockClear();
  for (const bad of badRefs) {
    const invalid = bad as RuntimeRef;
    expect(await router.status(invalid)).toMatchObject({ ok: false });
    expect(await router.release(invalid, { force: true })).toMatchObject({
      ok: false,
    });
    for await (const event of router.events(invalid))
      expect(event.ok).toBe(false);
  }
  expect(
    await router.resume_or_replace(ref, {
      ...launch,
      labels: { ...launch.labels, project: "other" },
    }),
  ).toMatchObject({ ok: false });
  expect(calls).not.toHaveBeenCalled();
});
test("alias rebinding and a generation change invalidate persisted refs across router restarts and open subscriptions", async () => {
  const ref = value(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  );
  const persisted = JSON.parse(JSON.stringify(ref)) as RuntimeRef;
  const stream = router.events(persisted);
  expect((await stream.next()).value).toMatchObject({ ok: true });
  workers = workers.map((w) =>
    w.machine_id === "worker-a" ? { ...w, generation: "two" } : w,
  );
  expect((await stream.next()).value).toMatchObject({ ok: false });
  const restart = value(
    await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      workers: () => workers,
      factory,
    }),
  );
  expect(await restart.release(persisted, { force: true })).toMatchObject({
    ok: false,
  });
  workers = workers.map((w) =>
    w.machine_id === "worker-a"
      ? {
          ...w,
          generation: "one",
          execution: { ...w.execution, host: "different.invalid" },
        }
      : w,
  );
  expect(await restart.release(persisted, { force: true })).toMatchObject({
    ok: false,
  });
  expect(ref).toEqual(persisted);
});
test("legacy local refs and new local binding remain usable; unknown or unregistered workers never fall back", async () => {
  const ref = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "old",
  };
  expect(value(await router.status(ref)).process).toBe("alive");
  const created = value(
    await router.provision(assignment(), role, machine("local"), launch),
  );
  expect(created.target).toMatchObject({
    project_id: "fixture",
    machine_id: "local",
    generation: "legacy",
  });
  expect(value(await router.status(created)).process).toBe("alive");
  expect(() => router.resolve("fixture", "unknown")).toThrow();
  expect(() => router.resolve("other", "worker-a")).toThrow();
  store.uow.run((tx) =>
    tx.machines.put("fixture", {
      ...machine("worker-a", "worker-a"),
      arch: "arm64",
    }),
  );
  expect(() => router.resolve("fixture", "worker-a")).toThrow();
});

test("project mappings use distinct aliases on the same registered physical machine, and cannot fall back to an unlisted account", async () => {
  const first = workers[0];
  if (!first) throw new Error("Missing fixture worker");
  workers = [
    {
      ...first,
      machine_id: "local",
      execution: { ...first.execution, machine: "project-a" },
    },
  ];
  const execution = { mode: "local" as const, dataDir: root };
  const global = value(
    await RuntimeTargets.create({
      execution,
      store,
      workers: () => workers,
      factory,
    }),
  );
  expect(() => global.resolve("other", "local")).toThrow();
  workers.push({
    ...first,
    machine_id: "local",
    project_id: "other",
    execution: { ...first.execution, machine: "project-b", user: "project_b" },
  });
  expect(global.resolve("fixture", "local").execution).toMatchObject({
    machine: "project-a",
  });
  expect(global.resolve("other", "local").execution).toMatchObject({
    machine: "project-b",
  });
  expect(
    await router.status({
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "t1",
      agent_name: "old",
    }),
  ).toMatchObject({ ok: false });
});

test("persisted pre-fingerprint refs prevent a restart from silently replacing their registered execution target", async () => {
  const foreignRef = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t9",
    agent_name: "other-project",
  };
  store.uow.run((tx) =>
    tx.assignments.put("other", { ...assignment(), runtime_ref: foreignRef }),
  );
  expect(await router.release(foreignRef, { force: true })).toMatchObject({
    ok: false,
  });
  store.uow.run((tx) =>
    tx.assignments.put("fixture", {
      ...assignment(),
      runtime_ref: {
        machine_id: "local",
        runtime_machine: "local",
        terminal_ref: "t1",
        agent_name: "old",
      },
    }),
  );
  const execution = { mode: "local" as const, dataDir: root };
  await writeRegisteredRuntime(root, execution, "original");
  expect(
    await RuntimeTargets.create({
      execution,
      store,
      session: "changed",
      workers: () => [],
      factory,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await RuntimeTargets.create({
      execution,
      store,
      session: "original",
      workers: () => [],
      factory,
    }),
  ).toMatchObject({ ok: true });
});

test("host-only capture preserves Git classification evidence while the public message is a category", async () => {
  const captureFactory = async (options: HerdrOptions) => {
    const adapter = value(await factory(options));
    return {
      ok: true as const,
      value: {
        ...adapter,
        captureAgent: async () => ({
          ok: false as const,
          error: {
            code: "runtime_unavailable" as const,
            message: "private command diagnostics",
            detail: {
              exit_code: 128,
              stderr: "fatal: Unable to create shallow.lock: File exists",
            },
          },
        }),
      },
    };
  };
  const capture = value(
    await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      project: "fixture",
      workers: () => [],
      factory: captureFactory,
    }),
  );
  expect(await capture.captureAgent("git", ["status"])).toMatchObject({
    ok: false,
    error: {
      message: "Runtime operation rejected: runtime_unavailable",
      detail: {
        exit_code: 128,
        stderr: expect.stringContaining("shallow.lock"),
      },
    },
  });
});
