import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assignment,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  type Runtime,
} from "@cardigan/domain";
import {
  authenticate,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
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
let time: number;
const project = "fixture";
const clock = { now: () => new Date(time).toISOString() };
const runtime = { status: vi.fn() } as unknown as Runtime;
beforeEach(async () => {
  time = Date.parse("2026-01-01T00:01:00.000Z");
  root = await mkdtemp(join(tmpdir(), "host-contexts-"));
  store = Store.open({ dataDir: root });
  store.createProject({ id: project });
  vi.mocked(readSessionContexts).mockReset().mockResolvedValue([]);
  service = new HostOpsService({
    store,
    runtime,
    clock,
    contextUsage: { execution: { mode: "local", dataDir: root } },
    upstreamMonitor: new UpstreamHealthMonitor(
      parseLaunchConfig({ providers: {}, profiles: {} }),
      runtime,
      clock,
    ),
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
  const reads = [service.tools.read(context), service.tools.read(context)];
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
