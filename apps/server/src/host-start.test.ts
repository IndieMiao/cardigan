import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Runtime, RuntimeLaunch, RuntimeRef } from "@cardigan/domain";
import {
  postComment,
  queueRun,
  stoppedByHuman,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { runCapacitySnapshot } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import { unfinishedBellAttempts } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import { hostMcpUrl } from "./host.js";
import { startQueuedRun } from "./host-start.js";

const launch = parseLaunchConfig({
  profiles: { fixture: { harness: "pi", model: "fixture-model" } },
});

let f: ReturnType<typeof dispatchFixture>;
let runtime: Runtime;
let provisioned: RuntimeLaunch[];

beforeEach(() => {
  f = dispatchFixture();
  provisioned = [];
  runtime = {
    provision: vi.fn(async (_a, _r, _m, desc: RuntimeLaunch) => {
      provisioned.push(desc);
      return {
        ok: true as const,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t9",
          agent_name: desc.agent_name,
        } satisfies RuntimeRef,
      };
    }),
    status: vi.fn(async () => ({
      ok: true as const,
      value: { process: "alive" as const, agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    interrupt: vi.fn(async () => ({ ok: true as const, value: undefined })),
    resume_or_replace: vi.fn(async () => ({
      ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "unused" },
    })),
    human_entry: vi.fn(async () => ({ ok: true as const, value: "attach" })),
  };
});
afterEach(() => f.close());

/** Queue a Run the way the Router would: a bell-triggered follow-up. */
function queuedRun(assignmentId?: string) {
  const created = f.create();
  const assignment =
    assignmentId === undefined
      ? created.assignment
      : (f.state().assignments.find((a) => a.id === assignmentId) ??
        created.assignment);
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        model: "fixture-model",
        agent_cli_version: "pi 1.5.0",
        kind: "rework",
        trigger_event_id: "E-900" as never,
      },
      p,
    ),
  );
  return { ...created, assignment, run };
}

const host = (dataDir: string) => ({
  store: f.store,
  runtime,
  launch: { config: launch, secrets: {} },
  mcpUrl: "http://127.0.0.1:3004/mcp",
  dataDir,
});

test("the host starts a terminal for the given Run and never queues a second one", async () => {
  const { assignment, run } = queuedRun();
  const bell =
    '[bell] card=C-1 asg=A-1 seq=3..7 summary="2 comments"\n→ 请调用 card.get_updates 读取详情';

  await startQueuedRun(host(f.dataDir), {
    project: f.project,
    assignment,
    run,
    bell,
  });

  const state = f.state();
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0]?.id).toBe(run.id);
  expect(state.runs[0]?.status).toBe("dispatched");
  const after = state.assignments.find((a) => a.id === assignment.id);
  expect(after?.runtime_ref?.terminal_ref).toBe("t9");
  expect(after?.runtime_state).toBe("running");

  // The bell is the first prompt, and the wrapper only runs after dispatch.
  const runDir = join(f.dataDir, "runs", f.project, assignment.id);
  expect(readFileSync(join(runDir, "first.md"), "utf8")).toContain(bell);
  expect(existsSync(join(runDir, "start"))).toBe(true);
  expect(existsSync(join(runDir, "token"))).toBe(true);
  expect(existsSync(join(runDir, "test-workers.cjs"))).toBe(true);
  expect(readFileSync(join(runDir, "launch.sh"), "utf8")).toContain(
    "export NODE_OPTIONS=",
  );
  expect(readFileSync(join(runDir, "launch.sh"), "utf8")).toContain(
    "export CARDIGAN_AGENT_LOCAL_TESTS='1'",
  );
  // The launch describes the Run, not a new one.
  expect(provisioned[0]?.labels).toMatchObject({
    cardigan: "1",
    project: f.project,
    assignment: assignment.id,
    run: run.id,
  });
  expect(provisioned[0]?.cwd).toBe(runDir);
});

test("dispatcher forwards the host test policy directory and rejects invalid policy before provisioning", async () => {
  const { assignment, run } = queuedRun();
  const configDir = join(f.dataDir, "policy");
  mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(configDir, "agent-tests.yaml"), "max_workers: 0\n", {
    mode: 0o600,
  });
  await expect(
    startQueuedRun(
      { ...host(f.dataDir), configDir },
      {
        project: f.project,
        assignment,
        run,
        bell: "[bell] fixture",
      },
    ),
  ).rejects.toThrow("agent-tests.yaml");
  expect(runtime.provision).not.toHaveBeenCalled();
  expect(f.state().runs[0]?.status).toBe("cancelled");
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, assignment.id))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
});

test("a previous token is revoked when the host issues the new one", async () => {
  const { assignment, run } = queuedRun();
  // The CLI would have issued one at M2.6 start time.
  f.store.issueToken({
    project_id: f.project,
    assignment_id: assignment.id,
    role: { role_version: assignment.role_version, allowed_tools: ["whoami"] },
    token: "fixture-previous-token",
  });
  const before = f.store.uow.run((tx) =>
    tx.tokensForAssignment(f.project, assignment.id),
  );
  expect(before.length).toBe(1);

  await startQueuedRun(host(f.dataDir), {
    project: f.project,
    assignment,
    run,
    bell: "[bell] fixture",
  });

  const after = f.store.uow.run((tx) =>
    tx.tokensForAssignment(f.project, assignment.id),
  );
  expect(after.filter((token) => token.revoked_at === null)).toHaveLength(1);
  expect(after.filter((token) => token.revoked_at === null)[0]?.id).not.toBe(
    before.at(-1)?.id,
  );
});

test("a provision failure cancels the Run, revokes the token and leaves no plaintext", async () => {
  const { assignment, run } = queuedRun();
  runtime.provision = vi.fn(async () => ({
    ok: false as const,
    error: { code: "runtime_unavailable" as const, message: "socket gone" },
  }));

  await expect(
    startQueuedRun(host(f.dataDir), {
      project: f.project,
      assignment,
      run,
      bell: "[bell] fixture",
    }),
  ).rejects.toThrow(/provision failed/);

  const state = f.state();
  expect(state.runs[0]?.status).toBe("cancelled");
  const runDir = join(f.dataDir, "runs", f.project, assignment.id);
  for (const name of ["token", "secrets.env", "start"])
    expect(existsSync(join(runDir, name)), name).toBe(false);
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, assignment.id))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
});

test("a dispatch failure releases the terminal before aborting the Run", async () => {
  const { assignment, run } = queuedRun();
  // A terminal on the wrong machine is refused by dispatchRun.
  runtime.provision = vi.fn(async (_a, _r, _m, desc: RuntimeLaunch) => ({
    ok: true as const,
    value: {
      machine_id: "remote",
      runtime_machine: "remote",
      terminal_ref: "t9",
      agent_name: desc.agent_name,
    } as never,
  }));

  await expect(
    startQueuedRun(host(f.dataDir), {
      project: f.project,
      assignment,
      run,
      bell: "[bell] fixture",
    }),
  ).rejects.toThrow();

  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(f.state().runs[0]?.status).toBe("cancelled");
});

test("C-227 a stop during provisioning releases the terminal and startup reservation so the next Run can dispatch", async () => {
  const notify = ({ card, item }: ReturnType<typeof f.create>) =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        { card_id: card.id, work_item_id: item.id, body: "Start this task" },
        p,
      ),
    );
  const target = f.create();
  const { assignment } = target;
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: assignment.id,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      p,
    ),
  );
  notify(target);
  const occupied = () =>
    f.store.uow.read((tx) =>
      runCapacitySnapshot(f.store, tx).occupied.get("local"),
    );
  const dispatcher = new Dispatcher({
    store: f.store,
    runtime,
    clock: f.clock,
    runLimit: () => 1,
    snapshot: async () => ({
      model: "fixture-model",
      agent_cli_version: "pi fixture",
    }),
    startRun: (input) =>
      startQueuedRun({ ...host(f.dataDir), clock: f.clock }, input),
  });
  // The human stops the Assignment after the host provisioned the terminal
  // but before dispatchRun commits (the in-flight window of a fresh start).
  vi.mocked(runtime.provision).mockImplementationOnce(
    async (_a, _r, _m, desc) => {
      expect(occupied()).toBe(1);
      expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([
        expect.objectContaining({ run_id: run.id, finished_at: null }),
      ]);
      expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
        "queued",
      );
      const stopped = f.apply((s, a, p) =>
        stopWorkItemAssignment(
          s,
          a,
          { assignment_id: assignment.id, reason: "stopped by host" },
          p,
        ),
      );
      expect(stopped.cancelled).toBe(1);
      return {
        ok: true as const,
        value: {
          machine_id: "local",
          runtime_machine: "local",
          terminal_ref: "t9",
          agent_name: desc.agent_name,
        } satisfies RuntimeRef,
      };
    },
  );

  await dispatcher.tick();

  // Compensation force-releases exactly the terminal this start created.
  expect(runtime.provision).toHaveBeenCalledTimes(1);
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(runtime.release).toHaveBeenCalledWith(
    expect.objectContaining({ terminal_ref: "t9" }),
    { force: true },
  );
  const state = f.state();
  expect(state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    summary: "stopped by host",
  });
  expect(
    state.events.some(
      (e) =>
        e.type === "run_dispatched" &&
        (e.payload as { run_id?: string }).run_id === run.id,
    ),
  ).toBe(false);
  expect(stoppedByHuman(state.events, assignment.id)).toBe(true);
  expect(
    state.assignments.find((a) => a.id === assignment.id)?.runtime_ref
      ?.terminal_ref,
  ).not.toBe("t9");
  // The wrapper never got its start sentinel, so the Agent never started,
  // and no plaintext credential or live token is left behind.
  const runDir = join(f.dataDir, "runs", f.project, assignment.id);
  for (const name of ["token", "secrets.env", "start"])
    expect(existsSync(join(runDir, name)), name).toBe(false);
  expect(
    f.store.uow
      .run((tx) => tx.tokensForAssignment(f.project, assignment.id))
      .every((token) => token.revoked_at !== null),
  ).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(occupied()).toBe(0);

  // Exercise the same one-slot scheduler again: neither the cancelled Run
  // nor its finished startup reservation may prevent another task starting.
  const next = f.create();
  notify(next);
  await dispatcher.tick();
  expect(
    f.state().runs.filter((r) => r.assignment_id === next.assignment.id),
  ).toEqual([expect.objectContaining({ status: "dispatched" })]);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(runtime.provision).toHaveBeenCalledTimes(2);
  expect(runtime.release).toHaveBeenCalledTimes(1);
  expect(unfinishedBellAttempts(f.store.database, f.project)).toEqual([]);
  expect(occupied()).toBe(1);
});

test("C-235 a start whose Run the stop already cancelled provisions nothing", async () => {
  const { assignment, run } = queuedRun();
  f.apply((s, a, p) =>
    stopWorkItemAssignment(
      s,
      a,
      { assignment_id: assignment.id, reason: "stopped by host" },
      p,
    ),
  );
  await expect(
    startQueuedRun(host(f.dataDir), {
      project: f.project,
      assignment,
      run,
      bell: "[bell] fixture",
    }),
  ).rejects.toThrow();
  expect(runtime.provision).not.toHaveBeenCalled();
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(
    existsSync(join(f.dataDir, "runs", f.project, assignment.id, "start")),
  ).toBe(false);
});

test("a planted start symlink is replaced, never followed", async () => {
  const { assignment, run } = queuedRun();
  const runDir = join(f.dataDir, "runs", f.project, assignment.id);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const target = join(f.dataDir, "host-file");
  writeFileSync(target, "host-private");
  rmSync(join(runDir, "start"), { force: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(target, join(runDir, "start"));

  await startQueuedRun(host(f.dataDir), {
    project: f.project,
    assignment,
    run,
    bell: "[bell] fixture",
  });

  expect(readFileSync(target, "utf8")).toBe("host-private");
  expect(lstatSync(join(runDir, "start")).isSymbolicLink()).toBe(false);
});

test("host start rejects an external identity before runtime, credentials or session changes", async () => {
  const { assignment, run } = queuedRun();
  const { work_item_id: _work, ...base } = assignment;
  const external = {
    ...base,
    id: "A-99" as const,
    scope: "standing" as const,
    standing_mode: "office" as const,
    role_id: "pm",
    external: true,
  };
  f.store.uow.run((tx) => tx.assignments.put(f.project, external));
  await expect(
    startQueuedRun(host(f.dataDir), {
      project: f.project,
      assignment: external,
      run: { ...run, assignment_id: external.id },
      bell: "fixture",
    }),
  ).rejects.toThrow("这是外接 Assignment");
  expect(f.state().assignments.find((a) => a.id === external.id)).toEqual(
    external,
  );
  expect(
    f.store.uow.run((tx) => tx.tokensForAssignment(f.project, external.id)),
  ).toEqual([]);
  expect(runtime.provision).not.toHaveBeenCalled();
  expect(runtime.status).not.toHaveBeenCalled();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(existsSync(join(f.dataDir, "runs", f.project, external.id))).toBe(
    false,
  );
});

test("C-211 a new session on a non-default CARDIGAN_MCP_PORT gets that port in its MCP config", async () => {
  const { assignment, run } = queuedRun();
  const mcpUrl = hostMcpUrl(undefined, { CARDIGAN_MCP_PORT: "4610" })();

  await startQueuedRun(
    { ...host(f.dataDir), mcpUrl },
    { project: f.project, assignment, run, bell: "[bell] card=C-1" },
  );

  const runDir = join(f.dataDir, "runs", f.project, assignment.id);
  const config = JSON.parse(
    readFileSync(join(runDir, "pi", "mcp.json"), "utf8"),
  ) as { mcpServers: Record<string, { url: string }> };
  const urls = Object.values(config.mcpServers).map((server) => server.url);
  expect(urls).toContain("http://127.0.0.1:4610/mcp");
  expect(JSON.stringify(config)).not.toContain(":3004");
});

test("C-497 cold start checks after provisioning, withholds the sentinel and keeps the same Run queued", async () => {
  const { assignment, run } = queuedRun();
  vi.mocked(runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "exited", agent: "idle", observed_seq: 1 },
  });
  const probe = vi.fn(async () => provisioned.length === 0);
  const input = {
    project: f.project,
    assignment,
    run,
    bell: "cold start",
    resourcePreflight: probe,
  };
  await expect(startQueuedRun(host(f.dataDir), input)).rejects.toThrow();
  expect(provisioned).toHaveLength(1);
  expect(probe).toHaveBeenCalled();
  const sentinel = join(f.dataDir, "runs", f.project, assignment.id, "start");
  expect(existsSync(sentinel)).toBe(false);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe("queued");
  probe.mockResolvedValue(true);
  await startQueuedRun(host(f.dataDir), input);
  expect(existsSync(sentinel)).toBe(true);
  expect(f.state().runs.find((r) => r.id === run.id)?.status).toBe(
    "dispatched",
  );
});
