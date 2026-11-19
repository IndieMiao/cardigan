import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  issueInstruction,
  type Run,
  type Runtime,
} from "@cardigan/domain";
import { RuntimeTargetError } from "@cardigan/host";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// P2a-10 A (finding 40): a Harness lists MCP tools once per session, so a live
// session started under an older deploy is replaced on its next natural wake
// when, and only when, the tools/list it saw differs from this deploy's.

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function fixture(options: { employee?: boolean; recorded?: string } = {}) {
  const f = dispatchFixture();
  fixtures.push(f);
  if (options.employee)
    f.store.uow.run((tx) =>
      tx.employees.put({
        id: "E-1" as never,
        name: "Alice",
        title: "Developer",
        bio: "",
        avatar: null,
        role_id: "coder",
        launch_profile_ref: "profile",
        status: "active",
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      }),
    );
  const { assignment, card, item } = f.create();
  const previous = f.session(assignment);
  // The previous session's Run recorded what it listed when it started.
  if (options.recorded !== undefined) {
    const stored = f.state().runs.find((r) => r.id === previous.id);
    if (!stored) throw new Error("Missing previous Run");
    const recorded: Run = {
      ...stored,
      tool_catalog: options.recorded,
      ...(options.employee
        ? { launch_profile_ref: "profile", model: "session-model" }
        : {}),
    };
    f.store.uow.run((tx) => tx.runs.put(f.project, recorded));
  }
  const wake = () =>
    f.apply((s, a, p) =>
      issueInstruction(
        s,
        a,
        { card_id: card.id, work_item_id: item.id, body: "Continue" },
        p,
      ),
    );
  const replacedRef = { ...f.refFor(assignment), terminal_ref: "t-new" };
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    human_entry: async () => ({ ok: true, value: "fixture" }),
    provision: vi.fn(async () => {
      throw new Error("not used");
    }),
    resume_or_replace: vi.fn(async () => ({ ok: true, value: replacedRef })),
  };
  let current = "catalog-v2";
  const toolCatalog = vi.fn(() => current);
  const dispatcher: DispatcherOptions = {
    store: f.store,
    clock: f.clock,
    runtime,
    toolCatalog,
    snapshot: vi.fn(async () => ({
      model: "session-model",
      agent_cli_version: "session-cli",
      ...(options.employee ? { launch_profile_ref: "profile" } : {}),
    })),
    // Stands in for the host: a replacement goes through resume_or_replace
    // (which force-releases the old terminal) and is recorded by dispatchRun.
    startRun: vi.fn(async ({ run, replacement }) => {
      const ref = replacement
        ? await runtime.resume_or_replace(replacement.previous, {
            command: "agent",
            args: [],
            cwd: "/tmp",
            agent_name: replacedRef.agent_name,
            labels: { run: run.id },
          })
        : undefined;
      f.apply(
        (s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              ...(ref?.ok ? { runtime_ref: ref.value } : {}),
              ...(replacement ? { replacement } : {}),
            },
            p,
          ),
        { kind: "system", project_id: f.project },
      );
    }),
  };
  return {
    ...f,
    assignment,
    previous,
    wake,
    runtime,
    dispatcher,
    toolCatalog,
    deploy: (catalog: string) => {
      current = catalog;
    },
    replaced: () =>
      f.state().events.filter((e) => e.type === "session_replaced"),
    latest: () => f.state().runs.at(-1),
  };
}

test("a protocol error during follow-up preflight backs off and wakes the same queued Run", async () => {
  const f = fixture({ employee: true, recorded: "catalog-v2" });
  let limit = 0;
  const dispatcher = new Dispatcher({
    ...f.dispatcher,
    runLimit: () => limit,
    deliveryRetryBaseMs: 100,
  });
  f.wake();
  await dispatcher.tick();
  const queued = f.latest();
  expect(queued).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  limit = 1;
  const snapshot = vi.mocked(f.dispatcher.snapshot);
  snapshot
    .mockClear()
    .mockRejectedValueOnce(new RuntimeTargetError("mcp_protocol_error"));
  await dispatcher.tick();
  f.advance(99);
  await dispatcher.tick();
  expect(snapshot).toHaveBeenCalledOnce();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.latest()).toEqual(queued);
  expect(
    f.state().events.filter((e) => e.type === "bell_delivery_failed"),
  ).toHaveLength(0);

  f.advance(1);
  await dispatcher.tick();
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(f.latest()).toMatchObject({ id: queued?.id, status: "dispatched" });
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.dispatcher.startRun).not.toHaveBeenCalled();
});

test("P2a-10 A: an unchanged tool catalog reuses the live session without replacement", async () => {
  const f = fixture({ recorded: "catalog-v2" });
  f.wake();
  await new Dispatcher(f.dispatcher).tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.dispatcher.startRun).not.toHaveBeenCalled();
  expect(f.runtime.resume_or_replace).not.toHaveBeenCalled();
  expect(f.replaced()).toEqual([]);
  // The reused session carries its catalog forward to the next Run.
  expect(f.latest()).toMatchObject({
    status: "dispatched",
    tool_catalog: "catalog-v2",
  });
});

test("P2a-10 A: a changed tool catalog without a natural wake never replaces the session", async () => {
  const f = fixture({ recorded: "catalog-v1" });
  const runs = f.state().runs.length;
  for (let i = 0; i < 3; i++) {
    await new Dispatcher(f.dispatcher).tick();
    f.advance(60_000);
  }
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.runtime.resume_or_replace).not.toHaveBeenCalled();
  expect(f.dispatcher.startRun).not.toHaveBeenCalled();
  expect(f.replaced()).toEqual([]);
  expect(f.state().runs).toHaveLength(runs);
  expect(
    f.state().assignments.find((a) => a.id === f.assignment.id)?.runtime_ref,
  ).toEqual(f.refFor(f.assignment));
});

test.each([
  { employee: false, label: "without an employee" },
  { employee: true, label: "with an unchanged employee profile" },
])(
  "P2a-10 A: a changed tool catalog replaces the live session on the next natural wake ($label)",
  async ({ employee }) => {
    const f = fixture({ recorded: "catalog-v1", employee });
    f.wake();
    await new Dispatcher(f.dispatcher).tick();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.runtime.resume_or_replace).toHaveBeenCalledOnce();
    expect(f.runtime.resume_or_replace).toHaveBeenCalledWith(
      f.refFor(f.assignment),
      expect.anything(),
    );
    expect(f.dispatcher.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        replacement: {
          previous: f.refFor(f.assignment),
          reason: "tool_catalog_changed",
        },
      }),
    );
    const replaced = f.replaced();
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.actor.kind).toBe("system");
    expect(replaced[0]?.payload).toMatchObject({
      reason: "tool_catalog_changed",
      last_run_id: f.previous.id,
    });
    // The new session is recorded with the catalog this deploy serves, so the
    // next wake on the same deploy reuses it instead of replacing again.
    expect(f.latest()).toMatchObject({
      status: "dispatched",
      tool_catalog: "catalog-v2",
    });
    expect(
      f.state().assignments.find((a) => a.id === f.assignment.id)?.runtime_ref,
    ).toMatchObject({ terminal_ref: "t-new" });
    const handoff = f
      .state()
      .timeline.filter((e) => e.type === "handoff")
      .at(-1);
    expect(handoff?.body).toContain("部署后工具清单已变更");
  },
);

test("P2a-10 A: after one replacement the same deploy reuses the new session", async () => {
  const f = fixture({ recorded: "catalog-v1" });
  f.wake();
  await new Dispatcher(f.dispatcher).tick();
  const replacement = f.latest();
  if (!replacement) throw new Error("Missing replacement Run");
  const agent = f.actorFor(f.assignment);
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: replacement.id }, p),
    agent,
  );
  f.apply(
    (s, a, p) =>
      finishRun(
        s,
        a,
        { run_id: replacement.id, outcome: "completed", summary: "Done" },
        p,
      ),
    agent,
  );
  f.wake();
  await new Dispatcher(f.dispatcher).tick();
  expect(f.replaced()).toHaveLength(1);
  expect(f.runtime.resume_or_replace).toHaveBeenCalledOnce();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.latest()).toMatchObject({
    status: "dispatched",
    tool_catalog: "catalog-v2",
  });
});

test("P2a-10 A: a legacy session without a recorded catalog is reused, never replaced", async () => {
  const f = fixture();
  f.wake();
  await new Dispatcher(f.dispatcher).tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.runtime.resume_or_replace).not.toHaveBeenCalled();
  expect(f.replaced()).toEqual([]);
  expect(f.latest()?.tool_catalog).toBeUndefined();
});

test("P2a-10 A: a failing catalog lookup skips the check instead of blocking delivery", async () => {
  const f = fixture({ recorded: "catalog-v1" });
  f.toolCatalog.mockImplementation(() => {
    throw new Error("token store unavailable");
  });
  const onError = vi.fn();
  f.wake();
  await new Dispatcher({ ...f.dispatcher, onError }).tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(f.replaced()).toEqual([]);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("tool catalog unavailable"),
    }),
  );
});

test("P2a-10 A: a fresh session records the catalog it will list", async () => {
  const f = fixture({ recorded: "catalog-v1" });
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: false,
    error: { code: "runtime_not_found", message: "gone" },
  });
  f.deploy("catalog-v3");
  f.wake();
  await new Dispatcher(f.dispatcher).tick();
  // A lost runtime keeps its own reason; the new session still records v3.
  expect(f.replaced()[0]?.payload).toMatchObject({
    reason: "runtime_not_found",
  });
  expect(f.latest()).toMatchObject({ tool_catalog: "catalog-v3" });
});
