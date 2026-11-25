import type { Assignment, IdleRetirement, RuntimeRef } from "@cardigan/domain";
import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  queueRun,
  stopWorkItemAssignment,
} from "@cardigan/domain";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-690 (sensen A-100: coder, claude, mac-mini worker). The idle patrol gave up
// on a session and handed its retirement off (retained_for_dispatch). A human
// `stop --hold` released that terminal and `start` launched a new one, but the
// handoff of the released session stayed on the Assignment. Every later bell
// and queued Run of the new session was skipped as `idle_retirement`; stall
// rows read retirement_handoff_changed / session_maintenance with
// can_restart=false, and only another human stop/start resumed it.

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

const human = (f: ReturnType<typeof dispatchFixture>) => ({
  kind: "human" as const,
  project_id: f.project,
});

function setup() {
  const f = dispatchFixture("worker", "none", "darwin");
  fixtures.push(f);
  const target = f.create();
  // The first session (t-old) finished its Run and was retained for dispatch.
  f.session(target.assignment);
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  const old = owner().runtime_ref!;
  const patch = (value: Partial<Assignment>) => {
    const current = owner();
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, { ...current, ...value } as Assignment),
    );
  };
  patch({
    idle_retirement: {
      phase: "waiting",
      handoff: true,
      runtime_ref: old,
      started_at: f.clock.now(),
      threshold_minutes: 60,
      failures: 3,
      last_failure: "unavailable",
      evidence: { stage: "probe", reason: "terminal_busy" },
    } as IdleRetirement,
  });
  const fresh: RuntimeRef = {
    ...old,
    terminal_ref: "worker/t7b",
    target: { ...old.target!, generation: "two" },
  };
  let cliExited = true;
  let closed = false;
  const runtime: DispatcherOptions["runtime"] = {
    // A plain live terminal: on a macOS worker hc only sees the idle owner.
    status: vi.fn(async () =>
      closed
        ? {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "gone" },
          }
        : {
            ok: true as const,
            value: {
              process: "alive" as const,
              agent: "idle" as const,
              observed_seq: 1,
            },
          },
    ),
    observe_agent_exit: vi.fn(async () => ({
      ok: true as const,
      value: cliExited && !closed,
    })),
    observe_retirement: vi.fn(async () => ({
      ok: true as const,
      value: "unknown" as const,
    })),
    release: vi.fn(async () => {
      closed = true;
      return { ok: true as const, value: undefined };
    }),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const startRun = vi.fn(
    async ({
      run,
      assignment,
    }: Parameters<NonNullable<DispatcherOptions["startRun"]>>[0]) => {
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: f.refFor(assignment) },
          p,
        ),
      );
    },
  );
  const onError = vi.fn();
  const dispatcher = new Dispatcher({
    store: f.store,
    clock: f.clock,
    runtime,
    startRun,
    onError,
    snapshot: vi.fn(async () => ({
      model: "fixture",
      agent_cli_version: "1",
      launch_profile_ref: "current-profile",
      harness: "claude-code" as const,
      effort: "high",
    })),
  });
  const settle = () => {
    for (const stream of [undefined, target.card.id])
      f.store.advanceRouterCursor(
        f.project,
        stream ?? PROJECT_EVENT_STREAM,
        f.store.getUpdates({
          project_id: f.project,
          ...(stream ? { card_id: stream } : {}),
        }).latest_seq,
      );
  };
  /** `cardigan assignment stop --hold`, the host's release, then `start`. */
  const humanRestart = (keepStale = false) => {
    const id = owner().id;
    f.apply(
      (s, a, p) =>
        stopWorkItemAssignment(
          s,
          a,
          { assignment_id: id, reason: "manual restart" },
          p,
        ),
      human(f),
    );
    // C-752: the release now finishes it; keep it for the legacy case.
    const stale = owner().idle_retirement;
    f.apply(
      (s, a, p) =>
        stopWorkItemAssignment(
          s,
          a,
          {
            assignment_id: id,
            reason: "manual restart",
            released_runtime_ref: old,
          },
          p,
        ),
      human(f),
    );
    const run = f.apply(
      (s, a, p) =>
        queueRun(
          s,
          a,
          { assignment_id: id, model: "m", agent_cli_version: "1" },
          p,
        ),
      human(f),
    );
    f.apply(
      (s, a, p) => dispatchRun(s, a, { run_id: run.id, runtime_ref: fresh }, p),
      human(f),
    );
    // Production state recorded before this fix: the start kept the record.
    if (keepStale && stale) patch({ idle_retirement: stale });
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(owner()),
    );
    // R-1820 finishes; the Agent stays idle or its CLI exits afterwards.
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "fixture" },
          p,
        ),
      f.actorFor(owner()),
    );
    settle();
    return run;
  };
  // A new instruction for the author arrives: the reviewer rejects R-1820.
  const notify = () => {
    const run = f.state().runs.findLast((r) => r.assignment_id === owner().id)!;
    f.store.uow.run((tx) => {
      const sha = "a".repeat(40);
      const verifier = tx.work_items
        .list(f.project)
        .find((w) => w.card_id === target.card.id && w.kind === "verify")!;
      const delivery = tx.ids.next(f.project, "delivery"),
        review = tx.ids.next(f.project, "review");
      tx.deliveries.put(f.project, {
        id: delivery,
        work_item_id: target.item.id,
        run_id: run.id,
        kind: "code",
        summary: "fixture",
        subject: { kind: "git_head", value: sha },
        status: "rejected",
        evidence: [],
        attachments: [],
        known_gaps: [],
        requested_verifiers: [verifier.id],
      });
      tx.reviews.put(f.project, {
        id: review,
        delivery_id: delivery,
        target_sha: sha,
        work_item_id: verifier.id,
        run_id: run.id,
        kind: "code",
        issues: [],
        verdict: "reject",
        blocking: true,
        recheck_required: false,
        attachments: [],
      });
      const item = tx.work_items.get(f.project, target.item.id)!;
      tx.work_items.put(f.project, { ...item, status: "changes_requested" });
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, target.card.id),
        card_id: target.card.id,
        type: "review_submitted",
        actor: { kind: "system", project_id: f.project },
        payload: {
          review_id: review,
          delivery_id: delivery,
          verdict: "reject",
          rework_allowed: true,
        },
        created_at: f.clock.now(),
      });
    });
  };
  return {
    ...f,
    target,
    runtime,
    dispatcher,
    startRun,
    onError,
    owner,
    patch,
    old,
    fresh,
    humanRestart,
    settle,
    notify,
    cliAlive: () => {
      cliExited = false;
    },
  };
}

/** Ticks until `done()`; returns the elapsed fixture time or undefined. */
async function within(
  f: ReturnType<typeof setup>,
  limitMs: number,
  done: () => boolean,
) {
  const start = Date.parse(f.clock.now());
  for (;;) {
    await f.dispatcher.tick([f.project]);
    if (done()) return Date.parse(f.clock.now()) - start;
    if (Date.parse(f.clock.now()) - start >= limitMs) return undefined;
    f.advance(10_000);
  }
}

const superseded = (f: ReturnType<typeof setup>) =>
  f
    .state()
    .events.filter((e) => e.type === "idle_session_retirement_superseded")
    .map((e) => e.payload);

test("a human stop/start drops the retained handoff of the released session", () => {
  const f = setup();
  f.humanRestart();
  expect(f.owner().runtime_ref).toEqual(f.fresh);
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(superseded(f)).toMatchObject([
    { assignment_id: f.owner().id, handoff: true, failures: 3 },
  ]);
});

test.each([
  ["new session's start", false],
  ["record kept by an earlier start", true],
] as const)(
  "after a human restart (%s) the Agent's CLI exits; the next notice resumes it within 2 minutes",
  async (_case, keepStale) => {
    const f = setup();
    f.humanRestart(keepStale);
    expect(Boolean(f.owner().idle_retirement)).toBe(keepStale);
    f.notify();
    const elapsed = await within(
      f,
      120_000,
      () => f.startRun.mock.calls.length > 0,
    );
    expect(elapsed).toBeDefined();
    expect(elapsed).toBeLessThanOrEqual(120_000);
    // Never typed into the terminal that no longer runs the CLI.
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(f.fresh, {
      force: true,
    });
    expect(
      f
        .state()
        .events.filter((e) => e.type === "session_replaced")
        .map((e) => e.payload),
    ).toMatchObject([{ reason: "agent_exited", old_runtime_ref: f.fresh }]);
    expect(f.owner().idle_retirement).toBeUndefined();
    expect(f.onError).not.toHaveBeenCalled();
  },
);

test("a still running CLI of the new session is woken despite the stale handoff", async () => {
  const f = setup();
  f.humanRestart(true);
  f.cliAlive();
  f.notify();
  const elapsed = await within(
    f,
    120_000,
    () => vi.mocked(f.runtime.wake).mock.calls.length > 0,
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.startRun).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(f.fresh);
});

test("a queued successor behind the stale handoff (retirement_wait) is dispatched within 2 minutes", async () => {
  const f = setup();
  f.humanRestart(true);
  f.cliAlive();
  // R-1836: queued for the author after R-1820 ended.
  const id = f.owner().id;
  const queued = f.apply(
    (s, a, p) =>
      queueRun(
        s,
        a,
        { assignment_id: id, model: "m", agent_cli_version: "1" },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  // Its earlier wake attempt left it waiting for the runtime.
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...tx.runs.get(f.project, queued.id)!,
      queue_reason: "runtime_unavailable",
    }),
  );
  const elapsed = await within(
    f,
    120_000,
    () => f.state().runs.find((r) => r.id === queued.id)?.status !== "queued",
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("a live session retained for dispatch (no Run queued) is woken by a notification within 2 minutes", async () => {
  const f = setup();
  f.settle();
  f.cliAlive();
  expect(f.owner().idle_retirement).toMatchObject({ handoff: true });
  f.notify();
  const elapsed = await within(
    f,
    120_000,
    () => vi.mocked(f.runtime.wake).mock.calls.length > 0,
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(
    f
      .state()
      .events.filter((e) => e.type === "idle_session_retirement_released")
      .map((e) => e.payload),
  ).toMatchObject([{ reason: "business_work", handoff: true, failures: 3 }]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.startRun).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(f.old);
});

// C-739 (sensen A-317): the C-575 takeover needs exit proof a macOS worker
// never gives, so the handoff fenced the queued Run until a managed stop.
test("a retained session with a never-started queued Run is handed back and the Run dispatched within 2 minutes", async () => {
  const f = setup();
  f.settle();
  f.cliAlive();
  const id = f.owner().id;
  const queued = f.apply(
    (s, a, p) =>
      queueRun(
        s,
        a,
        { assignment_id: id, model: "m", agent_cli_version: "1" },
        p,
      ),
    { kind: "system", project_id: f.project },
  );
  f.store.uow.run((tx) =>
    tx.runs.put(f.project, {
      ...tx.runs.get(f.project, queued.id)!,
      queue_reason: "runtime_unavailable",
    }),
  );
  const elapsed = await within(
    f,
    120_000,
    () => f.state().runs.find((r) => r.id === queued.id)?.status !== "queued",
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(f.owner().idle_retirement).toBeUndefined();
  expect(
    f
      .state()
      .events.filter((e) => e.type === "idle_session_retirement_released")
      .map((e) => e.payload),
  ).toMatchObject([{ reason: "business_work", handoff: true }]);
  expect(f.runtime.release).not.toHaveBeenCalled();
});

// C-739 (sensen A-327, A-316): long idle, so the patrol reclaimed the session
// right after handing it back (released -> started -> withdrawn -> handed
// off), and the waiting work was never dispatched.
test("an idle retained session handed back for work is not reclaimed before it is woken", async () => {
  const f = setup();
  f.settle();
  f.cliAlive();
  // As on mac-mini: the idle owner refuses every probe.
  f.runtime.retire_idle = vi.fn(async () => ({
    ok: true as const,
    value: {
      outcome: "withdrawn" as const,
      evidence: { stage: "probe" as const, reason: "probe_invalid" as const },
    },
  }));
  f.patch({ last_mcp_activity_at: f.clock.now() });
  f.advance(2 * 60 * 60_000);
  f.notify();
  const elapsed = await within(
    f,
    120_000,
    () => vi.mocked(f.runtime.wake).mock.calls.length > 0,
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  const types = f
    .state()
    .events.map((e) => e.type)
    .filter((t) => t.startsWith("idle_session_retirement_"));
  expect(types).toEqual(["idle_session_retirement_released"]);
  expect(f.runtime.retire_idle).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
});

test("a human stop keeps a retained session's handoff; nothing is woken", async () => {
  const f = setup();
  f.settle();
  f.cliAlive();
  const id = f.owner().id;
  f.apply(
    (s, a, p) =>
      stopWorkItemAssignment(s, a, { assignment_id: id, reason: "pause" }, p),
    human(f),
  );
  f.notify();
  await within(f, 120_000, () => false);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.owner().idle_retirement).toMatchObject({ handoff: true });
});

// C-752 (sensen A-388, artist_3d on mac-mini): a managed stop released the
// retained session; its handoff stayed, so the pending notification raised
// notification_backlog (restart_blocked=session_maintenance) and a handoff
// overdue, but no new session until a human start.
test("after a managed stop releases a retained session, the next notice starts a new session within 2 minutes", async () => {
  const f = setup();
  f.settle();
  const id = f.owner().id;
  for (const released_runtime_ref of [undefined, f.old])
    f.apply(
      (s, a, p) =>
        stopWorkItemAssignment(
          s,
          a,
          {
            assignment_id: id,
            reason: "managed stop",
            hold: false,
            ...(released_runtime_ref ? { released_runtime_ref } : {}),
          },
          p,
        ),
      human(f),
    );
  expect(f.owner()).toMatchObject({ runtime_ref: null });
  expect(f.owner().idle_retirement).toBeUndefined();
  f.settle();
  f.notify();
  const elapsed = await within(
    f,
    120_000,
    () => f.startRun.mock.calls.length > 0,
  );
  expect(elapsed).toBeDefined();
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
});
