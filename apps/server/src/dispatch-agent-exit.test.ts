import type { Assignment, IdleRetirement } from "@cardigan/domain";
import { dispatchRun, stopWorkItemAssignment } from "@cardigan/domain";
import * as host from "@cardigan/host";
import { PROJECT_EVENT_STREAM } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// C-672: on a macOS worker the terminal's program is the idle owner (an
// outer Python launcher), not the Agent CLI. When the CLI exits after its Run,
// the terminal stays live (not kept): bells were typed into it or deferred,
// retirement fences (recent_activity, retained_for_dispatch,
// observation_incomplete) kept it, and only a human stop/start resumed.

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

function setup() {
  const f = dispatchFixture("worker", "none", "darwin");
  fixtures.push(f);
  const target = f.create();
  // The Run finished normally; the session stays bound to its terminal.
  f.session(target.assignment);
  for (const stream of [undefined, target.card.id])
    f.store.advanceRouterCursor(
      f.project,
      stream ?? PROJECT_EVENT_STREAM,
      f.store.getUpdates({
        project_id: f.project,
        ...(stream ? { card_id: stream } : {}),
      }).latest_seq,
    );
  let cliExited = true;
  let closed = false;
  const runtime: DispatcherOptions["runtime"] = {
    // A plain (not kept) live terminal: hc only sees its launcher program.
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
              agent: "unknown" as const,
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
      harness: "pi" as const,
      effort: "high",
    })),
  });
  const owner = () =>
    f.state().assignments.find((a) => a.id === target.assignment.id)!;
  const patch = (value: Partial<Assignment>) => {
    const current = owner();
    f.store.uow.run((tx) =>
      tx.assignments.put(f.project, { ...current, ...value } as Assignment),
    );
  };
  const retirement = (value: Partial<IdleRetirement>) =>
    patch({
      idle_retirement: {
        phase: "waiting",
        runtime_ref: owner().runtime_ref!,
        started_at: f.clock.now(),
        threshold_minutes: 60,
        failures: 1,
        evidence: { stage: "probe", reason: "terminal_busy" },
        ...value,
      } as IdleRetirement,
    });
  // The reviewer rejects the delivery: the author is asked to rework it.
  const reject = () => {
    const run = f
      .state()
      .runs.findLast((r) => r.assignment_id === target.assignment.id)!;
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
  const notes = () =>
    f.store.listNotifications({
      project_id: f.project,
      assignment_id: target.assignment.id,
    });
  return {
    ...f,
    target,
    runtime,
    dispatcher,
    startRun,
    onError,
    owner,
    patch,
    retirement,
    reject,
    notes,
    cliAlive: () => {
      cliExited = false;
    },
  };
}
const replaced = (f: ReturnType<typeof setup>) =>
  f
    .state()
    .events.filter((e) => e.type === "session_replaced")
    .map((e) => e.payload);

/** Ticks until a new Run is dispatched; returns the elapsed fixture time. */
async function resumed(f: ReturnType<typeof setup>, limitMs: number) {
  const start = Date.parse(f.clock.now());
  for (;;) {
    await f.dispatcher.tick([f.project]);
    if (f.startRun.mock.calls.length) return Date.parse(f.clock.now()) - start;
    if (Date.parse(f.clock.now()) - start >= limitMs) return undefined;
    f.advance(10_000);
  }
}

test.each([
  ["recent activity", undefined],
  ["a waiting retirement", { phase: "waiting" }],
  ["a retirement handoff (retained_for_dispatch)", { handoff: true }],
  [
    "an unconfirmed retirement stop (observation_incomplete)",
    { phase: "stopping", observe_only: true },
  ],
] as const)(
  "after a finished Run the CLI exits; a review rejection then resumes the owner within 2 minutes despite %s",
  async (_case, pending) => {
    const f = setup();
    const old = f.owner().runtime_ref;
    if (pending) f.retirement(pending as Partial<IdleRetirement>);
    if (pending && "observe_only" in pending)
      f.patch({ runtime_state: "unknown" });
    f.reject();
    const elapsed = await resumed(f, 120_000);
    expect(elapsed).toBeDefined();
    expect(elapsed).toBeLessThanOrEqual(120_000);
    // Never typed into the terminal that no longer runs the CLI.
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.runtime.release).toHaveBeenCalledExactlyOnceWith(old, {
      force: true,
    });
    expect(replaced(f)).toMatchObject([
      { reason: "agent_exited", old_runtime_ref: old },
    ]);
    expect(f.owner().idle_retirement).toBeUndefined();
    expect(f.startRun).toHaveBeenCalledOnce();
    expect(
      f.state().runs.filter((r) => r.status === "dispatched"),
    ).toMatchObject([{ assignment_id: f.owner().id, kind: "rework" }]);
    expect(f.notes().length).toBeGreaterThan(0);
    expect(f.onError).not.toHaveBeenCalled();
  },
);

test("the diagnosis names an exited Agent instead of a live session until the terminal is closed", async () => {
  const f = setup();
  f.retirement({ handoff: true });
  f.reject();
  // The terminal cannot be closed this pass (Ops holds the launch lock).
  vi.spyOn(f.runtime, "release").mockResolvedValue({
    ok: false,
    error: { code: "runtime_unavailable", message: "busy" },
  });
  await host.upgradeIdleAssignmentRoles(f.store, f.project, f.runtime, f.clock);
  expect(f.owner().session_maintenance).toMatchObject({
    reason: "agent_exited",
  });
  expect(f.owner().runtime_ref).not.toBeNull();
});

test("a CLI that is still running is woken as before and its terminal is never closed", async () => {
  const f = setup();
  f.cliAlive();
  f.reject();
  await f.dispatcher.tick([f.project]);
  f.advance(host.IDLE_ROLE_UPGRADE_INTERVAL_MS);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(replaced(f)).toEqual([]);
  expect(f.runtime.wake).toHaveBeenCalledOnce();
});

test("a human stop keeps the terminal and the rejection for the human start", async () => {
  const f = setup();
  const a = f.owner();
  f.apply(
    (s, actor, p) =>
      stopWorkItemAssignment(s, actor, { assignment_id: a.id }, p),
    { kind: "human", project_id: f.project },
  );
  f.reject();
  await f.dispatcher.tick([f.project]);
  f.advance(host.IDLE_ROLE_UPGRADE_INTERVAL_MS);
  await f.dispatcher.tick([f.project]);
  expect(f.runtime.observe_agent_exit).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.owner().runtime_ref).toEqual(a.runtime_ref);
  expect(f.startRun).not.toHaveBeenCalled();
});
