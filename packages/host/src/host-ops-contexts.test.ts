import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  createHostOpsAssignment,
  dispatchRun,
  HOST_OPS_ROLE_TOOLS,
  type HostOpsExecution,
  pendingHostOpsActions,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import {
  authenticate,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store, writeContextSamples } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  readSessionContexts,
  type SessionContextDiagnostic,
} from "./context-usage.js";
import { HostOpsService } from "./host-ops.js";
import { UpstreamHealthMonitor } from "./upstream-health.js";

vi.mock("./context-usage.js", async (original) => ({
  ...(await original<typeof import("./context-usage.js")>()),
  readSessionContexts: vi.fn(async () => []),
}));

let root: string, store: Store, service: HostOpsService;
let monitor: UpstreamHealthMonitor;
let time: number;
const project = "fixture";
const clock = { now: () => new Date(time).toISOString() };
const runtime = { status: vi.fn(), release: vi.fn() } as unknown as Runtime;
beforeEach(async () => {
  time = Date.parse("2026-01-01T00:01:00.000Z");
  root = await mkdtemp(join(tmpdir(), "host-contexts-"));
  store = Store.open({ dataDir: root });
  store.createProject({ id: project });
  vi.mocked(readSessionContexts).mockReset().mockResolvedValue([]);
  const exited = new Set<string>();
  vi.mocked(runtime.status)
    .mockReset()
    .mockImplementation(async (ref) => ({
      ok: true,
      value: {
        process: exited.has(ref.terminal_ref) ? "exited" : "alive",
        agent: "idle",
        observed_seq: 1,
      },
    }));
  vi.mocked(runtime.release)
    .mockReset()
    .mockImplementation(async (ref) => {
      exited.add(ref.terminal_ref);
      return { ok: true, value: undefined };
    });
  monitor = new UpstreamHealthMonitor(
    parseLaunchConfig({ providers: {}, profiles: {} }),
    runtime,
    clock,
  );
  service = new HostOpsService({
    store,
    runtime,
    clock,
    contextUsage: { execution: { mode: "local", dataDir: root } },
    upstreamMonitor: monitor,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
  });
});
afterEach(async () => {
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});

function pendingSample() {
  const sample = Promise.withResolvers<SessionContextDiagnostic[]>();
  vi.mocked(readSessionContexts).mockReturnValueOnce(sample.promise);
  return sample;
}

test.each([1, 11])(
  "a stuck poll of %s Assignments never blocks ticks or starts overlapping rounds",
  async (count) => {
    store.uow.run((tx) => {
      for (let index = 1; index <= count; index++)
        tx.assignments.put(project, {
          id: `A-${index}` as Assignment["id"],
          scope: "standing",
          role_id: "pm",
          role_version: 1,
          status: "active",
          runtime_state: "idle",
          runtime_ref: null,
          machine_id: "local",
          mcp_token_id: "fixture",
          created_at: clock.now(),
        });
    });
    const sample = pendingSample();
    let tickDone = false;
    const tick = service.tick().then(() => {
      tickDone = true;
    });
    try {
      await vi.waitFor(() => expect(tickDone).toBe(true));
      expect(readSessionContexts).toHaveBeenCalledOnce();
      expect(
        vi.mocked(readSessionContexts).mock.calls[0]?.[0].assignments,
      ).toHaveLength(count);
      time += 120_000; // Long enough for many usual polling intervals.
      await service.tick();
      await service.tick();
      expect(readSessionContexts).toHaveBeenCalledOnce();
    } finally {
      sample.resolve([]);
      await tick;
    }
    // Wait for completion, then prove ordinary upstream ticks do not immediately
    // restart a long poll just because its start time was many intervals ago.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.tick();
    expect(readSessionContexts).toHaveBeenCalledOnce();
    time += 30_000;
    await service.tick();
    expect(readSessionContexts).toHaveBeenCalledTimes(2);
  },
);

test("closing aborts the in-flight sample, waits for it and never publishes its late result", async () => {
  const sample = pendingSample();
  await service.tick();
  const signal = vi.mocked(readSessionContexts).mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(false);
  sample.resolve([
    {
      assignment_id: "A-1",
      stale: false,
      observation: {
        assignment_id: "A-1",
        updated_at: clock.now(),
        context_tokens: 100,
        context_window_size: 1000,
        used_percentage: 10,
      },
    } as SessionContextDiagnostic,
  ]);
  await closing;
  expect(service.contextUsage(project).size).toBe(0);
  await service.tick();
  expect(readSessionContexts).toHaveBeenCalledOnce();
});

test("a failed background sample releases its slot and a later round can recover", async () => {
  const sample = pendingSample();
  await service.tick();
  sample.reject(new Error("fixture read failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  time += 30_000;
  await service.tick();
  expect(readSessionContexts).toHaveBeenCalledTimes(2);
});

test("diagnostics and patrol reuse one project sample, including upstream diagnostics", async () => {
  const assignment = store.uow.run((tx) => {
    tx.roles.put(project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    });
    const effect = unwrap(
      createHostOpsAssignment(
        loadCommandState(tx, project),
        { kind: "human", project_id: project },
        {},
        { ids: tx.ids, clock },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data.assignment;
  });
  const token = store.issueToken({
    project_id: project,
    assignment_id: assignment.id,
    role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
  });
  const context = { store, identity: unwrap(authenticate(store, token.token)) };
  const sample = pendingSample();
  const reads = [
    service.tools.read(context),
    service.tools.read(context),
    service.inspectHarnessActivity(project),
  ];
  const tick = service.tick();
  try {
    await vi.waitFor(() => expect(readSessionContexts).toHaveBeenCalled());
    expect(readSessionContexts).toHaveBeenCalledOnce();
  } finally {
    sample.resolve([]);
  }
  await Promise.all([...reads, tick]);
  // observeUpstream must reuse diagnostics' completed sample, too.
  expect(readSessionContexts).toHaveBeenCalledOnce();
});

// Persist synthetic, already-authorized intents; exercise real claim, mutex,
// runtime checks and settlement instead of mocking drain/observeUpstream.
function intent(assignment: Assignment["id"], tool: HostOpsExecution["tool"]) {
  return store.uow.run((tx) => {
    tx.roles.put(project, {
      role_id: "pm",
      role_version: 1,
      allowed_tools: [],
      capabilities: [],
    });
    const ref = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: assignment,
      agent_name: "fixture",
    };
    tx.assignments.put(project, {
      id: assignment,
      scope: "standing",
      role_id: "pm",
      role_version: 1,
      standing_mode: "ops",
      status: "active",
      runtime_state: "idle",
      runtime_ref: ref,
      machine_id: "local",
      mcp_token_id: "fixture",
      created_at: clock.now(),
    });
    let runId: HostOpsExecution["run_id"];
    if (tool === "host_ops_cancel_run") {
      const queued = unwrap(
        queueRun(
          loadCommandState(tx, project),
          { kind: "human", project_id: project },
          {
            assignment_id: assignment,
            model: "fixture",
            agent_cli_version: "fixture",
          },
          { ids: tx.ids, clock },
        ),
      );
      persistEffect(tx, project, queued);
      runId = queued.data.id;
      persistEffect(
        tx,
        project,
        unwrap(
          dispatchRun(
            loadCommandState(tx, project),
            { kind: "system", project_id: project },
            { run_id: runId, runtime_ref: ref },
            { ids: tx.ids, clock },
          ),
        ),
      );
    }
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_ops_action_taken" as const,
      actor: { kind: "system" as const, project_id: project },
      created_at: clock.now(),
      payload: {
        execution: true,
        assignment_id: assignment,
        target_id: runId ?? assignment,
        ...(runId ? { run_id: runId } : {}),
        tool,
        runtime_ref: ref,
        reason: "fixture",
        snapshot: { model: "fixture", agent_cli_version: "fixture" },
      },
    };
    tx.events.append(project, event);
    return event.id;
  });
}
const state = () => store.uow.read((tx) => loadCommandState(tx, project));

test("a pending restart cannot pull stalled sampling back into ticks or block another cancellation", async () => {
  const restart = intent("A-1", "host_ops_restart_standing_pm");
  const cancel = intent("A-2", "host_ops_cancel_run");
  const sample = pendingSample();
  const observe = vi.spyOn(monitor, "observe");
  let tickDone = false;
  const tick = service.tick().then(() => {
    tickDone = true;
  });
  try {
    await vi.waitFor(() =>
      expect(observe.mock.calls.some(([, only]) => only === "A-1")).toBe(true),
    );
    await vi.waitFor(() => expect(tickDone).toBe(true));
    expect(
      pendingHostOpsActions(state().events).map((a) => a.action_id),
    ).toEqual([restart]);
    expect(
      state().events.some(
        (e) =>
          e.type === "host_ops_action_finished" &&
          e.payload.action_id === cancel,
      ),
    ).toBe(true);
    expect(runtime.release).toHaveBeenCalledTimes(1);
    expect(
      state().runs.find((run) => run.assignment_id === "A-2")?.status,
    ).toBe("cancelled");
    expect(vi.mocked(runtime.release).mock.calls[0]?.[0].terminal_ref).toBe(
      "A-2",
    );
    time += 120_000; // Even past the durable lease, the in-flight mutex still owns it.
    await service.tick();
    expect(
      observe.mock.calls.filter(([, only]) => only === "A-1"),
    ).toHaveLength(1);
    expect(
      state().events.filter(
        (e) =>
          e.type === "host_ops_action_claimed" &&
          e.payload.action_id === restart,
      ),
    ).toHaveLength(1);
  } finally {
    sample.resolve([]);
    await tick;
  }
  // Unknown upstream still forbids the restart after the IO finishes.
  await vi.waitFor(() =>
    expect(
      state().events.some(
        (e) =>
          e.type === "host_ops_action_deferred" &&
          e.payload.action_id === restart,
      ),
    ).toBe(true),
  );
  expect(runtime.release).toHaveBeenCalledTimes(1);
});

test.each(["runtime_changed", "closing"])(
  "a restart waiting for sampling cannot stop a session after %s",
  async (reason) => {
    const action = intent("A-1", "host_ops_restart_standing_pm");
    // Make the upstream verdict permissive so these ownership/shutdown fences
    // must protect the terminal independently of an upstream wait verdict.
    vi.spyOn(monitor, "diagnosis").mockReturnValue({
      assignment_id: "A-1",
      provider: "fixture",
      group: "fixture",
      cause: "agent_stalled",
      action: "restart_once",
      evidence: [],
    });
    const sample = pendingSample();
    const observe = vi.spyOn(monitor, "observe");
    await service.tick();
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() =>
        expect(observe.mock.calls.some(([, only]) => only === "A-1")).toBe(
          true,
        ),
      );
      if (reason === "runtime_changed") {
        store.uow.run((tx) => {
          const assignment = tx.assignments.get(project, "A-1");
          if (!assignment?.runtime_ref) throw new Error("Missing fixture");
          tx.assignments.put(project, {
            ...assignment,
            runtime_ref: {
              ...assignment.runtime_ref,
              terminal_ref: "replacement",
            },
          });
        });
      } else {
        let closed = false;
        closing = service.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
      }
    } finally {
      sample.resolve([]);
      if (closing) await closing;
      else
        await vi.waitFor(() =>
          expect(
            state().events.some(
              (e) =>
                e.type === "host_ops_action_deferred" &&
                e.payload.action_id === action,
            ),
          ).toBe(true),
        );
    }
    expect(runtime.release).not.toHaveBeenCalled();
    expect(pendingHostOpsActions(state().events)).toHaveLength(1);
    expect(state().runs).toHaveLength(0);
  },
);

test("Workbench context view reads another connection's completed sample and applies existing expiry", () => {
  const writer = Store.open({ dataDir: root });
  const observation = {
    assignment_id: "A-1" as const,
    runtime_key: "null",
    source: "fixture",
    agent: "codex" as const,
    session_id: "fixture",
    transcript_path: null,
    cwd: "/fixture",
    model: null,
    context_tokens: 100,
    context_window_size: 1000,
    used_percentage: 10,
    updated_at: clock.now(),
  };
  try {
    expect(service.contextUsage(project).size).toBe(0);
    writeContextSamples(writer, project, [observation]);
    expect(service.contextUsage(project).get("A-1")).toEqual(observation);
    time += 600_001;
    expect(service.contextUsage(project).size).toBe(0);
    writeContextSamples(writer, project, [
      { ...observation, updated_at: clock.now() },
    ]);
    expect(service.contextUsage(project).size).toBe(1);
    writeContextSamples(writer, project, []);
    expect(service.contextUsage(project).size).toBe(0);
  } finally {
    writer.close();
  }
});
