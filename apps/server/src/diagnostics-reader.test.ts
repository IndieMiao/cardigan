import {
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type Runtime,
} from "@cardigan/domain";
import { HostOpsService, UpstreamHealthMonitor } from "@cardigan/host";
import { authenticate, type ToolContext, unwrap } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { DiagnosticsReader } from "./diagnostics-reader.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture(configuration?: ReturnType<typeof parseLaunchConfig>) {
  const f = dispatchFixture();
  f.store.uow.run((tx) =>
    tx.roles.put(f.project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  const ops = f.apply((s, a, p) =>
    createHostOpsAssignment(s, a, {}, p),
  ).assignment;
  const issued = f.store.issueToken({
    project_id: f.project,
    assignment_id: ops.id,
    role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
  });
  const context: ToolContext = {
    store: f.store,
    identity: unwrap(authenticate(f.store, issued.token)),
    revalidateToken: () => {
      if (!f.store.verifyToken(issued.token)) throw new Error("revoked");
    },
  };
  const status = vi.fn(async () => ({
    ok: true as const,
    value: {
      process: "alive" as const,
      agent: "idle" as const,
      observed_seq: 1,
    },
  }));
  const runtime = {
    status,
    diagnostics: () => ({ active: 0 }),
    release: vi.fn(),
    wake: vi.fn(),
  } as unknown as Runtime;
  const upstream =
    configuration ??
    parseLaunchConfig({
      providers: { relay: { harness: "codex" } },
      profiles: { fixture: { harness: "codex", provider: "relay" } },
    });
  const reader = new DiagnosticsReader(
    { dbPath: `${f.dataDir}/cardigan.db`, upstream },
    runtime,
    f.clock,
  );
  const inline = new HostOpsService({
    store: f.store,
    upstream,
    runtime,
    clock: f.clock,
    snapshot: async () => {
      throw new Error("unused");
    },
  });
  cleanups.push(async () => {
    await reader.close();
    await inline.close();
    f.close();
  });
  return { f, reader, inline, status, context, issued, runtime };
}

test("isolated diagnostics match inline output, observe other-connection revisions, and never publish", async () => {
  const { f, reader, inline, context } = fixture();
  const { assignment } = f.create();
  f.session(assignment, false);
  const before = f.state().events.length;
  const run = vi.spyOn(f.store.uow, "run");
  expect(await reader.read(context)).toEqual(await inline.tools.read(context));
  expect(run).not.toHaveBeenCalled();
  expect(f.state().events).toHaveLength(before);
  run.mockRestore();
  f.store.uow.run((tx) => {
    const a = tx.assignments.get(f.project, assignment.id);
    if (!a) throw new Error("missing assignment");
    tx.assignments.put(f.project, { ...a, runtime_state: "lost" });
  });
  const changed = (await reader.read(context)) as { lost: { id: string }[] };
  expect(changed.lost).toContainEqual(
    expect.objectContaining({ id: assignment.id }),
  );
  await expect(reader.read(context, "other")).rejects.toMatchObject({
    code: "unauthorized",
  });
});

test("runtime IO leaves Web timers responsive and revocation during IO rejects the response", async () => {
  const { f, reader, status, context, issued } = fixture();
  f.session(f.create().assignment, false);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  status.mockImplementation(async () => {
    await blocked;
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  });
  const result = reader.read(context);
  const rejected = expect(result).rejects.toThrow("revoked");
  await vi.waitFor(() => expect(status).toHaveBeenCalled());
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.store.revokeToken(issued.record.id);
  finish();
  await rejected;
});

test("a replaced session during runtime IO is rejected using the reader's fresh revision", async () => {
  const { f, reader, status, context } = fixture();
  const { assignment } = f.create();
  f.session(assignment, false);
  status.mockImplementationOnce(async () => {
    f.store.uow.run((tx) => {
      const a = tx.assignments.get(f.project, assignment.id);
      if (!a) throw new Error("missing assignment");
      tx.assignments.put(f.project, {
        ...a,
        runtime_ref: null,
        session_ref: "new-session",
      });
    });
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  });
  await expect(reader.read(context)).rejects.toMatchObject({
    code: "stale_target",
  });
});

test("shutdown rejects outstanding reads and further requests without starting a replacement", async () => {
  const { f, reader, status, context } = fixture();
  f.session(f.create().assignment, false);
  status.mockImplementation(() => new Promise(() => {}));
  const read = expect(reader.read(context)).rejects.toThrow("closed");
  await vi.waitFor(() => expect(status).toHaveBeenCalled());
  await reader.close();
  await read;
  await expect(reader.read(context)).rejects.toThrow("closed");
});

test("worker keeps pending publication, stale failure and configuration binding fail-closed", async () => {
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        upstream: { group: "shared", probe_url: "https://fixture.invalid" },
      },
    },
    profiles: { fixture: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 100, timeout_ms: 20, stale_after_ms: 200 },
    },
  });
  const { f, reader, context, runtime } = fixture(config);
  f.session(f.create().assignment, false);
  let finish!: (result: {
    status: "unreachable";
    failure: "connection_error";
  }) => void;
  const monitor = new UpstreamHealthMonitor(
    config,
    runtime,
    f.clock,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    f.store,
  );
  monitor.schedule();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const pending = (await reader.read(context)) as {
    upstream_health: {
      classification_available: boolean;
      providers: { status: string }[];
    };
  };
  expect(pending.upstream_health.classification_available).toBe(false);
  expect(pending.upstream_health.providers[0]?.status).toBe("unknown");
  finish({ status: "unreachable", failure: "connection_error" });
  await vi.waitFor(() =>
    expect(monitor.diagnostics(f.state()).providers[0]?.status).toBe(
      "unreachable",
    ),
  );
  expect(await reader.read(context)).toMatchObject({
    upstream_health: {
      providers: [
        expect.objectContaining({
          status: "unreachable",
          last_failure_at: f.clock.now(),
        }),
      ],
    },
  });
  f.advance(201);
  expect(await reader.read(context)).toMatchObject({
    upstream_health: {
      providers: [
        expect.objectContaining({
          status: "unknown",
          last_failure_at: expect.any(String),
        }),
      ],
    },
  });
  const changed = structuredClone(config);
  if (!changed.providers.relay?.upstream) throw new Error("missing config");
  changed.providers.relay.upstream.group = "different";
  const other = new DiagnosticsReader(
    { dbPath: `${f.dataDir}/cardigan.db`, upstream: changed },
    runtime,
    f.clock,
  );
  try {
    expect(await other.read(context)).toMatchObject({
      upstream_health: {
        providers: [
          expect.objectContaining({ group: "different", status: "unknown" }),
        ],
      },
    });
  } finally {
    await other.close();
    await monitor.close();
  }
});

test("concurrent status IO overlaps and runtime diagnostics include completed observations", async () => {
  const { f, reader, runtime, status, context } = fixture();
  f.session(f.create().assignment, false);
  Object.assign(runtime, {
    diagnostics: () => ({ status_calls: status.mock.calls.length }),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  status.mockImplementation(async () => {
    await gate;
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  });
  const first = reader.read(context),
    second = reader.read(context);
  await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  release();
  expect(await first).toMatchObject({ runtime_calls: { status_calls: 2 } });
  expect(await second).toMatchObject({ runtime_calls: { status_calls: 2 } });
});
