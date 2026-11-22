import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Assignment,
  Machine,
  Role,
  RuntimeLaunch,
  RuntimeRef,
  RuntimeResult,
  RuntimeWakeOptions,
} from "@cardigan/domain";
import * as herdr from "@cardigan/runtime-herdr";
import {
  HC_RELEASE,
  type HcClient,
  type HerdrOptions,
  hcCallPolicy,
  writeRegisteredRuntime,
} from "@cardigan/runtime-herdr";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { governHcClient } from "../../runtime-herdr/src/call-queue.js";
import { HerdrRuntime } from "../../runtime-herdr/src/index.js";
import { observeRegisteredMachine, RuntimeTargets } from "./runtime-targets.js";
import type { RuntimeWorker } from "./runtime-workers-config.js";
import { WorkerMcpError } from "./worker-mcp.js";
import { upgradeHold } from "./worker-upgrade-gate.js";

const value = <T>(result: RuntimeResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

test("independent review: a legacy local ref must not follow a changed session after an SSH migration", async () => {
  const oldRef: RuntimeRef = {
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: "old-local",
  };
  store.uow.run((tx) =>
    tx.assignments.put("fixture", { ...assignment(), runtime_ref: oldRef }),
  );
  const execution = {
    mode: "agent-ssh" as const,
    dataDir: root,
    agentRoot: "/workers/legacy",
    gid: 2001,
    machine: "legacy-agent",
    identityFile: "/private/key",
    knownHostsFile: "/private/known_hosts",
  };
  await writeRegisteredRuntime(root, execution, "old-session");
  const restarted = await RuntimeTargets.create({
    execution,
    session: "new-session",
    store,
    workers: () => [],
    factory,
  });
  let released = false;
  if (restarted.ok)
    released = (await restarted.value.release(oldRef, { force: true })).ok;
  expect(released).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  if (!restarted.ok) throw new Error("Invalid fixture");
  for (const result of [
    await restarted.value.status(oldRef),
    await restarted.value.human_entry(oldRef),
    await restarted.value.attachEnvironment(oldRef),
  ])
    expect(result.ok).toBe(false);
  for await (const result of restarted.value.events(oldRef))
    expect(result.ok).toBe(false);
  expect(factory).not.toHaveBeenCalled();
  expect(() => restarted.value.assertRegistration()).toThrow(
    "Runtime target rejected",
  );
  expect(
    store.uow.read((tx) => tx.assignments.get("fixture", "A-1"))?.runtime_ref,
  ).toEqual(oldRef);
});
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
const mcpReachability = vi.fn(async () => {});
const readiness = vi.fn(
  async (): Promise<
    readonly import("./worker-readiness.js").WorkerReadinessFailure[]
  > => [],
);
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
      observe_retirement: call("observe_retirement", "alive" as const),
      retire_idle: call("retire_idle", { outcome: "exited" }),
      probeTerminal: call("probeTerminal", "alive" as const),
      captureAgent: call("captureAgent", "fixture 1.0"),
      checkLocalHealth: call("checkLocalHealth", undefined),
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
    allow_remote_launch: true,
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
      mcp: {
        url: "https://control.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      },
      gitHelper: {
        python: "/usr/bin/python3",
        path: "/opt/worker/worker-git.py",
      },
      fileHelper: {
        python: "/usr/bin/python3",
        path: "/opt/worker/worker-files.py",
      },
      publication: {
        header_max_bytes: 4096,
        file_max_bytes: 2048,
        batch_max_bytes: 8192,
        timeout_ms: 2000,
      },
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
  readiness.mockReset().mockResolvedValue([]);
  mcpReachability.mockReset().mockResolvedValue(undefined);
  router = value(
    await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      project: "fixture",
      workers: () => workers,
      factory,
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
    }),
  );
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

test.each([
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
] as const)(
  "$os runtime methods, get probes and events select two machines with identical Assignment and terminal numbers",
  async (platform) => {
    workers = workers.map((worker) => ({
      ...worker,
      ...platform,
      execution: {
        ...worker.execution,
        ...(platform.os === "darwin" && {
          macosCore: { python: "/bin/python3", retiredLaunchdLabel: "fixture" },
        }),
      },
    }));
    store.uow.run((tx) => {
      for (const worker of workers)
        tx.machines.put("fixture", {
          ...machine(worker.machine_id, worker.execution.machine),
          ...platform,
        });
    });
    for (const id of ["worker-a", "worker-b"]) {
      const ref = value(
        await router.provision(
          assignment(id),
          role,
          { ...machine(id), ...platform },
          launch,
        ),
      );
      expect(ref.target?.machine_id).toBe(id);
      value(await router.wake(ref, "bell"));
      value(await router.status(ref));
      value(await router.interrupt(ref));
      value(await router.resume_or_replace(ref, launch));
      value(await router.human_entry(ref));
      value(await router.release(ref, { force: true }));
      const eligible = vi.fn(() => true);
      value(
        await router.retire_idle(ref, {
          project_id: "fixture",
          assignment_id: "A-1",
          hangup_ms: 1,
          terminate_ms: 1,
          before_signal: eligible,
        }),
      );
      value(
        await router.observe_retirement(ref, {
          project_id: "fixture",
          assignment_id: "A-1",
        }),
      );
      value(await router.probeTerminal(ref));
      for await (const event of router.events(ref)) value(event);
      expect(
        calls.mock.calls.filter((c) => c[0] === id).map((c) => c[1]),
      ).toEqual([
        "captureAgent",
        "provision",
        "wake",
        "status",
        "interrupt",
        "captureAgent",
        "resume_or_replace",
        "human_entry",
        "release",
        "retire_idle",
        "observe_retirement",
        "probeTerminal",
        "events",
      ]);
      expect(
        calls.mock.calls.find((c) => c[0] === id && c[1] === "provision")?.[4],
      ).toEqual({ ...machine(id, id), ...platform });
      expect(
        (await router.forLaunch("fixture", assignment(id))).machine.id,
      ).toBe(id);
      // The adapter holds this callback between its first probe and the signal.
      const gate = calls.mock.calls.find(
        (c) => c[0] === id && c[1] === "retire_idle",
      )?.[3].before_signal;
      expect(gate()).toBe(true);
      workers = workers.map((w) =>
        w.machine_id === id ? { ...w, allow_remote_launch: false } : w,
      );
      expect(gate()).toBe(false);
      expect(eligible).toHaveBeenCalledTimes(1);
    }
  },
);

test("MCP configuration is target-specific and changing it invalidates the old target binding", () => {
  const worker = workers[0];
  if (!worker) throw new Error("Missing fixture");
  const legacyLocal = router.resolve("fixture", "local");
  workers[0] = {
    ...worker,
    execution: {
      ...worker.execution,
      mcp: {
        url: "https://control.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      },
    },
  };
  const before = router.resolve("fixture", worker.machine_id);
  expect(
    before.execution.mode === "agent-ssh" && before.execution.mcp?.url,
  ).toBe("https://control.example-tailnet.ts.net/mcp");
  expect(router.resolve("fixture", "local")).toEqual(legacyLocal);
  workers[0] = {
    ...worker,
    execution: {
      ...worker.execution,
      mcp: {
        url: "https://other.example-tailnet.ts.net/mcp",
        timeoutMs: 10000,
      },
    },
  };
  const after = router.resolve("fixture", worker.machine_id);
  expect(after.execution.target?.fingerprint).not.toBe(
    before.execution.target?.fingerprint,
  );
  expect(
    router.ownsRef({
      machine_id: worker.machine_id,
      runtime_machine: worker.execution.machine,
      terminal_ref: `${worker.execution.machine}/t1`,
      agent_name: "fixture",
      ...(before.execution.target ? { target: before.execution.target } : {}),
    }),
  ).toBe(false);
});
test("macOS core owner changes invalidate the target binding while the legacy local identity stays stable", () => {
  const worker = workers[0];
  if (!worker) throw new Error("Missing fixture");
  const before = router.resolve("fixture", worker.machine_id);
  const local = router.resolve("fixture", "local");
  for (const retiredLaunchdLabel of [
    "dev.cardigan.fixture",
    "dev.cardigan.other",
  ]) {
    workers[0] = {
      ...worker,
      execution: {
        ...worker.execution,
        macosCore: { python: "/opt/homebrew/bin/python3", retiredLaunchdLabel },
      },
    };
    expect(
      router.resolve("fixture", worker.machine_id).execution.target
        ?.fingerprint,
    ).not.toBe(before.execution.target?.fingerprint);
    expect(router.resolve("fixture", "local")).toEqual(local);
    expect(
      router.ownsRef({
        machine_id: worker.machine_id,
        runtime_machine: worker.execution.machine,
        terminal_ref: `${worker.execution.machine}/t1`,
        agent_name: "fixture",
        ...(before.execution.target ? { target: before.execution.target } : {}),
      }),
    ).toBe(false);
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
test("retirement reports distinct allowlisted routing refusals before delegation; unknown failures never persist text", async () => {
  const ref: RuntimeRef = {
    machine_id: "unlisted",
    runtime_machine: "unlisted",
    terminal_ref: "unlisted/t1",
    agent_name: "fixture",
  };
  const options = {
    project_id: "fixture",
    assignment_id: "A-1",
    hangup_ms: 1,
    terminate_ms: 1,
    before_signal: vi.fn(),
  };
  const check = async (reason: string) =>
    expect(value(await router.retire_idle(ref, options))).toEqual({
      outcome: "withdrawn",
      evidence: { stage: "target", reason, runtime_code: "invalid_launch" },
    });
  await check("machine_unregistered");
  store.uow.run((tx) =>
    tx.machines.put("fixture", machine("unlisted", "unlisted")),
  );
  await check("worker_unconfigured");
  vi.spyOn(router, "resolve").mockImplementationOnce(() => {
    throw new Error("private worker details");
  });
  await check("target_rejected");
  expect(calls).not.toHaveBeenCalled();
  expect(options.before_signal).not.toHaveBeenCalled();
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
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
    }),
  );
  expect(await restart.release(persisted, { force: true })).toMatchObject({
    ok: false,
  });
  expect(
    await restart.retire_idle(persisted, {
      project_id: "fixture",
      assignment_id: "A-1",
      hangup_ms: 1,
      terminate_ms: 1,
      before_signal: () => true,
    }),
  ).toMatchObject({
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: { stage: "target", reason: "target_mismatch" },
    },
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
test("publication limits and helper changes invalidate the target binding", async () => {
  const original = router.resolve("fixture", "worker-a").execution.target;
  const local = router.resolve("fixture", "local").execution.target;
  workers = workers.map((w) => ({
    ...w,
    execution: {
      ...w.execution,
      publication: {
        header_max_bytes: 4096,
        file_max_bytes: 2048,
        batch_max_bytes: 8192,
        timeout_ms: 2000,
      },
      fileHelper: {
        python: "/usr/bin/python3",
        path: "/opt/worker/new-worker-files.py",
      },
    },
  }));
  const configured = router.resolve("fixture", "worker-a").execution.target;
  expect(configured?.fingerprint).not.toBe(original?.fingerprint);
  expect(router.resolve("fixture", "local").execution.target).toEqual(local);
  expect(
    (await router.forLaunch("fixture", assignment("worker-a"))).machine.id,
  ).toBe("worker-a");
  workers = workers.map((w) => ({
    ...w,
    execution: {
      ...w.execution,
      publication: {
        header_max_bytes: 4096,
        file_max_bytes: 2048,
        batch_max_bytes: 8192,
        timeout_ms: 2001,
      },
    },
  }));
  expect(
    router.resolve("fixture", "worker-a").execution.target?.fingerprint,
  ).not.toBe(configured?.fingerprint);
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
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
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
  const changed = value(
    await RuntimeTargets.create({
      execution,
      store,
      session: "changed",
      workers: () => [],
      factory,
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
    }),
  );
  expect(() => changed.assertRegistration()).toThrow("Runtime target rejected");
  expect(
    await RuntimeTargets.create({
      execution,
      store,
      session: "original",
      workers: () => [],
      factory,
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
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

test.each([undefined, false])(
  "remote launch without opt-in (%s) rejects before any probe and preserves local",
  async (enabled) => {
    workers = workers.map(({ allow_remote_launch: _, ...worker }) => ({
      ...worker,
      ...(enabled === undefined ? {} : { allow_remote_launch: enabled }),
    }));
    await expect(
      router.forLaunch("fixture", assignment("worker-a")),
    ).rejects.toThrow("remote_launch_disabled");
    expect(
      await router.provision(
        assignment("worker-a"),
        role,
        machine("worker-a"),
        launch,
      ),
    ).toMatchObject({ ok: false });
    expect(factory).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(mcpReachability).not.toHaveBeenCalled();
    expect((await router.forLaunch("fixture", assignment())).machine.id).toBe(
      "local",
    );
    expect(readiness).not.toHaveBeenCalled();
    expect(mcpReachability).not.toHaveBeenCalled();
  },
);

test.each(["offline", "draining"] as const)(
  "remote %s never starts or falls back",
  async (status) => {
    store.uow.run((tx) =>
      tx.machines.put("fixture", {
        ...machine("worker-a", "worker-a"),
        status,
      }),
    );
    await expect(
      router.forLaunch("fixture", assignment("worker-a")),
    ).rejects.toThrow("machine_not_ready");
    expect(factory).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  },
);

test.each(["gitHelper", "fileHelper", "publication", "path"] as const)(
  "missing %s rejects before hc or worker IO",
  async (field) => {
    workers = workers.map((worker) => {
      const { [field]: _, ...execution } = worker.execution;
      return { ...worker, execution };
    });
    await expect(
      router.forLaunch("fixture", assignment("worker-a")),
    ).rejects.toThrow("worker_configuration_incomplete");
    expect(await router.check("fixture", "worker-a")).toMatchObject({
      ok: false,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  },
);

test("registration, mapping and persisted fingerprint must all match before probing", async () => {
  await expect(
    router.forLaunch("fixture", assignment("unknown")),
  ).rejects.toThrow("machine_unregistered");
  store.uow.run((tx) =>
    tx.machines.put("fixture", machine("unconfigured", "unconfigured")),
  );
  await expect(
    router.forLaunch("fixture", assignment("unconfigured")),
  ).rejects.toThrow("worker_unconfigured");
  const ref = value(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  );
  calls.mockClear();
  readiness.mockClear();
  await expect(
    router.forLaunch("fixture", {
      ...assignment("worker-b"),
      runtime_ref: ref,
    }),
  ).rejects.toThrow("target_mismatch");
  workers = workers.map((w) => ({ ...w, generation: "changed" }));
  await expect(
    router.forLaunch("fixture", {
      ...assignment("worker-a"),
      runtime_ref: ref,
    }),
  ).rejects.toThrow("target_mismatch");
  expect(calls).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
});

test.each([
  "worker_unreachable",
  "hc_version",
  "worker_directories",
  "worker_helpers",
] as const)("a live %s failure blocks every remote launch", async (reason) => {
  readiness.mockResolvedValue([reason]);
  const checked = value(await router.check("fixture", "worker-a"));
  expect(checked).toEqual({
    machine_id: "worker-a",
    blockers: [reason],
    launch_enabled: false,
  });
  await expect(
    router.forLaunch("fixture", assignment("worker-a")),
  ).rejects.toThrow(reason);
  expect(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  ).toMatchObject({ ok: false });
  expect(calls.mock.calls.some((c) => c[1] === "provision")).toBe(false);
});

test("checks are live, and disabled launch is distinct from a passing machine check", async () => {
  const binding = router.resolve("fixture", "worker-a").execution.target;
  workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
  expect(value(await router.check("fixture", "worker-a"))).toEqual({
    machine_id: "worker-a",
    blockers: [],
    launch_enabled: false,
  });
  workers = workers.map((w) => ({ ...w, allow_remote_launch: true }));
  store.uow.run((tx) =>
    tx.machines.put("fixture", {
      ...machine("worker-a", "worker-a"),
      status: "degraded",
    }),
  );
  await router.forLaunch("fixture", assignment("worker-a"));
  await router.forLaunch("fixture", assignment("worker-a"));
  expect(readiness).toHaveBeenCalledTimes(3);
  expect(router.resolve("fixture", "worker-a").execution.target).toEqual(
    binding,
  );
  expect(calls.mock.calls.filter((c) => c[1] === "captureAgent")).toHaveLength(
    3,
  );
});

test("legacy local health uses the real adapter, refreshes capabilities, and observes lost liveness", async () => {
  const exec = vi.fn(async (args: readonly string[]) => {
    if (args.join(" ") === "--version") return `hc ${HC_RELEASE.version}`;
    if (args.join(" ") === "ls --json") return '{"terminals":[]}';
    throw new Error("Unexpected hc command");
  });
  const available = vi.fn(async () => true);
  const local = value(
    await RuntimeTargets.create({
      store,
      execution: { mode: "local", dataDir: root },
      workers: () => [],
      factory: HerdrRuntime.create,
      client: { exec, available, async *lines() {} },
      session: "local-health",
      socketPath: join(root, "local-health.sock"),
    }),
  );
  const probe = vi.fn(async () => ({ ok: true, output: "v24.0.0" }));
  const options = {
    catalog: () => [
      {
        key: "node",
        os: ["linux", "darwin"] as const,
        check: ["node", "--version"],
        version: ["node", "--version"],
        parseVersion: () => "24.0.0",
      },
    ],
    probe,
  };
  expect(value(await local.check("fixture", "local"))).toMatchObject({
    blockers: [],
    launch_enabled: true,
  });
  const first = await local.refreshMachine("fixture", "local", options);
  expect(first.health).toMatchObject({ status: "passed", available: true });
  expect(first.capabilities).toEqual([
    expect.objectContaining({ key: "node", available: true }),
  ]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls.map(([args]) => args)).toEqual([
    ["--version"],
    ["ls", "--json"],
    ["ls", "--json"],
  ]);
  available.mockResolvedValue(false);
  const failed = await local.refreshMachine("fixture", "local", options);
  expect(failed.health).toMatchObject({
    status: "failed",
    available: false,
    blockers: ["runtime_unavailable"],
  });
  expect(failed.capabilities).toEqual([]);
  expect(probe).toHaveBeenCalledTimes(1);
});

test.each(["configuration", "permission", "status"])(
  "a concurrent %s change cannot reuse a completed check",
  async (change) => {
    readiness.mockImplementationOnce(async () => {
      if (change === "configuration")
        workers = workers.map((w) => ({ ...w, generation: "changed" }));
      if (change === "permission")
        workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
      if (change === "status")
        store.uow.run((tx) =>
          tx.machines.put("fixture", {
            ...machine("worker-a", "worker-a"),
            status: "draining",
          }),
        );
      return [];
    });
    expect(
      await router.provision(
        assignment("worker-a"),
        role,
        machine("worker-a"),
        launch,
      ),
    ).toMatchObject({ ok: false });
    expect(calls.mock.calls.some((c) => c[1] === "provision")).toBe(false);
  },
);

test("revoking remote authorization rejects old observation, release and replacement", async () => {
  const ref = value(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  );
  workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
  calls.mockClear();
  expect(await router.resume_or_replace(ref, launch)).toMatchObject({
    ok: false,
  });
  expect(await router.wake(ref, "next run")).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("remote_launch_disabled") },
  });
  expect((await router.status(ref)).ok).toBe(false);
  expect((await router.release(ref, { force: true })).ok).toBe(false);
  expect(calls).not.toHaveBeenCalled();
});

test.each(["disabled", "offline", "draining"] as const)(
  "a completed preparation cannot authorize remote wake after %s",
  async (state) => {
    const ref = value(
      await router.provision(
        assignment("worker-a"),
        role,
        machine("worker-a"),
        launch,
      ),
    );
    const prepared = Promise.withResolvers<void>();
    const finishPreparation = Promise.withResolvers<void>();
    const sending = (async () => {
      await router.forLaunch("fixture", {
        machine_id: "worker-a",
        runtime_ref: ref,
      });
      prepared.resolve();
      await finishPreparation.promise;
      return router.wake(ref, "next run");
    })();
    await prepared.promise;
    if (state === "disabled")
      workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
    else
      store.uow.run((tx) =>
        tx.machines.put("fixture", {
          ...machine("worker-a", "worker-a"),
          status: state,
        }),
      );
    calls.mockClear();
    finishPreparation.resolve();
    expect(await sending).toMatchObject({ ok: false });
    expect(calls).not.toHaveBeenCalled();
    expect((await router.status(ref)).ok).toBe(state !== "disabled");
    expect((await router.release(ref, { force: true })).ok).toBe(
      state !== "disabled",
    );
  },
);

async function singleSlotWorker() {
  const socketPath = join(root, "wake.sock");
  const env = { CARDIGAN_HC_CONCURRENCY: "1" };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let queued: Promise<void> | undefined;
  const client: HcClient = {
    available: async () => true,
    exec: vi.fn(async (args) => {
      if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
      if (args[0] === "machine") {
        if (args[1] === "ls") return JSON.stringify({ machines: [] });
        if (hold) {
          hold = false;
          queued = governed.queue.run(async () => {
            entered.resolve();
            await release.promise;
          });
        }
        return JSON.stringify({ version: HC_RELEASE.version });
      }
      return "";
    }),
    async *lines() {},
  };
  const governed = governHcClient(client, {
    socket: socketPath,
    session: "worker-a",
    policy: hcCallPolicy({ ...process.env, ...env }),
  });
  const key = join(root, "key"),
    known = join(root, "known");
  await writeFile(key, "fixture", { mode: 0o600 });
  await writeFile(known, "fixture", { mode: 0o600 });
  workers = workers.map((w) => ({
    ...w,
    execution: { ...w.execution, identityFile: key, knownHostsFile: known },
  }));
  const live = value(
    await RuntimeTargets.create({
      execution: { mode: "local", dataDir: root },
      store,
      project: "fixture",
      socketPath,
      env,
      client,
      factory: (options) => HerdrRuntime.create(options),
      workers: () => workers,
      workerReadiness: readiness,
      workerMcpReachability: mcpReachability,
    }),
  );
  const target = (await live.forLaunch("fixture", assignment("worker-a")))
    .execution.target;
  if (!target) throw new Error("Missing fixture target");
  const ref: RuntimeRef = {
    machine_id: "worker-a",
    runtime_machine: "worker-a",
    terminal_ref: "worker-a/t1",
    agent_name: "fixture",
    target,
  };
  async function wakeAfterQueue(
    options: RuntimeWakeOptions,
    whileQueued: () => void | Promise<void>,
  ) {
    hold = true;
    const waking = live.wake(ref, "next run", options);
    try {
      await Promise.race([
        entered.promise,
        waking.then(() => {
          throw new Error("Wake never queued");
        }),
      ]);
      await whileQueued();
    } finally {
      release.resolve();
      await Promise.all([queued, waking]);
    }
    return value(await waking);
  }
  return { live, target, client, wakeAfterQueue, queue: governed.queue };
}

test.each([
  "disabled",
  "offline",
  "fingerprint",
  "caller",
  "caller_changes_policy",
  "ready",
] as const)(
  "real hc queue rechecks remote wake authority at send time: %s",
  async (change) => {
    const { client, wakeAfterQueue } = await singleSlotWorker();
    const caller = vi.fn(() => {
      if (change === "caller_changes_policy")
        workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
      return change !== "caller";
    });
    const result = await wakeAfterQueue(
      { before_send: caller, if_idle: true },
      () => {
        if (change === "disabled")
          workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
        if (change === "offline")
          store.uow.run((tx) =>
            tx.machines.put("fixture", {
              ...machine("worker-a", "worker-a"),
              status: "offline",
            }),
          );
        if (change === "fingerprint")
          workers = workers.map((w) => ({ ...w, generation: "new" }));
      },
    );
    expect(result).toEqual(
      change === "ready" ? { sent: true } : { sent: false, withdrawn: true },
    );
    expect(
      vi.mocked(client.exec).mock.calls.filter(([args]) => args[0] === "send"),
    ).toHaveLength(change === "ready" ? 1 : 0);
    expect(caller).toHaveBeenCalledTimes(1);
  },
);

test.each(["mounted", "unmounted"] as const)(
  "a single remote send slot checks the pinned resource after queuing: %s",
  async (condition) => {
    const { live, target, client, wakeAfterQueue, queue } =
      await singleSlotWorker();
    // Only replace the SSH transport. Run the real protected probe wrapper
    // against a synthetic mount marker on the same pinned fixture worker.
    using transport = vi
      .spyOn(herdr, "agentProcessCommand")
      .mockImplementation(async (execution, argv) => {
        if (
          execution.target?.fingerprint !== target.fingerprint ||
          argv[0] !== "/usr/bin/python3"
        )
          throw new Error("Wrong probe target");
        return { file: argv[0], args: argv.slice(1) };
      });
    const marker = join(root, "volume");
    await writeFile(marker, "mounted");
    const command = [
      await realpath("/usr/bin/python3"),
      "-I",
      "-c",
      "import os,sys; sys.exit(not os.path.isfile(sys.argv[1]))",
      marker,
    ] as const;
    const check = async () =>
      (await live.publicationResourceProbe(
        command,
        {
          project: "fixture",
          machine: "worker-a",
          key: "render",
          action: "check",
        },
        target.fingerprint,
      )) === target.fingerprint;
    expect(await check()).toBe(true);
    const result = await wakeAfterQueue(
      { resource_preflight: check },
      async () => {
        expect(transport).toHaveBeenCalledTimes(1);
        if (condition === "unmounted") await rm(marker);
      },
    );
    expect(result).toEqual(
      condition === "mounted"
        ? { sent: true }
        : { sent: false, withdrawn: true },
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(client.exec).mock.calls.filter(([args]) => args[0] === "send"),
    ).toHaveLength(condition === "mounted" ? 1 : 0);
    expect(queue.diagnostics().queue_timeouts).toBe(0);
  },
);

test("a timeout waiting for a machine-check command slot is a transient launch refusal", async () => {
  vi.spyOn(router, "check").mockResolvedValueOnce({
    ok: false,
    error: { code: "runtime_queue_timeout", message: "queue deadline" },
  });
  await expect(
    router.forLaunch("fixture", assignment("worker-a")),
  ).rejects.toMatchObject({
    reason: "machine_check_runtime_queue_timeout",
    transient: true,
  });
  expect(factory).not.toHaveBeenCalled();
});

test.each([
  "mcp_tls_failed",
  "mcp_unreachable",
  "mcp_timeout",
  "mcp_protocol_error",
  "mcp_gateway_error",
] as const)("a live %s blocks launch with its reason code", async (code) => {
  mcpReachability.mockRejectedValue(new WorkerMcpError(code));
  expect(value(await router.check("fixture", "worker-a"))).toEqual({
    machine_id: "worker-a",
    blockers: [code],
    launch_enabled: false,
  });
  await expect(
    router.forLaunch("fixture", assignment("worker-a")),
  ).rejects.toThrow(code);
  expect(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  ).toMatchObject({ ok: false });
  expect(calls.mock.calls.some((c) => c[1] === "provision")).toBe(false);
});

test("missing MCP config rejects before any network probe", async () => {
  workers = workers.map((w) => {
    const { mcp: _, ...execution } = w.execution;
    return { ...w, execution };
  });
  await expect(
    router.forLaunch("fixture", assignment("worker-a")),
  ).rejects.toThrow("mcp_config_missing");
  expect(factory).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
  expect(mcpReachability).not.toHaveBeenCalled();
});

test("MCP reachability is checked every time and a configuration change during it prevents launch", async () => {
  await router.forLaunch("fixture", assignment("worker-a"));
  await router.forLaunch("fixture", assignment("worker-a"));
  expect(mcpReachability).toHaveBeenCalledTimes(2);
  mcpReachability.mockImplementationOnce(async () => {
    workers = workers.map((w) => ({
      ...w,
      execution: {
        ...w.execution,
        mcp: {
          url: "https://changed.example-tailnet.ts.net/mcp",
          timeoutMs: 10000,
        },
      },
    }));
  });
  expect(
    await router.provision(
      assignment("worker-a"),
      role,
      machine("worker-a"),
      launch,
    ),
  ).toMatchObject({ ok: false });
  expect(calls.mock.calls.some((c) => c[1] === "provision")).toBe(false);
});

test.each([
  ["draining", false, "passed"],
  ["draining", true, "failed"],
  ["offline", false, undefined],
] as const)(
  "maintenance observation during %s (broken helpers: %s) never enables dispatch",
  async (status, broken, expected) => {
    const project = "fixture",
      id = "worker-a";
    store.uow.run((tx) =>
      tx.machines.put(project, { ...machine(id, id), status }),
    );
    if (broken) readiness.mockResolvedValue(["worker_helpers"]);
    const options = {
      store,
      project,
      machine: id,
      observationId: "maintenance-check",
      helperConfirmation: {
        binding:
          router.resolve(project, id).execution.target?.fingerprint ??
          "missing",
      },
      catalog: () => [],
    };
    const observed = await observeRegisteredMachine(options, () => router);
    expect(readiness).toHaveBeenCalledOnce();
    expect(observed.maintenance?.status).toBe(expected);
    if (broken)
      expect(observed.maintenance?.failed_steps).toEqual(["worker_helpers"]);
    expect(observed.health).toMatchObject({
      status: "failed",
      available: false,
      launch_enabled: false,
      blockers: expect.arrayContaining(["machine_not_ready"]),
    });
    expect(store.uow.read((tx) => tx.machines.get(project, id)?.status)).toBe(
      status,
    );
    await expect(router.forLaunch(project, assignment(id))).rejects.toThrow(
      "machine_not_ready",
    );
    const { helperConfirmation: _confirmation, ...ordinary } = options;
    expect(
      (await observeRegisteredMachine(ordinary, () => router)).maintenance,
    ).toBeUndefined();
  },
);

test("a manual confirmation may ignore drain but not a failed automatic upgrade", async () => {
  const project = "fixture",
    id = "worker-a";
  store.uow.run((tx) => {
    tx.machines.put(project, { ...machine(id, id), status: "draining" });
    store.database
      .prepare(
        "INSERT INTO worker_helper_upgrades (project_id,machine_id,release_key,state) VALUES (?,?,?,'failed')",
      )
      .run(project, id, "fixture-release");
  });
  const observed = await observeRegisteredMachine(
    {
      store,
      project,
      machine: id,
      observationId: "confirm-held",
      helperConfirmation: {
        binding:
          router.resolve(project, id).execution.target?.fingerprint ??
          "missing",
      },
      catalog: () => [],
    },
    () => router,
  );
  expect(observed.maintenance).toEqual({
    status: "failed",
    failed_steps: [upgradeHold],
  });
  expect(observed.health?.available).toBe(false);
});

test("machine checks persist a fixed routing reason before or during the probe", async () => {
  const options = {
    store,
    project: "fixture",
    machine: "worker-a",
    catalog: () => [],
  };
  const check = () => observeRegisteredMachine(options, () => router);
  workers = workers.map((w) => ({ ...w, arch: "other" }));
  expect((await check()).health?.blockers).toEqual([
    "invalid_launch",
    "target_mismatch",
  ]);
  workers = workers.map((w) => ({
    ...w,
    arch: "x64",
    execution: { ...w.execution, path: "" },
  }));
  expect((await check()).health?.blockers).toEqual([
    "invalid_launch",
    "worker_configuration_incomplete",
  ]);
});

test.each([
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
] as const)(
  "$os environment edits drain only the affected binding and survive restart",
  async (platform) => {
    workers = workers.map((w) => ({ ...w, ...platform }));
    store.uow.run((tx) => {
      for (const w of workers)
        tx.machines.put("fixture", {
          ...machine(w.machine_id, w.execution.machine),
          ...platform,
        });
    });
    const a = assignment("worker-a");
    const ref = value(
      await router.provision(a, role, machine("worker-a"), launch),
    );
    let run = {
      id: "R-1",
      assignment_id: a.id,
      trigger_event_id: "evt",
      kind: "initial",
      status: "running",
      role_version: 1,
      model: "fixture",
      agent_cli_version: "fixture",
      outcome: null,
      summary: "",
    } as import("@cardigan/domain").Run;
    store.uow.run((tx) => {
      tx.assignments.put("fixture", { ...a, runtime_ref: ref });
      tx.runs.put("fixture", run);
    });
    workers = workers.map((w) =>
      w.machine_id === "worker-a"
        ? {
            ...w,
            execution: {
              ...w.execution,
              path: "/new/bin:/usr/bin",
              env: { ANDROID_HOME: "/new/sdk" },
            },
          }
        : w,
    );
    const restarted = router.forProject("fixture");
    expect(restarted.executionForRef(ref)).toMatchObject({
      path: "/usr/bin:/bin",
      target: ref.target,
    });
    expect((await restarted.status(ref)).ok).toBe(true);
    expect(
      await restarted.forLaunch("fixture", assignment("worker-b")),
    ).toBeDefined();
    await expect(
      restarted.forLaunch("fixture", assignment("worker-a")),
    ).rejects.toThrow("worker_binding_draining");
    // A publication may outlive its process: waiting work must not drain itself.
    if (!ref.target) throw new Error("Missing target");
    const oldPublication = {
      generation: "old",
      target: ref.target,
      phase: "preparing" as const,
      lease_until: "2030-01-01T00:00:00.000Z",
      agent_name: "fixture",
      work_dir: "fixture",
      sha: null,
      token_id: null,
      runtime_ref: null,
      process: null,
      log_offset: 0,
      artifacts: [],
      wait: true,
      provision_attempted: true,
    };
    run = {
      ...run,
      status: "queued",
      queue_reason: "awaiting_dispatch",
      launch_publication: oldPublication,
    };
    store.uow.run((tx) => {
      tx.assignments.put("fixture", { ...a, runtime_ref: null });
      tx.runs.put("fixture", run);
    });
    expect(restarted.bindingState("fixture", "worker-a").pending).toBe(true);
    store.uow.run((tx) =>
      tx.runs.put("fixture", {
        ...run,
        launch_publication: { ...oldPublication, phase: "exited" },
      }),
    );
    expect(restarted.bindingState("fixture", "worker-a").pending).toBe(false);
    expect(value(await restarted.check("fixture", "worker-a"))).toMatchObject({
      launch_enabled: true,
      blockers: [],
    });
    expect((await restarted.forLaunch("fixture", a)).execution).toMatchObject({
      path: "/new/bin:/usr/bin",
    });
    workers = workers.map((w) => ({
      ...w,
      execution: { ...w.execution, user: "different" },
    }));
    expect((await restarted.status(ref)).ok).toBe(false);
  },
);

test("only a checked PATH-only binding can reuse the original session; a revoked send slot stays closed", async () => {
  const base = assignment("worker-a");
  const ref = value(
    await router.provision(base, role, machine("worker-a"), launch),
  );
  const a = { ...base, runtime_ref: ref, runtime_state: "idle" as const };
  store.uow.run((tx) => tx.assignments.put("fixture", a));
  workers = workers.map((w) => ({
    ...w,
    execution: { ...w.execution, path: "/next/bin:/usr/bin" },
  }));
  const fp = router.changedSessionEnvironment("fixture", a);
  if (!fp) throw new Error("missing edited target");
  expect(await router.canAdmitSession("fixture", a, fp)).toBe(true);
  expect((await router.forSession("fixture", a)).execution.target).toEqual(
    ref.target,
  );
  await expect(router.forLaunch("fixture", a)).rejects.toThrow(
    "target_mismatch",
  );
  const run = {
    id: "R-2",
    assignment_id: a.id,
    status: "dispatched",
    kind: "initial",
    trigger_event_id: "fixture",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "fixture",
    outcome: null,
    summary: "",
    session_environment_binding: fp,
  } as import("@cardigan/domain").Run;
  store.uow.run((tx) => tx.runs.put("fixture", run));
  expect((await router.forLaunch("fixture", base)).execution).toMatchObject({
    path: "/next/bin:/usr/bin",
  });
  await router.wake(ref, "next", {
    session_run: { assignment_id: a.id, run_id: run.id },
    before_send: () => true,
  });
  const options = calls.mock.calls.findLast(
    (c) => c[1] === "wake",
  )?.[4] as RuntimeWakeOptions;
  expect(options).toMatchObject({
    if_idle: true,
    retirement_owner: { project_id: "fixture", assignment_id: a.id },
  });
  expect(options.before_send?.()).toBe(true);
  workers = workers.map((w) => ({ ...w, allow_remote_launch: false }));
  expect(options.before_send?.()).toBe(false);
  expect(await router.canAdmitSession("fixture", a, fp)).toBe(false);
});

test("C-597: macOS retirement forwards only the stored launch's process and harness, never caller-supplied ones", async () => {
  const platform = { os: "darwin", arch: "arm64" } as const;
  workers = workers.map((w) => ({
    ...w,
    ...platform,
    execution: {
      ...w.execution,
      macosCore: { python: "/bin/python3", retiredLaunchdLabel: "fixture" },
    },
  }));
  store.uow.run((tx) => {
    for (const w of workers)
      tx.machines.put("fixture", {
        ...machine(w.machine_id, w.execution.machine),
        ...platform,
      });
  });
  const a = assignment("worker-a");
  const provisioned = value(
    await router.provision(
      a,
      role,
      { ...machine("worker-a"), ...platform },
      launch,
    ),
  );
  if (!provisioned.target) throw new Error("Missing target");
  const ref: RuntimeRef = {
    ...provisioned,
    launch_generation: { run_id: "R-9" as never, generation: "g9" },
  };
  const stored = {
    machine: provisioned.target.fingerprint,
    boot: "boot",
    uid: 501,
    pid: 4242,
    start: "1",
    process_group: 4242,
    terminal: "g9",
  };
  const run = {
    id: "R-9",
    assignment_id: a.id,
    trigger_event_id: "evt",
    kind: "initial",
    status: "completed",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "fixture",
    outcome: "success",
    summary: "",
    harness: "codex",
    launch_publication: {
      generation: "g9",
      target: provisioned.target,
      phase: "started",
      lease_until: "2030-01-01T00:00:00.000Z",
      agent_name: "fixture",
      work_dir: "fixture",
      sha: null,
      token_id: null,
      runtime_ref: ref,
      process: stored,
      log_offset: 0,
      artifacts: [],
      wait: true,
      provision_attempted: true,
    },
  } as unknown as import("@cardigan/domain").Run;
  const forwarded = async () => {
    calls.mockClear();
    value(
      await router.retire_idle(ref, {
        project_id: "fixture",
        assignment_id: a.id,
        hangup_ms: 1,
        terminate_ms: 1,
        harness: "claude-code",
        enrolled_process: { ...stored, pid: 1 },
        before_signal: () => true,
      }),
    );
    const options = calls.mock.calls.find((c) => c[1] === "retire_idle")?.[3];
    return { harness: options.harness, process: options.enrolled_process };
  };
  store.uow.run((tx) => {
    tx.assignments.put("fixture", { ...a, runtime_ref: ref });
    tx.runs.put("fixture", run);
  });
  expect(await forwarded()).toEqual({ harness: "codex", process: stored });
  const { harness: _harness, ...unrecorded } = run;
  store.uow.run((tx) => tx.runs.put("fixture", unrecorded));
  expect(await forwarded()).toEqual({ harness: undefined, process: stored });
  store.uow.run((tx) =>
    tx.runs.put("fixture", {
      ...run,
      launch_publication: { ...run.launch_publication!, generation: "other" },
    }),
  );
  expect(await forwarded()).toEqual({
    harness: undefined,
    process: undefined,
  });
});
