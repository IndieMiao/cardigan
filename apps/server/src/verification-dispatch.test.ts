import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Assignment,
  acknowledgeRun,
  dispatchRun,
  hasRunTarget,
  issueInstruction,
  queueRun,
  type Runtime,
  recordDecision,
  requestDecision,
} from "@cardigan/domain";
import { launchRun, RunTargetDeferred } from "@cardigan/host";
import { parseLaunchConfig } from "@cardigan/roles";
import {
  listBellAttempts,
  Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

let f: ReturnType<typeof m3Fixture>;
let options: DispatcherOptions;
beforeEach(({ task }) => {
  f = m3Fixture("m3-acceptance", undefined, task.name.startsWith("assign"));
  const runtime: Runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    release: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: vi.fn(async () => ({ model: "fixture", agent_cli_version: "1" })),
    startRun: vi.fn(async ({ run, assignment }) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: {
              machine_id: "local",
              runtime_machine: "local",
              terminal_ref: assignment.id,
              agent_name: assignment.id,
            },
          },
          p,
        ),
      );
    }),
  };
});
afterEach(() => f.close());
const runs = (owner: Assignment) =>
  f.state().runs.filter((r) => r.assignment_id === owner.id);
const notes = (owner: Assignment) =>
  f.store.listNotifications({ project_id: f.id, assignment_id: owner.id });
const triggers = [
  "assign",
  "comment",
  "mention",
  "instruction",
  "decision",
] as const;
function trigger(
  kind: (typeof triggers)[number],
  owner: Assignment,
): Assignment {
  if (owner.scope !== "work_item") throw new Error("Expected work item owner");
  // This fixture assigned the verifier through the real PM command at setup.
  if (kind === "assign") return owner;
  if (kind === "comment") f.comment(f.human, owner.work_item_id);
  else if (kind === "mention") f.comment(f.human, undefined, [owner.id]);
  else if (kind === "instruction")
    f.apply((s, a, p) =>
      issueInstruction(
        s,
        a,
        {
          card_id: f.card.id,
          work_item_id: owner.work_item_id,
          body: "Check the current delivery",
        },
        p,
      ),
    );
  else {
    const q = f.apply(
      (s, a, p) =>
        requestDecision(
          s,
          a,
          {
            card_id: f.card.id,
            kind: "choose",
            category: "general",
            question: "Continue?",
            context: "Review input",
            decider: "human",
            plain_summary: TEST_PLAIN_SUMMARY,
            blocking: false,
            options: [
              { key: "go", description: "Continue", impact: "Unblocks review" },
            ],
            recommended: "go",
            affected_cards: [f.card.id],
            affected_work_items: [],
          },
          p,
        ),
      f.actor(owner),
    ).data;
    f.apply((s, a, p) =>
      recordDecision(
        s,
        a,
        {
          decision_id: q.id,
          option: "go",
          rationale: "Ready",
          raw_quote: "go",
        },
        p,
      ),
    );
  }
  return owner;
}
async function product() {
  f.start(f.coder);
  return (await f.delivery()).data;
}
async function completion() {
  const code = await product();
  f.start(f.reviewer);
  f.review(code.id);
  f.finish(f.reviewer);
  return (await f.delivery("card_completion")).data;
}
const cases = triggers.flatMap((kind) =>
  [false, true].map((acceptance) => ({ kind, acceptance })),
);
test.each(cases)(
  "$kind waits durably for its own target (acceptance=$acceptance) and dispatches once",
  async ({ kind, acceptance }) => {
    const owner = trigger(kind, acceptance ? f.pm : f.reviewer);
    for (let i = 0; i < 2; i++) await new Dispatcher(options).tick();
    expect(runs(owner)).toEqual([]); // No queued or cancelled Run, even after restart.
    expect(notes(owner).length).toBeGreaterThan(0);
    expect(
      notes(owner).every(
        (n) => n.status === "pending" && n.attempts === 0 && !n.run_id,
      ),
    ).toBe(true);
    expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
    expect(options.startRun).not.toHaveBeenCalled();
    const retained = notes(owner).map((n) => n.id);
    if (acceptance) await completion();
    else await product();
    await new Dispatcher(options).tick();
    expect(runs(owner)).toHaveLength(1);
    expect(runs(owner)[0]?.status).toBe("dispatched");
    expect(
      notes(owner)
        .filter((n) => retained.includes(n.id))
        .every((n) => n.status === "belled"),
    ).toBe(true);
    const run = runs(owner)[0];
    if (!run) throw new Error("Missing dispatched Run");
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actor(owner),
    );
    f.store.ackEvents({
      project_id: f.id,
      assignment_id: owner.id,
      card_id: f.card.id,
      up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
        .latest_seq,
    });
    f.finish(owner);
    await new Dispatcher(options).tick();
    expect(runs(owner)).toHaveLength(1);
    expect(notes(owner).every((n) => n.status === "acked")).toBe(true);
  },
);

test("a superseded completion retains comments and reuses a capacity-deferred Run without blocking a producer", async () => {
  await completion();
  options.runLimit = () => 1; // The coder still owns the only slot.
  await new Dispatcher(options).tick();
  const queued = runs(f.pm)[0];
  expect(queued).toMatchObject({
    status: "queued",
    queue_reason: "concurrency_limit",
  });
  const next = (await f.delivery()).data; // Withdraws the old completion request.
  f.comment(f.human, undefined, [f.pm.id]);
  f.store.ackEvents({
    project_id: f.id,
    assignment_id: f.coder.id,
    card_id: f.card.id,
    up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
      .latest_seq,
  });
  f.finish(f.coder);
  const extra = f.extra("coder");
  const producer = f.assignItem(extra);
  f.comment(f.human, extra.id);
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toMatchObject([queued]);
  expect(notes(f.pm).every((n) => n.status === "pending")).toBe(true);
  // The older reviewer is dispatched first; after its review, the producer
  // must not be starved by the completion Run whose target was withdrawn.
  const reviewRun = runs(f.reviewer).find((r) => r.status === "dispatched");
  if (!reviewRun) throw new Error("Missing re-review Run");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: reviewRun.id }, p),
    f.actor(f.reviewer),
  );
  f.review(next.id);
  f.finish(f.reviewer);
  f.store.ackEvents({
    project_id: f.id,
    assignment_id: f.coder.id,
    card_id: f.card.id,
    up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
      .latest_seq,
  });
  await new Dispatcher(options).tick();
  expect(runs(producer)[0]?.status).toBe("dispatched");
  options.runLimit = () => 4;
  f.start(f.coder);
  await f.delivery("card_completion");
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toHaveLength(1);
  expect(runs(f.pm)[0]).toMatchObject({ id: queued?.id, status: "dispatched" });
});

test("claim rechecks a target withdrawn during async snapshot preparation", async () => {
  await completion();
  let withdraw = true;
  options.snapshot = async (owner) => {
    if (owner.id === f.pm.id && withdraw) {
      withdraw = false;
      await f.delivery();
    }
    return { model: "fixture", agent_cli_version: "1" };
  };
  await new Dispatcher(options).tick();
  expect(runs(f.pm)).toEqual([]);
  expect(
    notes(f.pm).every((n) => n.status === "pending" && n.attempts === 0),
  ).toBe(true);
  expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
});

const acknowledge = (...owners: Assignment[]) => {
  for (const owner of owners)
    f.store.ackEvents({
      project_id: f.id,
      assignment_id: owner.id,
      card_id: f.card.id,
      up_to_seq: f.store.getUpdates({ project_id: f.id, card_id: f.card.id })
        .latest_seq,
    });
};
async function replaceCompletion() {
  const code = f
    .state()
    .deliveries.find((d) => d.kind === "code" && d.status !== "superseded");
  if (!code) throw new Error("Missing replacement product");
  const active = runs(f.reviewer).find(
    (r) => r.status === "dispatched" || r.status === "running",
  );
  if (active?.status === "dispatched")
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: active.id }, p),
      f.actor(f.reviewer),
    );
  else if (!active) f.start(f.reviewer);
  f.review(code.id);
  f.finish(f.reviewer);
  await f.delivery("card_completion");
  acknowledge(f.coder, f.reviewer);
}
async function restartTick() {
  if (!f.dataDir) throw new Error("Missing data directory");
  const reopened = Store.open({ dataDir: f.dataDir, clock: f.clock });
  try {
    await new Dispatcher({ ...options, store: reopened }).tick();
  } finally {
    reopened.close();
  }
}
async function finishPm() {
  const run = runs(f.pm).find((r) => r.status === "dispatched");
  if (!run) throw new Error("Missing PM Run");
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actor(f.pm),
  );
  acknowledge(f.pm);
  f.finish(f.pm);
  await new Dispatcher(options).tick();
}
const noDeliveryFailure = () => {
  expect(
    f
      .state()
      .events.filter((e) =>
        [
          "bell_delivery_failed",
          "bell_delivery_attempt_failed",
          "run_dispatch_stalled",
        ].includes(e.type),
      ),
  ).toEqual([]);
  expect(options.onError).not.toHaveBeenCalled();
};

test.each([
  "start_callback",
  "before_wake",
  "before_wake_error",
  "host_prepare",
  "host_provision",
] as const)(
  "target withdrawn in %s retains the reservation's Run and resumes once after restart",
  async (window) => {
    await completion();
    options.inactiveCancelAfterMs = null;
    options.inactivityGraceMs = 24 * 60 * 60_000;
    options.onError = vi.fn();
    const live = window.startsWith("before_wake");
    if (live) {
      f.start(f.pm);
      f.finish(f.pm);
      acknowledge(f.pm);
      f.comment(f.human, undefined, [f.pm.id]);
    }
    acknowledge(f.coder, f.reviewer);
    const previousRuns = runs(f.pm).length;
    let withdraw = true;
    const remove = async () => {
      if (!withdraw) return;
      withdraw = false;
      await f.delivery();
    };
    const ordinaryStart = options.startRun;
    const wakeTargets: boolean[] = [];
    options.runtime.wake = vi.fn(async (ref) => {
      if (ref.terminal_ref === f.pm.id)
        wakeTargets.push(hasRunTarget(f.pm, f.state()));
      return { ok: true, value: { sent: true } };
    });
    if (window === "start_callback")
      options.startRun = async (input) => {
        await remove();
        await ordinaryStart(input);
      };
    else if (live)
      options.beforeWake = async ({ assignment }) => {
        if (assignment.id !== f.pm.id || !withdraw) return;
        await remove();
        if (window === "before_wake_error")
          throw new Error("No current Git delivery");
      };
    else {
      const exited = new Set<string>();
      options.runtime.provision = vi.fn(async (owner) => {
        exited.delete(owner.id);
        if (window === "host_provision") await remove();
        return {
          ok: true,
          value: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: owner.id,
            agent_name: owner.id,
          },
        };
      });
      options.runtime.release = vi.fn(async (ref) => {
        exited.add(ref.terminal_ref);
        return { ok: true, value: undefined };
      });
      options.runtime.status = vi.fn(async (ref) => ({
        ok: true,
        value: {
          process: exited.has(ref.terminal_ref) ? "exited" : "alive",
          agent: "idle",
          observed_seq: 1,
        },
      }));
      options.startRun = async ({ project, assignment, run, bell }) => {
        if (assignment.id !== f.pm.id)
          return ordinaryStart({ project, assignment, run, bell });
        if (!f.dataDir) throw new Error("Missing data directory");
        await launchRun(
          {
            store: f.store,
            runtime: options.runtime,
            clock: f.clock,
            dataDir: f.dataDir,
            mcpUrl: "http://127.0.0.1:7780/mcp",
            launch: {
              config: parseLaunchConfig({
                profiles: { acceptance: { harness: "pi", model: "fixture" } },
              }),
              secrets: {},
            },
          },
          {
            project,
            assignment_id: assignment.id,
            run,
            first_prompt: bell,
            actor: { kind: "system", project_id: project },
            prepare_worktree: async () => {
              if (window === "host_prepare") await remove();
              return undefined;
            },
          },
        );
      };
    }
    await new Dispatcher(options).tick();
    const waiting = runs(f.pm).find((r) => r.status === "queued");
    expect(waiting).toBeDefined();
    expect(runs(f.pm)).toHaveLength(previousRuns + 1);
    expect(
      notes(f.pm)
        .filter((n) => n.status !== "acked")
        .every((n) => n.status === "pending" && n.attempts === 0),
    ).toBe(true);
    expect(
      listBellAttempts(f.store.database, f.id).filter(
        (a) => a.assignment_id === f.pm.id,
      ),
    ).toEqual([]);
    expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
    expect(wakeTargets).toEqual([]);
    if (!live && f.dataDir)
      expect(existsSync(join(f.dataDir, "runs", f.id, f.pm.id, "start"))).toBe(
        false,
      );
    if (window === "host_provision") {
      expect(options.runtime.release).toHaveBeenCalledOnce();
      expect(
        f.store.uow
          .run((tx) => tx.tokensForAssignment(f.id, f.pm.id))
          .every((t) => t.revoked_at !== null),
      ).toBe(true);
    }
    noDeliveryFailure();
    f.advance(60 * 60_000);
    await restartTick();
    expect(runs(f.pm).find((r) => r.id === waiting?.id)?.status).toBe("queued");
    await replaceCompletion();
    await new Dispatcher(options).tick();
    expect(runs(f.pm).find((r) => r.id === waiting?.id)?.status).toBe(
      "dispatched",
    );
    expect(runs(f.pm)).toHaveLength(previousRuns + 1);
    if (live) expect(wakeTargets).toEqual([true]);
    await finishPm();
    expect(runs(f.pm)).toHaveLength(previousRuns + 1);
    noDeliveryFailure();
  },
);

test.each([
  "before_tick",
  "runtime_status",
  "before_wake",
  "before_wake_error",
] as const)(
  "failed delivery pauses retries when target vanishes at %s, excluding a long wait from timeout",
  async (window) => {
    await completion();
    f.start(f.pm);
    f.finish(f.pm);
    acknowledge(f.coder, f.reviewer, f.pm);
    f.comment(f.human, undefined, [f.pm.id]);
    options.inactiveCancelAfterMs = null;
    options.inactivityGraceMs = 24 * 60 * 60_000;
    options.onError = vi.fn();
    const wakeTargets: boolean[] = [];
    options.runtime.wake = vi.fn(async (ref) => {
      if (ref.terminal_ref === f.pm.id) {
        wakeTargets.push(hasRunTarget(f.pm, f.state()));
        return { ok: true, value: { sent: wakeTargets.length > 1 } };
      }
      return { ok: true, value: { sent: true } };
    });
    await new Dispatcher(options).tick();
    const run = runs(f.pm).find((r) => r.status === "dispatched");
    expect(run).toBeDefined();
    expect(wakeTargets).toEqual([true]);
    let withdraw = true;
    const remove = async () => {
      if (withdraw) {
        withdraw = false;
        await f.delivery();
      }
    };
    if (window === "before_tick") await remove();
    else if (window === "runtime_status")
      options.runtime.status = vi.fn(async (ref) => {
        if (ref.terminal_ref === f.pm.id) await remove();
        return {
          ok: true,
          value: { process: "alive", agent: "idle", observed_seq: 1 },
        };
      });
    else
      options.beforeWake = async ({ assignment }) => {
        if (assignment.id !== f.pm.id || !withdraw) return;
        await remove();
        if (window === "before_wake_error")
          throw new Error("Target withdrawn during Git preparation");
      };
    f.advance(30_000);
    await new Dispatcher(options).tick();
    expect(
      runs(f.pm).find((r) => r.id === run?.id)?.dispatch_target_wait?.since,
    ).toBeDefined();
    const attempts = () =>
      listBellAttempts(f.store.database, f.id).filter(
        (a) => a.run_id === run?.id,
      );
    expect(attempts()).toHaveLength(1);
    expect(wakeTargets).toEqual([true]);
    const reviewing = runs(f.reviewer).find((r) => r.status === "dispatched");
    if (reviewing)
      f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: reviewing.id }, p),
        f.actor(f.reviewer),
      );
    f.advance(60 * 60_000);
    await restartTick();
    expect(attempts()).toHaveLength(1);
    expect(runs(f.pm).find((r) => r.id === run?.id)?.status).toBe("dispatched");
    await replaceCompletion();
    await new Dispatcher(options).tick();
    expect(wakeTargets).toEqual([true, true]);
    expect(attempts()).toHaveLength(2);
    expect(attempts().map((a) => a.outcome)).toEqual(["failed", "sent"]);
    await finishPm();
    expect(runs(f.pm)).toHaveLength(2);
    noDeliveryFailure();
  },
);

test("an actual wake failure remains uncertain delivery even if the target was withdrawn inside wake", async () => {
  await completion();
  f.start(f.pm);
  f.finish(f.pm);
  acknowledge(f.coder, f.reviewer, f.pm);
  f.comment(f.human, undefined, [f.pm.id]);
  options.onError = vi.fn();
  options.runtime.wake = vi.fn(async (ref) => {
    if (ref.terminal_ref === f.pm.id) {
      await f.delivery();
      throw new Error("Transport lost after send");
    }
    return { ok: true, value: { sent: true } };
  });
  await new Dispatcher(options).tick();
  const run = runs(f.pm).find((r) => r.status === "dispatched");
  expect(
    listBellAttempts(f.store.database, f.id).filter(
      (a) => a.run_id === run?.id,
    ),
  ).toMatchObject([{ outcome: "failed" }]);
  expect(notes(f.pm).filter((n) => n.run_id === run?.id)).toMatchObject([
    { status: "delivery_failed", attempts: 1 },
  ]);
  expect(
    f.state().events.filter((e) => e.type === "run_dispatch_deferred"),
  ).toEqual([]);
  expect(options.onError).toHaveBeenCalledOnce();
  f.advance(30_000);
  await restartTick();
  expect(runs(f.pm).find((r) => r.id === run?.id)?.status).toBe("dispatched");
  expect(
    listBellAttempts(f.store.database, f.id).filter(
      (a) => a.run_id === run?.id,
    ),
  ).toHaveLength(1);
});

test("explicit host session reuse withdraws only its unsent reservation and preserves the existing credential", async () => {
  await completion();
  f.start(f.pm);
  f.finish(f.pm);
  acknowledge(f.coder, f.reviewer, f.pm);
  const token = f.store.issueToken({
    project_id: f.id,
    assignment_id: f.pm.id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      { assignment_id: f.pm.id, model: "fixture", agent_cli_version: "1" },
      p,
    ),
  ).data;
  if (!f.dataDir) throw new Error("Missing data directory");
  const host = {
    store: f.store,
    runtime: options.runtime,
    clock: f.clock,
    dataDir: f.dataDir,
    mcpUrl: "http://127.0.0.1:7780/mcp",
    launch: {
      config: parseLaunchConfig({
        profiles: { acceptance: { harness: "pi", model: "fixture" } },
      }),
      secrets: {},
    },
  };
  const input = {
    project: f.id,
    assignment_id: f.pm.id,
    run,
    actor: f.human,
    reuse_session: true,
  };
  await expect(
    launchRun(host, {
      ...input,
      prepare_worktree: async () => {
        await f.delivery();
        return undefined;
      },
    }),
  ).rejects.toBeInstanceOf(RunTargetDeferred);
  expect(runs(f.pm).find((r) => r.id === run.id)?.status).toBe("queued");
  expect(unfinishedBellAttempts(f.store.database, f.id)).toEqual([]);
  expect(f.store.verifyToken(token.token)).toBeDefined();
  expect(options.runtime.wake).not.toHaveBeenCalled();
  await replaceCompletion();
  await launchRun(host, { ...input, prepare_worktree: async () => undefined });
  expect(runs(f.pm).find((r) => r.id === run.id)?.status).toBe("dispatched");
  expect(options.runtime.wake).toHaveBeenCalledOnce();
  expect(f.store.verifyToken(token.token)).toBeDefined();
});
