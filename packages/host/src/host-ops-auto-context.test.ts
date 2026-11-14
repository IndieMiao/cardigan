import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  acknowledgeRun,
  type ContextObservation,
  dispatchRun,
  HOST_OPS_ROLE_TOOLS,
  hostOpsPending,
  pendingHostOpsActions,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  readSessionContexts,
  type SessionContextDiagnostic,
} from "./context-usage.js";
import { HostOpsService } from "./host-ops.js";

vi.mock("./context-usage.js", async (original) => ({
  ...(await original<typeof import("./context-usage.js")>()),
  readSessionContexts: vi.fn(),
}));
const project = "fixture";
const ref = {
  machine_id: "local",
  runtime_machine: "local",
  terminal_ref: "old",
  agent_name: "fixture",
  agent_session_id: "old-session",
};
const settings = { model: "fixture", agent_cli_version: "fixture" };
const snapshot = vi.fn(async () => settings);
let time: number,
  root: string,
  store: Store,
  service: HostOpsService,
  alive: boolean;
let usage: ContextObservation, ops: Assignment;
const clock = { now: () => new Date(time).toISOString() };
const runtime = { status: vi.fn(), release: vi.fn() } as unknown as Runtime;
const state = () => store.uow.read((tx) => loadCommandState(tx, project));
function makeService(
  extra: Partial<ConstructorParameters<typeof HostOpsService>[0]> = {},
) {
  return new HostOpsService({
    store,
    runtime,
    snapshot,
    clock,
    contextUsage: { execution: { mode: "local", dataDir: root } },
    ...extra,
  });
}
beforeEach(async () => {
  time = Date.parse("2030-01-01T00:00:00.000Z");
  root = await mkdtemp(join(tmpdir(), "auto-context-"));
  store = Store.open({ dataDir: root, clock });
  store.createProject({ id: project });
  alive = true;
  snapshot.mockReset().mockResolvedValue(settings);
  vi.mocked(runtime.status)
    .mockReset()
    .mockImplementation(async () => ({
      ok: true,
      value: {
        process: alive ? "alive" : "exited",
        agent: "idle",
        observed_seq: 1,
      },
    }));
  vi.mocked(runtime.release)
    .mockReset()
    .mockImplementation(async () => {
      alive = false;
      return { ok: true, value: undefined };
    });
  ops = {
    id: "A-1",
    scope: "standing",
    role_id: "host_ops",
    role_version: 1,
    employee_id: "E-1",
    status: "active",
    machine_id: "local",
    runtime_ref: ref,
    session_ref: "old-session",
    runtime_state: "idle",
    mcp_token_id: "fixture",
    created_at: clock.now(),
  } as Assignment;
  store.uow.run((tx) => {
    tx.roles.put(project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    });
    tx.assignments.put(project, ops);
  });
  usage = {
    assignment_id: ops.id,
    runtime_key: JSON.stringify(ref),
    agent: "pi",
    session_id: "old-session",
    cwd: "/fixture",
    model: "fixture",
    transcript_path: null,
    context_tokens: 850,
    context_window_size: 1000,
    used_percentage: 85,
    updated_at: clock.now(),
    source: "fixture",
  };
  vi.mocked(readSessionContexts)
    .mockReset()
    .mockImplementation(async () => [
      {
        assignment_id: ops.id,
        session_id: usage.session_id,
        stale: false,
        observation: usage,
      } as SessionContextDiagnostic,
    ]);
  service = makeService();
});
afterEach(async () => {
  await service.close();
  store.close();
  await rm(root, { recursive: true, force: true });
});
async function poll() {
  const calls = vi.mocked(readSessionContexts).mock.calls.length;
  time += 30_001;
  await service.tick();
  await vi.waitFor(() =>
    expect(readSessionContexts).toHaveBeenCalledTimes(calls + 1),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const events = (type: string) => state().events.filter((e) => e.type === type);
async function ready() {
  await poll();
  await poll();
  await vi.waitFor(() =>
    expect(events("host_ops_action_taken")).toHaveLength(1),
  );
}
async function drain() {
  await service.tick();
  await vi.waitFor(() =>
    expect(
      events("host_ops_action_finished").length +
        events("context_session_restart_result").length,
    ).toBeGreaterThan(0),
  );
}

test("handoff is copied to PM Ops; idle self restart stops once, keeps identity and reports actual start", async () => {
  await poll();
  expect(events("context_usage_notice")).toHaveLength(1);
  expect(snapshot).not.toHaveBeenCalled();
  expect(
    store
      .listNotifications({ project_id: project })
      .map((n) => n.recipient.kind)
      .sort(),
  ).toEqual(["assignment", "pm_ops"]);
  await poll();
  await drain();
  expect(runtime.release).toHaveBeenCalledOnce();
  expect(events("context_session_restart_result")).toHaveLength(0);
  const a = state().assignments[0];
  expect(a).toMatchObject({
    id: ops.id,
    employee_id: ops.employee_id,
    runtime_ref: null,
  });
  expect(a?.session_ref).toBeUndefined();
  const run = state().runs[0];
  if (!run) throw new Error("Missing run");
  store.uow.run((tx) => {
    persistEffect(
      tx,
      project,
      unwrap(
        dispatchRun(
          loadCommandState(tx, project),
          { kind: "system", project_id: project },
          {
            run_id: run.id,
            runtime_ref: {
              ...ref,
              terminal_ref: "new",
              agent_session_id: "new-session",
            },
          },
          { clock, ids: tx.ids },
        ),
      ),
    );
    persistEffect(
      tx,
      project,
      unwrap(
        acknowledgeRun(
          loadCommandState(tx, project),
          {
            kind: "assignment",
            project_id: project,
            assignment_id: ops.id,
            role_id: "host_ops",
            role_version: 1,
            allowed_tools: HOST_OPS_ROLE_TOOLS,
          },
          { run_id: run.id },
          { clock, ids: tx.ids },
        ),
      ),
    );
  });
  await service.tick();
  expect(events("session_replaced")).toHaveLength(1);
  const result = events("context_session_restart_result")[0];
  expect(result).toMatchObject({ payload: { result: "succeeded" } });
  expect(
    store
      .listNotifications({ project_id: project })
      .filter((n) => n.event_id === result?.id)
      .map((n) => n.recipient.kind),
  ).toEqual(["pm_ops"]);
  await poll();
  expect(runtime.release).toHaveBeenCalledOnce();
});

test("a Run queued while snapshot IO is pending wins; the later idle poll handles the same notice", async () => {
  await poll();
  const pending = Promise.withResolvers<typeof settings>();
  snapshot.mockReturnValueOnce(pending.promise);
  await poll();
  expect(snapshot).toHaveBeenCalledOnce();
  let id = "";
  store.uow.run((tx) => {
    const effect = unwrap(
      queueRun(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        { assignment_id: ops.id, ...settings },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    id = effect.data.id;
  });
  pending.resolve(settings);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(events("host_ops_action_taken")).toHaveLength(0);
  await poll();
  expect(runtime.release).not.toHaveBeenCalled();
  store.uow.run((tx) => {
    const run = tx.runs.list(project).find((r) => r.id === id);
    if (!run) throw new Error("Missing run");
    tx.runs.put(project, {
      ...run,
      status: "completed",
      finished_at: clock.now(),
    });
  });
  await poll();
  await drain();
  expect(runtime.release).toHaveBeenCalledOnce();
});

test.each(["old_ref", "stale", "unassociated"])(
  "%s samples never create an automatic intent",
  async (kind) => {
    if (kind === "old_ref")
      usage = {
        ...usage,
        runtime_key: JSON.stringify({ ...ref, runtime_machine: "other" }),
      };
    if (kind === "stale")
      usage = { ...usage, updated_at: "2000-01-01T00:00:00.000Z" };
    if (kind === "unassociated")
      vi.mocked(readSessionContexts).mockResolvedValue([
        { stale: false, assignment_id: null } as SessionContextDiagnostic,
      ]);
    await poll();
    await poll();
    expect(events("host_ops_action_taken")).toHaveLength(0);
    expect(runtime.release).not.toHaveBeenCalled();
  },
);

test.each(["unknown_exit", "status_throws", "snapshot_failed", "foreign"])(
  "%s escalates once, keeps a durable fence and does not retry after reopening the store",
  async (failure) => {
    if (failure === "unknown_exit")
      vi.mocked(runtime.status).mockResolvedValue({
        ok: true,
        value: { process: "unknown", agent: "unknown", observed_seq: 1 },
      });
    if (failure === "status_throws")
      vi.mocked(runtime.status).mockRejectedValue(new Error("fixture"));
    if (failure === "snapshot_failed")
      snapshot.mockRejectedValue(new Error("synthetic failure"));
    if (failure === "foreign") {
      await service.close();
      service = makeService({ ownsRuntimeRef: () => false });
    }
    await ready();
    await drain();
    const releases = vi.mocked(runtime.release).mock.calls.length;
    expect(releases).toBe(
      failure === "foreign" || failure === "snapshot_failed" ? 0 : 1,
    );
    expect(state().human_actions).toHaveLength(1);
    expect(state().assignments[0]?.runtime_ref).toEqual(ref);
    expect(state().runs).toHaveLength(0);
    const result = events("context_session_restart_result")[0];
    expect(result).toMatchObject({ payload: { result: "failed" } });
    expect(
      store
        .listNotifications({ project_id: project })
        .filter((n) => n.event_id === result?.id)
        .map((n) => n.recipient.kind)
        .sort(),
    ).toEqual(["needs_you", "pm_office", "pm_ops"]);
    await service.close();
    store.close();
    store = Store.open({ dataDir: root, clock });
    service = makeService();
    await poll();
    await poll();
    await service.tick();
    expect(runtime.release).toHaveBeenCalledTimes(releases);
    expect(state().human_actions).toHaveLength(1);
    expect(hostOpsPending(state().events, ops.id)).toBe(true);
  },
);

test("an interrupted stop is observed on restart but never released a second time", async () => {
  await ready();
  await service.close();
  const action = pendingHostOpsActions(state().events)[0];
  if (!action) throw new Error("Missing intent");
  store.uow.run((tx) =>
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_ops_action_deferred",
      actor: { kind: "system", project_id: project },
      created_at: clock.now(),
      payload: {
        action_id: action.action_id,
        reason: "automatic_context_stop_started",
      },
    }),
  );
  service = makeService();
  await drain();
  expect(runtime.release).not.toHaveBeenCalled();
  expect(state().human_actions).toHaveLength(1);
});

test("sample age is rechecked after the runtime observation and before release", async () => {
  await ready();
  const observed =
    Promise.withResolvers<Awaited<ReturnType<Runtime["status"]>>>();
  vi.mocked(runtime.status).mockReturnValueOnce(observed.promise);
  await service.tick();
  await vi.waitFor(() => expect(runtime.status).toHaveBeenCalled());
  time += 600_001;
  observed.resolve({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  await vi.waitFor(() => expect(state().human_actions).toHaveLength(1));
  expect(runtime.release).not.toHaveBeenCalled();
});

test.each(["compacted", "new_session"])(
  "a fresh %s observation before stopping invalidates the original trigger",
  async (change) => {
    await ready();
    usage =
      change === "compacted"
        ? { ...usage, context_tokens: 100, used_percentage: 10 }
        : { ...usage, session_id: "successor" };
    await drain();
    expect(runtime.release).not.toHaveBeenCalled();
    expect(events("context_session_restart_result")[0]).toMatchObject({
      payload: { result: "failed" },
    });
  },
);

test("a fresh Run cannot be queued while the old terminal observation is in flight", async () => {
  await ready();
  const observed =
    Promise.withResolvers<Awaited<ReturnType<Runtime["status"]>>>();
  vi.mocked(runtime.status).mockReturnValueOnce(observed.promise);
  await service.tick();
  await vi.waitFor(() => expect(runtime.status).toHaveBeenCalled());
  const result = store.uow.run((tx) =>
    queueRun(
      loadCommandState(tx, project),
      { kind: "system", project_id: project },
      { assignment_id: ops.id, ...settings },
      { clock, ids: tx.ids },
    ),
  );
  expect(result.ok).toBe(false);
  observed.resolve({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  });
  await vi.waitFor(() =>
    expect(events("host_ops_action_finished")).toHaveLength(1),
  );
  expect(runtime.release).toHaveBeenCalledOnce();
});
