import {
  acknowledgeRun,
  dispatchRun,
  listNeedsYou,
  queueRun,
} from "@cardigan/domain";
import {
  beginLaunchAttempt,
  finishBellAttempt,
  Store,
  tokensForAssignment,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { resolveServerConfig } from "./config.js";
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());
const fail = () =>
  vi.mocked(f.runtime.wake).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "uncertain" },
  });
const start = () => {
  const id = f.latest().id;
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
    f.actorFor(f.target.assignment),
  );
};
const count = (type: string) =>
  f.state().events.filter((e) => e.type === type).length;
const dispatcher = (extra: Partial<typeof f.options> = {}) =>
  new Dispatcher({
    ...f.options,
    standing: standingResolver(f.store),
    ...extra,
  });

test("failure retries after 30/60/120/240 seconds across restarts; only then queues one replacement", async () => {
  fail();
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  for (const [i, delay] of [30000, 60000, 120000, 240000].entries()) {
    f.advance(delay - 1);
    await dispatcher().tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 1);
    f.advance(1);
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await dispatcher({ store: reopened }).tick();
    } finally {
      reopened.close();
    }
    expect(f.runtime.wake).toHaveBeenCalledTimes(i + 2);
    expect(f.latest().id).toBe(original.id);
    expect(f.runtime.status).toHaveBeenCalledTimes(i + 2);
    expect(f.state().human_actions).toEqual([]);
  }
  await dispatcher().tick();
  expect(f.latest().id).not.toBe(original.id);
  expect(f.latest()).toMatchObject({
    status: "dispatched",
    kind: original.kind,
    model: original.model,
  });
  expect(f.state().runs.find((r) => r.id === original.id)?.status).toBe(
    "cancelled",
  );
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.notes()[0]?.status).toBe("resolved");
});

test("successful send without run_started times out once; second timeout creates a visible Needs You action", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.advance(99);
  await d.tick();
  expect(f.latest().id).toBe(original.id);
  f.advance(1);
  await d.tick();
  expect(f.latest().id).not.toBe(original.id);
  expect(f.latest().status).toBe("dispatched");
  f.advance(100);
  await d.tick();
  await dispatcher({ dispatchTimeoutMs: 100 }).tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(f.runtime.wake).toHaveBeenCalledTimes(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
  const result = listNeedsYou(f.state(), {
    kind: "human",
    project_id: f.project,
  });
  expect(result.ok && result.value.data.human_actions).toHaveLength(1);
  expect(f.state().human_actions[0]?.instructions).toContain(f.target.card.id);
  expect(f.state().human_actions[0]?.instructions).toContain(
    `cardigan assignment start ${f.target.assignment.id}`,
  );
  expect(
    f.state().timeline.some((e) => e.body.includes("已自动恢复过一次")),
  ).toBe(true);
  start();
  await d.tick();
  expect(f.state().human_actions[0]?.status).toBe("cancelled");
  expect(f.notes().some((n) => n.status === "needs_attention")).toBe(false);
});

test.each(["exited", "unknown"] as const)(
  "retry checks the terminal and skips wake when process is %s",
  async (process) => {
    fail();
    f.comment();
    await dispatcher().tick();
    vi.mocked(f.runtime.status).mockResolvedValue({
      ok: true,
      value: { process, agent: "unknown", observed_seq: 2 },
    });
    f.advance(30000);
    await dispatcher().tick();
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(f.runtime.status).toHaveBeenCalledTimes(2);
    expect(f.state().runs).toHaveLength(2);
  },
);

test("MCP start during terminal inspection wins over a retry claim", async () => {
  fail();
  f.comment();
  await dispatcher().tick();
  vi.mocked(f.runtime.status).mockImplementation(async () => {
    start();
    return {
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 2 },
    };
  });
  f.advance(30000);
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  f.advance(600000);
  await dispatcher().tick();
  expect(count("run_dispatch_recovered")).toBe(0);
});

test("two dispatchers share a retry lease and a late ACK wins over failure", async () => {
  fail();
  f.comment();
  await dispatcher().tick();
  let release!: () => void;
  vi.mocked(f.runtime.wake).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    start();
    const note = f.notes()[0];
    if (!note?.card_id) throw new Error("Missing notice");
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      card_id: note.card_id,
      up_to_seq: note.seq,
    });
    return { ok: false, error: { code: "runtime_timeout", message: "late" } };
  });
  f.advance(30000);
  const sending = dispatcher().tick();
  try {
    await expect
      .poll(() => unfinishedBellAttempts(f.store.database, f.project).length)
      .toBe(1);
    await dispatcher().tick();
    expect(f.runtime.wake).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await sending;
  }
  expect(f.notes()[0]?.status).toBe("acked");
  expect(f.latest().status).toBe("running");
});

test("explicit CLI launch with no notifications also retries and recovers from its durable intent", async () => {
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.target.assignment.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run(() =>
    beginLaunchAttempt(f.store.database, {
      id: "cli-launch",
      project_id: f.project,
      assignment_id: run.assignment_id,
      run_id: run.id,
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 1000).toISOString(),
    }),
  );
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  f.store.uow.run(() =>
    finishBellAttempt(
      f.store.database,
      f.project,
      "cli-launch",
      "failed",
      f.clock.now(),
    ),
  );
  f.skipEvents();
  expect(f.notes()).toEqual([]);
  f.advance(30000);
  await dispatcher().tick();
  expect(f.runtime.wake).toHaveBeenCalledOnce();
  expect(vi.mocked(f.runtime.wake).mock.calls[0]?.[1]).toContain(
    `run=${run.id}`,
  );
  f.advance(600000);
  await dispatcher().tick();
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("active PM Ops receives plain language escalation in its inbox", async () => {
  const ops = f.pm();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...ops, standing_mode: "ops" }),
  );
  f.session(ops, false); // A busy Ops keeps the alert visible in its inbox.
  f.skipEvents();
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  f.advance(100);
  await d.tick();
  f.advance(100);
  await d.tick();
  expect(f.state().human_actions).toEqual([]);
  const event = f.state().events.find((e) => e.type === "run_dispatch_stalled");
  expect(event?.payload).toMatchObject({ audience: "pm_ops" });
  expect(
    f.store
      .listNotifications({ project_id: f.project })
      .find((n) => n.event_id === event?.id && n.recipient.kind === "pm_ops")
      ?.status,
  ).toBe("pending");
});

test("500-minute-old watchdog attention resolves after the Run finishes or the Assignment releases", async () => {
  f.session(f.target.assignment, false);
  f.skipEvents();
  const d = dispatcher({ inactivityGraceMs: 1 });
  f.advance(500 * 60000);
  await d.tick();
  expect(f.notes()[0]?.status).toBe("needs_attention");
  f.complete();
  f.skipEvents();
  await d.tick();
  expect(f.notes()[0]?.status).toBe("resolved");
  const another = f.create();
  f.session(another.assignment, false);
  f.skipEvents();
  f.advance(500 * 60000);
  await d.tick();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, {
      ...another.assignment,
      status: "released",
    }),
  );
  await d.tick();
  expect(
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: another.assignment.id,
    })[0]?.status,
  ).toBe("resolved");
});

test("dispatch timeout is configurable and rejects invalid values", () => {
  expect(resolveServerConfig({}).dispatchTimeoutMs).toBe(600000);
  expect(
    resolveServerConfig({ CARDIGAN_DISPATCH_TIMEOUT_MS: "1234" })
      .dispatchTimeoutMs,
  ).toBe(1234);
  expect(() =>
    resolveServerConfig({ CARDIGAN_DISPATCH_TIMEOUT_MS: "0" }),
  ).toThrow();
  expect(() => dispatcher({ dispatchTimeoutMs: 0 })).toThrow(
    "Invalid dispatcher",
  );
});

test("an in-flight delivery lease prevents timeout recovery until settlement", async () => {
  f.comment();
  let release!: () => void;
  vi.mocked(f.runtime.wake).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, value: { sent: true } };
  });
  const sending = dispatcher({ dispatchTimeoutMs: 100 }).tick();
  try {
    await expect
      .poll(() => unfinishedBellAttempts(f.store.database, f.project).length)
      .toBe(1);
    f.advance(101);
    await dispatcher({ dispatchTimeoutMs: 100 }).tick();
    expect(count("run_dispatch_recovered")).toBe(0);
  } finally {
    release();
    await sending;
  }
  await dispatcher({ dispatchTimeoutMs: 100 }).tick();
  expect(count("run_dispatch_recovered")).toBe(1);
});

test("unconfirmed terminal stop escalates without cancelling or requeuing", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: original.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  vi.mocked(f.runtime.status).mockResolvedValue({
    ok: true,
    value: { process: "unknown", agent: "unknown", observed_seq: 2 },
  });
  f.advance(100);
  await d.tick();
  expect(f.latest()).toEqual(original);
  expect(count("run_dispatch_recovered")).toBe(0);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(
    tokensForAssignment(
      f.store.database,
      f.project,
      original.assignment_id,
    ).every((t) => t.revoked_at === null),
  ).toBe(true);
  expect(f.state().human_actions[0]?.instructions).toContain(
    "无法确认旧终端已停止",
  );
});

test("confirmed stop precedes atomic cancellation, token revocation and queueing", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  const original = f.latest();
  f.store.issueToken({
    project_id: f.project,
    assignment_id: original.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const release = f.runtime.release;
  f.runtime.release = vi.fn(async (...args) => {
    expect(f.latest().status).toBe("dispatched");
    expect(
      tokensForAssignment(
        f.store.database,
        f.project,
        original.assignment_id,
      ).every((t) => t.revoked_at === null),
    ).toBe(true);
    // The live monitor observes exit concurrently with the stop operation.
    f.store.uow.run((tx) => {
      const current = tx.runs.get(f.project, original.id);
      const owner = tx.assignments.get(f.project, original.assignment_id);
      if (!current || !owner) throw new Error("Missing run");
      tx.runs.put(f.project, { ...current, status: "unknown" });
      tx.assignments.put(f.project, { ...owner, runtime_state: "unknown" });
    });
    return release(...args);
  });
  f.advance(100);
  await d.tick();
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(
    tokensForAssignment(
      f.store.database,
      f.project,
      original.assignment_id,
    ).every((t) => t.revoked_at !== null),
  ).toBe(true);
  expect(count("run_dispatch_aborted")).toBe(1);
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});

test("fresh MCP activity during the stop preflight prevents release and cancellation", async () => {
  f.comment();
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  await d.tick();
  vi.mocked(f.runtime.status).mockImplementationOnce(async () => {
    start();
    return {
      ok: true,
      value: { process: "alive", agent: "working", observed_seq: 2 },
    };
  });
  f.advance(100);
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.latest().status).toBe("running");
  expect(count("run_dispatch_recovered")).toBe(0);
});

test("PM Ops delivery failure escalates to Needs You without notifying itself repeatedly", async () => {
  const ops = f.pm();
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...ops, standing_mode: "ops" }),
  );
  f.session(ops);
  f.skipEvents();
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      { assignment_id: ops.id, model: "fixture", agent_cli_version: "fixture" },
      p,
    ),
  );
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  const d = dispatcher({ dispatchTimeoutMs: 100 });
  f.advance(100);
  await d.tick();
  f.advance(100);
  await d.tick();
  await d.tick();
  expect(count("run_dispatch_recovered")).toBe(1);
  expect(count("run_dispatch_stalled")).toBe(1);
  expect(f.state().human_actions).toHaveLength(1);
  expect(f.options.startRun).toHaveBeenCalledOnce();
});
