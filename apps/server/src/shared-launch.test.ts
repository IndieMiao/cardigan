import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Assignment,
  Runtime,
  RuntimeLaunch,
  RuntimeRef,
} from "@cardigan/domain";
import {
  claimDispatchStop,
  queueRun,
  recoverDispatch,
  startDispatchStop,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * The CLI entry (`cardigan assignment start`) and the server entry (the
 * Dispatcher opening a terminal for a bell) must run the *same* implementation,
 * so a fix or a compensation step can never be added to only one of them.
 *
 * The shared module is wrapped in a spy that still calls the real function:
 * both entries are exercised end to end and every call is accounted for.
 */
vi.mock("@cardigan/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cardigan/host")>();
  return { ...actual, launchRun: vi.fn(actual.launchRun) };
});

import { type CliIo, startAssignment } from "@cardigan/cli";
import { launchRun } from "@cardigan/host";
import { dispatchFixture } from "../test-support/dispatch.js";
import { startQueuedRun } from "./host-start.js";

const launch = {
  config: parseLaunchConfig({
    profiles: { fixture: { harness: "pi", model: "fixture-model" } },
  }),
  secrets: {},
};
const mcpUrl = "http://127.0.0.1:3004/mcp";

interface Fixture {
  readonly f: ReturnType<typeof dispatchFixture>;
  readonly assignment: Assignment;
  readonly runtime: Runtime & {
    failProvision(): void;
    rejectDispatch(): void;
  };
  readonly provisions: RuntimeLaunch[];
  readonly released: RuntimeRef[];
  readonly io: CliIo;
}

function fixture(): Fixture {
  const f = dispatchFixture();
  const { assignment } = f.create();
  const provisions: RuntimeLaunch[] = [];
  const released: RuntimeRef[] = [];
  let provisionFailure = false;
  let wrongMachine = false;
  const refFor = (agentName: string): RuntimeRef => ({
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: "t1",
    agent_name: agentName,
  });
  const runtime = {
    provision: vi.fn(async (_a, _r, _m, desc: RuntimeLaunch) => {
      provisions.push(desc);
      if (provisionFailure)
        return {
          ok: false as const,
          error: { code: "runtime_unavailable" as const, message: "socket" },
        };
      const ref = refFor(desc.agent_name);
      return {
        ok: true as const,
        value: wrongMachine ? { ...ref, machine_id: "remote" as never } : ref,
      };
    }),
    release: vi.fn(async (ref: RuntimeRef) => {
      released.push(ref);
      return { ok: true as const, value: undefined };
    }),
    wake: async () => ({ ok: true as const, value: { sent: true } }),
    status: async () => ({
      ok: false as const,
      error: { code: "runtime_not_found" as const, message: "unused" },
    }),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "unused" },
    }),
    human_entry: async () => ({ ok: true as const, value: "attach" }),
    failProvision: () => {
      provisionFailure = true;
    },
    rejectDispatch: () => {
      wrongMachine = true;
    },
  };
  const io: CliIo = {
    env: { CARDIGAN_RUNTIME_MODE: "local", CARDIGAN_DATA_DIR: f.dataDir },
    cwd: f.dataDir,
    platform: "linux",
    stdout: () => undefined,
    stderr: () => undefined,
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("assignment start must not spawn");
    },
    captureCommand: async () => ({
      code: 0,
      stdout: "pi 1.5.0-fixture\n",
      stderr: "",
    }),
  };
  return { f, assignment, runtime, provisions, released, io };
}

let x: Fixture;
beforeEach(() => {
  x = fixture();
  vi.mocked(launchRun).mockClear();
});
afterEach(() => x.f.close());

const startFromCli = (assignment: Assignment) =>
  startAssignment({
    store: x.f.store,
    io: x.io,
    project_id: x.f.project,
    assignment_id: assignment.id,
    launch,
    mcpUrl,
    runtime: x.runtime,
    dataDir: x.f.dataDir,
  });

/** Queue a bell-triggered Run the way the Router would before `startRun`. */
const startFromServer = async (assignment: Assignment) => {
  const run = x.f.apply((state, who, ports) =>
    queueRun(
      state,
      who,
      {
        assignment_id: assignment.id,
        model: "fixture-model",
        agent_cli_version: "pi 1.5.0-fixture",
        kind: "rework",
        trigger_event_id: "E-900" as never,
      },
      ports,
    ),
  );
  await startQueuedRun(
    {
      store: x.f.store,
      runtime: x.runtime,
      launch,
      mcpUrl,
      dataDir: x.f.dataDir,
    },
    {
      project: x.f.project,
      assignment:
        x.f.state().assignments.find((a) => a.id === assignment.id) ??
        assignment,
      run,
      bell: "[bell] card=C-1 asg=A-2 summary=fixture",
    },
  );
  return run;
};

test("both entries start a terminal through the same launchRun", async () => {
  const cliAssignment = x.assignment;
  const serverAssignment = x.f.create().assignment;

  const started = await startFromCli(cliAssignment);
  const serverRun = await startFromServer(serverAssignment);

  const spy = vi.mocked(launchRun);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls.map(([, input]) => input.assignment_id)).toEqual([
    cliAssignment.id,
    serverAssignment.id,
  ]);
  // Both entries hand the shared flow the same host facts; only the domain
  // actor differs (human for the CLI, system for the Dispatcher).
  for (const [host, input] of spy.mock.calls) {
    expect(host.runtime).toBe(x.runtime);
    expect(host.launch).toBe(launch);
    expect(host.mcpUrl).toBe(mcpUrl);
    expect(host.execution?.mode ?? "local").toBe("local");
    expect(input.run.status).toBe("queued");
  }
  expect(spy.mock.calls[0]?.[1].actor.kind).toBe("human");
  expect(spy.mock.calls[1]?.[1].actor.kind).toBe("system");

  // The observable outcome is identical: dispatched Runs, one naming rule, and
  // each entry's own first prompt compiled by the same step.
  const runs = x.f.state().runs;
  expect(runs.map((run) => run.status)).toEqual(["dispatched", "dispatched"]);
  expect(started.run_id).toBe(runs[0]?.id);
  expect(serverRun.id).toBe(runs[1]?.id);
  expect(x.provisions).toHaveLength(2);
  for (const provisioned of x.provisions)
    expect(provisioned.agent_name).toMatch(/^coder-[0-9a-f]{24}$/u);
  const firstFile = (id: Assignment["id"]) =>
    readFileSync(
      join(x.f.dataDir, "runs", x.f.project, id, "first.md"),
      "utf8",
    );
  expect(firstFile(cliAssignment.id)).toContain("kind=initial");
  expect(firstFile(serverAssignment.id)).toContain(
    "[bell] card=C-1 asg=A-2 summary=fixture",
  );
});

const failures = [
  { entry: "cli", failure: "provision" },
  { entry: "cli", failure: "dispatch" },
  { entry: "server", failure: "provision" },
  { entry: "server", failure: "dispatch" },
] as const;

test.each(failures)(
  "$entry entry compensates a $failure failure the same way",
  async ({ entry, failure }) => {
    if (failure === "provision") x.runtime.failProvision();
    else x.runtime.rejectDispatch();

    const attempt =
      entry === "cli"
        ? startFromCli(x.assignment)
        : startFromServer(x.assignment);
    await expect(attempt).rejects.toThrow();

    // The Run is cancelled, not left queued: a later start is not blocked.
    const runs = x.f.state().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("cancelled");
    // The token issued for this attempt is revoked, and no plaintext survives.
    const tokens = x.f.store.uow.run((tx) =>
      tx.tokensForAssignment(x.f.project, x.assignment.id),
    );
    expect(tokens).toHaveLength(1);
    expect(tokens.every((token) => token.revoked_at !== null)).toBe(true);
    const runDir = join(x.f.dataDir, "runs", x.f.project, x.assignment.id);
    // A dispatched-but-rejected Run releases its terminal; a failed provision
    // has no terminal to release. The sentinel never appears, so the Agent
    // could not have started.
    for (const name of ["token", "secrets.env", "start"])
      expect(existsSync(join(runDir, name)), name).toBe(false);
    expect(x.released).toHaveLength(failure === "dispatch" ? 1 : 0);
  },
);

test("C3 new roots give local terminals a host-generated launch generation; legacy roots do not", async () => {
  x.f.store.uow.run((tx) => {
    const card = tx.cards.list(x.f.project)[0];
    if (!card) throw new Error("Missing card");
    tx.cards.put(x.f.project, { ...card, flow_version: 6 });
  });
  await startFromCli(x.assignment);
  expect(x.f.state().runs[0]?.recovery_policy?.version).toBe(6);
  expect(x.provisions[0]?.labels.generation).toMatch(/^[a-f0-9-]{36}$/u);
  const old = x.f.create().assignment;
  await startFromCli(old);
  expect(x.provisions[1]?.labels.generation).toBeUndefined();
});

test("a C3 successor refuses changed launch settings before provisioning and keeps its spent budget", async () => {
  x.f.store.uow.run((tx) => {
    const card = tx.cards.list(x.f.project)[0];
    if (!card) throw new Error("Missing card");
    tx.cards.put(x.f.project, { ...card, flow_version: 6 });
  });
  await startFromCli(x.assignment);
  const original = x.f.state().runs[0];
  if (!original) throw new Error("Missing original");
  const system = { kind: "system" as const, project_id: x.f.project };
  const claimed = x.f.apply(
    (s, a, p) =>
      claimDispatchStop(
        s,
        a,
        { run_id: original.id, reason: "dispatch_timeout", lease_ms: 60000 },
        p,
      ),
    system,
  );
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("Missing fence");
  x.f.apply(
    (s, a, p) =>
      startDispatchStop(
        s,
        a,
        { run_id: original.id, attempt_id: stop.attempt_id },
        p,
      ),
    system,
  );
  const next = x.f.apply(
    (s, a, p) =>
      recoverDispatch(
        s,
        a,
        {
          run_id: original.id,
          timeout_ms: 100,
          max_failures: 1,
          failed_attempts: 0,
          stop_id: stop.attempt_id,
          stopped_runtime: stop.runtime_ref,
        },
        p,
      ),
    system,
  );
  if (!next) throw new Error("Missing successor");
  const changed = {
    config: parseLaunchConfig({
      profiles: { fixture: { harness: "pi", model: "changed-model" } },
    }),
    secrets: {},
  };
  await expect(
    startQueuedRun(
      {
        store: x.f.store,
        runtime: x.runtime,
        launch: changed,
        mcpUrl,
        dataDir: x.f.dataDir,
      },
      {
        project: x.f.project,
        assignment: x.assignment,
        run: next,
        bell: "fixture",
      },
    ),
  ).rejects.toThrow("Recovery launch settings changed");
  expect(x.provisions).toHaveLength(1);
  expect(x.f.state().runs.find((r) => r.id === next.id)?.status).toBe(
    "cancelled",
  );
  expect(
    x.f.state().events.filter((e) => e.type === "run_dispatch_recovered"),
  ).toHaveLength(1);
});
